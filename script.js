function showToast(message, duration = 2200) {
    const toast = document.getElementById('toast-notification');
    if (!toast) return;

    toast.textContent = message;
    toast.classList.add('show');

    clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => {
        toast.classList.remove('show');
    }, duration);
}

function undoCode() {
    editor.undo();
    editor.focus();
}

function redoCode() {
    editor.redo();
    editor.focus();
}

function insertText(text) {
    if (text === 'Tab') {
        editor.replaceSelection('    ');
    } else {
        editor.replaceSelection(text);
    }

    editor.focus();
}

async function copyAllCode() {
    const code = editor.getValue();
    if (!code) {
        showToast('File hiện tại đang trống');
        return;
    }

    try {
        await navigator.clipboard.writeText(code);
        showToast('Đã sao chép code!');
    } catch (error) {
        try {
            const textarea = document.createElement('textarea');
            textarea.value = code;
            textarea.style.position = 'fixed';
            textarea.style.opacity = '0';
            document.body.appendChild(textarea);
            textarea.select();
            const copied = document.execCommand('copy');
            textarea.remove();
            if (!copied) throw new Error('Clipboard không khả dụng');
            showToast('Đã sao chép code!');
        } catch (fallbackError) {
            alert('Đã xảy ra lỗi khi copy: ' + fallbackError);
        }
    }
}

async function pasteFromClipboard() {
    try {
        const text = await navigator.clipboard.readText();

        if (text) {
            editor.focus();
            editor.replaceSelection(text);
            showToast('Đã dán nội dung');
        }
    } catch (error) {
        alert("Trình duyệt không cấp quyền truy cập Clipboard. Vui lòng ấn giữ vào màn hình và chọn 'Dán'.");
    }
}

function downloadBlobFile(blob, fileName) {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');

    anchor.href = url;
    anchor.download = fileName;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();

    setTimeout(() => URL.revokeObjectURL(url), 1500);
}

// CODE EDITOR LITE — giữ CodeMirror, JSZip và các thao tác Clipboard cũ.
const STORAGE_KEY = 'ios_editor_pro_files'; // Đọc dữ liệu phiên bản cũ một lần.
const JOURNAL_KEY = 'code_editor_lite_pending';
const ZIP_MAX_ARCHIVE_BYTES = 30 * 1024 * 1024;
const ZIP_MAX_TOTAL_BYTES = 25 * 1024 * 1024;
const ZIP_MAX_SINGLE_FILE_BYTES = 4 * 1024 * 1024;
const ZIP_MAX_FILE_COUNT = 300;
const TEXT_EXTENSIONS = new Set('html htm css js mjs cjs json txt md xml svg csv ts tsx jsx yml yaml ini conf env gitignore'.split(' '));
let files = Object.create(null);
let folders = new Set();
let expanded = new Set();
let currentFile = null;
let selectedPath = '';
let selectedFolder = true;
let db;
let revision = 0;
let saveQueue = Promise.resolve();
let toastTimeout;
let projectOperationInProgress = false;
let searchTimeout;
const documents = new Map();
const editor = CodeMirror.fromTextArea(document.getElementById('code-editor'), {
    theme: 'dracula', lineNumbers: true, lineWrapping: true,
    indentUnit: 4, tabSize: 4, autoCloseBrackets: true,
    autoCloseTags: true, matchBrackets: true, styleActiveLine: true,
    readOnly: true
});
const $ = id => document.getElementById(id);

function extension(path) {
    return path.split('/').pop().split('.').pop().toLowerCase();
}
function parseFileMetadata(path) {
    const ext = extension(path);
    return { mode: ({ html: 'htmlmixed', htm: 'htmlmixed', css: 'css', js: 'javascript',
        mjs: 'javascript', cjs: 'javascript', json: 'application/json', xml: 'xml', svg: 'xml' })[ext] || 'text/plain' };
}
function mimeType(path) {
    return ({ html: 'text/html', htm: 'text/html', css: 'text/css', js: 'text/javascript',
        mjs: 'text/javascript', cjs: 'text/javascript', json: 'application/json', svg: 'image/svg+xml',
        png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
        ico: 'image/x-icon', avif: 'image/avif', woff: 'font/woff', woff2: 'font/woff2',
        ttf: 'font/ttf', mp3: 'audio/mpeg', mp4: 'video/mp4', pdf: 'application/pdf',
        txt: 'text/plain', xml: 'application/xml' })[extension(path)] || 'application/octet-stream';
}
function parentPath(path) { return path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''; }
function safePath(raw) {
    const path = String(raw).replace(/\\/g, '/').replace(/\/$/, '');
    if (!path || path.startsWith('/') || /^[a-z]:/i.test(path) || /[\x00-\x1f\x7f]/.test(path) ||
        path.split('/').some(part => !part || part === '.' || part === '..')) {
        throw new Error('Đường dẫn không hợp lệ: ' + raw);
    }
    return path;
}
function ensureParents(path, targetFolders = folders, targetFiles = files) {
    let parent = parentPath(path);
    while (parent) {
        if (targetFiles[parent]) throw new Error('File đang chiếm đường dẫn thư mục: ' + parent);
        targetFolders.add(parent);
        parent = parentPath(parent);
    }
}
function validateProject(project) {
    const nextFiles = Object.create(null);
    const nextFolders = new Set();
    for (const name of project.folders || []) nextFolders.add(safePath(name));
    for (const [name, item] of Object.entries(project.files || {})) {
        const path = safePath(name);
        if (!item || (typeof item.content !== 'string' && typeof item.data !== 'string')) {
            throw new Error('Dữ liệu file không hợp lệ: ' + path);
        }
        nextFiles[path] = item;
    }
    for (const path of [...nextFolders, ...Object.keys(nextFiles)]) {
        ensureParents(path, nextFolders, nextFiles);
    }
    for (const path of nextFolders) if (nextFiles[path]) throw new Error('Trùng file và thư mục: ' + path);
    return { files: nextFiles, folders: [...nextFolders], currentFile: project.currentFile,
        expanded: project.expanded || [] };
}
function snapshot() {
    return { files, folders: [...folders], currentFile, expanded: [...expanded] };
}
function setSaveStatus(text, error = false) {
    $('save-status').textContent = text;
    $('save-status').classList.toggle('error', error);
}
function openStorage() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open('code-editor-lite', 1);
        request.onupgradeneeded = () => request.result.createObjectStore('projects');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
        request.onblocked = () => reject(new Error('Kho dữ liệu đang bị chặn bởi tab khác.'));
    });
}
function readProject() {
    return new Promise((resolve, reject) => {
        const request = db.transaction('projects').objectStore('projects').get('local');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}
function writeProject(project) {
    return new Promise((resolve, reject) => {
        const tx = db.transaction('projects', 'readwrite');
        tx.objectStore('projects').put(project, 'local');
        tx.oncomplete = resolve;
        tx.onerror = tx.onabort = () => reject(tx.error || new Error('Không thể lưu dự án.'));
    });
}
function persistFiles() {
    const version = ++revision;
    // structuredClone được thực hiện ngay lúc put, nên chụp dữ liệu trước khi xếp hàng.
    const project = JSON.parse(JSON.stringify(snapshot()));
    setSaveStatus('Đang lưu…');
    const pending = saveQueue.catch(() => {}).then(() => writeProject(project));
    saveQueue = pending;
    pending.then(() => {
        if (version !== revision) return;
        try { localStorage.removeItem(JOURNAL_KEY); } catch (_) { /* IDB đã lưu */ }
        setSaveStatus('Đã lưu trên máy');
    }).catch(error => {
        setSaveStatus('Chưa lưu được', true);
        showToast('Không thể lưu: ' + error.message, 6000);
    });
    return pending;
}
function journalCode() {
    // Nhật ký của duy nhất lần lưu đang chờ, không phải lịch sử backup.
    try {
        const pending = Object.assign(Object.create(null), JSON.parse(localStorage.getItem(JOURNAL_KEY) || '{}'));
        pending[currentFile] = files[currentFile].content;
        localStorage.setItem(JOURNAL_KEY, JSON.stringify(pending));
    } catch (_) { setSaveStatus('Đang lưu vào thiết bị…'); }
}
editor.on('change', () => {
    if (!currentFile || !files[currentFile] || files[currentFile].binary) return;
    files[currentFile].content = editor.getValue();
    journalCode();
    persistFiles();
    clearTimeout(searchTimeout);
    if ($('project-search').value) searchTimeout = setTimeout(renderTree, 200);
});
function saveCurrentEditorContent() {
    if (currentFile && files[currentFile] && !files[currentFile].binary) {
        files[currentFile].content = editor.getValue();
    }
}
function revealParents(path) {
    let parent = parentPath(path);
    while (parent) { expanded.add(parent); parent = parentPath(parent); }
}
function switchFile(path, { persist = true } = {}) {
    if (!files[path]) return;
    saveCurrentEditorContent();
    currentFile = path;
    selectedPath = path;
    selectedFolder = false;
    const item = files[path];
    let doc = documents.get(path);
    if (!doc) {
        doc = new CodeMirror.Doc(item.binary ? '' : item.content, parseFileMetadata(path).mode);
        documents.set(path, doc);
    }
    editor.swapDoc(doc);
    editor.setOption('readOnly', !!item.binary);
    editor.setOption('mode', parseFileMetadata(path).mode);
    $('current-path').textContent = path;
    $('editor-empty').hidden = !item.binary;
    $('editor-empty').textContent = 'Tài nguyên nhị phân — được giữ nguyên khi xuất ZIP.';
    for (const button of document.querySelectorAll('.editor-toolbar button')) button.disabled = !!item.binary;
    revealParents(path);
    renderTree();
    if (persist) persistFiles();
    if (matchMedia('(max-width: 700px)').matches) toggleTree(false);
    requestAnimationFrame(() => editor.refresh());
}
function showEmptyEditor() {
    currentFile = null;
    editor.swapDoc(new CodeMirror.Doc('', 'text/plain'));
    editor.setOption('readOnly', true);
    $('current-path').textContent = 'Chưa mở file';
    $('editor-empty').textContent = 'Chọn hoặc tạo file trong cây thư mục.';
    $('editor-empty').hidden = false;
    for (const button of document.querySelectorAll('.editor-toolbar button')) button.disabled = true;
}
function toggleTree(visible = document.body.classList.contains('tree-hidden')) {
    document.body.classList.toggle('tree-hidden', !visible);
    $('btn-toggle-tree').setAttribute('aria-expanded', String(visible));
    requestAnimationFrame(() => editor.refresh());
}
function selectRoot() {
    selectedPath = ''; selectedFolder = true;
    renderTree();
}
function renderTree() {
    const container = $('file-tree');
    container.replaceChildren();
    $('file-count').textContent = Object.keys(files).length + ' file';
    $('import-destination').textContent = 'Nhập vào: /' + (creationBase() || ' (gốc dự án)');
    $('project-root').classList.toggle('selected', !selectedPath);
    const query = $('project-search').value.trim().toLocaleLowerCase('vi');
    if (query) { renderSearch(container, query); return; }
    const root = { children: new Map() };
    const insert = (path, directory) => {
        let node = root;
        const parts = path.split('/');
        parts.forEach((part, i) => {
            if (!node.children.has(part)) node.children.set(part, { name: part, path: parts.slice(0, i + 1).join('/'), children: new Map(), directory: true });
            node = node.children.get(part);
        });
        node.directory = directory;
    };
    [...folders].forEach(path => insert(path, true));
    Object.keys(files).forEach(path => insert(path, false));
    const draw = (node, target, depth) => {
        const list = document.createElement('ul');
        list.className = 'tree-group';
        list.setAttribute('role', 'group');
        [...node.children.values()].sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name, 'vi')).forEach(child => {
            const row = document.createElement('button');
            row.className = 'tree-row';
            row.style.paddingLeft = (8 + depth * 18) + 'px';
            row.classList.toggle('selected', selectedPath === child.path);
            row.classList.toggle('current', currentFile === child.path);
            row.title = child.path;
            row.setAttribute('role', 'treeitem');
            row.setAttribute('aria-selected', String(selectedPath === child.path));
            if (child.directory) row.setAttribute('aria-expanded', String(expanded.has(child.path)));
            const icon = document.createElement('i');
            icon.className = child.directory ? 'fa-solid fa-folder' + (expanded.has(child.path) ? '-open' : '') : 'fa-regular fa-file-code';
            icon.setAttribute('aria-hidden', 'true');
            const label = document.createElement('span');
            label.className = 'tree-label'; label.textContent = child.name;
            row.append(icon, label);
            const li = document.createElement('li');
            li.setAttribute('role', 'none'); li.append(row); list.append(li);
            row.onclick = () => {
                if (!child.directory) return switchFile(child.path);
                selectedPath = child.path; selectedFolder = true;
                expanded.has(child.path) ? expanded.delete(child.path) : expanded.add(child.path);
                renderTree(); persistFiles();
            };
            if (child.directory && expanded.has(child.path)) draw(child, li, depth + 1);
        });
        target.append(list);
    };
    draw(root, container, 0);
    if (!folders.size && !Object.keys(files).length) container.textContent = 'Dự án trống. Tạo file, nhập thư mục hoặc ZIP.';
}
function renderSearch(container, query) {
    let count = 0;
    const result = (path, label, detail, action) => {
        const button = document.createElement('button'); button.className = 'search-result';
        button.textContent = label;
        const small = document.createElement('small'); small.textContent = detail;
        button.append(small); button.title = path; button.onclick = action;
        container.append(button); count++;
    };
    [...folders].sort().forEach(path => {
        if (!path.toLocaleLowerCase('vi').includes(query)) return;
        result(path, '📁 ' + path, 'Thư mục', () => {
            selectedPath = path; selectedFolder = true; revealParents(path); expanded.add(path);
            $('project-search').value = ''; renderTree(); persistFiles();
        });
    });
    Object.keys(files).sort().forEach(path => {
        const open = () => switchFile(path);
        if (path.toLocaleLowerCase('vi').includes(query)) result(path, path, 'Tên / đường dẫn file', open);
        if (files[path].binary) return;
        files[path].content.split('\n').forEach((line, index) => {
            const ch = line.toLocaleLowerCase('vi').indexOf(query);
            if (ch < 0) return;
            result(path, path + ':' + (index + 1), line.slice(Math.max(0, ch - 35), ch + query.length + 90), () => {
                open();
                editor.setSelection({ line: index, ch }, { line: index, ch: ch + query.length });
                editor.scrollIntoView({ line: index, ch }, 60); editor.focus();
            });
        });
    });
    if (!count) { const p = document.createElement('p'); p.className = 'empty-message'; p.textContent = 'Không tìm thấy kết quả.'; container.append(p); }
}
$('project-search').addEventListener('input', () => {
    clearTimeout(searchTimeout); searchTimeout = setTimeout(renderTree, 150);
});
function creationBase() { return selectedFolder ? selectedPath : parentPath(selectedPath); }
function askPath(label, initial) {
    const raw = prompt(label, initial);
    if (raw === null || !raw.trim()) return null;
    try { return safePath(raw.trim()); } catch (error) { alert(error.message); return null; }
}
function addNewFile() {
    const base = creationBase();
    const path = askPath('Đường dẫn file mới (VD: src/app.js):', (base ? base + '/' : '') + '');
    if (!path) return;
    if (files[path] || folders.has(path)) return alert('Đường dẫn này đã tồn tại.');
    try { ensureParents(path); } catch (error) { return alert(error.message); }
    files[path] = { content: '', binary: false };
    $('project-search').value = '';
    switchFile(path);
}
function addNewFolder() {
    const base = creationBase();
    const path = askPath('Đường dẫn thư mục mới:', base ? base + '/' : '');
    if (!path) return;
    if (files[path] || folders.has(path)) return alert('Đường dẫn này đã tồn tại.');
    try { ensureParents(path); } catch (error) { return alert(error.message); }
    folders.add(path); expanded.add(path); revealParents(path);
    selectedPath = path; selectedFolder = true;
    $('project-search').value = ''; persistFiles(); renderTree();
}
function renameSelected() {
    if (!selectedPath) return showToast('Chọn file hoặc thư mục cần đổi tên.');
    const old = selectedPath;
    const destination = askPath('Đường dẫn mới:', old);
    if (!destination || destination === old) return;
    if (selectedFolder && destination.startsWith(old + '/')) return alert('Không thể chuyển thư mục vào chính nó.');
    if (files[destination] || folders.has(destination)) return alert('Đường dẫn này đã tồn tại.');
    saveCurrentEditorContent();
    const belongs = path => path === old || (selectedFolder && path.startsWith(old + '/'));
    const move = path => belongs(path) ? destination + path.slice(old.length) : path;
    try {
        const renamed = Object.create(null);
        Object.entries(files).forEach(([path, item]) => { renamed[move(path)] = item; });
        const project = validateProject({ files: renamed, folders: [...folders].map(move) });
        files = project.files; folders = new Set(project.folders);
    } catch (error) { return alert(error.message); }
    const movedDocs = [...documents]; documents.clear();
    movedDocs.forEach(([path, doc]) => {
        documents.set(move(path), doc);
    });
    currentFile = currentFile ? move(currentFile) : null;
    selectedPath = destination; expanded = new Set([...expanded].map(move)); revealParents(destination);
    $('current-path').textContent = currentFile || 'Chưa mở file';
    if (currentFile) editor.setOption('mode', parseFileMetadata(currentFile).mode);
    persistFiles(); renderTree();
}
function deleteSelected() {
    if (!selectedPath) return showToast('Chọn file hoặc thư mục cần xóa.');
    const path = selectedPath;
    if (!confirm('Xóa ' + (selectedFolder ? 'thư mục và toàn bộ nội dung: ' : 'file: ') + path + '?')) return;
    const belongs = name => name === path || (selectedFolder && name.startsWith(path + '/'));
    Object.keys(files).forEach(name => { if (belongs(name)) { delete files[name]; documents.delete(name); } });
    folders = new Set([...folders].filter(name => !belongs(name)));
    expanded = new Set([...expanded].filter(name => !belongs(name)));
    if (currentFile && belongs(currentFile)) showEmptyEditor();
    selectedPath = parentPath(path); selectedFolder = true;
    persistFiles(); renderTree();
}
function clearCurrentCode() {
    if (!currentFile || files[currentFile].binary) return;
    if (!confirm('Xóa toàn bộ code trong file [' + currentFile + ']?')) return;
    // replaceRange giữ nguyên Undo/Redo của CodeMirror.
    editor.replaceRange('', { line: 0, ch: 0 }, editor.posFromIndex(editor.getValue().length), '+delete');
    editor.focus(); showToast('Đã xóa code. Có thể Undo.');
}
function openFolderPicker() {
    const input = $('folder-input');
    if (!('webkitdirectory' in input)) {
        return alert('Trình duyệt này chưa hỗ trợ chọn thư mục. Hãy nén thư mục thành ZIP rồi dùng Nhập ZIP.');
    }
    input.click();
}
function showImportResult(message, error = false) {
    const result = $('import-result');
    result.textContent = message;
    result.classList.toggle('error', error);
    result.hidden = false;
}
// Tạo bản sao để một lỗi đọc file / xung đột không làm nhập dở dang.
async function mergeImportedEntries(entries, base, overwrite) {
    if (entries.length > ZIP_MAX_FILE_COUNT * 2 || entries.filter(entry => !entry.directory).length > ZIP_MAX_FILE_COUNT) {
        throw new Error('Mỗi lần nhập tối đa 300 file và 600 mục gồm file/thư mục.');
    }
    const nextFiles = Object.assign(Object.create(null), files);
    const nextFolders = new Set(folders);
    const incomingPaths = new Set();
    const changedPaths = [];
    let added = 0, replaced = 0, skipped = 0, total = 0;
    for (const entry of entries) {
        const relative = safePath(entry.path);
        const path = safePath((base ? base + '/' : '') + relative);
        if (incomingPaths.has(path)) throw new Error('Nguồn nhập có đường dẫn trùng: ' + path);
        incomingPaths.add(path);
        if (entry.directory) {
            if (nextFiles[path]) throw new Error('File đang chiếm đường dẫn thư mục: ' + path);
            ensureParents(path, nextFolders, nextFiles);
            nextFolders.add(path);
            continue;
        }
        if (nextFolders.has(path)) throw new Error('Thư mục đang chiếm đường dẫn file: ' + path);
        ensureParents(path, nextFolders, nextFiles);
        if (entry.size > ZIP_MAX_SINGLE_FILE_BYTES) throw new Error('File lớn hơn 4 MB: ' + path);
        const bytes = await entry.read();
        total += bytes.length;
        if (bytes.length > ZIP_MAX_SINGLE_FILE_BYTES || total > ZIP_MAX_TOTAL_BYTES) {
            throw new Error('Vượt giới hạn 4 MB/file hoặc 25 MB tổng nội dung nhập.');
        }
        if (nextFiles[path] && !overwrite) { skipped++; continue; }
        const item = await makeFile(path, bytes);
        if (nextFiles[path]) replaced++; else added++;
        nextFiles[path] = item;
        changedPaths.push(path);
    }
    const project = validateProject({ files: nextFiles, folders: [...nextFolders] });
    return { project, changedPaths, added, replaced, skipped,
        addedFolders: project.folders.filter(path => !folders.has(path)) };
}
async function importIntoProject(input, label, loadEntries) {
    if (projectOperationInProgress) { input.value = ''; return showToast('Đang xử lý dự án. Vui lòng chờ.'); }
    const options = { base: creationBase(), overwrite: $('import-overwrite').checked,
        keepRoot: $('import-keep-root').checked };
    const main = document.querySelector('main');
    const previousInert = main.inert;
    const previousReadOnly = editor.getOption('readOnly');
    projectOperationInProgress = true;
    main.inert = true;
    editor.setOption('readOnly', true);
    saveCurrentEditorContent();
    setSaveStatus('Đang nhập…');
    showImportResult('Đang đọc ' + label.toLocaleLowerCase('vi') + '…');
    try {
        const entries = await loadEntries(options);
        if (!entries.length) throw new Error('Không tìm thấy file hoặc thư mục để nhập.');
        const result = await mergeImportedEntries(entries, options.base, options.overwrite);
        const { project, changedPaths, added, replaced, skipped, addedFolders } = result;
        const first = chooseImportedStartFile(changedPaths) || currentFile;
        const nextExpanded = new Set(expanded);
        for (const path of [...changedPaths, ...addedFolders]) {
            let parent = parentPath(path);
            while (parent) { nextExpanded.add(parent); parent = parentPath(parent); }
        }
        // Xếp sau mọi lần lưu cũ; chỉ thay dữ liệu trên màn hình khi transaction thành công.
        await saveQueue.catch(() => {});
        await writeProject({ ...project, currentFile: first || null, expanded: [...nextExpanded] });
        revision++;
        try { localStorage.removeItem(JOURNAL_KEY); } catch (_) { /* IDB đã lưu */ }
        // Bỏ doc cache của file đã thay, tránh hiển thị/lưu lại code cũ sau ghi đè.
        changedPaths.forEach(path => documents.delete(path));
        currentFile = null;
        files = project.files; folders = new Set(project.folders); expanded = nextExpanded;
        $('project-search').value = '';
        if (first) switchFile(first, { persist: false });
        else { showEmptyEditor(); renderTree(); }
        setSaveStatus('Đã lưu trên máy');
        const message = `Thêm ${added} file, ghi đè ${replaced}, bỏ qua ${skipped}` +
            (addedFolders.length ? `; thêm ${addedFolders.length} thư mục.` : '.');
        showImportResult(message);
        showToast(message, 5000);
    } catch (error) {
        setSaveStatus('Nhập chưa hoàn tất', true);
        showImportResult('Không thể nhập ' + label.toLocaleLowerCase('vi') + ': ' + error.message + ' Dự án hiện tại được giữ nguyên.', true);
        alert('Không thể nhập ' + label.toLocaleLowerCase('vi') + ': ' + error.message + '\nDự án hiện tại được giữ nguyên.');
    } finally {
        projectOperationInProgress = false;
        main.inert = previousInert;
        editor.setOption('readOnly', currentFile ? !!files[currentFile].binary : previousReadOnly);
        input.value = '';
    }
}
async function importFiles(event, directory = false) {
    const input = event.target;
    if (!input.files.length) return;
    const selectedFiles = Array.from(input.files);
    return importIntoProject(input, directory ? 'Thư mục' : 'File', async options => {
        return selectedFiles.map(file => {
            let path = directory ? file.webkitRelativePath : file.name;
            if (directory) {
                if (!path || !path.includes('/')) throw new Error('Trình duyệt không cung cấp đường dẫn thư mục. Hãy dùng Nhập ZIP.');
                path = safePath(path);
                if (!options.keepRoot) path = path.slice(path.indexOf('/') + 1);
            }
            return { path, size: file.size, read: async () => new Uint8Array(await file.arrayBuffer()) };
        });
    });
}
async function makeFile(path, bytes) {
    const text = TEXT_EXTENSIONS.has(extension(path)) || /^(readme|license)$/i.test(path.split('/').pop());
    if (text) {
        try { return { content: new TextDecoder('utf-8', { fatal: true }).decode(bytes), binary: false }; }
        catch (_) { /* Giữ byte gốc nếu văn bản không phải UTF-8. */ }
    }
    const data = await new Promise((resolve, reject) => {
        const reader = new FileReader(); reader.onload = () => resolve(reader.result.split(',')[1]);
        reader.onerror = () => reject(reader.error); reader.readAsDataURL(new Blob([bytes]));
    });
    return { data, binary: true };
}
function chooseImportedStartFile(names) {
    return names.find(name => name === 'index.html') || names.filter(name => /(^|\/)index\.html?$/i.test(name)).sort((a, b) => a.length - b.length)[0] || names.find(name => /\.html?$/i.test(name)) || names[0];
}
async function importZipProject(event) {
    const input = event.target;
    const archive = input.files[0];
    if (!archive) return;
    return importIntoProject(input, 'ZIP', async () => {
        if (typeof JSZip === 'undefined') throw new Error('Không tải được JSZip. Kiểm tra kết nối rồi mở lại ứng dụng.');
        if (archive.size > ZIP_MAX_ARCHIVE_BYTES) throw new Error('ZIP lớn hơn 30 MB.');
        const zip = await JSZip.loadAsync(archive);
        return Object.values(zip.files).map(entry => {
            // Không chấp nhận đường dẫn bị JSZip sửa do chứa ../.
            if (entry.unsafeOriginalName && entry.unsafeOriginalName !== entry.name) throw new Error('ZIP chứa đường dẫn không an toàn.');
            return { path: entry.name, directory: entry.dir, read: () => entry.async('uint8array') };
        });
    });
}
async function exportProjectZip() {
    if (projectOperationInProgress) return showToast('Đang xử lý dự án. Vui lòng chờ.');
    if (typeof JSZip === 'undefined') return alert('Không tải được JSZip. Kiểm tra kết nối rồi mở lại ứng dụng.');
    projectOperationInProgress = true;
    try {
        saveCurrentEditorContent();
        const zip = new JSZip();
        [...folders].forEach(path => zip.folder(path));
        Object.entries(files).forEach(([path, item]) => zip.file(path, item.binary ? item.data : item.content,
            { base64: !!item.binary, createFolders: true }));
        const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
        downloadBlobFile(blob, 'code-editor-lite.zip');
        showToast('Đã xuất ZIP.');
    } catch (error) { alert('Không thể xuất ZIP: ' + error.message); }
    finally { projectOperationInProgress = false; }
}
// Chạy hoàn toàn trong iframe có origin riêng; không cấp allow-same-origin.
function previewProject(project, entry) {
    const root = 'https://code-editor-lite.invalid/';
    const NativeURL = window.URL;
    const urls = Object.create(null);
    const cssCache = Object.create(null);
    const cssBuilding = new Set();
    const moduleAliases = new Map();
    const virtual = path => root + path.split('/').map(encodeURIComponent).join('/');
    let activeBase = virtual(entry);
    function resolve(ref, base = activeBase) {
        if (!ref || ref.startsWith('#') || /^(data:|blob:|javascript:|mailto:|tel:)/i.test(ref)) return null;
        const url = new NativeURL(ref, base);
        if (url.origin !== new NativeURL(root).origin) return null;
        let path;
        try { path = decodeURIComponent(url.pathname.slice(1)); } catch (_) { return null; }
        if (project[path + '/index.html']) path += '/index.html';
        return { path, url: url.href, hash: url.hash };
    }
    function mime(path) {
        return ({ html: 'text/html', htm: 'text/html', css: 'text/css', js: 'text/javascript', mjs: 'text/javascript',
            cjs: 'text/javascript', json: 'application/json', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg',
            jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', ico: 'image/x-icon',
            woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf', mp3: 'audio/mpeg',
            mp4: 'video/mp4', pdf: 'application/pdf', txt: 'text/plain', xml: 'application/xml' })[path.split('.').pop().toLowerCase()] || 'application/octet-stream';
    }
    const blobURL = (content, type) => NativeURL.createObjectURL(new Blob([content], { type }));
    function rewriteJS(code, path) {
        // Bỏ qua comment, chuỗi và template; chỉ đổi specifier import/export.
        const pattern = /\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|(?<![\w$.])import\.meta\.url|(?<![\w$.])import\s*\(\s*(['"])([^'"\n]+)\1|(?<![\w$.])(?:import|export)\s+(?:(?:(?![;'"`])[\s\S])*?\bfrom\s*)?(['"])([^'"\n]+)\3/g;
        return code.replace(pattern, (match, quote1, dynamic, quote2, specifier) => {
            if (match === 'import.meta.url') return JSON.stringify(virtual(path));
            const spec = dynamic || specifier;
            if (!spec || !/^(\.{1,2}\/|\/)/.test(spec)) return match;
            const target = resolve(spec, virtual(path));
            if (!target) return match;
            moduleAliases.set(target.url, target.path);
            const quote = quote1 || quote2;
            const at = match.lastIndexOf(quote + spec + quote);
            return match.slice(0, at) + JSON.stringify(target.url) + match.slice(at + spec.length + 2);
        });
    }
    for (const [path, file] of Object.entries(project)) {
        let data = file.content;
        if (file.binary) {
            const bytes = atob(file.data);
            data = Uint8Array.from(bytes, ch => ch.charCodeAt(0));
        } else if (/\.(?:m?js|cjs)$/i.test(path)) data = rewriteJS(data, path);
        urls[path] = blobURL(data, mime(path));
    }
    function resource(ref, base) {
        const target = resolve(ref, base);
        if (!target) return ref;
        if (!project[target.path]) return target.url;
        const url = /\.css$/i.test(target.path) ? stylesheet(target.path) : urls[target.path];
        return url + target.hash;
    }
    function rewriteCSS(code, base) {
        return code.replace(/\/\*[\s\S]*?\*\/|url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*?))\s*\)|@import\s+(["'])(.*?)\4/g,
            (match, double, single, plain, quote, imported) => {
                if (match.startsWith('/*')) return match;
                const ref = imported ?? double ?? single ?? plain;
                const url = resource(ref.trim(), base);
                return imported !== undefined ? '@import ' + JSON.stringify(url) : 'url(' + JSON.stringify(url) + ')';
            });
    }
    function stylesheet(path) {
        if (cssCache[path]) return cssCache[path];
        if (cssBuilding.has(path)) return 'data:text/css,'; // CSS bỏ qua vòng @import.
        cssBuilding.add(path);
        cssCache[path] = blobURL(rewriteCSS(project[path].content || '', virtual(path)), 'text/css');
        cssBuilding.delete(path);
        return cssCache[path];
    }
    // Tài nguyên tạo bằng fetch/XHR và new URL(..., import.meta.url).
    const nativeFetch = window.fetch.bind(window);
    window.fetch = (input, options) => {
        const ref = typeof input === 'string' || input instanceof NativeURL ? String(input) : input.url;
        const resolved = resource(ref, activeBase);
        return nativeFetch(typeof input === 'object' && !(input instanceof NativeURL) && resolved !== ref ? new Request(resolved, input) : resolved, options);
    };
    const open = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(method, url, ...args) { return open.call(this, method, resource(String(url), activeBase), ...args); };
    window.URL = class extends NativeURL {
        constructor(url, base) {
            const resolved = new NativeURL(url, base);
            super(resource(resolved.href, activeBase));
        }
    };
    function render(path) {
        const file = project[path];
        if (!file || file.binary) return;
        const doc = new DOMParser().parseFromString(file.content, 'text/html');
        const originalBase = doc.querySelector('base[href]');
        activeBase = originalBase ? new NativeURL(originalBase.getAttribute('href'), virtual(path)).href : virtual(path);
        doc.querySelectorAll('base').forEach(el => el.remove());
        const base = doc.createElement('base'); base.href = activeBase; doc.head.prepend(base);
        doc.querySelectorAll('[src], [href], [poster], [data], [xlink\\:href]').forEach(el => {
            for (const attr of ['src', 'href', 'poster', 'data', 'xlink:href']) {
                if (!el.hasAttribute(attr) || el === base) continue;
                const ref = el.getAttribute(attr);
                if (el.tagName === 'A' && attr === 'href') {
                    const target = resolve(ref, activeBase);
                    if (target && project[target.path] && /\.html?$/i.test(target.path)) {
                        el.setAttribute('href', target.url);
                        el.setAttribute('data-lite-page', target.path);
                        continue;
                    }
                }
                el.setAttribute(attr, resource(ref, activeBase));
            }
            // Byte thay đổi do sửa URL: integrity cũ không còn áp dụng với file nội bộ.
            if (el.hasAttribute('integrity') && (el.src?.startsWith('blob:') || el.href?.startsWith('blob:'))) el.removeAttribute('integrity');
        });
        doc.querySelectorAll('[srcset]').forEach(el => {
            // Giữ nguyên data URL có dấu phẩy.
            el.setAttribute('srcset', el.getAttribute('srcset').replace(/(^|,\s*)([^\s,]+)(\s+[^,]+)?/g,
                (match, prefix, ref, descriptor = '') => ref.startsWith('data:') ? match : prefix + resource(ref, activeBase) + descriptor));
        });
        doc.querySelectorAll('style').forEach(el => { el.textContent = rewriteCSS(el.textContent, activeBase); });
        doc.querySelectorAll('[style]').forEach(el => el.setAttribute('style', rewriteCSS(el.getAttribute('style'), activeBase)));
        doc.querySelectorAll('script[type="module"]:not([src])').forEach(el => { el.textContent = rewriteJS(el.textContent, path); });
        const imports = Object.create(null);
        for (const [name, url] of Object.entries(urls)) imports[virtual(name)] = url;
        for (const [alias, name] of moduleAliases) if (urls[name]) imports[alias] = urls[name];
        const importMap = doc.createElement('script'); importMap.type = 'importmap';
        importMap.textContent = JSON.stringify({ imports }).replace(/</g, '\\u003c');
        // Bổ sung vào importmap hiện có thay vì thay mapping của người dùng.
        const existingMap = doc.querySelector('script[type="importmap"]');
        if (existingMap) {
            const original = JSON.parse(existingMap.textContent);
            importMap.textContent = JSON.stringify({ ...original, imports: { ...imports, ...original.imports } }).replace(/</g, '\\u003c');
            existingMap.remove();
        }
        doc.head.insertBefore(importMap, base.nextSibling);
        const navigation = doc.createElement('script');
        navigation.textContent = `document.addEventListener('click', function(e) { const a = e.target.closest && e.target.closest('a[data-lite-page]'); if (a && !e.ctrlKey && !e.metaKey && !e.shiftKey) { e.preventDefault(); window.__liteNavigate(a.dataset.litePage); } });`;
        doc.head.insertBefore(navigation, importMap.nextSibling);
        document.open();
        document.write('<!DOCTYPE html>\n' + doc.documentElement.outerHTML);
        document.close();
    }
    window.__liteNavigate = render;
    render(entry);
}
function runCode() {
    saveCurrentEditorContent();
    const candidates = Object.keys(files).filter(path => /\.html?$/i.test(path) && !files[path].binary);
    const entry = candidates.includes(currentFile) ? currentFile : chooseImportedStartFile(candidates);
    if (!entry) return showToast('Tạo hoặc mở file HTML để RUN.');
    document.activeElement?.blur();
    closePreview();
    const iframe = document.createElement('iframe');
    iframe.id = 'preview'; iframe.title = 'Kết quả chạy HTML';
    iframe.setAttribute('sandbox', 'allow-scripts allow-forms allow-modals allow-downloads');
    iframe.referrerPolicy = 'no-referrer';
    const source = '(' + previewProject.toString() + ')(' + JSON.stringify(files) + ',' + JSON.stringify(entry) + ');';
    iframe.srcdoc = '<!doctype html><meta charset="utf-8"><script>' + source.replace(/<\/script/gi, '<\\/script') + '<\/script>';
    $('iframe-container').replaceChildren(iframe);
    $('preview-title').textContent = 'RUN · ' + entry;
    $('preview-overlay').hidden = false;
}
function closePreview() {
    $('preview-overlay').hidden = true;
    $('iframe-container').replaceChildren(); // Hủy context, script và blob của lần RUN cũ.
    requestAnimationFrame(() => editor.refresh());
}
window.addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
        event.preventDefault(); toggleTree(true); $('project-search').focus();
    }
    if (event.key === 'Escape') closePreview();
});
if (window.visualViewport) {
    const adjustViewport = () => {
        document.body.style.height = window.visualViewport.height + 'px';
        requestAnimationFrame(() => editor.refresh());
    };
    window.visualViewport.addEventListener('resize', adjustViewport);
    adjustViewport();
}
async function init() {
    try {
        db = await openStorage();
        let project = await readProject();
        if (!project) {
            const legacy = localStorage.getItem(STORAGE_KEY);
            project = legacy ? { files: JSON.parse(legacy), folders: [] } : { files: {}, folders: [] };
        }
        project = validateProject(project);
        const pending = JSON.parse(localStorage.getItem(JOURNAL_KEY) || '{}');
        Object.entries(pending).forEach(([path, content]) => {
            if (project.files[path] && !project.files[path].binary && typeof content === 'string') project.files[path].content = content;
        });
        files = project.files; folders = new Set(project.folders); expanded = new Set(project.expanded);
        const first = files[project.currentFile] ? project.currentFile : chooseImportedStartFile(Object.keys(files));
        if (first) switchFile(first); else { showEmptyEditor(); renderTree(); await persistFiles(); }
        toggleTree(true);
        if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
    } catch (error) {
        showEmptyEditor();
        setSaveStatus('Lỗi bộ nhớ', true);
        alert('Không thể mở dữ liệu trên thiết bị. Dữ liệu cũ chưa bị thay đổi.\n' + error.message);
    }
}
// Ngăn thao tác trước khi đọc xong kho dữ liệu.
document.querySelector('main').inert = true;
init().finally(() => { document.querySelector('main').inert = false; });
