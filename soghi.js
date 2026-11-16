(() => {
  "use strict";

  const DB_NAME = "soghi_local_demo_v1";
  const DB_VERSION = 2;
  const Ledger = globalThis.SoghiLedger;
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
    keyboardHeight: 0
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
      const tx = state.db.transaction(storeName, mode);
      const store = tx.objectStore(storeName);
      let request;
      try { request = action(store); } catch (err) { reject(err); return; }
      tx.oncomplete = () => resolve(request?.result);
      tx.onerror = () => reject(tx.error || request?.error);
      tx.onabort = () => reject(tx.error || new Error("Giao dịch dữ liệu bị hủy."));
    });
  }
  const getAll = name => storeRequest(name, "readonly", store => store.getAll());
  const put = (name, value) => storeRequest(name, "readwrite", store => store.put(value));
  const getOne = (name, key) => storeRequest(name, "readonly", store => store.get(key));
  function transaction(names, mode, action) {
    return new Promise((resolve, reject) => {
      const tx = state.db.transaction(names, mode);
      let value, problem;
      tx.oncomplete = () => resolve(value);
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
  function showModal(title, bodyHTML, actionsHTML, onSubmit) {
    const generation = ++modalGeneration;
    let busy = false;
    setVirtualKeyboard(false);
    modalTitle.textContent = title;
    modalBody.innerHTML = bodyHTML;
    modalActions.innerHTML = actionsHTML;
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
    if (!navigator.onLine) return "Ngoại tuyến · Dữ liệu lưu trên thiết bị";
    return "Đang dùng dữ liệu kiểm thử trên thiết bị";
  }
  function connectionHTML() {
    return `<div class="status-line"><span class="connection-pill"><i class="connection-dot"></i>${escapeHTML(connectionText())}</span></div>`;
  }

  function renderAuth() {
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
          <p class="auth-foot">Bản web kiểm thử lưu dữ liệu trên trình duyệt này.<br>Chưa kết nối Supabase hoặc đồng bộ nhiều thiết bị.</p>
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

  async function loginAccount(account) {
    state.account = account;
    localStorage.setItem(SESSION_KEY, account.id);
    await loadSettings();
    await renderHome();
  }
  function logout() {
    if (state.saving) return showToast("Đang lưu dữ liệu, vui lòng chờ.");
    localStorage.removeItem(SESSION_KEY);
    state.account = null;
    state.currentHarvesterId = null;
    state.authMode = "login";
    renderAuth();
  }

  async function renderHome() {
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
          <div class="person-avatar">${escapeHTML(initial.toLocaleUpperCase("vi-VN"))}</div>
          <div class="person-main" data-open-person="${escapeHTML(person.id)}">
            <p class="person-name">${escapeHTML(person.name)}</p>
            <p class="person-date">${lastDate ? `Ghi gần nhất: ${formatDate(lastDate)}` : "Chưa có ghi chép"}</p>
          </div>
          <div class="person-tools">
            <button type="button" title="Sửa tên" aria-label="Sửa tên" data-edit-person="${escapeHTML(person.id)}">✎</button>
            <button type="button" title="Xóa người hái" aria-label="Xóa người hái" data-delete-person="${escapeHTML(person.id)}">⋯</button>
          </div>
        </article>`;
    }).join("") : `
      <div class="empty-state">
        <strong>${query ? "Không tìm thấy người hái" : "Chưa có người hái nào"}</strong>
        ${query ? "Thử tìm bằng tên khác." : "Nhấn dấu cộng để thêm người đầu tiên."}
      </div>`;
    parkEntryDock();
    app.innerHTML = `
      <header class="topbar">
        <div class="brand">
          <div class="brand-mark">SG</div>
          <div><h1>Sổ ghi công hái</h1><small>${escapeHTML(state.account.displayName)}</small></div>
        </div>
        <div class="top-actions">
          <button class="icon-button" id="add-person-top" aria-label="Thêm người">＋</button>
          <button class="icon-button" id="open-settings" aria-label="Cài đặt">⚙</button>
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
    $("#person-search").addEventListener("input", event => { state.search = event.target.value; filterPeople(); });
    $("#add-person-top").addEventListener("click", openAddPerson);
    $("#add-person-fab").addEventListener("click", openAddPerson);
    $("#open-settings").addEventListener("click", openSettings);
    app.querySelectorAll("[data-open-person]").forEach(node => node.addEventListener("click", () => {
      state.currentHarvesterId = node.dataset.openPerson;
      state.currentDate = todayISO();
      showEntryDock(false);
      run(renderBook)();
    }));
    app.querySelectorAll("[data-edit-person]").forEach(node => node.addEventListener("click", run(() => editPerson(node.dataset.editPerson))));
    app.querySelectorAll("[data-delete-person]").forEach(node => node.addEventListener("click", run(() => deletePerson(node.dataset.deletePerson))));
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
      person.name = name;
      person.updatedAt = new Date().toISOString();
      await put("harvesters", person);
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
      <header class="topbar book-topbar">
        <button class="icon-button" id="back-home" aria-label="Quay lại">‹</button>
        <div class="book-title"><h1>${escapeHTML(person.name)}</h1><small>Sổ ghi sản lượng</small></div>
        <button class="icon-button" id="book-settings" aria-label="Cài đặt">⚙</button>
      </header>
      <div class="date-tools">
        <button class="day-button" id="previous-day" aria-label="Ngày trước">‹</button>
        <input type="date" id="book-date" value="${escapeHTML(context.date)}" aria-label="Chọn ngày">
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
        <section class="finance-panel" aria-label="Tiền công">
          <div class="finance-overview" id="finance-overview"></div>
          <div class="finance-actions">
            <button class="secondary-button" id="add-advance">Ứng tiền</button>
            <button class="primary-button" id="settle-book">Kết sổ</button>
            <button class="secondary-button" id="finance-history">Lịch sử</button>
          </div>
        </section>
        ${connectionHTML()}
      </main>`;
    $("#book-settings").insertAdjacentElement("beforebegin", entryDock);
    showEntryDock(false);
    $("#back-home").addEventListener("click", run(async () => {
      if (state.saving) return showToast("Đang lưu, vui lòng chờ.");
      await renderHome();
    }));
    $("#book-settings").addEventListener("click", run(openSettings));
    $("#book-date").addEventListener("change", run(event => changeDate(event.target.value)));
    $("#previous-day").addEventListener("click", run(() => flipToDate(-1)));
    $("#next-day").addEventListener("click", run(() => flipToDate(1)));
    $("#add-advance").addEventListener("click", run(() => openAdvance(context.harvesterId)));
    $("#settle-book").addEventListener("click", run(() => openSettlement(context.harvesterId)));
    $("#finance-history").addEventListener("click", run(() => openFinanceHistory(context.harvesterId)));
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
    const data = state.bookData, locked = Ledger.lockedIds(data), used = Ledger.allocations(data);
    const pending = data.entries.filter(e => e.harvesterId === state.currentHarvesterId && !locked.has(e.id));
    const remaining = data.advances.filter(a => a.harvesterId === state.currentHarvesterId)
      .reduce((s, a) => s + a.amount - (used.get(a.id) || 0), 0);
    $("#finance-overview").textContent = `Chưa kết sổ: ${formatNumber(pending.reduce((s, e) => s + Ledger.kg100(e.kg), 0) / 100)} kg · Còn ứng: ${money(remaining)}`;
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
  keyboardToggle.addEventListener("click", () => setVirtualKeyboard(virtualKeyboard.hidden));
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
      <div class="form-field"><label for="rate-date">Bắt đầu áp dụng từ ngày</label><input id="rate-date" name="date" type="date" value="${editing?.effectiveDate || state.currentDate || todayISO()}" required></div>
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
      <div class="form-field"><label for="advance-date">Ngày ứng</label><input type="date" id="advance-date" name="date" value="${editing?.date || state.currentDate || todayISO()}" required></div>
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
    let preview = null;
    showModal("Kết sổ tính tiền", `
      <div class="form-field"><label for="settlement-mode">Phạm vi</label><select name="mode" id="settlement-mode"><option value="range">Theo khoảng ngày</option><option value="all">Toàn bộ chưa kết toán</option></select></div>
      <div id="settlement-dates" class="date-range">
        <div class="form-field"><label for="settlement-from">Từ ngày</label><input type="date" name="from" id="settlement-from" value="${state.currentDate}" required></div>
        <div class="form-field"><label for="settlement-to">Đến ngày</label><input type="date" name="to" id="settlement-to" value="${state.currentDate}" required></div>
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

  async function openSettings() {
    const body = `
      <div class="form-field"><label for="theme-choice">Màu giao diện</label>
        <select id="theme-choice" name="theme">
          <option value="green" ${state.settings.theme === "green" ? "selected" : ""}>Xanh lá</option>
          <option value="blue" ${state.settings.theme === "blue" ? "selected" : ""}>Xanh dương</option>
        </select>
      </div>
      <div class="settings-list">
        <button type="button" id="manage-rates"><span>Đơn giá công hái theo ngày</span><span>₫</span></button>
        <button type="button" id="backup-json"><span>Sao lưu dữ liệu (JSON)</span><span>↓</span></button>
        <button type="button" id="restore-json"><span>Khôi phục dữ liệu (JSON)</span><span>↑</span></button>
        <button type="button" id="export-csv"><span>Xuất Excel (CSV)</span><span>↗</span></button>
        <button type="button" id="logout-button"><span>Đăng xuất</span><span>→</span></button>
      </div>
      <p class="form-hint" style="margin-top:12px">Bản kiểm thử hiện lưu trên trình duyệt này. Chưa đồng bộ Supabase và chưa chia sẻ dữ liệu giữa các thiết bị.</p>
    `;
    showModal("Cài đặt", body,
      `<button type="button" class="secondary-button" data-cancel>Đóng</button><button type="submit" class="primary-button">Lưu giao diện</button>`,
      async data => {
        state.settings.theme = data.get("theme") || "green";
        document.body.dataset.theme = state.settings.theme;
        await saveSettings();
        showToast("Đã lưu giao diện.");
        if (state.screen === "home") renderHome(); else renderBook();
      });
    $("[data-cancel]").addEventListener("click", closeModal);
    $("#manage-rates").addEventListener("click", run(() => openRates()));
    $("#backup-json").addEventListener("click", run(exportBackup));
    $("#restore-json").addEventListener("click", () => { closeModal(); importInput.click(); });
    $("#export-csv").addEventListener("click", run(exportCSV));
    $("#logout-button").addEventListener("click", () => {
      closeModal();
      if (window.confirm("Đăng xuất khỏi tài khoản kiểm thử này?")) logout();
    });
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
  importInput.addEventListener("change", run(async event => {
    const file = event.target.files?.[0];
    if (!file || !state.account) return;
    const accountId = state.account.id;
    try {
      const incoming = Ledger.validateBackup(JSON.parse(await file.text()));
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
      });
      state.drafts.clear();
      await loadSettings();
      await renderHome(); showToast("Đã khôi phục đầy đủ dữ liệu.");
    } catch (error) { showToast(error.message || "Không thể khôi phục. Dữ liệu hiện tại được giữ nguyên."); }
    finally { importInput.value = ""; }
  }));
  function refreshConnection() {
    document.querySelectorAll(".connection-pill").forEach(node => {
      node.innerHTML = `<i class="connection-dot"></i>${escapeHTML(connectionText())}`;
    });
  }
  window.addEventListener("online", refreshConnection);
  window.addEventListener("offline", refreshConnection);
  window.addEventListener("storage", event => {
    if (event.key === SESSION_KEY && event.newValue !== state.account?.id) {
      closeModal(); hideEntryDock(); state.account = null; state.currentHarvesterId = null; renderAuth();
      showToast("Phiên đăng nhập đã đổi ở tab khác. Hãy đăng nhập lại.");
    }
  });
  window.addEventListener("focus", run(async () => {
    if (state.account && !state.saving && !modal.open) await updateVisibleData();
  }));

  async function init() {
    try {
      if (!("indexedDB" in window)) throw new Error("Trình duyệt không hỗ trợ IndexedDB.");
      state.db = await openDatabase();
      const sessionId = localStorage.getItem(SESSION_KEY);
      if (sessionId) {
        const account = await getOne("accounts", sessionId);
        if (account) {
          state.account = account;
          await loadSettings();
          await renderHome();
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
