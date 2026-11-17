(() => {
  "use strict";

  const DB_NAME = "soghi_local_demo_v1";
  const DB_VERSION = 3;
  const Ledger = globalThis.SoghiLedger;
  const UI = globalThis.SoghiUI;
  const STORE_NAMES = { harvesters: "harvesters", entries: "entries", rates: "soghi_rates", advances: "soghi_advances", settlements: "soghi_settlements" };
  const SESSION_KEY = "soghi_demo_session";
  const $ = (selector, root = document) => root.querySelector(selector);
  const app = $("#app");
  const modal = $("#soghi-modal");
  const modalForm = $("#soghi-modal-form");
  const modalTitle = $("#soghi-modal-title");
  const modalBody = $("#soghi-modal-body");
  const modalActions = $("#soghi-modal-actions");
  const toastNode = $("#soghi-toast");
  const importInput = $("#soghi-import-file");
  const entryDock = $("#soghi-entry-dock");
  const keyboardToggle = $("#soghi-keyboard-toggle");
  const virtualKeyboard = $("#soghi-virtual-keyboard");

  const state = {
    db: null,
    account: null,
    screen: "auth",
    authMode: "login",
    currentHarvesterId: null,
    currentDate: todayISO(),
    search: "",
    settings: { theme: "green" },
    toastTimer: null,
    swipeStart: null,
    drafts: new Map(),
    bookData: null,
    viewToken: 0,
    saving: false,
    keyboardHeight: 0,
    picker: null,
    navigationBusy: false,
    statistics: null,
    statsData: null,
    statsReturn: null,
    viewportWidth: 0
  };

  function todayISO() {
    const now = new Date();
    const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
    return local.toISOString().slice(0, 10);
  }
  function dateFromISO(value) {
    return new Date(`${value}T12:00:00`);
  }
  function shiftDate(value, amount) {
    const d = dateFromISO(value);
    d.setDate(d.getDate() + amount);
    const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
    return local.toISOString().slice(0, 10);
  }
  function formatDate(value) {
    if (!value) return "Chưa ghi chép";
    const d = dateFromISO(value);
    return d.toLocaleDateString("vi-VN");
  }
  function formatNumber(value) {
    return new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 2 }).format(value || 0);
  }
  function money(value) { return new Intl.NumberFormat("vi-VN").format(value) + "đ"; }
  function dateLabel(value) { return formatDate(value); }
  function moneyInput(value, allowZero = false, max = 1000000000000) {
    const text = String(value ?? "").trim();
    const n = Number(text);
    if (!/^\d+$/.test(text) || !Ledger.integer(n, allowZero ? 0 : 1) || n > max) throw new Error("Nhập số tiền nguyên hợp lệ, không có dấu phân cách.");
    return n;
  }
  function run(task) {
    return (...args) => {
      try { return Promise.resolve(task(...args)).catch(error => showToast(error.message || "Có lỗi xảy ra.")); }
      catch (error) { showToast(error.message || "Có lỗi xảy ra."); }
    };
  }
  function sameBook(context) {
    return state.screen === "book" && state.account?.id === context.accountId && state.currentHarvesterId === context.harvesterId && state.currentDate === context.date;
  }
  function bookContext() { return { accountId: state.account?.id, harvesterId: state.currentHarvesterId, date: state.currentDate }; }
  function draftKey(context = bookContext()) { return JSON.stringify([context.accountId, context.harvesterId, context.date]); }
  function draft() {
    const key = draftKey();
    if (!state.drafts.has(key)) state.drafts.set(key, { value: "", entryId: null, replace: false });
    return state.drafts.get(key);
  }
  function escapeHTML(value) {
    return String(value ?? "").replace(/[&<>"']/g, ch => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[ch]));
  }
  function normalizeUsername(value) {
    return String(value || "")
      .trim()
      .replace(/\s+/g, " ")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[đĐ]/g, "d")
      .toLocaleLowerCase("vi-VN");
  }
  function randomId() {
    if (crypto.randomUUID) return crypto.randomUUID();
    return `soghi-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }
  function bytesToHex(bytes) {
    return Array.from(new Uint8Array(bytes)).map(b => b.toString(16).padStart(2, "0")).join("");
  }
  function hexToBytes(hex) {
    return new Uint8Array((hex.match(/.{1,2}/g) || []).map(x => parseInt(x, 16)));
  }
  async function hashPin(pin, saltHex) {
    if (!window.crypto?.subtle) {
      throw new Error("Trình duyệt cần chạy trên localhost hoặc HTTPS để tạo mã PIN an toàn.");
    }
    const salt = saltHex ? hexToBytes(saltHex) : crypto.getRandomValues(new Uint8Array(16));
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(pin), "PBKDF2", false, ["deriveBits"]);
    const bits = await crypto.subtle.deriveBits(
      { name: "PBKDF2", salt, iterations: 120000, hash: "SHA-256" }, key, 256
    );
    return { hash: bytesToHex(bits), salt: bytesToHex(salt) };
  }

  function openDatabase() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains("accounts")) {
          const store = db.createObjectStore("accounts", { keyPath: "id" });
          store.createIndex("usernameKey", "usernameKey", { unique: true });
        }
        if (!db.objectStoreNames.contains("harvesters")) {
          const store = db.createObjectStore("harvesters", { keyPath: "id" });
          store.createIndex("accountId", "accountId", { unique: false });
        }
        if (!db.objectStoreNames.contains("entries")) {
          const store = db.createObjectStore("entries", { keyPath: "id" });
          store.createIndex("accountId", "accountId", { unique: false });
          store.createIndex("harvesterId", "harvesterId", { unique: false });
          store.createIndex("date", "date", { unique: false });
        }
        if (!db.objectStoreNames.contains("settings")) {
          db.createObjectStore("settings", { keyPath: "accountId" });
        }
        for (const name of ["soghi_rates", "soghi_advances", "soghi_settlements"]) {
          if (!db.objectStoreNames.contains(name)) {
            const store = db.createObjectStore(name, { keyPath: "id" });
            store.createIndex("accountId", "accountId", { unique: false });
          }
        }
        if (!db.objectStoreNames.contains("soghi_sync_state")) db.createObjectStore("soghi_sync_state", { keyPath: "accountId" });
      };
      request.onblocked = () => showToast("Đóng tab Sổ Ghi cũ để hoàn tất cập nhật dữ liệu.");
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => { db.close(); showToast("Ứng dụng có bản cập nhật. Hãy tải lại trang."); };
        resolve(db);
      };
      request.onerror = () => reject(request.error);
    });
  }
  function storeRequest(storeName, mode, action) {
    return new Promise((resolve, reject) => {
      const changed = mode === "readwrite" && (Object.values(STORE_NAMES).includes(storeName) || storeName === "settings") && state.account;
      const tx = state.db.transaction(changed ? [storeName, "soghi_sync_state"] : storeName, mode);
      if (changed) markDirty(tx, state.account.id);
      const store = tx.objectStore(storeName);
      let request;
      try { request = action(store); } catch (err) { reject(err); return; }
      tx.oncomplete = () => { resolve(request?.result); if (changed) cloud.schedule(); };
      tx.onerror = () => reject(tx.error || request?.error);
      tx.onabort = () => reject(tx.error || new Error("Giao dịch dữ liệu bị hủy."));
    });
  }
  const getAll = name => storeRequest(name, "readonly", store => store.getAll());
  const put = (name, value) => storeRequest(name, "readwrite", store => store.put(value));
  const getOne = (name, key) => storeRequest(name, "readonly", store => store.get(key));
  function markDirty(tx, accountId, options = {}) {
    const store = tx.objectStore("soghi_sync_state"), req = store.get(accountId);
    req.onsuccess = () => {
      if (!req.result) return;
      const next = { ...req.result, counter: req.result.counter + 1 };
      if (options.restore) Object.assign(next, { restore: true, restoreRevision: req.result.revision, restoreId: randomId() });
      store.put(next);
    };
  }
  function transaction(names, mode, action, options = {}) {
    return new Promise((resolve, reject) => {
      const changed = !options.silent && mode === "readwrite" && names.some(n => Object.values(STORE_NAMES).includes(n) || n === "settings") && state.account;
      const stores = [...new Set(changed ? [...names, "soghi_sync_state"] : names)];
      const tx = state.db.transaction(stores, mode);
      if (changed) markDirty(tx, state.account.id, options);
      let value, problem;
      tx.oncomplete = () => { resolve(value); if (changed) cloud.schedule(); };
      tx.onabort = tx.onerror = () => reject(problem || tx.error || new Error("Giao dịch dữ liệu bị hủy."));
      const request = req => new Promise((yes, no) => { req.onsuccess = () => yes(req.result); req.onerror = () => no(req.error); });
      Promise.resolve().then(() => action(tx, request)).then(result => { value = result; }).catch(error => {
        problem = error;
        try { tx.abort(); } catch { reject(error); }
      });
    });
  }
  async function readData(tx, request, accountId) {
    const pairs = await Promise.all(Object.entries(STORE_NAMES).map(async ([key, store]) =>
      [key, await request(tx.objectStore(store).index("accountId").getAll(accountId))]));
    return Object.fromEntries(pairs);
  }
  async function getAccountData(accountId = state.account.id) {
    return transaction(Object.values(STORE_NAMES), "readonly", (tx, request) => readData(tx, request, accountId));
  }
  async function readCloudBundle(accountId) {
    return transaction([...Object.values(STORE_NAMES), "settings", "soghi_sync_state"], "readonly", async (tx, request) => {
      const [data, settings, meta] = await Promise.all([readData(tx, request, accountId), request(tx.objectStore("settings").get(accountId)), request(tx.objectStore("soghi_sync_state").get(accountId))]);
      return { data: SoghiSync.mapIds({ ...data, settings }, meta?.idMap, true), meta };
    });
  }
  async function updateCloudMeta(accountId, change) {
    return transaction(["soghi_sync_state"], "readwrite", async (tx, request) => {
      const old = await request(tx.objectStore("soghi_sync_state").get(accountId));
      const next = change(old);
      if (next) tx.objectStore("soghi_sync_state").put(next);
    }, { silent: true });
  }
  async function applyCloudSnapshot(accountId, incoming, expectedLocal, patch, choice, syncRequest) {
    await transaction([...Object.values(STORE_NAMES), "settings", "soghi_sync_state"], "readwrite", async (tx, request) => {
      const [all, settings, meta] = await Promise.all([
        Promise.all(Object.entries(STORE_NAMES).map(async ([key, store]) => [key, await request(tx.objectStore(store).getAll())])).then(Object.fromEntries),
        request(tx.objectStore("settings").get(accountId)), request(tx.objectStore("soghi_sync_state").get(accountId))
      ]);
      if (!meta) throw new Error("Phiên đồng bộ đã thay đổi.");
      const data = Object.fromEntries(Object.entries(all).map(([key, rows]) => [key, rows.filter(r => r.accountId === accountId)]));
      const current = SoghiSync.mapIds({ ...data, settings }, meta.idMap, true);
      const result = SoghiSync.merge(expectedLocal, current, incoming, choice);
      if (result.conflicts.length) throw new SoghiSync.SyncError("Có thay đổi mới trong lúc đồng bộ. Dữ liệu vẫn được giữ lại.", "CONFLICT", result.conflicts);
      const maps = structuredClone(meta.idMap || {});
      for (const key of Object.keys(STORE_NAMES)) {
        maps[key] ||= {};
        const otherIds = new Set(all[key].filter(r => r.accountId !== accountId).map(r => r.id));
        const targets = new Set([...all[key].map(r => r.id), ...Object.values(maps[key])]);
        for (const row of result.data[key]) {
          let target = Object.hasOwn(maps[key], row.id) ? maps[key][row.id] : row.id;
          if (otherIds.has(target)) { do { target = randomId(); } while (targets.has(target)); Object.defineProperty(maps[key], row.id, { value: target, enumerable: true, writable: true, configurable: true }); targets.add(target); }
        }
      }
      const local = SoghiSync.mapIds(result.data, maps);
      for (const [key, store] of Object.entries(STORE_NAMES)) {
        for (const old of data[key]) tx.objectStore(store).delete(old.id);
        for (const row of local[key]) tx.objectStore(store).put({ ...row, accountId });
      }
      tx.objectStore("settings").put({ ...local.settings, accountId });
      const next = { ...meta, ...patch, idMap: maps, ackCounter: Math.max(meta.ackCounter, patch.ackCounter) };
      if (syncRequest.replace && (!meta.restoreId || meta.restoreId === syncRequest.restoreId)) Object.assign(next, { restore: false, restoreId: null, restoreRevision: null });
      tx.objectStore("soghi_sync_state").put(next);
    }, { silent: true });
  }
  async function saveSettings() {
    await put("settings", { accountId: state.account.id, ...state.settings });
  }
  async function loadSettings() {
    const saved = await getOne("settings", state.account.id);
    state.settings = { theme: saved?.theme || "green" };
    document.body.dataset.theme = state.settings.theme;
  }

  function showToast(message) {
    (modal.open ? modal : document.body).appendChild(toastNode);
    toastNode.textContent = message;
    toastNode.classList.add("show");
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => toastNode.classList.remove("show"), 2400);
  }
  let modalGeneration = 0;
  function showModal(title, bodyHTML, actionsHTML, onSubmit, options = {}) {
    closePersonPicker(false);
    const generation = ++modalGeneration;
    let busy = false;
    setVirtualKeyboard(false);
    modal.classList.toggle("menu-dialog", options.menu === true);
    modalTitle.textContent = title;
    modalBody.innerHTML = bodyHTML;
    modalActions.innerHTML = actionsHTML;
    modalActions.hidden = !actionsHTML;
    UI.bindDates(modalBody);
    modal.showModal();
    modalForm.onsubmit = async event => {
      event.preventDefault();
      if (busy) return;
      busy = true;
      modalActions.querySelectorAll("button[type=submit]").forEach(b => b.disabled = true);
      try {
        const result = await onSubmit?.(new FormData(modalForm));
        if (result !== false && generation === modalGeneration) modal.close();
      } catch (error) {
        showToast(error.message || "Có lỗi xảy ra.");
      } finally {
        busy = false;
        if (generation === modalGeneration) modalActions.querySelectorAll("button[type=submit]").forEach(b => b.disabled = false);
      }
    };
  }
  function closeModal() { if (modal.open) modal.close(); }
  modal.addEventListener("close", () => document.body.appendChild(toastNode));
  $(".modal-close").addEventListener("click", closeModal);
  modal.addEventListener("click", event => {
    if (event.target === modal) closeModal();
  });

  function connectionText() {
    if (cloud.enabled) {
      if (!navigator.onLine) return "Ngoại tuyến · Sẽ đồng bộ khi có mạng";
      const labels = { synced: "Đã đồng bộ Supabase", syncing: "Đang đồng bộ…", pending: "Đã lưu trên máy · Chờ đồng bộ", conflict: "Cần đối chiếu dữ liệu · Mở Cài đặt", expired: "Cần đăng nhập lại để đồng bộ", unlinked: "Dữ liệu trên máy · Liên kết trong Cài đặt", error: "Chưa đồng bộ · Mở Cài đặt", offline: "Chưa tới được máy chủ · Dữ liệu lưu trên máy" };
      return labels[cloud.status] || "Đang kiểm tra đồng bộ";
    }
    if (!navigator.onLine) return "Ngoại tuyến · Dữ liệu lưu trên thiết bị";
    return "Đang dùng dữ liệu kiểm thử trên thiết bị";
  }
  function connectionHTML() {
    return `<div class="status-line"><span class="connection-pill"><i class="connection-dot"></i>${escapeHTML(connectionText())}</span></div>`;
  }

  function personColor(person) { return UI.color(person, state.settings.theme === "blue" ? "#245a85" : "#176b3a"); }
  function actionMenu(title, items, intro = "") {
    showModal(title, `${intro}<div class="action-menu">${items.map((item, i) => `<button type="button" data-menu-action="${i}" ${item.id ? `id="${item.id}"` : ""} class="menu-action${item.danger ? " menu-danger" : ""}"><span class="menu-action-icon">${UI.icon(item.icon)}</span><span>${item.label}${item.hint ? `<small>${item.hint}</small>` : ""}</span><span class="menu-action-arrow" aria-hidden="true">›</span></button>`).join("")}</div>`, "", null, { menu: true });
    modalBody.querySelectorAll("[data-menu-action]").forEach(button => button.addEventListener("click", run(async () => {
      const item = items[Number(button.dataset.menuAction)];
      closeModal(); await item.action();
    })));
  }
  function openHomeMenu() {
    actionMenu("Menu chính", [
      { label: "Thống kê", hint: "Tổng sản lượng và biểu đồ", icon: "chart", id: "open-statistics", action: () => openStatistics() },
      { label: "Thêm người hái", icon: "add", id: "add-person-top", action: openAddPerson },
      { label: "Cài đặt", hint: "Đơn giá, sao lưu và đồng bộ", icon: "settings", id: "open-settings", action: openSettings }
    ]);
  }
  async function openBookMenu() {
    if (state.saving) return showToast("Đang lưu, vui lòng chờ.");
    const context = bookContext(), wasOpen = !virtualKeyboard.hidden, data = await getAccountData(context.accountId);
    if (!sameBook(context)) return;
    const person = data.harvesters.find(p => p.id === context.harvesterId);
    if (!person) return renderHome();
    const locked = Ledger.lockedIds(data), used = Ledger.allocations(data);
    const pending = data.entries.filter(e => e.harvesterId === person.id && !locked.has(e.id)).reduce((s, e) => s + Ledger.kg100(e.kg), 0);
    const advance = data.advances.filter(a => a.harvesterId === person.id).reduce((s, a) => s + a.amount - (used.get(a.id) || 0), 0);
    actionMenu(person.name, [
      { label: "Ứng tiền", icon: "wallet", id: "add-advance", action: () => openAdvance(person.id) },
      { label: "Kết sổ", icon: "settle", id: "settle-book", action: () => openSettlement(person.id) },
      { label: "Lịch sử", icon: "history", id: "finance-history", action: () => openFinanceHistory(person.id) },
      { label: "Màu hiển thị", icon: "palette", id: "person-color", action: () => openPersonColor(person.id) },
      { label: "Thống kê", icon: "chart", id: "open-statistics", action: () => openStatistics({ personId: person.id, returnKeyboard: wasOpen }) },
      { label: "Cài đặt", icon: "settings", id: "open-settings", action: openSettings }
    ], `<p class="menu-overview">Chưa kết sổ: <strong>${formatNumber(pending / 100)} kg</strong><br>Còn ứng: <strong>${money(advance)}</strong></p>`);
  }
  async function openPersonMenu(id) {
    const token = state.viewToken, person = await getOne("harvesters", id);
    if (token !== state.viewToken || !person || person.accountId !== state.account?.id) return;
    actionMenu(person.name, [
      { label: "Mở sổ", icon: "person", action: async () => { state.currentHarvesterId = id; state.currentDate = todayISO(); await renderBook(); } },
      { label: "Sửa tên", icon: "edit", id: "edit-person", action: () => editPerson(id) },
      { label: "Màu hiển thị", icon: "palette", id: "person-color", action: () => openPersonColor(id) },
      { label: "Xóa người hái", icon: "trash", danger: true, id: "delete-person", action: () => deletePerson(id) }
    ]);
  }
  async function openPersonColor(id) {
    const accountId = state.account.id, person = await getOne("harvesters", id);
    if (!person || person.accountId !== accountId || state.account?.id !== accountId) return;
    const selected = UI.palette.some(p => p.value === person.color) ? person.color : "";
    showModal("Màu hiển thị", `<p class="form-hint">Màu của thanh tiêu đề, tên và biểu tượng <strong>${escapeHTML(person.name)}</strong>. Trang giấy vẫn giữ nền kem.</p>
      <div class="color-preview" style="--person-color:${personColor(person)}"><span class="person-avatar">${escapeHTML([...person.name][0])}</span><strong>${escapeHTML(person.name)}</strong></div>
      <fieldset class="color-options"><legend class="sr-only">Chọn màu cho người hái</legend>
        <label class="color-option color-default"><input type="radio" name="color" value="" ${!selected ? "checked" : ""}><span class="color-choice">Theo màu chung</span></label>
        ${UI.palette.map(p => `<label class="color-option" style="--swatch:${p.value}"><input type="radio" name="color" value="${p.value}" ${selected === p.value ? "checked" : ""}><span class="color-choice"><span class="color-dot" aria-hidden="true"></span>${p.label}</span></label>`).join("")}
      </fieldset>`, standardActions("Lưu màu"), async form => {
      const value = String(form.get("color") || "");
      if (value && !UI.palette.some(p => p.value === value)) throw new Error("Màu không hợp lệ.");
      await transaction(["harvesters"], "readwrite", async (tx, request) => {
        const latest = await request(tx.objectStore("harvesters").get(id));
        if (!latest || latest.accountId !== accountId) throw new Error("Người hái không còn tồn tại.");
        if (value) latest.color = value; else delete latest.color;
        latest.updatedAt = new Date().toISOString(); tx.objectStore("harvesters").put(latest);
      });
      await updateVisibleData(); showToast("Đã lưu màu hiển thị.");
    });
    modalCancel();
    modalBody.querySelectorAll('input[name="color"]').forEach(input => input.addEventListener("change", () => {
      $(".color-preview", modalBody).style.setProperty("--person-color", UI.color({ color: input.value }, personColor(null)));
    }));
  }
  function placePersonPicker() {
    if (!state.picker) return;
    const top = $(".book-topbar")?.getBoundingClientRect().bottom || 72;
    const picker = $("#soghi-person-picker"), height = window.visualViewport?.height || innerHeight;
    picker.style.top = (top + 6) + "px";
    picker.style.maxHeight = Math.max(120, Math.min(380, height - top - 18)) + "px";
  }
  function renderPersonPicker() {
    if (!state.picker || state.screen !== "book") return;
    const query = normalizeUsername($("#person-picker-search").value);
    const people = state.bookData.harvesters.filter(p => normalizeUsername(p.name).includes(query)).sort((a, b) => a.name.localeCompare(b.name, "vi"));
    $("#person-picker-list").innerHTML = people.length ? people.map(p => `<button type="button" data-switch-person="${escapeHTML(p.id)}" aria-current="${p.id === state.currentHarvesterId}" style="--person-color:${personColor(p)}"><span class="person-avatar">${escapeHTML([...p.name][0])}</span><span class="picker-person-name">${escapeHTML(p.name)}</span><span class="picker-current">${p.id === state.currentHarvesterId ? "Đang mở ✓" : ""}</span></button>`).join("") : '<p class="picker-empty" role="status">Không tìm thấy người hái.</p>';
    placePersonPicker();
  }
  function togglePersonPicker() {
    if (state.picker) return closePersonPicker();
    if (state.saving || state.navigationBusy || dateFlipBusy) return showToast("Đang mở/lưu trang sổ, vui lòng chờ.");
    state.picker = { context: bookContext(), keyboardOpen: !virtualKeyboard.hidden };
    setVirtualKeyboard(false);
    $("#person-picker-search").value = "";
    $("#soghi-person-picker").hidden = false; $("#soghi-picker-backdrop").hidden = false;
    $("#book-person-toggle").setAttribute("aria-expanded", "true");
    document.body.classList.add("person-picker-open"); renderPersonPicker();
  }
  function closePersonPicker(restoreKeyboard = true) {
    const picker = state.picker;
    state.picker = null;
    $("#soghi-person-picker").hidden = true; $("#soghi-picker-backdrop").hidden = true;
    if (document.activeElement === $("#person-picker-search")) document.activeElement.blur();
    $("#book-person-toggle")?.setAttribute("aria-expanded", "false");
    document.body.classList.remove("person-picker-open");
    if (restoreKeyboard && picker && sameBook(picker.context)) setVirtualKeyboard(picker.keyboardOpen);
  }
  async function switchPerson(id) {
    if (!state.picker || state.saving || state.navigationBusy) return;
    const picker = state.picker;
    if (!state.bookData.harvesters.some(p => p.id === id)) return;
    closePersonPicker(false); state.navigationBusy = true;
    toastNode.classList.remove("show"); clearTimeout(state.toastTimer);
    try {
      state.currentHarvesterId = id;
      await renderBook();
      if (state.screen === "book" && state.currentHarvesterId === id) setVirtualKeyboard(picker.keyboardOpen);
    } finally { state.navigationBusy = false; }
  }
  $("#soghi-picker-backdrop").addEventListener("click", () => closePersonPicker());
  $("#close-person-picker").addEventListener("click", () => closePersonPicker());
  $("#person-picker-search").addEventListener("input", renderPersonPicker);
  $("#person-picker-list").addEventListener("click", run(event => {
    const target = event.target.closest("[data-switch-person]");
    if (target) return switchPerson(target.dataset.switchPerson);
  }));
  document.addEventListener("keydown", event => { if (event.key === "Escape" && state.picker) { event.preventDefault(); closePersonPicker(); $("#book-person-toggle")?.focus({ preventScroll: true }); } });
  function updateViewportSpace() {
    const changedWidth = state.viewportWidth !== innerWidth;
    state.viewportWidth = innerWidth;
    document.documentElement.style.setProperty("--soghi-viewport-height", (window.visualViewport?.height || innerHeight) + "px");
    placePersonPicker();
    if (changedWidth && state.screen === "statistics" && state.statistics?.view === "chart") renderStatisticsResults();
  }
  window.addEventListener("resize", updateViewportSpace);
  window.visualViewport?.addEventListener("resize", updateViewportSpace);
  window.addEventListener("scroll", placePersonPicker, { passive: true });
  updateViewportSpace();

  function renderAuth() {
    closePersonPicker(false);
    hideEntryDock();
    parkEntryDock();
    state.viewToken++;
    state.screen = "auth";
    const isRegister = state.authMode === "register";
    app.innerHTML = `
      <main class="auth-screen">
        <section class="auth-card">
          <div class="auth-brand">
            <div class="brand-mark">SG</div>
            <h1>SỔ GHI CÔNG HÁI</h1>
            <p>Ghi nhanh · Tính tự động · Xem lại dễ dàng</p>
          </div>
          <div class="auth-tabs">
            <button type="button" data-auth-mode="login" class="${!isRegister ? "active" : ""}">Đăng nhập</button>
            <button type="button" data-auth-mode="register" class="${isRegister ? "active" : ""}">Tạo tài khoản</button>
          </div>
          <form id="auth-form">
            ${isRegister ? `
              <div class="form-field">
                <label for="display-name">Tên hiển thị</label>
                <input id="display-name" name="displayName" autocomplete="name" placeholder="Ví dụ: Nguyễn Văn A" required maxlength="80">
              </div>` : ""}
            <div class="form-field">
              <label for="username">Username</label>
              <input id="username" name="username" autocomplete="username" placeholder="Tên đăng nhập hoặc số điện thoại" required maxlength="80">
            </div>
            <div class="form-field">
              <label for="pin">Mã PIN 6 chữ số</label>
              <input id="pin" name="pin" type="password" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="${isRegister ? "new-password" : "current-password"}" placeholder="••••••" required>
            </div>
            ${isRegister ? `
              <div class="form-field">
                <label for="pin-confirm">Nhập lại mã PIN</label>
                <input id="pin-confirm" name="pinConfirm" type="password" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" placeholder="••••••" required>
              </div>` : ""}
            <button class="primary-button" type="submit">${isRegister ? "TẠO TÀI KHOẢN" : "ĐĂNG NHẬP"}</button>
          </form>
          <p class="auth-foot">${cloud.enabled ? "Đăng nhập Supabase bằng username và PIN.<br>Thiết bị đã đăng nhập vẫn ghi được khi mất mạng." : "Dữ liệu lưu trên trình duyệt này.<br>Điền URL/key trong config để kết nối Supabase."}</p>
        </section>
      </main>`;
    app.querySelectorAll("[data-auth-mode]").forEach(button => {
      button.addEventListener("click", () => {
        state.authMode = button.dataset.authMode;
        renderAuth();
      });
    });
    let authBusy = false;
    $("#auth-form").addEventListener("submit", run(async event => {
      event.preventDefault();
      if (authBusy) return;
      authBusy = true;
      const submit = event.currentTarget.querySelector("button[type=submit]");
      submit.disabled = true;
      try {
      const data = new FormData(event.currentTarget);
      const username = String(data.get("username") || "").trim();
      const usernameKey = normalizeUsername(username);
      const pin = String(data.get("pin") || "");
      if (!usernameKey) return showToast("Vui lòng nhập Username.");
      if (!/^\d{6}$/.test(pin)) return showToast("Mã PIN phải gồm đúng 6 chữ số.");
      if (cloud.enabled) {
        const existing = (await getAll("accounts")).find(a => a.usernameKey === usernameKey);
        const localPinOK = existing ? (await hashPin(pin, existing.pinSalt)).hash === existing.pinHash : false;
        const cached = existing && (await readCloudBundle(existing.id)).meta?.remoteId;
        try {
          if (isRegister && existing) throw new Error("Username đã có dữ liệu trên máy. Hãy dùng Đăng nhập để liên kết, không tạo lại tài khoản.");
          if (isRegister && String(data.get("pinConfirm")) !== pin) throw new Error("Hai mã PIN không khớp.");
          const auth = await cloud.authenticate({ username, pin, displayName: isRegister ? String(data.get("displayName") || "").trim() : existing?.displayName || username, register: isRegister, migrate: !isRegister && !!localPinOK });
          if (existing && !localPinOK) throw new Error("PIN cloud khác PIN của dữ liệu cục bộ cùng username. Hãy sao lưu dữ liệu cục bộ trước khi chuyển tài khoản; chưa có dữ liệu nào bị thay thế.");
          const hashed = await hashPin(pin), now = new Date().toISOString();
          const account = { ...existing, id: existing?.id || auth.account.id, ...auth.account, usernameKey,
            pinHash: hashed.hash, pinSalt: hashed.salt, createdAt: existing?.createdAt || now, updatedAt: now };
          // ID cục bộ cũ được giữ nguyên khi liên kết để không làm mất các sổ hiện có.
          account.id = existing?.id || auth.account.id;
          await put("accounts", account); await loginAccount(account, auth);
        } catch (error) {
          if (error.code === "NETWORK" && !isRegister && localPinOK && cached) {
            await loginAccount(existing); showToast("Đăng nhập dữ liệu đã lưu trên máy. Sẽ đồng bộ khi có mạng.");
          } else throw error;
        }
        return;
      }
      if (isRegister) {
        const displayName = String(data.get("displayName") || "").trim();
        const pinConfirm = String(data.get("pinConfirm") || "");
        if (!displayName) return showToast("Vui lòng nhập tên hiển thị.");
        if (pin !== pinConfirm) return showToast("Hai mã PIN không khớp.");
        const accounts = await getAll("accounts");
        if (accounts.some(a => a.usernameKey === usernameKey)) {
          return showToast("Username này đã được sử dụng.");
        }
        const hashed = await hashPin(pin);
        const account = {
          id: randomId(), displayName, username, usernameKey,
          pinHash: hashed.hash, pinSalt: hashed.salt, createdAt: new Date().toISOString()
        };
        await put("accounts", account);
        await loginAccount(account);
        showToast("Đã tạo tài khoản.");
      } else {
        const accounts = await getAll("accounts");
        const account = accounts.find(a => a.usernameKey === usernameKey);
        if (!account) return showToast("Không tìm thấy tài khoản.");
        const hashed = await hashPin(pin, account.pinSalt);
        if (hashed.hash !== account.pinHash) return showToast("Username hoặc mã PIN không đúng.");
        await loginAccount(account);
      }
      } finally { authBusy = false; submit.disabled = false; }
    }));
  }

  async function loginAccount(account, auth) {
    state.account = account;
    localStorage.setItem(SESSION_KEY, account.id);
    await loadSettings();
    await renderHome();
    if (cloud.enabled) await cloud.attach(account, auth);
  }
  async function logout() {
    if (state.saving) return showToast("Đang lưu dữ liệu, vui lòng chờ.");
    if (cloud.enabled) await cloud.logout();
    localStorage.removeItem(SESSION_KEY);
    state.account = null;
    state.currentHarvesterId = null;
    state.authMode = "login";
    renderAuth();
  }

  async function renderHome() {
    closePersonPicker(false);
    hideEntryDock();
    state.screen = "home";
    state.currentHarvesterId = null;
    const token = ++state.viewToken;
    const { harvesters, entries } = await getAccountData();
    if (token !== state.viewToken || state.screen !== "home") return;
    const query = normalizeUsername(state.search);
    const filtered = harvesters
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const listHTML = filtered.length ? filtered.map(person => {
      const dates = entries.filter(entry => entry.harvesterId === person.id).map(entry => entry.date).sort();
      const lastDate = dates.length ? dates[dates.length - 1] : "";
      const initial = [...person.name.trim()][0] || "•";
      return `
        <article class="person-row">
          <div class="person-avatar" style="--person-color:${personColor(person)}">${escapeHTML(initial.toLocaleUpperCase("vi-VN"))}</div>
          <div class="person-main" data-open-person="${escapeHTML(person.id)}">
            <p class="person-name" style="color:${personColor(person)}">${escapeHTML(person.name)}</p>
            <p class="person-date">${lastDate ? `Ghi gần nhất: ${formatDate(lastDate)}` : "Chưa có ghi chép"}</p>
          </div>
          <div class="person-tools">
            <button type="button" title="Thao tác với người hái" aria-label="Thao tác với ${escapeHTML(person.name)}" data-person-menu="${escapeHTML(person.id)}">${UI.icon("more")}</button>
          </div>
        </article>`;
    }).join("") : `
      <div class="empty-state">
        <strong>${query ? "Không tìm thấy người hái" : "Chưa có người hái nào"}</strong>
        ${query ? "Thử tìm bằng tên khác." : "Nhấn dấu cộng để thêm người đầu tiên."}
      </div>`;
    const searchInput = $("#person-search"), keepSearchFocus = document.activeElement === searchInput && !!searchInput;
    const searchCaret = keepSearchFocus ? searchInput.selectionStart : null;
    parkEntryDock();
    app.innerHTML = `
      <header class="topbar">
        <div class="brand">
          <div class="brand-mark">SG</div>
          <div><h1>Sổ ghi công hái</h1><small>${escapeHTML(state.account.displayName)}</small></div>
        </div>
        <div class="top-actions">
          <button class="icon-button" id="home-menu" aria-label="Menu chính">${UI.icon("more")}</button>
        </div>
      </header>
      <main class="page-wrap">
        <div class="search-row">
          <div class="search-box"><span>⌕</span><input id="person-search" type="search" placeholder="Tìm tên người hái..." value="${escapeHTML(state.search)}"></div>
        </div>
        <section class="person-list">${listHTML}</section>
        <div id="person-search-empty" class="empty-state" hidden><strong>Không tìm thấy người hái</strong>Thử tìm bằng tên khác.</div>
        ${connectionHTML()}
      </main>
      <button class="fab" id="add-person-fab" aria-label="Thêm người hái">＋</button>`;
    function filterPeople() {
      const query = normalizeUsername(state.search), rows = [...app.querySelectorAll(".person-row")];
      rows.forEach(row => row.hidden = !normalizeUsername($(".person-name", row).textContent).includes(query));
      $("#person-search-empty").hidden = !rows.length || rows.some(row => !row.hidden);
    }
    filterPeople();
    if (keepSearchFocus) {
      const input = $("#person-search");
      input.focus({ preventScroll: true });
      if (searchCaret !== null) input.setSelectionRange(searchCaret, searchCaret);
    }
    $("#person-search").addEventListener("input", event => { state.search = event.target.value; filterPeople(); });
    $("#add-person-fab").addEventListener("click", openAddPerson);
    $("#home-menu").addEventListener("click", openHomeMenu);
    app.querySelectorAll("[data-open-person]").forEach(node => node.addEventListener("click", () => {
      state.currentHarvesterId = node.dataset.openPerson;
      state.currentDate = todayISO();
      showEntryDock(false);
      run(renderBook)();
    }));
    app.querySelectorAll("[data-person-menu]").forEach(node => node.addEventListener("click", run(() => openPersonMenu(node.dataset.personMenu))));
  }

  function openAddPerson() {
    showModal("Thêm người hái", `
      <div class="form-field"><label for="person-name">Tên người hái</label><input id="person-name" name="name" maxlength="80" placeholder="Nhập họ tên..." required autofocus></div>
    `, `<button type="button" class="secondary-button" data-cancel>Hủy</button><button type="submit" class="primary-button">Lưu người</button>`, async data => {
      const name = String(data.get("name") || "").trim().replace(/\s+/g, " ");
      if (!name) throw new Error("Vui lòng nhập tên người hái.");
      const { harvesters } = await getAccountData();
      if (harvesters.some(p => normalizeUsername(p.name) === normalizeUsername(name))) {
        throw new Error("Tên người hái này đã có trong danh sách.");
      }
      await put("harvesters", { id: randomId(), accountId: state.account.id, name, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
      await renderHome();
      showToast("Đã thêm người hái.");
    });
    $("[data-cancel]").addEventListener("click", closeModal);
    $("#person-name").focus();
  }
  async function editPerson(id) {
    const person = await getOne("harvesters", id);
    if (!person || person.accountId !== state.account.id) return;
    showModal("Sửa tên người hái", `
      <div class="form-field"><label for="person-name">Tên người hái</label><input id="person-name" name="name" maxlength="80" value="${escapeHTML(person.name)}" required></div>
    `, `<button type="button" class="secondary-button" data-cancel>Hủy</button><button type="submit" class="primary-button">Lưu thay đổi</button>`, async data => {
      const name = String(data.get("name") || "").trim().replace(/\s+/g, " ");
      if (!name) throw new Error("Tên không được để trống.");
      const { harvesters } = await getAccountData();
      if (harvesters.some(p => p.id !== id && normalizeUsername(p.name) === normalizeUsername(name))) {
        throw new Error("Tên người hái này đã được sử dụng.");
      }
      await transaction(["harvesters"], "readwrite", async (tx, request) => {
        const latest = await request(tx.objectStore("harvesters").get(id));
        if (!latest || latest.accountId !== state.account.id) throw new Error("Không tìm thấy người hái.");
        tx.objectStore("harvesters").put({ ...latest, name, updatedAt: new Date().toISOString() });
      });
      await renderHome();
      showToast("Đã cập nhật tên.");
    });
    $("[data-cancel]").addEventListener("click", closeModal);
  }
  async function deletePerson(id) {
    const person = await getOne("harvesters", id);
    if (!person || person.accountId !== state.account.id) return;
    const { entries, settlements, advances } = await getAccountData();
    if (settlements.some(s => s.harvesterId === id)) return showToast("Người này có lịch sử kết sổ, không thể xóa để bảo toàn kết toán.");
    const count = entries.filter(x => x.harvesterId === id).length;
    const confirmed = window.confirm(`XÓA VĨNH VIỄN "${person.name}"?\n\nToàn bộ ${count} lần ghi kg và ${advances.filter(a => a.harvesterId === id).length} khoản ứng chưa kết toán sẽ bị xóa. Nên sao lưu trước. Không thể hoàn tác.`);
    if (!confirmed) return;
    const accountId = state.account.id;
    await transaction(Object.values(STORE_NAMES), "readwrite", async (tx, request) => {
      const data = await readData(tx, request, accountId);
      if (data.settlements.some(s => s.harvesterId === id)) throw new Error("Người này vừa được kết sổ, không thể xóa.");
      if (!data.harvesters.some(p => p.id === id)) throw new Error("Không tìm thấy người hái.");
      for (const [key, store] of Object.entries(STORE_NAMES)) {
        for (const row of data[key]) if (key === "harvesters" ? row.id === id : row.harvesterId === id) tx.objectStore(store).delete(row.id);
      }
    });
    for (const key of state.drafts.keys()) if (JSON.parse(key)[1] === id) state.drafts.delete(key);
    await renderHome();
    showToast("Đã xóa người hái và toàn bộ lịch sử.");
  }

  let dateFlipBusy = false;
  let gridObserver;
  function parkEntryDock() {
    if (app.contains(entryDock)) document.body.appendChild(entryDock);
  }
  async function changeDate(value, direction = 0) {
    closePersonPicker();
    if (!Ledger.isDate(value) || state.saving || dateFlipBusy) return;
    const context = bookContext();
    dateFlipBusy = true;
    try {
      const paper = $("#book-paper");
      if (direction && paper && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
        paper.classList.remove("flip-in-next", "flip-in-prev");
        paper.classList.add(direction > 0 ? "flip-out-next" : "flip-out-prev");
        await new Promise(resolve => setTimeout(resolve, 190));
      }
      if (!sameBook(context)) return;
      state.currentDate = value;
      await renderBook();
      const newPaper = $("#book-paper");
      if (direction && newPaper) {
        const cls = direction > 0 ? "flip-in-next" : "flip-in-prev";
        newPaper.classList.add(cls);
        setTimeout(() => newPaper.classList.remove(cls), 400);
      }
    } finally { dateFlipBusy = false; }
  }
  async function flipToDate(direction) {
    return changeDate(shiftDate(state.currentDate, direction), direction);
  }
  async function renderBook() {
    closePersonPicker(false);
    state.screen = "book";
    const token = ++state.viewToken;
    const context = bookContext();
    const data = await getAccountData(context.accountId);
    if (token !== state.viewToken || !sameBook(context)) return;
    const person = data.harvesters.find(p => p.id === context.harvesterId);
    if (!person) return renderHome();
    state.bookData = data;
    parkEntryDock();
    gridObserver?.disconnect();
    app.innerHTML = `
      <header class="topbar book-topbar" style="--person-color:${personColor(person)}">
        <button class="icon-button" id="back-home" aria-label="Quay lại">‹</button>
        <button type="button" class="book-title book-person-toggle" id="book-person-toggle" aria-label="Chuyển người, đang mở sổ ${escapeHTML(person.name)}" aria-expanded="false" aria-controls="soghi-person-picker"><span><strong>${escapeHTML(person.name)}</strong><small>Sổ ghi sản lượng</small></span>${UI.icon("down")}</button>
        <button class="icon-button" id="book-menu" aria-label="Menu sổ">${UI.icon("more")}</button>
      </header>
      <div class="date-tools">
        <button class="day-button" id="previous-day" aria-label="Ngày trước">‹</button>
        ${UI.dateField({ id: "book-date", value: context.date, label: "Chọn ngày ghi sổ" })}
        <button class="day-button" id="next-day" aria-label="Ngày sau">›</button>
      </div>
      <main class="book-wrap">
        <section class="book-paper" id="book-paper">
          <div class="paper-caption"><span>NGÀY ${formatDate(context.date)}</span><strong id="day-count"></strong></div>
          <div class="notebook-grid-wrap"><div class="notebook-grid"></div></div>
          <div class="summary-rule"></div>
          <div class="summary-row">
            <div class="summary-item"><span class="summary-label">SỐ LẦN</span><span class="summary-value" id="summary-count"></span></div>
            <div class="summary-item"><span class="summary-label">TỔNG KG</span><span class="summary-value" id="summary-kg"></span></div>
          </div>
          <div class="book-note">Số đang gõ có viền xanh, chưa tính vào tổng. Chạm số đã lưu để sửa.</div>
        </section>
        ${connectionHTML()}
      </main>`;
    $("#book-menu").insertAdjacentElement("beforebegin", entryDock);
    UI.bindDates(app);
    showEntryDock(false);
    $("#back-home").addEventListener("click", run(async () => {
      if (state.saving) return showToast("Đang lưu, vui lòng chờ.");
      await renderHome();
    }));
    $("#book-menu").addEventListener("click", run(openBookMenu));
    $("#book-person-toggle").addEventListener("click", togglePersonPicker);
    $("#book-date").addEventListener("change", run(event => changeDate(event.target.value)));
    $("#previous-day").addEventListener("click", run(() => flipToDate(-1)));
    $("#next-day").addEventListener("click", run(() => flipToDate(1)));
    $(".notebook-grid").addEventListener("click", run(event => {
      if (state.saving) return;
      const cell = event.target.closest("button");
      if (!cell) return;
      const entry = state.bookData.entries.find(e => e.id === cell.dataset.entryId);
      if (entry && Ledger.lockedIds(state.bookData).has(entry.id)) {
        return showToast("Số này đã kết sổ, không thể sửa hoặc xóa.");
      }
      const d = draft();
      if (entry) { d.value = String(entry.kg).replace(".", ","); d.entryId = entry.id; d.replace = true; }
      else if (!cell.hasAttribute("data-draft")) { d.value = ""; d.entryId = null; d.replace = false; }
      setVirtualKeyboard(true);
      renderGrid();
      scrollToDraft();
    }));
    const paper = $("#book-paper");
    let swipeStart = null;
    paper.addEventListener("touchstart", event => {
      swipeStart = null;
      if (event.touches.length > 1 || event.target.closest(".notebook-grid-wrap, button, input, select, a")) return;
      const t = event.changedTouches[0]; swipeStart = { x: t.clientX, y: t.clientY };
    }, { passive: true });
    paper.addEventListener("touchend", run(event => {
      if (!swipeStart) return;
      const t = event.changedTouches[0], dx = t.clientX - swipeStart.x, dy = t.clientY - swipeStart.y;
      swipeStart = null;
      if (Math.abs(dx) > 65 && Math.abs(dx) > Math.abs(dy) * 1.25) return flipToDate(dx < 0 ? 1 : -1);
    }), { passive: true });
    paper.addEventListener("touchcancel", () => { swipeStart = null; }, { passive: true });
    renderBookContent();
    if ("ResizeObserver" in window) {
      let width = 0;
      gridObserver = new ResizeObserver(items => {
        const w = Math.round(items[0].contentRect.width);
        if (w !== width) { width = w; renderGrid(); }
      });
      gridObserver.observe($(".notebook-grid-wrap"));
    }
  }
  async function refreshBook(context = bookContext()) {
    const token = state.viewToken;
    const data = await getAccountData(context.accountId);
    if (sameBook(context) && token === state.viewToken) { state.bookData = data; renderBookContent(); }
  }
  function renderBookContent() {
    if (state.screen !== "book" || !state.bookData || !$(".notebook-grid")) return;
    renderGrid();
    const person = state.bookData.harvesters.find(p => p.id === state.currentHarvesterId);
    if (person) {
      $(".book-topbar").style.setProperty("--person-color", personColor(person));
      $("#book-person-toggle strong").textContent = person.name;
      $("#book-person-toggle").setAttribute("aria-label", "Chuyển người, đang mở sổ " + person.name);
    }
    if (state.picker) renderPersonPicker();
  }
  function renderGrid() {
    const grid = $(".notebook-grid");
    if (!grid || state.screen !== "book" || !state.bookData) return;
    const entries = state.bookData.entries.filter(e => e.harvesterId === state.currentHarvesterId && e.date === state.currentDate).sort(Ledger.order);
    const locked = Ledger.lockedIds(state.bookData), d = draft();
    if (d.entryId && (!entries.some(e => e.id === d.entryId) || locked.has(d.entryId))) {
      d.entryId = null; d.value = ""; d.replace = false;
    }
    const width = $(".notebook-grid-wrap").clientWidth;
    const base = width < 340 ? 4 : 5;
    const hasDraft = !d.entryId && (d.value !== "" || !virtualKeyboard.hidden);
    const columns = Math.max(base, Math.ceil((entries.length + (hasDraft ? 1 : 0)) / 7));
    grid.style.setProperty("--columns", columns);
    const cells = [];
    for (let i = 0; i < columns * 7; i++) {
      const entry = entries[i];
      const active = entry ? entry.id === d.entryId : hasDraft && i === entries.length;
      const cls = active ? "entry-cell draft-cell" : entry ? `entry-cell${locked.has(entry.id) ? " settled-cell" : ""}` : "empty-cell";
      const value = active ? (d.value || "…") : entry ? formatNumber(entry.kg) : "";
      const label = active ? "Số đang nhập, chưa lưu" : entry ? formatNumber(entry.kg) + " kg" + (locked.has(entry.id) ? ", đã kết sổ" : "") : "Nhập số kg";
      cells.push(`<button type="button" class="${cls}" ${entry ? `data-entry-id="${escapeHTML(entry.id)}"` : "data-add-entry"} ${active ? "data-draft" : ""} aria-label="${escapeHTML(label)}">${escapeHTML(value)}</button>`);
    }
    grid.innerHTML = cells.join("");
    $("#day-count").textContent = entries.length + " lần ghi";
    $("#summary-count").textContent = entries.length;
    const total = entries.reduce((s, e) => s + Ledger.kg100(e.kg), 0) / 100;
    $("#summary-kg").innerHTML = `${formatNumber(total)} <small>kg</small>`;
    $("#soghi-live-summary").textContent = `Đã lưu: ${entries.length} lần\nTổng: ${formatNumber(total)} kg`;
    showKgDisplay();
  }
  function showEntryDock(openKeyboard = false) {
    entryDock.hidden = false;
    document.body.classList.add("entry-active");
    if (openKeyboard) setVirtualKeyboard(true);
  }
  function setVirtualKeyboard(open) {
    virtualKeyboard.hidden = !open;
    keyboardToggle.setAttribute("aria-expanded", String(open));
    keyboardToggle.setAttribute("aria-label", open ? "Đóng bàn phím nhập kg" : "Mở bàn phím nhập kg");
    document.body.classList.toggle("keyboard-open", open);
    updateKeyboardSpace();
    if (state.screen === "book") { renderGrid(); if (open) scrollToDraft(); }
  }
  function updateKeyboardSpace() {
    state.keyboardHeight = virtualKeyboard.hidden ? 0 : Math.ceil(virtualKeyboard.getBoundingClientRect().height);
    document.body.style.setProperty("--soghi-keyboard-height", state.keyboardHeight + "px");
  }
  function hideEntryDock() {
    entryDock.hidden = true;
    virtualKeyboard.hidden = true;
    document.body.classList.remove("entry-active", "keyboard-open");
    keyboardToggle.setAttribute("aria-expanded", "false");
    keyboardToggle.setAttribute("aria-label", "Mở bàn phím nhập kg");
    updateKeyboardSpace();
  }
  function showKgDisplay() {
    if (state.screen !== "book") return;
    const d = draft();
    $("#soghi-kg-display").textContent = d.value || "Chưa nhập";
    $("#soghi-entry-mode").textContent = d.entryId ? "Đang sửa · chưa lưu" : "Số mới · ENTER để lưu";
    $("#soghi-delete-entry").hidden = !d.entryId;
    $("#soghi-cancel-entry").hidden = !d.entryId && !d.value;
  }
  function scrollToDraft() {
    requestAnimationFrame(() => {
      const cell = $("[data-draft]");
      if (!cell || virtualKeyboard.hidden || modal.open) return;
      const wrap = $(".notebook-grid-wrap"), r = cell.getBoundingClientRect(), w = wrap.getBoundingClientRect();
      if (r.right > w.right) wrap.scrollLeft += r.right - w.right + 8;
      if (r.left < w.left) wrap.scrollLeft += r.left - w.left - 8;
      const bottom = virtualKeyboard.getBoundingClientRect().top - 12;
      const top = ($(".book-topbar")?.getBoundingClientRect().bottom || 0) + 8;
      if (r.bottom > bottom) window.scrollBy(0, r.bottom - bottom);
      else if (r.top < top) window.scrollBy(0, r.top - top);
    });
  }
  function appendVirtualKey(key) {
    if (state.saving || state.screen !== "book") return;
    const d = draft();
    if (d.replace && key !== "backspace") d.value = "";
    d.replace = false;
    if (key === "backspace") d.value = d.value.slice(0, -1);
    else if (key === "decimal") { if (!d.value.includes(",")) d.value = (d.value || "0") + ","; }
    else if (/^\d$/.test(key) && d.value.length < 9) {
      const parts = d.value.split(",");
      if (parts.length === 1 ? parts[0].length < 6 : parts[1].length < 2) d.value += key;
    }
    renderGrid(); scrollToDraft();
  }
  function parseKg(value) {
    const normalized = String(value ?? "").trim().replace(",", ".");
    if (!/^\d+(\.\d{1,2})?$/.test(normalized)) return null;
    try { Ledger.kg100(Number(normalized)); return Number(normalized); } catch { return null; }
  }
  function setEntryBusy(busy) {
    state.saving = busy;
    virtualKeyboard.querySelectorAll("button").forEach(b => b.disabled = busy);
    keyboardToggle.disabled = busy;
    $("#book-date")?.toggleAttribute("disabled", busy);
  }
  async function submitVirtualKg() {
    if (state.saving || !state.account || state.screen !== "book" || modal.open) return;
    const context = bookContext(), current = draft(), kg = parseKg(current.value);
    if (kg === null) return showToast("Nhập số kg hợp lệ, tối đa 2 số lẻ; ô trống chưa được lưu.");
    const entryId = current.entryId, value = current.value;
    setEntryBusy(true);
    try {
      await transaction(["entries", "harvesters", "soghi_settlements"], "readwrite", async (tx, request) => {
        const person = await request(tx.objectStore("harvesters").get(context.harvesterId));
        if (!person || person.accountId !== context.accountId) throw new Error("Người hái không còn tồn tại.");
        const settlements = await request(tx.objectStore("soghi_settlements").index("accountId").getAll(context.accountId));
        const now = new Date().toISOString();
        if (entryId) {
          const entry = await request(tx.objectStore("entries").get(entryId));
          if (!entry || entry.accountId !== context.accountId || entry.harvesterId !== context.harvesterId || entry.date !== context.date) throw new Error("Số kg không thuộc trang đang sửa.");
          if (Ledger.lockedIds({ settlements }).has(entryId)) throw new Error("Số này vừa được kết sổ, không thể sửa.");
          tx.objectStore("entries").put({ ...entry, kg, updatedAt: now });
        } else tx.objectStore("entries").add({ id: randomId(), ...context, kg, createdAt: now, updatedAt: now });
      });
      const savedDraft = state.drafts.get(draftKey(context));
      if (savedDraft?.entryId === entryId && savedDraft.value === value) state.drafts.delete(draftKey(context));
      await refreshBook(context);
      if (sameBook(context)) { showToast(entryId ? "Đã sửa số kg." : "Đã ghi " + formatNumber(kg) + " kg."); scrollToDraft(); }
    } catch (error) { showToast(error.message || "Chưa lưu được số kg. Số đang nhập vẫn được giữ lại."); }
    finally { setEntryBusy(false); }
  }
  async function deleteCurrentEntry() {
    if (state.saving || !draft().entryId) return;
    const context = bookContext(), id = draft().entryId;
    if (!window.confirm("Xóa số kg đang chọn?")) return;
    setEntryBusy(true);
    try {
      await transaction(["entries", "soghi_settlements"], "readwrite", async (tx, request) => {
        const e = await request(tx.objectStore("entries").get(id));
        const settlements = await request(tx.objectStore("soghi_settlements").index("accountId").getAll(context.accountId));
        if (!e || e.accountId !== context.accountId || e.harvesterId !== context.harvesterId || e.date !== context.date) throw new Error("Không tìm thấy số kg.");
        if (Ledger.lockedIds({ settlements }).has(id)) throw new Error("Số đã kết sổ không thể xóa.");
        tx.objectStore("entries").delete(id);
      });
      state.drafts.delete(draftKey(context)); await refreshBook(context); showToast("Đã xóa số kg.");
    } finally { setEntryBusy(false); }
  }
  keyboardToggle.addEventListener("click", () => {
    if (state.picker) { const wasOpen = state.picker.keyboardOpen; closePersonPicker(false); setVirtualKeyboard(!wasOpen); }
    else setVirtualKeyboard(virtualKeyboard.hidden);
  });
  virtualKeyboard.querySelectorAll("[data-key]").forEach(button => button.addEventListener("click", run(() => {
    const key = button.dataset.key;
    return key === "enter" ? submitVirtualKg() : appendVirtualKey(key);
  })));
  $("#soghi-delete-entry").addEventListener("click", run(deleteCurrentEntry));
  $("#soghi-cancel-entry").addEventListener("click", () => {
    if (state.saving) return;
    state.drafts.delete(draftKey()); renderGrid(); scrollToDraft();
  });
  if ("ResizeObserver" in window) new ResizeObserver(() => { updateKeyboardSpace(); if (!virtualKeyboard.hidden) scrollToDraft(); }).observe(virtualKeyboard);

  function modalCancel() { $("[data-cancel]")?.addEventListener("click", closeModal); }
  function standardActions(label = "Lưu") {
    return `<button type="button" class="secondary-button" data-cancel>Đóng</button><button type="submit" class="primary-button">${label}</button>`;
  }
  async function updateVisibleData() {
    if (state.screen === "book") await refreshBook();
    else if (state.screen === "home") await renderHome();
    else if (state.screen === "statistics") await refreshStatistics();
  }
  async function openStatistics(options = {}) {
    closePersonPicker();
    toastNode.classList.remove("show"); clearTimeout(state.toastTimer);
    const fromBook = state.screen === "book";
    state.statsReturn = fromBook ? { screen: "book", ...bookContext(), keyboardOpen: options.returnKeyboard ?? !virtualKeyboard.hidden } : { screen: "home" };
    if (!state.statistics) state.statistics = { personId: "all", preset: "today", from: todayISO(), to: todayISO(), view: "table", group: fromBook ? "day" : "person" };
    if (options.personId) {
      Object.assign(state.statistics, { personId: options.personId, preset: fromBook && state.currentDate !== todayISO() ? "range" : "today", from: fromBook ? state.currentDate : todayISO(), to: fromBook ? state.currentDate : todayISO() });
    }
    await renderStatistics();
  }
  async function renderStatistics() {
    hideEntryDock(); parkEntryDock(); gridObserver?.disconnect();
    state.screen = "statistics";
    const token = ++state.viewToken, accountId = state.account.id, data = await getAccountData(accountId);
    if (state.screen !== "statistics" || token !== state.viewToken || accountId !== state.account?.id) return;
    state.statsData = data;
    const f = state.statistics;
    if (f.personId !== "all" && !data.harvesters.some(p => p.id === f.personId)) f.personId = "all";
    app.innerHTML = `
      <header class="topbar statistics-topbar"><button class="icon-button" id="back-statistics" aria-label="Quay lại">${UI.icon("back")}</button><div class="book-title"><h1>Thống kê</h1><small>Sản lượng của đội và từng người</small></div></header>
      <main class="stats-wrap">
        <section class="stats-filters" aria-label="Bộ lọc thống kê">
          <div class="stats-filter-row">
            <div class="form-field"><label for="stats-person">Xem sản lượng</label><select id="stats-person"><option value="all">Cả đội</option>${data.harvesters.map(p => `<option value="${escapeHTML(p.id)}" ${f.personId === p.id ? "selected" : ""}>${escapeHTML(p.name)}</option>`).join("")}</select></div>
            <div class="form-field"><label for="stats-period">Thời gian</label><select id="stats-period"><option value="today" ${f.preset === "today" ? "selected" : ""}>Hôm nay</option><option value="range" ${f.preset === "range" ? "selected" : ""}>Khoảng ngày</option><option value="all" ${f.preset === "all" ? "selected" : ""}>Toàn bộ</option></select></div>
          </div>
          <div id="stats-dates" class="date-range" ${f.preset !== "range" ? "hidden" : ""}>
            <div class="form-field"><label for="stats-from">Từ ngày</label>${UI.dateField({ id: "stats-from", value: f.from, label: "Thống kê từ ngày", required: true })}</div>
            <div class="form-field"><label for="stats-to">Đến ngày</label>${UI.dateField({ id: "stats-to", value: f.to, label: "Thống kê đến ngày", required: true })}</div>
          </div>
        </section>
        <section class="stats-summary" aria-label="Tổng sản lượng đã lưu"><span class="summary-label">TỔNG SẢN LƯỢNG</span><strong id="stats-total">0 <small>kg</small></strong><div class="stats-summary-details"><span><strong id="stats-count">0</strong> lần ghi</span><span><strong id="stats-people">0</strong> người có ghi chép</span></div></section>
        <section class="stats-output" aria-label="Chi tiết thống kê">
          <div class="stats-presentation"><div class="stats-view-switch" role="group" aria-label="Cách hiển thị"><button type="button" data-stats-view="table">Bảng số liệu</button><button type="button" data-stats-view="chart">${UI.icon("chart")} Biểu đồ</button></div>
            <div class="form-field stats-group-field"><label for="stats-group">Nhóm theo</label><select id="stats-group"><option value="person" ${f.group === "person" ? "selected" : ""}>Theo người</option><option value="day" ${f.group === "day" ? "selected" : ""}>Theo ngày</option></select></div>
          </div>
          <p id="stats-description" class="stats-description"></p><div id="stats-result" aria-live="polite"></div>
          <p class="form-hint" id="stats-note"></p>
        </section>
        ${connectionHTML()}
      </main>`;
    window.scrollTo(0, 0);
    UI.bindDates(app);
    $("#back-statistics").addEventListener("click", run(async () => {
      const target = state.statsReturn;
      if (target?.screen === "book" && target.accountId === state.account.id) {
        state.currentHarvesterId = target.harvesterId; state.currentDate = target.date;
        await renderBook(); if (state.screen === "book") setVirtualKeyboard(target.keyboardOpen);
      } else await renderHome();
    }));
    $("#stats-person").addEventListener("change", event => { f.personId = event.target.value; renderStatisticsResults(); });
    $("#stats-period").addEventListener("change", event => { f.preset = event.target.value; $("#stats-dates").hidden = f.preset !== "range"; renderStatisticsResults(); });
    for (const key of ["from", "to"]) $("#stats-" + key).addEventListener("change", event => { f[key] = event.target.value; renderStatisticsResults(); });
    $("#stats-group").addEventListener("change", event => { f.group = event.target.value; renderStatisticsResults(); });
    app.querySelectorAll("[data-stats-view]").forEach(button => button.addEventListener("click", () => { f.view = button.dataset.statsView; renderStatisticsResults(); }));
    function showColumn(event) {
      const target = event.target.closest("[data-chart-index]");
      if (!target || (event.type === "keydown" && !["Enter", " "].includes(event.key))) return;
      if (event.type === "keydown") event.preventDefault();
      const row = state.statsResult?.rows[Number(target.dataset.chartIndex)];
      if (!row) return;
      $("#stats-chart-detail").textContent = `${row.label}: ${formatNumber(row.kg100 / 100)} kg · ${row.count} lần ghi`;
      $("#stats-result").querySelectorAll("[data-chart-index]").forEach(node => { node.classList.toggle("chart-selected", node === target); node.setAttribute("aria-pressed", String(node === target)); });
    }
    $("#stats-result").addEventListener("click", showColumn);
    $("#stats-result").addEventListener("keydown", showColumn);
    renderStatisticsResults();
  }
  async function refreshStatistics() {
    const accountId = state.account.id, token = state.viewToken, data = await getAccountData(accountId);
    if (state.screen !== "statistics" || token !== state.viewToken || state.account?.id !== accountId) return;
    state.statsData = data;
    const f = state.statistics;
    if (f.personId !== "all" && !data.harvesters.some(p => p.id === f.personId)) f.personId = "all";
    $("#stats-person").innerHTML = `<option value="all">Cả đội</option>${data.harvesters.map(p => `<option value="${escapeHTML(p.id)}">${escapeHTML(p.name)}</option>`).join("")}`;
    $("#stats-person").value = f.personId;
    renderStatisticsResults();
  }
  function renderStatisticsResults() {
    if (state.screen !== "statistics" || !state.statsData || !$("#stats-result")) return;
    const f = state.statistics, data = state.statsData;
    let from = "", to = "";
    if (f.preset === "today") from = to = todayISO();
    if (f.preset === "range") { from = f.from; to = f.to; }
    app.querySelectorAll("[data-stats-view]").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.statsView === f.view)));
    const who = f.personId === "all" ? "Cả đội" : data.harvesters.find(p => p.id === f.personId)?.name || "Người hái";
    $("#stats-description").textContent = `${who} · ${f.preset === "all" ? "Toàn bộ thời gian" : from === to ? UI.dateText(from) : `${UI.dateText(from)} – ${UI.dateText(to)}`}`;
    try {
      if (f.preset === "range" && (!Ledger.isDate(from) || !Ledger.isDate(to))) throw new Error("Chọn đầy đủ ngày bắt đầu và ngày kết thúc.");
      const result = UI.summarize(data, { ...f, from, to, defaultColor: personColor(null) });
      state.statsResult = result;
      $("#stats-total").innerHTML = `${formatNumber(result.kg100 / 100)} <small>kg</small>`;
      $("#stats-count").textContent = result.count; $("#stats-people").textContent = result.peopleCount;
      $("#stats-note").textContent = (f.group === "day" ? "Chỉ liệt kê ngày có ghi chép. " : "") + "Tính số đã lưu, gồm cả phần đã kết sổ. Không tính bản nháp.";
      if (!result.count) { $("#stats-result").innerHTML = '<div class="empty-state"><strong>Chưa có sản lượng đã lưu</strong>Thử chọn người hoặc khoảng ngày khác.</div>'; return; }
      if (f.view === "chart") {
        const width = $("#stats-result").clientWidth;
        $("#stats-result").innerHTML = `<div class="stats-chart" id="stats-chart">${UI.chart(result, width)}</div><div class="stats-chart-detail" id="stats-chart-detail" role="status">Chạm một cột để xem chi tiết. Vuốt ngang nếu có nhiều cột.</div>`;
      } else {
        $("#stats-result").innerHTML = `<div class="ledger-table-wrap"><table class="ledger-table stats-table"><caption class="sr-only">Sản lượng theo ${f.group === "day" ? "ngày" : "người"}</caption><thead><tr><th>${f.group === "day" ? "Ngày" : "Người hái"}</th><th>Số lần</th><th>Tổng kg</th></tr></thead><tbody>${result.rows.map(row => `<tr><td>${f.group === "person" ? `<span class="stats-person-dot" style="background:${row.color}" aria-hidden="true"></span>` : ""}${escapeHTML(row.label)}</td><td>${row.count}</td><td>${formatNumber(row.kg100 / 100)}</td></tr>`).join("")}</tbody></table></div>`;
      }
    } catch (error) {
      state.statsResult = null;
      $("#stats-total").textContent = "—"; $("#stats-count").textContent = "—"; $("#stats-people").textContent = "—";
      $("#stats-note").textContent = "";
      $("#stats-result").innerHTML = `<p class="stats-error" role="alert">${escapeHTML(error.message)}</p>`;
    }
  }
  async function openRates(editId = null) {
    const accountId = state.account.id, data = await getAccountData(accountId);
    const editing = data.rates.find(r => r.id === editId);
    const people = new Map(data.harvesters.map(p => [p.id, p.name]));
    const sorted = [...data.rates].sort((a, b) => b.effectiveDate.localeCompare(a.effectiveDate));
    showModal("Đơn giá công hái", `
      <p class="form-hint">Giá có hiệu lực từ ngày chọn đến khi có mức mới. Giá riêng được ưu tiên hơn giá chung. Thay đổi giá chỉ ảnh hưởng phần chưa kết sổ.</p>
      <div class="form-field"><label for="rate-scope">Áp dụng cho</label><select id="rate-scope" name="scope">
        <option value="">Tất cả người hái (giá chung)</option>
        ${data.harvesters.map(p => `<option value="${escapeHTML(p.id)}" ${editing?.harvesterId === p.id ? "selected" : ""}>${escapeHTML(p.name)} (giá riêng)</option>`).join("")}
      </select></div>
      <div class="form-field"><label for="rate-date">Bắt đầu áp dụng từ ngày</label>${UI.dateField({ id: "rate-date", name: "date", value: editing?.effectiveDate || state.currentDate || todayISO(), label: "Ngày bắt đầu áp dụng đơn giá", required: true })}</div>
      <div class="form-field"><label for="rate-amount">Đơn giá (đồng/kg)</label><input id="rate-amount" name="amount" type="text" inputmode="numeric" pattern="[0-9]+" maxlength="9" value="${editing?.amount ?? ""}" placeholder="Ví dụ: 2500" required></div>
      <h3 class="section-label">Các mức giá đã đặt</h3>
      <div class="ledger-list">${sorted.length ? sorted.map(r => `<div class="ledger-item">
        <div><strong>${money(r.amount)}/kg</strong><small>Từ ${dateLabel(r.effectiveDate)} · ${escapeHTML(r.harvesterId ? people.get(r.harvesterId) || "Người hái" : "Giá chung")}</small></div>
        <div class="ledger-tools"><button type="button" data-rate-edit="${escapeHTML(r.id)}" aria-label="Sửa đơn giá">Sửa</button><button type="button" data-rate-delete="${escapeHTML(r.id)}" aria-label="Xóa đơn giá">Xóa</button></div>
      </div>`).join("") : `<p class="form-hint">Chưa có đơn giá. Đặt ngày bắt đầu đủ sớm để tính các ngày đã ghi.</p>`}</div>`, standardActions(editing ? "Lưu thay đổi" : "Thêm đơn giá"), async form => {
      const scope = String(form.get("scope") || "") || null, effectiveDate = String(form.get("date") || "");
      const amount = moneyInput(form.get("amount"), true, 100000000);
      if (!Ledger.isDate(effectiveDate)) throw new Error("Ngày áp dụng không hợp lệ.");
      await transaction(["soghi_rates", "harvesters"], "readwrite", async (tx, request) => {
        if (scope) { const p = await request(tx.objectStore("harvesters").get(scope)); if (!p || p.accountId !== accountId) throw new Error("Người hái không tồn tại."); }
        const rates = await request(tx.objectStore("soghi_rates").index("accountId").getAll(accountId));
        if (rates.some(r => r.id !== editing?.id && r.harvesterId === scope && r.effectiveDate === effectiveDate)) throw new Error("Đã có đơn giá cho ngày và đối tượng này. Hãy chọn Sửa.");
        const original = editing && rates.find(r => r.id === editing.id);
        if (editing && !original) throw new Error("Đơn giá vừa bị thay đổi ở tab khác. Mở lại danh sách.");
        const now = new Date().toISOString();
        tx.objectStore("soghi_rates").put({ id: original?.id || randomId(), accountId, harvesterId: scope, effectiveDate, amount, createdAt: original?.createdAt || now, updatedAt: now });
      });
      await updateVisibleData(); await openRates(); showToast("Đã lưu đơn giá."); return false;
    });
    modalCancel();
    modalBody.querySelectorAll("[data-rate-edit]").forEach(b => b.addEventListener("click", run(() => openRates(b.dataset.rateEdit))));
    modalBody.querySelectorAll("[data-rate-delete]").forEach(b => b.addEventListener("click", run(async () => {
      if (!window.confirm("Xóa mức giá này? Phần chưa kết sổ sẽ tính lại theo giá còn lại. Lịch sử đã chốt được giữ nguyên.")) return;
      await transaction(["soghi_rates"], "readwrite", async (tx, request) => {
        const r = await request(tx.objectStore("soghi_rates").get(b.dataset.rateDelete));
        if (r?.accountId === accountId) tx.objectStore("soghi_rates").delete(r.id);
      });
      await updateVisibleData(); await openRates(); showToast("Đã xóa đơn giá.");
    })));
  }
  async function openAdvance(harvesterId, editId = null) {
    const accountId = state.account.id, data = await getAccountData(accountId);
    const person = data.harvesters.find(p => p.id === harvesterId);
    if (!person) throw new Error("Không tìm thấy người hái.");
    const editing = data.advances.find(a => a.id === editId);
    if (editing && Ledger.allocations(data).get(editing.id)) throw new Error("Khoản ứng đã khấu trừ không thể sửa hoặc xóa.");
    showModal(editing ? "Sửa khoản ứng" : "Ghi ứng tiền", `
      <p class="form-hint">Người hái: <strong>${escapeHTML(person.name)}</strong></p>
      <div class="form-field"><label for="advance-date">Ngày ứng</label>${UI.dateField({ id: "advance-date", name: "date", value: editing?.date || state.currentDate || todayISO(), label: "Ngày ứng tiền", required: true })}</div>
      <div class="form-field"><label for="advance-amount">Số tiền (đồng)</label><input id="advance-amount" name="amount" type="text" inputmode="numeric" pattern="[0-9]+" maxlength="13" placeholder="Ví dụ: 100000" value="${editing?.amount ?? ""}" required></div>
      <div class="form-field"><label for="advance-note">Ghi chú</label><input id="advance-note" name="note" maxlength="500" value="${escapeHTML(editing?.note || "")}" placeholder="Không bắt buộc"></div>
      <p class="form-hint">Tiền ứng chưa khấu trừ sẽ được đưa vào lần kết sổ tiếp theo.</p>`, standardActions(editing ? "Lưu thay đổi" : "Lưu khoản ứng"), async form => {
      const date = String(form.get("date") || ""), amount = moneyInput(form.get("amount")), note = String(form.get("note") || "").trim();
      if (!Ledger.isDate(date) || note.length > 500) throw new Error("Ngày hoặc ghi chú không hợp lệ.");
      await transaction(["soghi_advances", "soghi_settlements", "harvesters"], "readwrite", async (tx, request) => {
        const p = await request(tx.objectStore("harvesters").get(harvesterId));
        if (!p || p.accountId !== accountId) throw new Error("Người hái không còn tồn tại.");
        let original;
        if (editing) {
          original = await request(tx.objectStore("soghi_advances").get(editing.id));
          const settlements = await request(tx.objectStore("soghi_settlements").index("accountId").getAll(accountId));
          if (!original || original.accountId !== accountId || original.harvesterId !== harvesterId) throw new Error("Không tìm thấy khoản ứng.");
          if (Ledger.allocations({ settlements }).get(editing.id)) throw new Error("Khoản ứng đã được khấu trừ, không thể sửa.");
        }
        const now = new Date().toISOString();
        tx.objectStore("soghi_advances").put({ id: original?.id || randomId(), accountId, harvesterId, date, amount, note, createdAt: original?.createdAt || now, updatedAt: now });
      });
      await updateVisibleData(); showToast("Đã lưu khoản ứng.");
    });
    modalCancel();
  }
  function settlementHTML(s) {
    return `<p class="form-hint"><strong>${escapeHTML(s.personName)}</strong> · ${s.mode === "all" ? "Toàn bộ phần chưa kết toán" : `${dateLabel(s.from)} – ${dateLabel(s.to)}`}</p>
      <div class="ledger-table-wrap"><table class="ledger-table"><thead><tr><th>Ngày</th><th>Kg</th><th>Giá/kg</th><th>Tiền công</th></tr></thead><tbody>
      ${s.days.map(d => `<tr><td>${dateLabel(d.date)}</td><td>${formatNumber(d.kg100 / 100)}</td><td>${money(d.rate)}</td><td>${money(d.amount)}</td></tr>`).join("")}
      </tbody></table></div>
      <dl class="settlement-totals"><div><dt>Tổng sản lượng</dt><dd>${formatNumber(s.totalKg100 / 100)} kg</dd></div>
      <div><dt>Tiền công</dt><dd>${money(s.gross)}</dd></div>
      <div><dt>Tiền ứng chưa khấu trừ trong kỳ tính</dt><dd>${money(s.availableAdvance)}</dd></div>
      <div><dt>Khấu trừ lần này</dt><dd>${money(s.advanceApplied)}</dd></div>
      <div class="payable"><dt>Còn phải trả</dt><dd>${money(s.payable)}</dd></div>
      ${s.carry ? `<div><dt>Tiền còn ứng chuyển lần sau</dt><dd>${money(s.carry)}</dd></div>` : ""}</dl>
      ${s.advanceAllocations.length ? `<details><summary>Các khoản ứng được khấu trừ</summary><ul class="advance-details">${s.advanceAllocations.map(a => `<li>${dateLabel(a.date)}: ${money(a.amount)}${a.note ? ` · ${escapeHTML(a.note)}` : ""}</li>`).join("")}</ul></details>` : ""}
      <p class="form-hint">Tiền công làm tròn đến đồng theo từng ngày. ${s.mode === "range" ? "Khấu trừ tiền ứng chưa kết toán đến hết ngày cuối, kể cả khoản ứng trước ngày bắt đầu." : "Bao gồm toàn bộ tiền ứng chưa khấu trừ."}</p>`;
  }
  async function openSettlement(harvesterId) {
    const accountId = state.account.id;
    if (cloud.enabled) {
      if (!cloud.linked || cloud.status === "expired") return openCloudAccess();
      await cloud.flush();
    }
    let preview = null;
    showModal("Kết sổ tính tiền", `
      <div class="form-field"><label for="settlement-mode">Phạm vi</label><select name="mode" id="settlement-mode"><option value="range">Theo khoảng ngày</option><option value="all">Toàn bộ chưa kết toán</option></select></div>
      <div id="settlement-dates" class="date-range">
        <div class="form-field"><label for="settlement-from">Từ ngày</label>${UI.dateField({ id: "settlement-from", name: "from", value: state.currentDate, label: "Kết sổ từ ngày", required: true })}</div>
        <div class="form-field"><label for="settlement-to">Đến ngày</label>${UI.dateField({ id: "settlement-to", name: "to", value: state.currentDate, label: "Kết sổ đến ngày", required: true })}</div>
      </div>
      <div id="settlement-preview" aria-live="polite"><p class="form-hint">Chỉ tính số kg chưa kết sổ. Chọn cùng ngày bắt đầu và kết thúc để tính một ngày.</p></div>`, standardActions("Tính tiền"), async form => {
      const selection = { mode: String(form.get("mode")), from: String(form.get("from") || ""), to: String(form.get("to") || "") };
      if (!preview) {
        preview = Ledger.buildSettlement(await getAccountData(accountId), harvesterId, selection);
        $("#settlement-preview").innerHTML = settlementHTML(preview) + `<p class="form-hint">Xác nhận sẽ lưu lịch sử và khóa sửa/xóa các số kg đã tính. Đây là ghi nhận kết toán trong sổ.</p>`;
        $("button[type=submit]", modalActions).textContent = "Xác nhận kết sổ";
        return false;
      }
      const expected = JSON.stringify(preview);
      try {
        if (cloud.enabled) {
          await cloud.flush();
          const latest = Ledger.buildSettlement(await getAccountData(accountId), harvesterId, selection);
          if (JSON.stringify(latest) !== expected) throw new Error("Dữ liệu vừa thay đổi. Hãy tính lại trước khi kết sổ.");
          await cloud.settle(selection, harvesterId);
          showToast("Đã kết sổ trên Supabase và lưu lịch sử.");
          return;
        }
        await transaction(Object.values(STORE_NAMES), "readwrite", async (tx, request) => {
          const data = await readData(tx, request, accountId);
          const latest = Ledger.buildSettlement(data, harvesterId, selection);
          if (JSON.stringify(latest) !== expected) throw new Error("Dữ liệu hoặc đơn giá vừa thay đổi. Hãy tính lại trước khi kết sổ.");
          const now = new Date().toISOString();
          tx.objectStore("soghi_settlements").add({ ...latest, id: randomId(), accountId, createdAt: now, updatedAt: now });
        });
      } catch (error) { invalidatePreview(); throw error; }
      await updateVisibleData(); showToast("Đã kết sổ và lưu lịch sử.");
    });
    function invalidatePreview() {
      preview = null;
      $("#settlement-preview").innerHTML = `<p class="form-hint">Nhấn Tính tiền để xem bảng kết toán mới.</p>`;
      $("button[type=submit]", modalActions).textContent = "Tính tiền";
    }
    modalCancel();
    modalBody.querySelectorAll("input, select").forEach(node => node.addEventListener("change", () => {
      invalidatePreview();
      const all = $("#settlement-mode").value === "all";
      $("#settlement-dates").hidden = all;
      $("#settlement-dates").querySelectorAll("input").forEach(input => input.disabled = all);
    }));
  }
  async function openFinanceHistory(harvesterId) {
    const accountId = state.account.id, data = await getAccountData(accountId), used = Ledger.allocations(data);
    const advances = data.advances.filter(a => a.harvesterId === harvesterId).sort((a, b) => Ledger.order(b, a));
    const settlements = data.settlements.filter(s => s.harvesterId === harvesterId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    showModal("Lịch sử ứng tiền & kết sổ", `
      <h3 class="section-label">Ứng tiền</h3><div class="ledger-list">${advances.length ? advances.map(a => `<div class="ledger-item"><div><strong>${money(a.amount)}</strong><small>${dateLabel(a.date)}${a.note ? ` · ${escapeHTML(a.note)}` : ""}</small><small>Đã trừ ${money(used.get(a.id) || 0)} · còn ${money(a.amount - (used.get(a.id) || 0))}</small></div>${!used.get(a.id) ? `<div class="ledger-tools"><button type="button" data-advance-edit="${escapeHTML(a.id)}">Sửa</button><button type="button" data-advance-delete="${escapeHTML(a.id)}">Xóa</button></div>` : ""}</div>`).join("") : `<p class="form-hint">Chưa có khoản ứng.</p>`}</div>
      <h3 class="section-label">Các lần kết sổ</h3><div class="ledger-list">${settlements.length ? settlements.map(s => `<button type="button" class="history-settlement" data-settlement="${escapeHTML(s.id)}"><strong>${money(s.payable)} · ${formatNumber(s.totalKg100 / 100)} kg</strong><small>${s.mode === "all" ? "Toàn bộ chưa kết toán" : `${dateLabel(s.from)} – ${dateLabel(s.to)}`} · chốt ${new Date(s.createdAt).toLocaleString("vi-VN")}</small></button>`).join("") : `<p class="form-hint">Chưa kết sổ lần nào.</p>`}</div>`, `<button type="button" class="secondary-button" data-cancel>Đóng</button>`);
    modalCancel();
    modalBody.querySelectorAll("[data-advance-edit]").forEach(b => b.addEventListener("click", run(() => openAdvance(harvesterId, b.dataset.advanceEdit))));
    modalBody.querySelectorAll("[data-advance-delete]").forEach(b => b.addEventListener("click", run(async () => {
      if (!window.confirm("Xóa khoản ứng chưa khấu trừ này?")) return;
      await transaction(["soghi_advances", "soghi_settlements"], "readwrite", async (tx, request) => {
        const a = await request(tx.objectStore("soghi_advances").get(b.dataset.advanceDelete));
        const settlements = await request(tx.objectStore("soghi_settlements").index("accountId").getAll(accountId));
        if (!a || a.accountId !== accountId || a.harvesterId !== harvesterId) throw new Error("Không tìm thấy khoản ứng.");
        if (Ledger.allocations({ settlements }).get(a.id)) throw new Error("Khoản ứng đã khấu trừ, không thể xóa.");
        tx.objectStore("soghi_advances").delete(a.id);
      });
      await updateVisibleData(); await openFinanceHistory(harvesterId); showToast("Đã xóa khoản ứng.");
    })));
    modalBody.querySelectorAll("[data-settlement]").forEach(b => b.addEventListener("click", () => {
      const s = settlements.find(s => s.id === b.dataset.settlement);
      showModal("Chi tiết kết sổ", `<p class="form-hint">Đã chốt ${new Date(s.createdAt).toLocaleString("vi-VN")}. Số tiền và đơn giá được giữ nguyên.</p>${settlementHTML(s)}`, `<button type="button" class="secondary-button" id="back-history">Lịch sử</button><button type="button" class="primary-button" data-cancel>Đóng</button>`);
      modalCancel(); $("#back-history").addEventListener("click", run(() => openFinanceHistory(harvesterId)));
    }));
  }

  async function openCloudAccess() {
    if (!cloud.enabled) return showToast("Điền Project URL và publishable/anon key trong soghi-config.js để bật Supabase.");
    const account = state.account;
    showModal("Liên kết Supabase", `<p class="form-hint">Username: <strong>${escapeHTML(account.username)}</strong>. Nhập PIN để liên kết sổ đang có với tài khoản trên máy chủ. Dữ liệu trên máy được giữ lại và ghép khi đồng bộ.</p><div class="form-field"><label for="cloud-pin">PIN 6 chữ số</label><input id="cloud-pin" name="pin" type="password" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" required autocomplete="current-password"></div>`, standardActions("Liên kết"), async form => {
      const pin = String(form.get("pin") || "");
      if ((await hashPin(pin, account.pinSalt)).hash !== account.pinHash) throw new Error("PIN cục bộ không đúng.");
      const auth = await cloud.authenticate({ username: account.username, displayName: account.displayName, pin, migrate: true });
      await cloud.attach(account, auth); await cloud.flush(); showToast("Đã liên kết và đồng bộ Supabase.");
    });
    modalCancel();
  }
  async function openCloudPanel() {
    if (!cloud.linked || cloud.status === "expired") return openCloudAccess();
    const labels = { harvesters: "Người hái", entries: "Số kg", rates: "Đơn giá", advances: "Ứng tiền", settlements: "Kết sổ", settings: "Giao diện", restore: "Bản khôi phục" };
    function describe(row) {
      if (!row) return "Đã xóa";
      if (row.name) return row.name;
      if (row.kg !== undefined) return `${formatNumber(row.kg)} kg · ${dateLabel(row.date)}`;
      if (row.amount !== undefined) return `${money(row.amount)} · ${dateLabel(row.date || row.effectiveDate)}`;
      if (row.gross !== undefined) return `${row.personName} · ${money(row.gross)}`;
      return row.theme || "Toàn bộ dữ liệu";
    }
    const hasConflict = cloud.status === "conflict";
    showModal("Đồng bộ Supabase", `<p class="form-hint">${escapeHTML(connectionText())}</p>${cloud.error ? `<p class="form-hint">${escapeHTML(cloud.error)}</p>` : ""}
      ${hasConflict ? `<p class="form-hint">Sao lưu JSON trước khi chọn bản dữ liệu. Những số đã kết sổ trên cloud được giữ theo bản đã chốt.</p><div class="ledger-list">${cloud.conflicts.slice(0,20).map(c => `<div class="ledger-item"><div><strong>${labels[c.collection] || "Dữ liệu"}</strong><small>Thiết bị: ${escapeHTML(describe(c.local))}</small><small>Cloud: ${escapeHTML(describe(c.remote))}</small></div></div>`).join("")}</div>` : ""}
      <div class="settings-list"><button type="button" id="cloud-backup"><span>Sao lưu JSON trước khi đối chiếu</span><span>↓</span></button>
      ${hasConflict ? `<button type="button" id="cloud-use-remote"><span>Dùng bản cloud cho các mục xung đột</span><span>↑</span></button>${cloud.conflicts.some(c => c.locked) ? "" : `<button type="button" id="cloud-use-local"><span>Giữ thay đổi của thiết bị</span><span>↑</span></button>`}` : ""}</div>`, standardActions("Đồng bộ ngay"), async () => {
      await cloud.flush(); showToast("Đã đồng bộ Supabase.");
    });
    modalCancel();
    $("#cloud-backup").addEventListener("click", run(exportBackup));
    for (const [id, choice] of [["cloud-use-remote", "remote"], ["cloud-use-local", "local"]]) $("#" + id)?.addEventListener("click", run(async () => {
      if (!window.confirm("Áp dụng lựa chọn cho các mục xung đột đã hiển thị?")) return;
      await cloud.resolve(choice); closeModal(); showToast("Đã đối chiếu và đồng bộ.");
    }));
  }

  async function openSettings() {
    const body = `
      <div class="form-field"><label for="theme-choice">Màu giao diện</label>
        <select id="theme-choice" name="theme">
          <option value="green" ${state.settings.theme === "green" ? "selected" : ""}>Xanh lá</option>
          <option value="blue" ${state.settings.theme === "blue" ? "selected" : ""}>Xanh dương</option>
        </select>
      </div>
      <div class="settings-list">
        ${cloud.enabled ? `<button type="button" id="manage-sync"><span>Đồng bộ Supabase</span><span>↻</span></button>` : ""}
        <button type="button" id="manage-rates"><span>Đơn giá công hái theo ngày</span><span>₫</span></button>
        <button type="button" id="backup-json"><span>Sao lưu dữ liệu (JSON)</span><span>↓</span></button>
        <button type="button" id="restore-json"><span>Khôi phục dữ liệu (JSON)</span><span>↑</span></button>
        <button type="button" id="export-csv"><span>Xuất Excel (CSV)</span><span>↗</span></button>
        <button type="button" id="logout-button"><span>Đăng xuất</span><span>→</span></button>
      </div>
      <p class="form-hint" style="margin-top:12px">${escapeHTML(connectionText())}</p>
    `;
    showModal("Cài đặt", body,
      `<button type="button" class="secondary-button" data-cancel>Đóng</button><button type="submit" class="primary-button">Lưu giao diện</button>`,
      async data => {
        state.settings.theme = data.get("theme") || "green";
        document.body.dataset.theme = state.settings.theme;
        await saveSettings();
        showToast("Đã lưu giao diện.");
        await updateVisibleData();
      });
    $("[data-cancel]").addEventListener("click", closeModal);
    $("#manage-rates").addEventListener("click", run(() => openRates()));
    $("#manage-sync")?.addEventListener("click", run(openCloudPanel));
    $("#backup-json").addEventListener("click", run(exportBackup));
    $("#restore-json").addEventListener("click", () => { closeModal(); importInput.click(); });
    $("#export-csv").addEventListener("click", run(exportCSV));
    $("#logout-button").addEventListener("click", run(async () => {
      closeModal();
      if (window.confirm("Đăng xuất khỏi tài khoản này? Các thay đổi chưa đồng bộ vẫn được giữ trên thiết bị.")) await logout();
    }));
  }

  function downloadFile(filename, content, type) {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function exportBackup() {
    const account = state.account, data = await getAccountData(account.id);
    const payload = {
      app: "soghi", version: 2, exportedAt: new Date().toISOString(),
      account: { displayName: account.displayName, username: account.username },
      settings: state.settings, ...data
    };
    downloadFile(`soghi-sao-luu-${todayISO()}.json`, JSON.stringify(payload, null, 2), "application/json;charset=utf-8");
    showToast("Đã sao lưu cả sản lượng, đơn giá, ứng tiền và kết sổ.");
  }
  function csvText(rows) {
    return "\uFEFF" + rows.map(row => row.map(value => {
      let text = String(value ?? "");
      if (typeof value === "string" && /^[=+@\-\t\r]/.test(text)) text = "'" + text;
      return `"${text.replace(/"/g, '\"\"')}"`;
    }).join(",")).join("\r\n");
  }
  async function exportCSV() {
    const data = await getAccountData(), people = new Map(data.harvesters.map(p => [p.id, p.name]));
    const settled = new Map();
    for (const s of data.settlements) for (const day of s.days) for (const id of day.entryIds) settled.set(id, { id: s.id, rate: day.rate });
    const rows = [["Tên người hái", "Ngày", "Sản lượng (kg)", "Thời điểm nhập", "Đơn giá/kg", "Trạng thái", "Mã kết sổ"]];
    [...data.entries].sort(Ledger.order).forEach(e => {
      const closed = settled.get(e.id), rate = closed?.rate ?? Ledger.effectiveRate(data.rates, e.harvesterId, e.date)?.amount ?? "";
      rows.push([people.get(e.harvesterId) || "", e.date, e.kg, e.createdAt, rate, closed ? "Đã kết sổ" : "Chưa kết sổ", closed?.id || ""]);
    });
    downloadFile(`soghi-san-luong-${todayISO()}.csv`, csvText(rows), "text/csv;charset=utf-8");
    showToast("Đã xuất sản lượng CSV.");
  }
  let importBusy = false;
  importInput.addEventListener("change", run(async event => {
    const file = event.target.files?.[0];
    if (!file || !state.account || importBusy) return;
    importBusy = true;
    const accountId = state.account.id;
    try {
      const incoming = Ledger.validateBackup(JSON.parse(await file.text()));
      if (cloud.enabled) {
        if (!cloud.linked) throw new Error("Liên kết Supabase trước khi khôi phục ở chế độ cloud.");
        await cloud.flush();
      }
      if (!window.confirm("Khôi phục sẽ thay thế sản lượng, đơn giá, ứng tiền và lịch sử kết sổ của tài khoản này. Nên sao lưu dữ liệu hiện tại trước. Tiếp tục?")) return;
      if (state.account?.id !== accountId || state.saving) throw new Error("Tài khoản hoặc thao tác lưu đã thay đổi. Hãy thử lại.");
      await transaction([...Object.values(STORE_NAMES), "settings"], "readwrite", async (tx, request) => {
        const existing = Object.fromEntries(await Promise.all(Object.entries(STORE_NAMES).map(async ([key, store]) => [key, await request(tx.objectStore(store).getAll())])));
        const maps = {};
        for (const key of Object.keys(STORE_NAMES)) {
          const otherIds = new Set(existing[key].filter(r => r.accountId !== accountId).map(r => r.id));
          const incomingIds = new Set(incoming[key].map(r => r.id));
          maps[key] = new Map(incoming[key].map(row => {
            let id = row.id;
            if (otherIds.has(id)) { do { id = randomId(); } while (otherIds.has(id) || incomingIds.has(id)); incomingIds.add(id); }
            return [row.id, id];
          }));
        }
        for (const [key, store] of Object.entries(STORE_NAMES)) {
          for (const row of existing[key]) if (row.accountId === accountId) tx.objectStore(store).delete(row.id);
          for (const row of incoming[key]) {
            const saved = { ...row, id: maps[key].get(row.id), accountId };
            if (key !== "harvesters") saved.harvesterId = row.harvesterId === null ? null : maps.harvesters.get(row.harvesterId);
            if (key === "settlements") {
              saved.entryIds = row.entryIds.map(id => maps.entries.get(id));
              saved.days = row.days.map(d => ({ ...d, rateId: maps.rates.get(d.rateId) || d.rateId, entryIds: d.entryIds.map(id => maps.entries.get(id)) }));
              saved.advanceAllocations = row.advanceAllocations.map(a => ({ ...a, advanceId: maps.advances.get(a.advanceId) }));
            }
            tx.objectStore(store).put(saved);
          }
        }
        tx.objectStore("settings").put({ accountId, ...incoming.settings });
      }, { restore: cloud.enabled });
      state.drafts.clear();
      await loadSettings();
      await renderHome();
      if (cloud.enabled) await cloud.flush();
      showToast("Đã khôi phục đầy đủ dữ liệu.");
    } catch (error) { showToast(error.message || "Không thể khôi phục. Dữ liệu hiện tại được giữ nguyên."); }
    finally { importInput.value = ""; importBusy = false; }
  }));
  function refreshConnection() {
    document.querySelectorAll(".connection-pill").forEach(node => {
      node.innerHTML = `<i class="connection-dot"></i>${escapeHTML(connectionText())}`;
    });
  }
  window.addEventListener("online", refreshConnection);
  window.addEventListener("offline", refreshConnection);
  window.addEventListener("storage", run(async event => {
    if (event.key === SESSION_KEY && event.newValue !== state.account?.id) {
      if (cloud.enabled) await cloud.logout();
      closeModal(); hideEntryDock(); state.account = null; state.currentHarvesterId = null; renderAuth();
      showToast("Phiên đăng nhập đã đổi ở tab khác. Hãy đăng nhập lại.");
    }
  }));
  window.addEventListener("focus", run(async () => {
    if (state.account && !state.saving && !modal.open) await updateVisibleData();
  }));

  const cloud = SoghiSync.create({
    config: window.SOGHI_CONFIG,
    readBundle: readCloudBundle,
    updateMeta: updateCloudMeta,
    apply: applyCloudSnapshot,
    validate: data => Ledger.validateBackup({ app: "soghi", version: 2, ...data }),
    onState: refreshConnection,
    onChange: async () => { if (state.account) { await loadSettings(); await updateVisibleData(); } }
  });
  async function init() {
    try {
      if (!("indexedDB" in window)) throw new Error("Trình duyệt không hỗ trợ IndexedDB.");
      state.db = await openDatabase();
      const sessionId = localStorage.getItem(SESSION_KEY);
      if (sessionId) {
        const account = await getOne("accounts", sessionId);
        if (account) {
          await loginAccount(account);
        } else {
          localStorage.removeItem(SESSION_KEY);
          renderAuth();
        }
      } else {
        renderAuth();
      }
      if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost")) {
        navigator.serviceWorker.register("soghi-sw.js").catch(() => {});
      }
    } catch (error) {
      app.innerHTML = `<main class="auth-screen"><section class="auth-card"><h1>Không thể mở Sổ Ghi</h1><p>${escapeHTML(error.message)}</p><p class="auth-foot">Hãy mở ứng dụng qua localhost hoặc HTTPS, không mở trực tiếp bằng file://.</p></section></main>`;
    }
  }
  init();
})();
