(() => {
  "use strict";

  const DB_NAME = "soghi_local_demo_v1";
  const DB_VERSION = 1;
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
  const entryInput = $("#soghi-entry-value");
  const entrySubmit = $("#soghi-entry-submit");
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
    editingEntryId: null
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
      };
      request.onsuccess = () => resolve(request.result);
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
  const remove = (name, key) => storeRequest(name, "readwrite", store => store.delete(key));

  async function deleteWhere(storeName, predicate) {
    const rows = await getAll(storeName);
    const targets = rows.filter(predicate);
    if (!targets.length) return;
    await new Promise((resolve, reject) => {
      const tx = state.db.transaction(storeName, "readwrite");
      const store = tx.objectStore(storeName);
      targets.forEach(row => store.delete(row.id));
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  }
  async function getAccountData() {
    const [harvesters, entries] = await Promise.all([getAll("harvesters"), getAll("entries")]);
    return {
      harvesters: harvesters.filter(x => x.accountId === state.account.id),
      entries: entries.filter(x => x.accountId === state.account.id)
    };
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
    toastNode.textContent = message;
    toastNode.classList.add("show");
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => toastNode.classList.remove("show"), 2400);
  }
  function showModal(title, bodyHTML, actionsHTML, onSubmit) {
    modalTitle.textContent = title;
    modalBody.innerHTML = bodyHTML;
    modalActions.innerHTML = actionsHTML;
    modal.showModal();
    modalForm.onsubmit = async event => {
      event.preventDefault();
      try {
        const result = await onSubmit?.(new FormData(modalForm));
        if (result !== false) modal.close();
      } catch (error) {
        showToast(error.message || "Có lỗi xảy ra.");
      }
    };
  }
  function closeModal() { if (modal.open) modal.close(); }
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
    $("#auth-form").addEventListener("submit", async event => {
      event.preventDefault();
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
    });
  }

  async function loginAccount(account) {
    state.account = account;
    localStorage.setItem(SESSION_KEY, account.id);
    await loadSettings();
    await renderHome();
  }
  function logout() {
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
    const { harvesters, entries } = await getAccountData();
    const query = normalizeUsername(state.search);
    const filtered = harvesters
      .filter(person => !query || normalizeUsername(person.name).includes(query))
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
        ${connectionHTML()}
      </main>
      <button class="fab" id="add-person-fab" aria-label="Thêm người hái">＋</button>`;
    $("#person-search").addEventListener("input", event => {
      state.search = event.target.value;
      const pos = event.target.selectionStart;
      renderHome().then(() => {
        const input = $("#person-search");
        input.focus();
        input.setSelectionRange(pos, pos);
      });
    });
    $("#add-person-top").addEventListener("click", openAddPerson);
    $("#add-person-fab").addEventListener("click", openAddPerson);
    $("#open-settings").addEventListener("click", openSettings);
    app.querySelectorAll("[data-open-person]").forEach(node => node.addEventListener("click", () => {
      state.currentHarvesterId = node.dataset.openPerson;
      state.currentDate = todayISO();
      state.editingEntryId = null;
      entryInput.value = "";
      showEntryDock(false);
      renderBook();
    }));
    app.querySelectorAll("[data-edit-person]").forEach(node => node.addEventListener("click", () => editPerson(node.dataset.editPerson)));
    app.querySelectorAll("[data-delete-person]").forEach(node => node.addEventListener("click", () => deletePerson(node.dataset.deletePerson)));
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
    const { entries } = await getAccountData();
    const count = entries.filter(x => x.harvesterId === id).length;
    const confirmed = window.confirm(`XÓA VĨNH VIỄN "${person.name}"?\n\nToàn bộ ${count} lần ghi kg và lịch sử của người này sẽ bị xóa khỏi dữ liệu kiểm thử. Không thể khôi phục.`);
    if (!confirmed) return;
    await deleteWhere("entries", row => row.accountId === state.account.id && row.harvesterId === id);
    await remove("harvesters", id);
    await renderHome();
    showToast("Đã xóa người hái và toàn bộ lịch sử.");
  }

  async function renderBook() {
    state.screen = "book";
    const person = await getOne("harvesters", state.currentHarvesterId);
    if (!person || person.accountId !== state.account.id) return renderHome();
    const { entries } = await getAccountData();
    const dayEntries = entries
      .filter(entry => entry.harvesterId === person.id && entry.date === state.currentDate)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const columnCount = Math.max(5, Math.ceil(dayEntries.length / 7));
    let cells = "";
    for (let col = 0; col < columnCount; col++) {
      for (let row = 0; row < 7; row++) {
        const entry = dayEntries[col * 7 + row];
        cells += entry
          ? `<button type="button" class="entry-cell" data-entry-id="${escapeHTML(entry.id)}" aria-label="${formatNumber(entry.kg)} kg">${formatNumber(entry.kg)}</button>`
          : `<button type="button" class="empty-cell" data-add-entry aria-label="Nhập số kg vào ô trống"></button>`;
      }
    }
    const total = dayEntries.reduce((sum, entry) => sum + Number(entry.kg), 0);
    app.innerHTML = `
      <header class="topbar book-topbar">
        <button class="icon-button" id="back-home" aria-label="Quay lại">‹</button>
        <div class="book-title"><h1>${escapeHTML(person.name)}</h1><small>Sổ ghi sản lượng</small></div>
        <button class="icon-button" id="book-settings" aria-label="Cài đặt">⚙</button>
      </header>
      <div class="date-tools">
        <button class="day-button" id="previous-day" aria-label="Ngày trước">‹</button>
        <input type="date" id="book-date" value="${escapeHTML(state.currentDate)}" aria-label="Chọn ngày">
        <button class="day-button" id="next-day" aria-label="Ngày sau">›</button>
      </div>
      <main class="book-wrap">
        <section class="book-paper" id="book-paper">
          <div class="paper-caption"><span>NGÀY ${formatDate(state.currentDate)}</span><strong>${dayEntries.length} lần ghi</strong></div>
          <div class="notebook-grid-wrap">
            <div class="notebook-grid" style="--columns:${columnCount}">${cells}</div>
          </div>
          <div class="summary-rule"></div>
          <div class="summary-row">
            <div class="summary-item"><span class="summary-label">SỐ LẦN</span><span class="summary-value">${dayEntries.length}</span></div>
            <div class="summary-item"><span class="summary-label">TỔNG KG</span><span class="summary-value">${formatNumber(total)} <small>kg</small></span></div>
          </div>
          <div class="book-note">Chạm vào số kg để sửa hoặc xóa. Số mới được ghi vào ô tiếp theo.</div>
        </section>
        ${connectionHTML()}
      </main>
`;
    $("#back-home").addEventListener("click", () => {
      hideEntryDock();
      renderHome();
    });
    $("#book-settings").addEventListener("click", openSettings);
    $("#book-date").addEventListener("change", event => {
      if (event.target.value) { state.currentDate = event.target.value; renderBook(); }
    });
    $("#previous-day").addEventListener("click", () => { state.currentDate = shiftDate(state.currentDate, -1); renderBook(); });
    $("#next-day").addEventListener("click", () => { state.currentDate = shiftDate(state.currentDate, 1); renderBook(); });
    app.querySelectorAll("[data-entry-id]").forEach(node => node.addEventListener("click", async () => {
      const entry = await getOne("entries", node.dataset.entryId);
      if (!entry || entry.accountId !== state.account.id) return;
      state.editingEntryId = entry.id;
      showEntryDock(true);
      entryInput.value = String(entry.kg).replace(".", ",");
      entrySubmit.textContent = "SỬA";
    }));
    app.querySelectorAll("[data-add-entry]").forEach(node => node.addEventListener("click", () => {
      state.editingEntryId = null;
      state.editingEntryId = null;
      entryInput.value = "";
      showEntryDock(true);
    }));
    const paper = $("#book-paper");
    paper.addEventListener("touchstart", event => {
      if (event.target.closest(".notebook-grid-wrap")) return;
      const touch = event.changedTouches[0];
      state.swipeStart = { x: touch.clientX, y: touch.clientY };
    }, { passive: true });
    paper.addEventListener("touchend", event => {
      if (!state.swipeStart) return;
      const touch = event.changedTouches[0];
      const dx = touch.clientX - state.swipeStart.x;
      const dy = touch.clientY - state.swipeStart.y;
      state.swipeStart = null;
      if (Math.abs(dx) > 75 && Math.abs(dy) < 55) {
        state.currentDate = shiftDate(state.currentDate, dx < 0 ? 1 : -1);
        renderBook();
      }
    }, { passive: true });
  }

  function showEntryDock(openKeyboard = false) {
    entryDock.hidden = false;
    document.body.classList.add("entry-active");
    if (!state.editingEntryId) entrySubmit.textContent = "GHI";
    if (openKeyboard) setVirtualKeyboard(true);
  }
  function setVirtualKeyboard(open) {
    virtualKeyboard.hidden = !open;
    keyboardToggle.setAttribute("aria-expanded", open ? "true" : "false");
    keyboardToggle.setAttribute("aria-label", open ? "Đóng bàn phím nhập kg" : "Mở bàn phím nhập kg");
    document.body.classList.toggle("keyboard-open", open);
    if (open) {
      // Keep focus away from the operating-system keyboard; all digits come from web keys.
      entryInput.blur();
    }
  }
  function hideEntryDock() {
    entryDock.hidden = true;
    document.body.classList.remove("entry-active", "keyboard-open");
    virtualKeyboard.hidden = true;
    keyboardToggle.setAttribute("aria-expanded", "false");
    state.editingEntryId = null;
    entryInput.value = "";
    entrySubmit.textContent = "GHI";
  }
  function appendVirtualKey(key) {
    let value = entryInput.value || "";
    if (key === "backspace") {
      value = value.slice(0, -1);
    } else if (key === "decimal") {
      if (!value.includes(",") && !value.includes(".")) value = value ? value + "," : "0,";
    } else if (/^\d$/.test(key)) {
      if (value.length < 9) value += key;
    }
    entryInput.value = value;
  }
  keyboardToggle.addEventListener("click", () => {
    setVirtualKeyboard(virtualKeyboard.hidden);
  });
  entryInput.addEventListener("click", () => setVirtualKeyboard(true));
  virtualKeyboard.querySelectorAll("[data-key]").forEach(button => {
    button.addEventListener("click", async () => {
      const key = button.dataset.key;
      if (key === "enter") {
        entryDock.requestSubmit();
      } else {
        appendVirtualKey(key);
      }
    });
  });

  entryDock.addEventListener("submit", async event => {
    event.preventDefault();
    if (!state.account || !state.currentHarvesterId || state.screen !== "book") return;
    const kg = parseKg(entryInput.value);
    if (kg === null) {
      showToast("Nhập số kg hợp lệ, không âm và tối đa 2 chữ số thập phân.");
      setVirtualKeyboard(true);
      return;
    }
    try {
      if (state.editingEntryId) {
        const entry = await getOne("entries", state.editingEntryId);
        if (!entry || entry.accountId !== state.account.id) throw new Error("Không tìm thấy số kg cần sửa.");
        entry.kg = kg;
        entry.updatedAt = new Date().toISOString();
        await put("entries", entry);
        state.editingEntryId = null;
        entrySubmit.textContent = "GHI";
        showToast("Đã sửa số kg.");
      } else {
        await put("entries", {
          id: randomId(), accountId: state.account.id, harvesterId: state.currentHarvesterId,
          date: state.currentDate, kg, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
        });
        showToast("Đã ghi " + formatNumber(kg) + " kg.");
      }
      entryInput.value = "";
      // Re-render the book only; keep the custom web keypad open for the next weighing.
      await renderBook();
      setVirtualKeyboard(true);
    } catch (error) {
      showToast(error.message || "Không thể lưu số kg.");
      setVirtualKeyboard(true);
    }
  });

  function parseKg(value) {
    const normalized = String(value ?? "").trim().replace(",", ".");
    if (!normalized || !/^\d+(\.\d{1,2})?$/.test(normalized)) return null;
    const number = Number(normalized);
    if (!Number.isFinite(number) || number < 0) return null;
    return number;
  }
  function openEntryModal() {
    showModal("Nhập số kg", `
      <div class="form-field"><label for="entry-kg">Sản lượng (kg)</label><input id="entry-kg" class="numeric-entry" name="kg" type="number" inputmode="decimal" enterkeyhint="done" min="0" step="0.01" placeholder="Nhập số kg" required autofocus></div>
      <p class="form-hint">Nhập số cân rồi nhấn Enter/Done để ghi ngay vào sổ ngày ${formatDate(state.currentDate)}.</p>
    `, `<button type="button" class="secondary-button" data-cancel>Hủy</button><button type="submit" class="primary-button">Ghi vào sổ</button>`, async data => {
      const kg = parseKg(data.get("kg"));
      if (kg === null) throw new Error("Vui lòng nhập số kg hợp lệ, không âm và tối đa 2 chữ số thập phân.");
      await put("entries", {
        id: randomId(), accountId: state.account.id, harvesterId: state.currentHarvesterId,
        date: state.currentDate, kg, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
      });
      await renderBook();
      showToast("Đã lưu số kg.");
    });
    $("[data-cancel]").addEventListener("click", closeModal);
    requestAnimationFrame(() => {
      const input = $("#entry-kg");
      input?.focus();
      input?.select();
    });
  }
  async function editEntry(id) {
    const entry = await getOne("entries", id);
    if (!entry || entry.accountId !== state.account.id) return;
    showModal("Sửa số kg", `
      <div class="form-field"><label for="entry-kg">Sản lượng (kg)</label><input id="entry-kg" class="numeric-entry" name="kg" type="number" inputmode="decimal" enterkeyhint="done" min="0" step="0.01" value="${escapeHTML(entry.kg)}" required></div>
      <p class="form-hint">Ngày ghi: ${formatDate(entry.date)}. Sửa số liệu không thay đổi ngày ghi.</p>
    `, `<button type="button" class="danger-button" id="delete-entry">Xóa số</button><span style="flex:1"></span><button type="button" class="secondary-button" data-cancel>Hủy</button><button type="submit" class="primary-button">Ghi vào sổ</button>`, async data => {
      const kg = parseKg(data.get("kg"));
      if (kg === null) throw new Error("Vui lòng nhập số kg hợp lệ, không âm và tối đa 2 chữ số thập phân.");
      entry.kg = kg;
      entry.updatedAt = new Date().toISOString();
      await put("entries", entry);
      await renderBook();
      showToast("Đã cập nhật số kg.");
    });
    $("[data-cancel]").addEventListener("click", closeModal);
    requestAnimationFrame(() => {
      const input = $("#entry-kg");
      input?.focus();
      input?.select();
    });
    $("#delete-entry").addEventListener("click", async () => {
      const confirmed = window.confirm(`Xóa số ${formatNumber(entry.kg)} kg khỏi ngày ${formatDate(entry.date)}?`);
      if (!confirmed) return;
      await remove("entries", entry.id);
      closeModal();
      await renderBook();
      showToast("Đã xóa số kg.");
    });
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
    $("#backup-json").addEventListener("click", exportBackup);
    $("#restore-json").addEventListener("click", () => { closeModal(); importInput.click(); });
    $("#export-csv").addEventListener("click", exportCSV);
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
    const { harvesters, entries } = await getAccountData();
    const payload = {
      app: "soghi", version: 1, exportedAt: new Date().toISOString(),
      account: { displayName: state.account.displayName, username: state.account.username },
      settings: state.settings, harvesters, entries
    };
    downloadFile(`soghi-sao-luu-${todayISO()}.json`, JSON.stringify(payload, null, 2), "application/json;charset=utf-8");
    showToast("Đã tạo file sao lưu.");
  }
  async function exportCSV() {
    const { harvesters, entries } = await getAccountData();
    const people = new Map(harvesters.map(p => [p.id, p.name]));
    const rows = [["Tên người hái", "Ngày", "Sản lượng (kg)", "Thời điểm nhập"]];
    entries.sort((a, b) => a.date.localeCompare(b.date) || a.createdAt.localeCompare(b.createdAt))
      .forEach(entry => rows.push([people.get(entry.harvesterId) || "", entry.date, entry.kg, entry.createdAt]));
    const csv = "\uFEFF" + rows.map(row => row.map(value => `"${String(value ?? "").replace(/"/g, '""')}"`).join(",")).join("\r\n");
    downloadFile(`soghi-san-luong-${todayISO()}.csv`, csv, "text/csv;charset=utf-8");
    showToast("Đã xuất dữ liệu CSV.");
  }
  importInput.addEventListener("change", async event => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const payload = JSON.parse(await file.text());
      if (payload.app !== "soghi" || !Array.isArray(payload.harvesters) || !Array.isArray(payload.entries)) {
        throw new Error("File sao lưu không đúng định dạng Sổ Ghi.");
      }
      const confirmed = window.confirm("Khôi phục sẽ thay thế toàn bộ danh sách người hái và số kg hiện có của tài khoản này. Tiếp tục?");
      if (!confirmed) return;
      await deleteWhere("entries", row => row.accountId === state.account.id);
      await deleteWhere("harvesters", row => row.accountId === state.account.id);
      for (const person of payload.harvesters) {
        await put("harvesters", { ...person, accountId: state.account.id });
      }
      for (const entry of payload.entries) {
        await put("entries", { ...entry, accountId: state.account.id });
      }
      if (payload.settings) {
        state.settings = { theme: payload.settings.theme === "blue" ? "blue" : "green" };
        await saveSettings();
        document.body.dataset.theme = state.settings.theme;
      }
      await renderHome();
      showToast("Đã khôi phục dữ liệu.");
    } catch (error) {
      showToast(error.message || "Không thể khôi phục file.");
    } finally {
      importInput.value = "";
    }
  });

  window.addEventListener("online", () => {
    if (state.account && state.screen === "home") renderHome();
    if (state.account && state.screen === "book") renderBook();
  });
  window.addEventListener("offline", () => {
    if (state.account && state.screen === "home") renderHome();
    if (state.account && state.screen === "book") renderBook();
  });

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
