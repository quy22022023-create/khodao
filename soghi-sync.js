/* Đồng bộ snapshot có revision, ghép 3 chiều theo ID và giữ hàng đợi bền vững trong IndexedDB. */
(() => {
  'use strict';
  const collections = ['harvesters','entries','rates','advances','settlements'];
  function stable(value) {
    if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
    if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k)+':'+stable(value[k])).join(',') + '}';
    return JSON.stringify(value);
  }
  const equal = (a,b) => stable(a) === stable(b);
  function clean(data) {
    const result = {};
    for (const key of collections) result[key] = (data?.[key] || []).map(row => {
      const copy = { ...row }; delete copy.accountId; return copy;
    }).sort((a,b) => a.id.localeCompare(b.id));
    result.settings = { theme: data?.settings?.theme === 'blue' ? 'blue' : 'green' };
    return result;
  }
  const empty = () => clean({});
  function mapIds(value,maps={},reverse=false) {
    const resolved={};
    for(const key of collections)resolved[key]=new Map(Object.entries(maps[key]||{}).map(([remote,local])=>reverse?[local,remote]:[remote,local]));
    const id=(key,value)=>resolved[key].get(value)||value;
    const data=clean(value);
    for(const key of collections)for(const row of data[key]) {
      row.id=id(key,row.id);
      if(row.harvesterId)row.harvesterId=id('harvesters',row.harvesterId);
      if(key==='settlements') {
        row.entryIds=row.entryIds.map(v=>id('entries',v));
        row.days=row.days.map(d=>({...d,rateId:id('rates',d.rateId),entryIds:d.entryIds.map(v=>id('entries',v))}));
        row.advanceAllocations=row.advanceAllocations.map(a=>({...a,advanceId:id('advances',a.advanceId)}));
      }
    }
    return clean(data);
  }
  function merge(baseValue,localValue,remoteValue,choice) {
    const base=clean(baseValue),local=clean(localValue),remote=clean(remoteValue),data=empty(),conflicts=[];
    for (const key of [...collections,'settings']) {
      const map = value => new Map((key==='settings' ? [{id:'settings',...value[key]}] : value[key]).map(r=>[r.id,r]));
      const b=map(base),l=map(local),r=map(remote),rows=[];
      for (const id of new Set([...b.keys(),...l.keys(),...r.keys()])) {
        const bv=b.get(id),lv=l.get(id),rv=r.get(id); let value;
        if (equal(lv,rv)) value=lv;
        else if (equal(lv,bv)) value=rv;
        else if (equal(rv,bv)) value=lv;
        else if (choice==='local') value=lv;
        else if (choice==='remote') value=rv;
        else { conflicts.push({collection:key,id,local:lv,remote:rv}); value=lv; }
        if (value) rows.push(value);
      }
      if(key==='settings') data.settings={theme:rows[0]?.theme||'green'}; else data[key]=rows;
    }
    // Nếu thiết bị khác đã chốt, thay đổi kg/khoản ứng ở máy này phải được đối chiếu.
    const locked = new Set(remote.settlements.flatMap(s=>s.entryIds));
    const used = new Set(remote.settlements.flatMap(s=>s.advanceAllocations.map(a=>a.advanceId)));
    for (const key of ['entries','advances','settlements']) {
      const protectedRows=remote[key].filter(row=>key==='settlements'||(key==='entries'?locked.has(row.id):used.has(row.id)));
      for(const row of protectedRows) {
        const index=data[key].findIndex(x=>x.id===row.id),candidate=data[key][index];
        if (!equal(candidate,row)) {
          if(choice==='remote') { if(index<0)data[key].push(row);else data[key][index]=row; }
          else if(!conflicts.some(c=>c.collection===key&&c.id===row.id)) conflicts.push({collection:key,id:row.id,local:candidate,remote:row,locked:true});
        }
      }
    }
    // Hai thiết bị có thể thêm cùng một mốc giá với hai UUID khác nhau.
    const rateGroups=new Map();
    for(const rate of data.rates){const k=JSON.stringify([rate.harvesterId,rate.effectiveDate]);if(!rateGroups.has(k))rateGroups.set(k,[]);rateGroups.get(k).push(rate);}
    for(const [id,rows] of rateGroups)if(rows.length>1){
      const matches=r=>JSON.stringify([r.harvesterId,r.effectiveDate])===id;
      const lv=local.rates.find(matches),rv=remote.rates.find(matches);
      if(choice){const keep=choice==='remote'?rv:lv;data.rates=data.rates.filter(r=>!matches(r)||r.id===keep?.id);}
      else conflicts.push({collection:'rates',id,local:lv,remote:rv});
    }
    // Xóa người ở một máy trong lúc máy kia thêm số: bắt buộc người dùng đối chiếu.
    for(const key of ['entries','rates','advances','settlements'])for(const row of [...data[key]]) {
      if(!row.harvesterId||data.harvesters.some(p=>p.id===row.harvesterId))continue;
      const lv=local[key].find(r=>r.id===row.id),rv=remote[key].find(r=>r.id===row.id);
      if(choice){
        const source=choice==='remote'?remote:local,keep=source[key].find(r=>r.id===row.id),parent=source.harvesters.find(p=>p.id===row.harvesterId);
        if(keep&&parent){data.harvesters.push(parent);data[key]=data[key].map(r=>r.id===row.id?keep:r);}
        else data[key]=data[key].filter(r=>r.id!==row.id);
      }else if(!conflicts.some(c=>c.collection===key&&c.id===row.id))conflicts.push({collection:key,id:row.id,local:lv,remote:rv});
    }
    const remoteSettlements=new Set(remote.settlements.map(s=>s.id)),remoteClaims=new Map();
    for(const s of remote.settlements)for(const id of s.entryIds)remoteClaims.set(id,s);
    const remoteUsed=new Map();for(const s of remote.settlements)for(const a of s.advanceAllocations)remoteUsed.set(a.advanceId,(remoteUsed.get(a.advanceId)||0)+a.amount);
    for(const s of [...data.settlements])if(!remoteSettlements.has(s.id)){
      let existing=s.entryIds.map(id=>remoteClaims.get(id)).find(Boolean);
      if(!existing)for(const a of s.advanceAllocations){const loan=data.advances.find(v=>v.id===a.advanceId);if(loan&&(remoteUsed.get(a.advanceId)||0)+a.amount>loan.amount)existing=remote.settlements.find(v=>v.advanceAllocations.some(x=>x.advanceId===a.advanceId));}
      if(existing){if(choice==='remote')data.settlements=data.settlements.filter(v=>v.id!==s.id);else conflicts.push({collection:'settlements',id:s.id,local:s,remote:existing,locked:true});}
    }
    return {data:clean(data),conflicts};
  }
  class SyncError extends Error {
    constructor(message,code,details) { super(message);this.code=code;this.details=details; }
  }
  function create(options) {
    const config=options.config||{},url=String(config.supabaseUrl||'').replace(/\/+$/,''),key=String(config.supabaseAnonKey||'');
    const enabled=config.mode==='supabase'||(config.mode!=='local-demo'&&!!(url||key));
    let account=null,timer=null,poll=null,running=null,status='idle',lastError='',conflicts=[];
    let credentials=null,stopped=false,rerun=false;
    const uuid=()=>crypto.randomUUID();
    function validateConfig() {
      if(!/^https:\/\//.test(url)&&!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(url)) throw new SyncError('Điền Project URL HTTPS vào soghi-config.js.','CONFIG');
      if(!key)throw new SyncError('Điền publishable/anon key vào soghi-config.js.','CONFIG');
      if(key.startsWith('sb_secret_'))throw new SyncError('Config đang chứa secret key. Chỉ dùng publishable/anon key.','CONFIG');
      if(key.split('.').length===3) {
        try {const payload=JSON.parse(atob(key.split('.')[1].replace(/-/g,'+').replace(/_/g,'/')));if(payload.role==='service_role')throw new SyncError('Không dùng service_role key trong web.','CONFIG');}catch(e){if(e.code==='CONFIG')throw e;}
      }
    }
    function setStatus(value,error='') {status=value;lastError=error;options.onState?.();}
    async function rpc(name,body,token=credentials) {
      validateConfig();
      if(!navigator.onLine)throw new SyncError('Đang ngoại tuyến. Dữ liệu vẫn được giữ trên thiết bị.','NETWORK');
      const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),15000);
      try {
        const headers={'Content-Type':'application/json',apikey:key};if(key.startsWith('eyJ'))headers.Authorization='Bearer '+key;
        const response=await fetch(url+'/rest/v1/rpc/soghi_'+name,{method:'POST',headers,body:JSON.stringify(token?{...body,p_token:token}:body),signal:controller.signal,cache:'no-store'});
        const payload=await response.json().catch(()=>({message:'Máy chủ trả dữ liệu không hợp lệ.'}));
        if(!response.ok||!payload||payload.ok!==true){
          const code=payload?.error||(/SESSION_EXPIRED/.test(payload?.message)?'SESSION_EXPIRED':response.status===401?'API_KEY':'SERVER');
          throw new SyncError(payload?.message||'Máy chủ trả dữ liệu không đúng cấu trúc Sổ Ghi. Kiểm tra URL/key và chạy SQL cài đặt.',code,payload?.snapshot);
        }
        return payload;
      } catch(e) {if(e instanceof SyncError)throw e;throw new SyncError('Chưa kết nối được máy chủ. Dữ liệu chưa đồng bộ vẫn được giữ lại.','NETWORK');}
      finally {clearTimeout(timeout);}
    }
    async function authenticate({username,pin,displayName,register,migrate}) {
      if(register)return rpc('register',{p_username:username,p_display_name:displayName,p_pin:pin},null);
      try{return await rpc('login',{p_username:username,p_pin:pin},null);}
      catch(e){
        if(migrate&&e.code==='INVALID_LOGIN') {
          try{return await rpc('register',{p_username:username,p_display_name:displayName,p_pin:pin},null);}
          catch(reg){if(reg.code==='USERNAME_EXISTS')throw e;throw reg;}
        }
        throw e;
      }
    }
    function schedule(delay=700) {
      if(!enabled||!account||stopped)return;
      if(running)rerun=true;
      if(status==='synced')setStatus('pending');
      clearTimeout(timer);timer=setTimeout(()=>flush().catch(()=>{}),delay);
    }
    async function attach(localAccount,auth) {
      account=localAccount;stopped=false;
      if(auth)await options.updateMeta(account.id,old=>old?.remoteId===auth.account.id?{...old,token:auth.token,expiresAt:auth.expiresAt}:{accountId:account.id,remoteId:auth.account.id,token:auth.token,expiresAt:auth.expiresAt,revision:0,base:empty(),counter:1,ackCounter:0,importing:true});
      const bundle=await options.readBundle(account.id);credentials=bundle.meta?.token||null;
      clearInterval(poll);
      if(!credentials){setStatus('unlinked');return;}
      poll=setInterval(()=>{if(document.visibilityState!=='hidden')schedule(0);},15000);
      schedule(0);
    }
    async function settle(selection,harvesterId) {
      await flush();
      const bundle=await options.readBundle(account.id);
      if(!credentials)throw new SyncError('Đăng nhập Supabase trước khi kết sổ.','SESSION_EXPIRED');
      if(bundle.meta.counter!==bundle.meta.ackCounter)throw new SyncError('Cần đồng bộ xong trước khi xác nhận kết sổ.','PENDING');
      const remoteHarvester=Object.entries(bundle.meta.idMap?.harvesters||{}).find(([,local])=>local===harvesterId)?.[0]||harvesterId;
      const pending={requestId:uuid(),revision:bundle.meta.revision,selection,harvesterId:remoteHarvester,local:bundle.data,counter:bundle.meta.counter};
      await options.updateMeta(account.id,old=>({...old,pendingSettlement:pending}));
      await flush();
    }
    async function accept(response,request,bundle) {
      const choice=bundle.meta.resolution?.revision===response.revision?bundle.meta.resolution.choice:undefined;
      await options.apply(account.id,response.data,request.local,{revision:response.revision,base:clean(response.data),ackCounter:request.counter,pendingRequest:null,pendingSettlement:null,importing:false,resolution:null},choice,request);
      await options.onChange?.();
    }
    async function syncWork() {
      if(!enabled||!account||stopped)return;
      setStatus('syncing');
      try {
        for(let attempt=0;attempt<5;attempt++) {
          let bundle=await options.readBundle(account.id);credentials=bundle.meta?.token||null;
          if(!credentials){setStatus('unlinked');return;}
          let meta=bundle.meta;
          if(meta.pendingSettlement) {
            const pending=meta.pendingSettlement;
            try {
              const response=await rpc('settle',{p_revision:pending.revision,p_request_id:pending.requestId,p_harvester_id:pending.harvesterId,p_mode:pending.selection.mode,p_from:pending.selection.from||'',p_to:pending.selection.to||''});
              await accept(response,pending,bundle);
            }catch(e){
              if(e.code!=='NETWORK')await options.updateMeta(account.id,old=>({...old,pendingSettlement:null}));
              throw e;
            }
            continue;
          }
          if(meta.pendingRequest) {
            const pending=meta.pendingRequest;
            try {
              const response=await rpc('save',{p_revision:pending.revision,p_request_id:pending.requestId,p_data:pending.data,p_replace:!!pending.replace,p_import:!!pending.importing});
              await accept(response,pending,bundle);
            }catch(e){
              if(e.code==='REVISION_CONFLICT'){await options.updateMeta(account.id,old=>({...old,pendingRequest:null}));continue;}
              if(e.code!=='NETWORK')await options.updateMeta(account.id,old=>({...old,pendingRequest:null}));
              throw e;
            }
            continue;
          }
          const dirty=meta.counter!==meta.ackCounter;
          if(!dirty){const head=await rpc('head',{});if(head.revision===meta.revision){setStatus('synced');return;}}
          const remote=await rpc('pull',{});
          const choice=meta.resolution?.revision===remote.revision?meta.resolution.choice:undefined;
          let candidate;
          if(meta.restore) {
            if(remote.revision!==meta.restoreRevision&&!choice)throw new SyncError('Cloud có dữ liệu mới sau lúc khôi phục. Cần chọn bản dữ liệu để tiếp tục.','CONFLICT',[{collection:'restore',local:bundle.data,remote:remote.data}]);
            candidate=choice==='remote'?remote.data:bundle.data;
          } else {
            const result=merge(meta.base,bundle.data,remote.data,choice);
            if(result.conflicts.length)throw new SyncError('Có thay đổi cùng một dữ liệu trên hai thiết bị.','CONFLICT',result.conflicts);
            candidate=result.data;
          }
          options.validate(candidate);
          if(equal(candidate,clean(remote.data))) {
            await accept(remote,{local:bundle.data,counter:meta.counter,replace:meta.restore,restoreId:meta.restoreId},bundle);continue;
          }
          const pending={requestId:uuid(),revision:remote.revision,data:clean(candidate),local:bundle.data,counter:meta.counter,replace:!!meta.restore,restoreId:meta.restoreId,importing:!!meta.importing};
          await options.updateMeta(account.id,old=>({...old,pendingRequest:pending}));
        }
        schedule(100);
      }catch(e){
        if(e.code==='CONFLICT'){conflicts=e.details;setStatus('conflict',e.message);}
        else setStatus(e.code==='NETWORK'?'offline':e.code==='SESSION_EXPIRED'?'expired':'error',e.message);
        throw e;
      }
    }
    async function flush() {
      clearTimeout(timer);
      if(running)return running;
      const task=()=>syncWork();
      running=(globalThis.navigator?.locks&&account?navigator.locks.request('soghi-sync-'+account.id,task):task()).finally(()=>{running=null;if(rerun&&!stopped){rerun=false;schedule(0);}});
      return running;
    }
    async function resolve(choice) {
      const remote=await rpc('pull',{});
      await options.updateMeta(account.id,old=>({...old,resolution:{choice,revision:remote.revision}}));
      conflicts=[];return flush();
    }
    async function logout() {
      stopped=true;clearTimeout(timer);clearInterval(poll);
      if(running)await running.catch(()=>{});
      const token=credentials,aid=account?.id;account=null;credentials=null;
      if(aid)await options.updateMeta(aid,old=>({...old,token:null}));
      if(token)rpc('logout',{},token).catch(()=>{});
    }
    window.addEventListener('online',()=>schedule(0));
    window.addEventListener('focus',()=>schedule(0));
    document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')schedule(0);});
    return {enabled,authenticate,attach,schedule,flush,settle,resolve,logout,merge,clean,
      get status(){return status;},get error(){return lastError;},get conflicts(){return conflicts;},
      get linked(){return !!credentials;}};
  }
  globalThis.SoghiSync=Object.freeze({stable,equal,clean,empty,mapIds,merge,create,SyncError});
})();
