const STORAGE_KEY = 'ios_editor_pro_files';
const BACKUP_STORAGE_KEY = 'ios_editor_pro_backups';
const MAX_BACKUPS = 12;

// Khởi tạo file mặc định ban đầu: chỉ có duy nhất file 'new'
let defaultFiles = {
    'new': {
        mode: 'javascript',
        content: '// Bắt đầu viết mã của bạn tại đây...\n'
    }
};

function cloneData(data) {
    return JSON.parse(JSON.stringify(data));
}

function loadStoredFiles() {
    try {
        const stored = localStorage.getItem(STORAGE_KEY);
        if (!stored) return cloneData(defaultFiles);

        const parsed = JSON.parse(stored);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return cloneData(defaultFiles);
        }

        const validNames = Object.keys(parsed).filter(name => {
            const item = parsed[name];
            return item && typeof item === 'object' && typeof item.content === 'string';
        });

        if (validNames.length === 0) return cloneData(defaultFiles);

        validNames.forEach(name => {
            if (!parsed[name].mode) {
                parsed[name].mode = parseFileMetadata(name).mode;
            }
        });

        return parsed;
    } catch (error) {
        console.error('Không thể đọc dữ liệu đã lưu:', error);
        return cloneData(defaultFiles);
    }
}

let files = loadStoredFiles();
let currentFile = Object.keys(files)[0] || 'new';

// Biến lưu độ lệch dòng để tính toán chính xác vị trí lỗi
let offsetHTML = 0;
let offsetJS = 0;
let navigationHighlightTimeout = null;
let toastTimeout = null;

// Version 1.3 - trạng thái xóa cụm code an toàn
let safeDeleteCandidate = null;
let safeDeleteHighlightedLines = [];
let lastSafeDeletion = null;
let safeDeleteUndoTimeout = null;

const editor = CodeMirror.fromTextArea(document.getElementById('code-editor'), {
    theme: 'dracula',
    lineNumbers: true,
    lineWrapping: true,
    indentUnit: 4,
    tabSize: 4,
    autoCloseBrackets: true,
    autoCloseTags: true,
    matchBrackets: true,
    styleActiveLine: true,
    extraKeys: {
        'Ctrl-Space': 'autocomplete',
        'Cmd-Space': 'autocomplete'
    }
});

function persistFiles() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(files));
}

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

function escapeHtml(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function formatDateTime(timestamp) {
    try {
        return new Intl.DateTimeFormat('vi-VN', {
            day: '2-digit',
            month: '2-digit',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit'
        }).format(new Date(timestamp));
    } catch (error) {
        return new Date(timestamp).toLocaleString();
    }
}

function updateToolsCurrentFile() {
    const label = document.getElementById('tools-current-file');
    if (!label) return;

    const lineCount = editor ? editor.lineCount() : 0;
    label.textContent = `${currentFile} • ${lineCount} dòng`;
}

// Hàm xoá bôi đỏ dòng lỗi
function clearErrorLines() {
    editor.eachLine(function (line) {
        editor.removeLineClass(line, 'background', 'error-line');
    });
}

function clearNavigationHighlight() {
    editor.eachLine(function (line) {
        editor.removeLineClass(line, 'background', 'tools-current-line-highlight');
    });
}

function jumpToLine(lineNumber, closePanelAfter = true) {
    const parsedLine = Number.parseInt(lineNumber, 10);
    const lineCount = editor.lineCount();

    if (!Number.isInteger(parsedLine) || parsedLine < 1 || parsedLine > lineCount) {
        showToast(`Số dòng phải từ 1 đến ${lineCount}`);
        return false;
    }

    const targetLine = parsedLine - 1;

    clearNavigationHighlight();
    clearTimeout(navigationHighlightTimeout);

    editor.setCursor({ line: targetLine, ch: 0 });
    editor.scrollIntoView(
        {
            from: { line: targetLine, ch: 0 },
            to: { line: targetLine, ch: editor.getLine(targetLine).length }
        },
        90
    );
    editor.addLineClass(targetLine, 'background', 'tools-current-line-highlight');

    navigationHighlightTimeout = setTimeout(() => {
        editor.removeLineClass(targetLine, 'background', 'tools-current-line-highlight');
    }, 2400);

    if (closePanelAfter) closeToolsPanel();

    setTimeout(() => {
        editor.refresh();
        editor.focus();
    }, 120);

    return true;
}

// --- TỐI ƯU HIỆU SUẤT LƯU FILE: DEBOUNCE ---
let saveTimeout;
editor.on('change', () => {
    clearErrorLines();
    clearTimeout(saveTimeout);

    saveTimeout = setTimeout(() => {
        if (files[currentFile]) {
            files[currentFile].content = editor.getValue();
            persistFiles();
            updateToolsCurrentFile();
        }
    }, 500);
});

// Kích hoạt gợi ý Code tự động
editor.on('inputRead', function (cm, change) {
    if (change.origin !== '+input' || change.text.length !== 1) return;

    const char = change.text[0];
    if (/[a-zA-Z.]/.test(char) || char === '<') {
        setTimeout(function () {
            if (!cm.state.completionActive) {
                cm.showHint({ completeSingle: false });
            }
        }, 100);
    }
});

// Lắng nghe tín hiệu Console và bắt lỗi từ iframe
window.addEventListener('message', function (event) {
    if (!event.data || !event.data.type) return;
    if (!['error', 'log'].includes(event.data.type)) return;

    const output = document.getElementById('console-output');
    if (!output) return;

    const div = document.createElement('div');
    div.className = event.data.type === 'error' ? 'console-error' : 'console-log';

    let displayLog = '> ' + event.data.log;

    if (event.data.type === 'error' && event.data.line) {
        const errorLine = Number.parseInt(event.data.line, 10);
        let actualLine = -1;
        const currentMode = files[currentFile] ? files[currentFile].mode : '';

        if (currentMode === 'javascript') {
            actualLine = errorLine - offsetJS - 1;
        } else if (currentMode === 'htmlmixed') {
            actualLine = errorLine - offsetHTML - 1;
        }

        if (actualLine >= 0 && actualLine < editor.lineCount()) {
            displayLog = '> Lỗi dòng ' + (actualLine + 1) + ': ' + event.data.log;
            editor.addLineClass(actualLine, 'background', 'error-line');
        }
    }

    div.textContent = displayLog;
    output.appendChild(div);
    output.scrollTop = output.scrollHeight;
});

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

// --- THUẬT TOÁN BÓC TÁCH FILE BẰNG lastIndexOf ---
function parseFileMetadata(fileName) {
    let baseName = fileName;
    let ext = '';
    let mode = 'javascript';

    const lastDotIndex = fileName.lastIndexOf('.');

    if (lastDotIndex > 0) {
        baseName = fileName.substring(0, lastDotIndex);
        ext = fileName.substring(lastDotIndex + 1).toLowerCase();
    }

    switch (ext) {
        case 'html':
        case 'htm':
            mode = 'htmlmixed';
            break;
        case 'css':
            mode = 'css';
            break;
        case 'js':
        case 'json':
        default:
            mode = 'javascript';
            break;
    }

    return {
        baseName,
        ext: ext ? `.${ext}` : '',
        mode
    };
}

function renderDropdown() {
    const selector = document.getElementById('file-selector');
    if (!selector) return;

    selector.innerHTML = '';

    Object.keys(files).forEach(fileName => {
        const option = document.createElement('option');
        option.value = fileName;
        option.innerText = fileName;
        option.selected = fileName === currentFile;
        selector.appendChild(option);
    });
}

function onFileSelectChange() {
    const selector = document.getElementById('file-selector');
    if (!selector) return;
    switchFile(selector.value);
}

function switchFile(fileName, options = {}) {
    if (!files[fileName]) {
        showToast('Không tìm thấy file cần mở');
        return;
    }

    const { skipSaveCurrent = false } = options;

    if (!skipSaveCurrent && files[currentFile]) {
        files[currentFile].content = editor.getValue();
        persistFiles();
    }

    currentFile = fileName;
    editor.setOption('mode', files[fileName].mode);
    editor.setValue(files[fileName].content);
    clearErrorLines();
    clearNavigationHighlight();
    renderDropdown();
    updateToolsCurrentFile();

    setTimeout(() => editor.refresh(), 50);
}

// --- QUẢN LÝ MENU ---
function toggleMenu() {
    const menu = document.getElementById('dropdown-menu');
    if (!menu) return;
    menu.classList.toggle('active');
}

function closeMenuOutside(event) {
    const menu = document.getElementById('dropdown-menu');
    const btnMenu = document.getElementById('btn-toggle-menu');

    if (!menu || !btnMenu || !menu.classList.contains('active')) return;

    if (!menu.contains(event.target) && !btnMenu.contains(event.target)) {
        menu.classList.remove('active');
    }
}

// --- COPY TOÀN BỘ CODE ---
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
            document.execCommand('copy');
            textarea.remove();
            showToast('Đã sao chép code!');
        } catch (fallbackError) {
            alert('Đã xảy ra lỗi khi copy: ' + fallbackError);
        }
    }
}

function addNewFile() {
    const menu = document.getElementById('dropdown-menu');
    if (menu) menu.classList.remove('active');

    let name = prompt('Tên file mới (VD: app.min.js, style.css):');
    if (!name) return;

    name = name.trim();
    if (!name) return;

    if (files[name]) {
        let counter = 1;
        const meta = parseFileMetadata(name);
        let newName = `${meta.baseName}_${counter}${meta.ext}`;

        while (files[newName]) {
            counter++;
            newName = `${meta.baseName}_${counter}${meta.ext}`;
        }

        name = newName;
    }

    const finalMeta = parseFileMetadata(name);
    files[name] = {
        mode: finalMeta.mode,
        content: ''
    };

    persistFiles();
    switchFile(name);
    showToast(`Đã tạo ${name}`);
}

function renameCurrentFile() {
    const menu = document.getElementById('dropdown-menu');
    if (menu) menu.classList.remove('active');

    files[currentFile].content = editor.getValue();

    let newName = prompt('Nhập tên mới cho file (VD: index.html, main.js):', currentFile);
    if (!newName) return;

    newName = newName.trim();
    if (!newName || newName === currentFile) return;

    if (files[newName]) {
        alert('Tên file này đã tồn tại!');
        return;
    }

    const oldName = currentFile;
    const meta = parseFileMetadata(newName);

    files[newName] = {
        mode: meta.mode,
        content: files[oldName].content
    };

    delete files[oldName];
    currentFile = newName;

    persistFiles();
    switchFile(currentFile, { skipSaveCurrent: true });
    showToast(`Đã đổi tên thành ${newName}`);
}

function deleteCurrentFile() {
    const menu = document.getElementById('dropdown-menu');
    if (menu) menu.classList.remove('active');

    if (Object.keys(files).length <= 1) {
        alert('Bạn phải giữ lại ít nhất một file hệ thống.');
        return;
    }

    const fileToDelete = currentFile;
    const lineCount = editor.lineCount();

    if (!confirm(`Bạn có chắc muốn xoá file [${fileToDelete}]?\n\nFile có ${lineCount} dòng code.`)) {
        return;
    }

    createBackupSnapshot(`Trước khi xoá ${fileToDelete}`, false);

    delete files[fileToDelete];
    currentFile = Object.keys(files)[0];

    persistFiles();
    renderDropdown();
    switchFile(currentFile, { skipSaveCurrent: true });
    showToast(`Đã xoá ${fileToDelete}`);
}

function clearCurrentCode() {
    if (!confirm(`Xoá toàn bộ code trong file [${currentFile}]?`)) return;

    createBackupSnapshot(`Trước khi xoá nội dung ${currentFile}`, false);

    editor.setValue('');
    files[currentFile].content = '';
    persistFiles();
    clearErrorLines();
    showToast('Đã xoá nội dung file');
}

function resetAllData() {
    const menu = document.getElementById('dropdown-menu');
    if (menu) menu.classList.remove('active');

    const warning = 'CẢNH BÁO: Hành động này sẽ xoá sạch TẤT CẢ các file hiện tại.\n\nMột bản sao lưu sẽ được tạo trước khi xoá.\n\nTiếp tục?';

    if (confirm(warning)) {
        createBackupSnapshot('Trước khi khôi phục App', false);
        localStorage.removeItem(STORAGE_KEY);
        location.reload();
    }
}

// --- TỐI ƯU TRẢI NGHIỆM DÁN TRÊN IOS ---
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

async function importFiles(event) {
    const menu = document.getElementById('dropdown-menu');
    if (menu) menu.classList.remove('active');

    const uploadedFiles = event.target.files;
    if (uploadedFiles.length === 0) return;

    createBackupSnapshot('Trước khi nhập file', false);

    const readPromises = Array.from(uploadedFiles).map(file => {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();

            reader.onload = e => {
                const content = e.target.result;
                let fileName = file.name;

                if (files[fileName]) {
                    let counter = 1;
                    const meta = parseFileMetadata(fileName);
                    let newName = `${meta.baseName}_${counter}${meta.ext}`;

                    while (files[newName]) {
                        counter++;
                        newName = `${meta.baseName}_${counter}${meta.ext}`;
                    }

                    fileName = newName;
                }

                const metaFinal = parseFileMetadata(fileName);
                files[fileName] = {
                    mode: metaFinal.mode,
                    content
                };

                resolve(fileName);
            };

            reader.onerror = () => reject(new Error(`Không thể đọc ${file.name}`));
            reader.readAsText(file);
        });
    });

    try {
        const importedNames = await Promise.all(readPromises);
        const lastFileName = importedNames[importedNames.length - 1];

        if (files.new && Object.keys(files).length > 1 && files.new.content.trim().startsWith('// Bắt đầu viết mã')) {
            delete files.new;
        }

        currentFile = files[lastFileName] ? lastFileName : Object.keys(files)[0];

        persistFiles();
        event.target.value = '';
        renderDropdown();
        switchFile(currentFile, { skipSaveCurrent: true });
        showToast(`Đã nhập ${uploadedFiles.length} file`);
    } catch (error) {
        event.target.value = '';
        alert(error.message);
    }
}

function exportFiles() {
    const menu = document.getElementById('dropdown-menu');
    if (menu) menu.classList.remove('active');

    files[currentFile].content = editor.getValue();
    persistFiles();

    const exportAll = confirm('Xuất TẤT CẢ các file (OK) hay chỉ file hiện tại (Cancel)?');

    if (exportAll) {
        let delay = 0;

        Object.keys(files).forEach(fileName => {
            setTimeout(() => {
                downloadSingleFile(fileName, files[fileName].content);
            }, delay);

            delay += 400;
        });
    } else {
        downloadSingleFile(currentFile, files[currentFile].content);
    }
}

// --- FIX LỖI IOS GẮN ĐUÔI .TXT ---
function downloadSingleFile(filename, content) {
    let mimeType = 'text/plain';

    if (filename.endsWith('.html') || filename.endsWith('.htm')) {
        mimeType = 'text/html';
    } else if (filename.endsWith('.css')) {
        mimeType = 'text/css';
    } else if (filename.endsWith('.js')) {
        mimeType = 'text/javascript';
    } else if (filename.endsWith('.json')) {
        mimeType = 'application/json';
    }

    const blob = new Blob([content], {
        type: `${mimeType};charset=utf-8`
    });

    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');

    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);

    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function toggleConsole() {
    const virtualConsole = document.getElementById('virtual-console');
    if (!virtualConsole) return;
    virtualConsole.classList.toggle('active');
}

function closePreview() {
    const overlay = document.getElementById('preview-overlay');
    const iframe = document.getElementById('preview');

    if (!overlay || !iframe) return;

    overlay.classList.remove('active');

    const virtualConsole = document.getElementById('virtual-console');
    if (virtualConsole) virtualConsole.classList.remove('active');

    if (iframe.src && iframe.src.startsWith('blob:')) {
        URL.revokeObjectURL(iframe.src);
    }

    iframe.src = 'about:blank';

    setTimeout(() => {
        editor.refresh();
        editor.focus();
    }, 450);
}

function runCode() {
    closeToolsPanel();

    if (document.activeElement && typeof document.activeElement.blur === 'function') {
        document.activeElement.blur();
    }

    if (editor) {
        editor.getInputField().blur();
    }

    files[currentFile].content = editor.getValue();
    persistFiles();
    clearErrorLines();

    const overlay = document.getElementById('preview-overlay');
    const iframeContainer = document.getElementById('iframe-container');

    if (!overlay || !iframeContainer) return;

    overlay.classList.add('active');

    const consoleOutput = document.getElementById('console-output');
    if (consoleOutput) consoleOutput.innerHTML = '';

    let htmlContent = '';

    if (files['index.html']) {
        htmlContent = files['index.html'].content;
    } else {
        const firstHtml = Object.keys(files).find(name => name.toLowerCase().endsWith('.html'));
        htmlContent = firstHtml ? files[firstHtml].content : '<body></body>';
    }

    let cssContent = '';
    let jsContent = '';

    Object.keys(files).forEach(fileName => {
        const lowerName = fileName.toLowerCase();
        const isCSS = lowerName.endsWith('.css') || files[fileName].mode === 'css';
        const isJS = lowerName.endsWith('.js') || files[fileName].mode === 'javascript';

        if (isCSS) {
            cssContent += `\n/* File: ${fileName} */\n${files[fileName].content}`;
        }

        if (isJS) {
            jsContent += `\n// File: ${fileName}\n${files[fileName].content}`;
        }
    });

    const consoleInterceptor = `
        <script>
            window.onerror = function(message, source, lineno, colno, error) {
                window.parent.postMessage({ type: 'error', log: message, line: lineno }, '*');
                return true;
            };

            window.addEventListener('unhandledrejection', function(event) {
                var reason = event.reason && event.reason.message
                    ? event.reason.message
                    : String(event.reason);

                window.parent.postMessage({ type: 'error', log: reason }, '*');
            });

            const originalLog = console.log;
            console.log = function(...args) {
                const msg = args.map(a => {
                    try {
                        return typeof a === 'object' ? JSON.stringify(a) : String(a);
                    } catch (error) {
                        return String(a);
                    }
                }).join(' ');

                window.parent.postMessage({ type: 'log', log: msg }, '*');
                originalLog.apply(console, args);
            };

            const originalError = console.error;
            console.error = function(...args) {
                const msg = args.map(a => {
                    try {
                        return typeof a === 'object' ? JSON.stringify(a) : String(a);
                    } catch (error) {
                        return String(a);
                    }
                }).join(' ');

                window.parent.postMessage({ type: 'error', log: msg }, '*');
                originalError.apply(console, args);
            };
        <\/script>
    `;

    const headPart = [
        '<!DOCTYPE html>',
        '<html>',
        '<head>',
        '<meta charset="UTF-8">',
        '<meta name="viewport" content="width=device-width, initial-scale=1.0">',
        consoleInterceptor,
        '<style>',
        cssContent,
        '</style>',
        '</head>',
        '<body>'
    ].join('\n');

    const bodyPart = htmlContent + '\n<script>\n';

    offsetHTML = headPart.split('\n').length;
    offsetJS = offsetHTML + bodyPart.split('\n').length - 1;

    const finalSource =
        headPart +
        '\n' +
        htmlContent +
        `\n<script>\n${jsContent}\n<\/script>\n</body>\n</html>`;

    const blob = new Blob([finalSource], { type: 'text/html' });
    const url = URL.createObjectURL(blob);

    const oldIframe = document.getElementById('preview');

    if (oldIframe) {
        if (oldIframe.src && oldIframe.src.startsWith('blob:')) {
            URL.revokeObjectURL(oldIframe.src);
        }

        oldIframe.remove();
    }

    const newIframe = document.createElement('iframe');
    newIframe.id = 'preview';
    newIframe.src = url;
    iframeContainer.appendChild(newIframe);
}

/* =========================================================
   VERSION 1.2 - QUICK EDIT TOOLS
   ========================================================= */

function openToolsPanel() {
    const menu = document.getElementById('dropdown-menu');
    const panel = document.getElementById('tools-panel');
    const backdrop = document.getElementById('tools-backdrop');

    if (menu) menu.classList.remove('active');
    if (!panel || !backdrop) return;

    files[currentFile].content = editor.getValue();
    persistFiles();

    updateToolsCurrentFile();
    showToolsHome();

    panel.classList.add('active');
    backdrop.classList.add('active');
    panel.setAttribute('aria-hidden', 'false');
    backdrop.setAttribute('aria-hidden', 'false');
    document.body.classList.add('tools-panel-open');
}

function closeToolsPanel() {
    clearSafeDeleteHighlight();

    const panel = document.getElementById('tools-panel');
    const backdrop = document.getElementById('tools-backdrop');

    if (panel) {
        panel.classList.remove('active');
        panel.setAttribute('aria-hidden', 'true');
    }

    if (backdrop) {
        backdrop.classList.remove('active');
        backdrop.setAttribute('aria-hidden', 'true');
    }

    document.body.classList.remove('tools-panel-open');

    setTimeout(() => editor.refresh(), 80);
}

function showToolsHome() {
    const homeView = document.getElementById('tools-home-view');
    const detailView = document.getElementById('tools-detail-view');

    if (homeView) homeView.classList.add('active');
    if (detailView) detailView.classList.remove('active');
}

function showToolsDetail(title, contentHtml) {
    const homeView = document.getElementById('tools-home-view');
    const detailView = document.getElementById('tools-detail-view');
    const titleElement = document.getElementById('tools-detail-title');
    const contentElement = document.getElementById('tools-detail-content');

    if (!detailView || !titleElement || !contentElement) return;

    if (homeView) homeView.classList.remove('active');
    detailView.classList.add('active');
    titleElement.textContent = title;
    contentElement.innerHTML = contentHtml;
}

function getEditorLines() {
    return editor.getValue().split('\n');
}

function openSearchTool() {
    showToolsDetail(
        'Tìm code',
        `
            <div class="tools-form">
                <div class="tools-input-group">
                    <label class="tools-input-label" for="tools-search-input">Từ khóa cần tìm</label>
                    <input
                        id="tools-search-input"
                        class="tools-input"
                        type="search"
                        placeholder="Ví dụ: runCode, .btn-run, preview-overlay"
                        autocomplete="off"
                    >
                </div>

                <label style="display:flex; align-items:center; gap:9px; color:var(--text-muted); font-size:14px;">
                    <input id="tools-search-case" type="checkbox" style="width:18px; height:18px;">
                    Phân biệt chữ hoa và chữ thường
                </label>

                <div class="tools-button-row">
                    <button id="tools-search-submit" class="tools-primary-btn" type="button">
                        <i class="fa-solid fa-magnifying-glass"></i>
                        Tìm kiếm
                    </button>
                </div>
            </div>

            <div id="tools-search-summary" class="tools-result-summary">
                Nhập tên hàm, ID, class hoặc đoạn chữ cần tìm.
            </div>

            <div id="tools-search-results" class="tools-list-results"></div>
        `
    );

    const input = document.getElementById('tools-search-input');
    const submit = document.getElementById('tools-search-submit');

    if (submit) submit.addEventListener('click', performCodeSearch);

    if (input) {
        input.addEventListener('keydown', event => {
            if (event.key === 'Enter') {
                event.preventDefault();
                performCodeSearch();
            }
        });

        setTimeout(() => input.focus(), 100);
    }
}

function performCodeSearch() {
    const input = document.getElementById('tools-search-input');
    const caseCheckbox = document.getElementById('tools-search-case');
    const summary = document.getElementById('tools-search-summary');
    const resultsContainer = document.getElementById('tools-search-results');

    if (!input || !summary || !resultsContainer) return;

    const query = input.value.trim();
    const caseSensitive = Boolean(caseCheckbox && caseCheckbox.checked);

    resultsContainer.innerHTML = '';

    if (!query) {
        summary.textContent = 'Vui lòng nhập từ khóa cần tìm.';
        return;
    }

    const lines = getEditorLines();
    const normalizedQuery = caseSensitive ? query : query.toLowerCase();
    const results = [];

    lines.forEach((line, index) => {
        const normalizedLine = caseSensitive ? line : line.toLowerCase();

        if (normalizedLine.includes(normalizedQuery)) {
            results.push({
                line: index + 1,
                content: line.trim() || '(dòng trống)'
            });
        }
    });

    summary.textContent = results.length > 0
        ? `Tìm thấy ${results.length} kết quả trong ${currentFile}.`
        : `Không tìm thấy “${query}” trong ${currentFile}.`;

    if (results.length === 0) {
        resultsContainer.innerHTML = `
            <div class="tools-empty-state">
                <i class="fa-solid fa-magnifying-glass"></i>
                <strong>Không có kết quả</strong>
                <p>Thử dùng từ khóa ngắn hơn hoặc tắt phân biệt chữ hoa và chữ thường.</p>
            </div>
        `;
        return;
    }

    results.slice(0, 200).forEach(result => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'tools-result-item';
        button.innerHTML = `
            <span class="tools-result-line">${result.line}</span>
            <span class="tools-result-main">
                <span class="tools-result-title">Dòng ${result.line}</span>
                <span class="tools-result-preview">${escapeHtml(result.content)}</span>
            </span>
            <i class="fa-solid fa-chevron-right tools-card-arrow"></i>
        `;

        button.addEventListener('click', () => jumpToLine(result.line));
        resultsContainer.appendChild(button);
    });

    if (results.length > 200) {
        const notice = document.createElement('div');
        notice.className = 'tools-result-summary';
        notice.textContent = `Đang hiển thị 200/${results.length} kết quả đầu tiên. Hãy nhập từ khóa cụ thể hơn.`;
        resultsContainer.appendChild(notice);
    }
}

function openGoToLineTool() {
    const lineCount = editor.lineCount();
    const currentCursorLine = editor.getCursor().line + 1;

    showToolsDetail(
        'Đi tới dòng',
        `
            <div class="tools-form">
                <div class="tools-input-group">
                    <label class="tools-input-label" for="tools-line-input">
                        Số dòng từ 1 đến ${lineCount}
                    </label>
                    <input
                        id="tools-line-input"
                        class="tools-input"
                        type="number"
                        inputmode="numeric"
                        min="1"
                        max="${lineCount}"
                        value="${currentCursorLine}"
                    >
                </div>

                <button id="tools-line-submit" class="tools-primary-btn" type="button">
                    <i class="fa-solid fa-location-crosshairs"></i>
                    Mở dòng này
                </button>
            </div>

            <div class="tools-result-summary">
                File <strong>${escapeHtml(currentFile)}</strong> hiện có ${lineCount} dòng.
            </div>
        `
    );

    const input = document.getElementById('tools-line-input');
    const submit = document.getElementById('tools-line-submit');

    const goToLine = () => {
        if (input) jumpToLine(input.value);
    };

    if (submit) submit.addEventListener('click', goToLine);

    if (input) {
        input.addEventListener('keydown', event => {
            if (event.key === 'Enter') {
                event.preventDefault();
                goToLine();
            }
        });

        setTimeout(() => {
            input.focus();
            input.select();
        }, 100);
    }
}

function parseCodeRegions() {
    const lines = getEditorLines();
    const regions = [];

    const addRegion = (title, line) => {
        const cleanTitle = title
            .replace(/^[-=/*#!<>\s]+/, '')
            .replace(/[-=/*#!<>\s]+$/, '')
            .trim();

        if (!cleanTitle) return;

        const key = `${cleanTitle.toLowerCase()}-${line}`;
        if (regions.some(region => region.key === key)) return;

        regions.push({
            key,
            title: cleanTitle,
            line
        });
    };

    lines.forEach((line, index) => {
        const singleLineMatch = line.match(/^\s*\/\/\s*[-=]{3,}\s*(.*?)\s*[-=]{3,}\s*$/);
        if (singleLineMatch) {
            addRegion(singleLineMatch[1], index + 1);
            return;
        }

        const blockSingleMatch = line.match(/^\s*\/\*\s*[-=]{3,}\s*(.*?)\s*[-=]{3,}\s*\*\/\s*$/);
        if (blockSingleMatch) {
            addRegion(blockSingleMatch[1], index + 1);
            return;
        }

        const htmlSingleMatch = line.match(/^\s*<!--\s*[-=]{3,}\s*(.*?)\s*[-=]{3,}\s*-->\s*$/);
        if (htmlSingleMatch) {
            addRegion(htmlSingleMatch[1], index + 1);
            return;
        }

        if (/^\s*\/\*\s*[-=]{3,}\s*$/.test(line)) {
            for (let lookAhead = index + 1; lookAhead <= Math.min(index + 3, lines.length - 1); lookAhead++) {
                const candidate = lines[lookAhead]
                    .replace(/^\s*\*?\s*/, '')
                    .replace(/\s*\*\/\s*$/, '')
                    .trim();

                if (candidate && !/^[-=]+$/.test(candidate)) {
                    addRegion(candidate, index + 1);
                    break;
                }
            }
        }

        if (/^\s*<!--\s*[-=]{3,}\s*$/.test(line)) {
            for (let lookAhead = index + 1; lookAhead <= Math.min(index + 3, lines.length - 1); lookAhead++) {
                const candidate = lines[lookAhead]
                    .replace(/^\s*/, '')
                    .replace(/\s*-->\s*$/, '')
                    .trim();

                if (candidate && !/^[-=]+$/.test(candidate)) {
                    addRegion(candidate, index + 1);
                    break;
                }
            }
        }
    });

    return regions;
}

function openRegionNavigator() {
    const regions = parseCodeRegions();

    if (regions.length === 0) {
        showToolsDetail(
            'Khu vực code',
            `
                <div class="tools-empty-state">
                    <i class="fa-solid fa-layer-group"></i>
                    <strong>Chưa tìm thấy khu vực</strong>
                    <p>
                        App nhận diện các tiêu đề dạng
                        <code>// --- QUẢN LÝ FILE ---</code>
                        hoặc các khối comment phân cách bằng dấu =.
                    </p>
                </div>
            `
        );
        return;
    }

    showToolsDetail(
        'Khu vực code',
        `
            <div class="tools-result-summary">
                Tìm thấy ${regions.length} khu vực trong ${escapeHtml(currentFile)}.
            </div>
            <div id="tools-region-results" class="tools-list-results"></div>
        `
    );

    const container = document.getElementById('tools-region-results');
    if (!container) return;

    regions.forEach(region => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'tools-result-item';
        button.innerHTML = `
            <span class="tools-result-line">${region.line}</span>
            <span class="tools-result-main">
                <span class="tools-result-title">${escapeHtml(region.title)}</span>
                <span class="tools-result-preview">Bắt đầu tại dòng ${region.line}</span>
            </span>
            <i class="fa-solid fa-chevron-right tools-card-arrow"></i>
        `;

        button.addEventListener('click', () => jumpToLine(region.line));
        container.appendChild(button);
    });
}

function parseFunctions() {
    const lines = getEditorLines();
    const found = [];
    const known = new Set();

    const patterns = [
        {
            type: 'function',
            regex: /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/
        },
        {
            type: 'function expression',
            regex: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?function\s*\(/
        },
        {
            type: 'arrow function',
            regex: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/
        }
    ];

    lines.forEach((line, index) => {
        for (const pattern of patterns) {
            const match = line.match(pattern.regex);
            if (!match) continue;

            const name = match[1];
            const key = `${name}-${index + 1}`;

            if (!known.has(key)) {
                known.add(key);
                found.push({
                    name,
                    type: pattern.type,
                    line: index + 1,
                    preview: line.trim()
                });
            }

            break;
        }
    });

    return found;
}

function openFunctionNavigator() {
    const functions = parseFunctions();

    if (functions.length === 0) {
        showToolsDetail(
            'Danh sách hàm',
            `
                <div class="tools-empty-state">
                    <i class="fa-solid fa-code"></i>
                    <strong>Không tìm thấy hàm</strong>
                    <p>
                        File hiện tại có thể không phải JavaScript hoặc đang dùng cú pháp mà bộ quét chưa nhận diện.
                    </p>
                </div>
            `
        );
        return;
    }

    showToolsDetail(
        'Danh sách hàm',
        `
            <div class="tools-result-summary">
                Tìm thấy ${functions.length} hàm trong ${escapeHtml(currentFile)}.
            </div>
            <div id="tools-function-results" class="tools-list-results"></div>
        `
    );

    const container = document.getElementById('tools-function-results');
    if (!container) return;

    functions.forEach(item => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'tools-result-item';
        button.innerHTML = `
            <span class="tools-result-line">${item.line}</span>
            <span class="tools-result-main">
                <span class="tools-result-title">${escapeHtml(item.name)}()</span>
                <span class="tools-result-preview">${escapeHtml(item.preview)}</span>
            </span>
            <i class="fa-solid fa-chevron-right tools-card-arrow"></i>
        `;

        button.addEventListener('click', () => jumpToLine(item.line));
        container.appendChild(button);
    });
}

function loadBackups() {
    try {
        const stored = localStorage.getItem(BACKUP_STORAGE_KEY);
        if (!stored) return [];

        const parsed = JSON.parse(stored);
        return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
        console.error('Không thể đọc lịch sử sao lưu:', error);
        return [];
    }
}

function saveBackups(backups) {
    localStorage.setItem(BACKUP_STORAGE_KEY, JSON.stringify(backups));
}

function createBackupSnapshot(label = 'Sao lưu thủ công', showMessage = true) {
    if (files[currentFile]) {
        files[currentFile].content = editor.getValue();
        persistFiles();
    }

    const backups = loadBackups();
    const timestamp = Date.now();

    backups.unshift({
        id: `${timestamp}-${Math.random().toString(36).slice(2, 8)}`,
        createdAt: timestamp,
        label,
        currentFile,
        files: cloneData(files)
    });

    const limitedBackups = backups.slice(0, MAX_BACKUPS);

    try {
        saveBackups(limitedBackups);

        if (showMessage) {
            showToast('Đã tạo bản sao lưu');
        }

        return true;
    } catch (error) {
        console.error('Không thể tạo bản sao lưu:', error);

        if (showMessage) {
            alert('Không thể tạo bản sao lưu. Bộ nhớ trình duyệt có thể đã đầy.');
        }

        return false;
    }
}

function createManualBackup() {
    const success = createBackupSnapshot('Sao lưu thủ công', true);

    if (success) {
        updateToolsCurrentFile();
    }
}

function openBackupHistory() {
    const backups = loadBackups();

    if (backups.length === 0) {
        showToolsDetail(
            'Lịch sử sao lưu',
            `
                <div class="tools-empty-state">
                    <i class="fa-solid fa-clock-rotate-left"></i>
                    <strong>Chưa có bản sao lưu</strong>
                    <p>Hãy chọn “Tạo bản sao lưu” trước khi thực hiện thay đổi lớn.</p>
                </div>
            `
        );
        return;
    }

    showToolsDetail(
        'Lịch sử sao lưu',
        `
            <div class="tools-result-summary">
                Đang lưu ${backups.length}/${MAX_BACKUPS} phiên bản gần nhất.
            </div>
            <div id="tools-backup-results" class="tools-list-results"></div>
        `
    );

    const container = document.getElementById('tools-backup-results');
    if (!container) return;

    backups.forEach(backup => {
        const fileCount = backup.files && typeof backup.files === 'object'
            ? Object.keys(backup.files).length
            : 0;

        const item = document.createElement('div');
        item.className = 'tools-backup-item';
        item.innerHTML = `
            <div class="tools-backup-info">
                <strong>${escapeHtml(backup.label || 'Bản sao lưu')}</strong>
                <small>${escapeHtml(formatDateTime(backup.createdAt))} • ${fileCount} file</small>
            </div>
            <button class="tools-backup-restore" type="button">Khôi phục</button>
        `;

        const restoreButton = item.querySelector('.tools-backup-restore');
        restoreButton.addEventListener('click', () => restoreBackup(backup.id));

        container.appendChild(item);
    });
}

function restoreBackup(backupId) {
    const backups = loadBackups();
    const backup = backups.find(item => item.id === backupId);

    if (!backup || !backup.files) {
        alert('Không tìm thấy bản sao lưu này.');
        return;
    }

    const backupDate = formatDateTime(backup.createdAt);
    const message = `Khôi phục bản sao lưu ngày ${backupDate}?\n\nDữ liệu hiện tại sẽ được sao lưu thêm một bản trước khi khôi phục.`;

    if (!confirm(message)) return;

    createBackupSnapshot('Trước khi khôi phục phiên bản cũ', false);

    files = cloneData(backup.files);
    currentFile = files[backup.currentFile]
        ? backup.currentFile
        : Object.keys(files)[0];

    persistFiles();
    renderDropdown();
    switchFile(currentFile, { skipSaveCurrent: true });
    closeToolsPanel();
    showToast('Đã khôi phục bản sao lưu');
}

// =========================================================
// VERSION 1.3 - XÓA CỤM CODE AN TOÀN
// =========================================================

function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function compareEditorPositions(first, second) {
    if (first.line !== second.line) {
        return first.line - second.line;
    }
    return first.ch - second.ch;
}

function normalizeEditorRange(from, to) {
    if (compareEditorPositions(from, to) <= 0) {
        return {
            from: { line: from.line, ch: from.ch },
            to: { line: to.line, ch: to.ch }
        };
    }

    return {
        from: { line: to.line, ch: to.ch },
        to: { line: from.line, ch: from.ch }
    };
}

function clearSafeDeleteHighlight() {
    safeDeleteHighlightedLines.forEach(lineNumber => {
        if (lineNumber >= 0 && lineNumber < editor.lineCount()) {
            editor.removeLineClass(
                lineNumber,
                'background',
                'safe-delete-selected-line'
            );
        }
    });

    safeDeleteHighlightedLines = [];
}

function highlightSafeDeleteCandidate(candidate) {
    clearSafeDeleteHighlight();
    if (!candidate) return;

    const firstLine = candidate.from.line;
    const finalLine = Math.min(
        candidate.to.ch === 0
            ? candidate.to.line - 1
            : candidate.to.line,
        editor.lineCount() - 1
    );

    for (let line = firstLine; line <= finalLine; line++) {
        if (line < 0) continue;

        editor.addLineClass(
            line,
            'background',
            'safe-delete-selected-line'
        );
        safeDeleteHighlightedLines.push(line);
    }

    editor.scrollIntoView(
        { from: candidate.from, to: candidate.to },
        80
    );
}

function createSafeDeleteCandidate(from, to, type, label) {
    const normalized = normalizeEditorRange(from, to);
    const text = editor.getRange(normalized.from, normalized.to);

    if (!text) return null;

    const lastIncludedLine =
        normalized.to.ch === 0 &&
        normalized.to.line > normalized.from.line
            ? normalized.to.line
            : normalized.to.line + 1;

    return {
        fileName: currentFile,
        type,
        label,
        from: normalized.from,
        to: normalized.to,
        text,
        startLine: normalized.from.line + 1,
        endLine: Math.max(
            normalized.from.line + 1,
            lastIncludedLine
        )
    };
}

function getSelectionSafeDeleteCandidate() {
    if (!editor.somethingSelected()) return null;

    return createSafeDeleteCandidate(
        editor.getCursor('from'),
        editor.getCursor('to'),
        'selection',
        'Đoạn đang bôi đen'
    );
}

function getLineRangeSafeDeleteCandidate(startLine, endLine) {
    const totalLines = editor.lineCount();
    const start = Number.parseInt(startLine, 10);
    const end = Number.parseInt(endLine, 10);

    if (
        !Number.isInteger(start) ||
        !Number.isInteger(end) ||
        start < 1 ||
        end < start ||
        end > totalLines
    ) {
        return null;
    }

    const from = { line: start - 1, ch: 0 };
    const to = end < totalLines
        ? { line: end, ch: 0 }
        : {
            line: totalLines - 1,
            ch: editor.getLine(totalLines - 1).length
        };

    return createSafeDeleteCandidate(
        from,
        to,
        'line-range',
        `Dòng ${start}–${end}`
    );
}

function buildBracePairs(text) {
    const stack = [];
    const pairs = [];
    let mode = 'code';
    let escaped = false;

    for (let index = 0; index < text.length; index++) {
        const char = text[index];
        const next = text[index + 1];

        if (mode === 'line-comment') {
            if (char === '\n') mode = 'code';
            continue;
        }

        if (mode === 'block-comment') {
            if (char === '*' && next === '/') {
                mode = 'code';
                index++;
            }
            continue;
        }

        if (
            mode === 'single-quote' ||
            mode === 'double-quote' ||
            mode === 'template'
        ) {
            if (escaped) {
                escaped = false;
                continue;
            }

            if (char === '\\') {
                escaped = true;
                continue;
            }

            if (
                (mode === 'single-quote' && char === "'") ||
                (mode === 'double-quote' && char === '"') ||
                (mode === 'template' && char === '`')
            ) {
                mode = 'code';
            }
            continue;
        }

        if (char === '/' && next === '/') {
            mode = 'line-comment';
            index++;
            continue;
        }

        if (char === '/' && next === '*') {
            mode = 'block-comment';
            index++;
            continue;
        }

        if (char === "'") {
            mode = 'single-quote';
            continue;
        }

        if (char === '"') {
            mode = 'double-quote';
            continue;
        }

        if (char === '`') {
            mode = 'template';
            continue;
        }

        if (char === '{') {
            stack.push(index);
            continue;
        }

        if (char === '}' && stack.length > 0) {
            pairs.push({ open: stack.pop(), close: index });
        }
    }

    return pairs;
}

function includeFollowingLineBreak(text, endIndex) {
    let finalIndex = endIndex;

    while (
        finalIndex < text.length &&
        (text[finalIndex] === ' ' || text[finalIndex] === '\t')
    ) {
        finalIndex++;
    }

    if (text[finalIndex] === ';') finalIndex++;

    if (
        text[finalIndex] === '\r' &&
        text[finalIndex + 1] === '\n'
    ) {
        return finalIndex + 2;
    }

    if (text[finalIndex] === '\n') return finalIndex + 1;
    return finalIndex;
}

function lineStartIndex(text, index) {
    const found = text.lastIndexOf('\n', index - 1);
    return found === -1 ? 0 : found + 1;
}

function findJavaScriptBlockCandidate() {
    const content = editor.getValue();
    const cursorIndex = editor.indexFromPos(editor.getCursor());
    const pairs = buildBracePairs(content);
    const functionRegex = /(?:^|\n)[\t ]*(?:(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+[A-Za-z_$][\w$]*\s*\([^)]*\)|(?:export\s+)?(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*(?:async\s+)?(?:function\s*\([^)]*\)|(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>)|(?:export\s+)?class\s+[A-Za-z_$][\w$]*(?:\s+extends\s+[^\{]+)?)[\t ]*\{/gm;
    const matches = [];
    let match;

    while ((match = functionRegex.exec(content))) {
        const open = content.indexOf('{', match.index);
        const pair = pairs.find(item => item.open === open);
        if (!pair) continue;

        const start = lineStartIndex(content, match.index);
        const end = includeFollowingLineBreak(content, pair.close + 1);

        if (cursorIndex >= start && cursorIndex <= end) {
            const declaration = match[0].trim();
            const nameMatch = declaration.match(
                /(?:function|class)\s+([A-Za-z_$][\w$]*)|(?:const|let|var)\s+([A-Za-z_$][\w$]*)/
            );

            matches.push({
                start,
                end,
                name:
                    (nameMatch && (nameMatch[1] || nameMatch[2])) ||
                    'khối JavaScript'
            });
        }
    }

    if (matches.length > 0) {
        matches.sort(
            (first, second) =>
                first.end - first.start -
                (second.end - second.start)
        );

        const best = matches[0];
        return createSafeDeleteCandidate(
            editor.posFromIndex(best.start),
            editor.posFromIndex(best.end),
            'javascript-function',
            `${best.name}()`
        );
    }

    const enclosingPairs = pairs
        .filter(pair =>
            cursorIndex >= pair.open && cursorIndex <= pair.close
        )
        .sort(
            (first, second) =>
                first.close - first.open -
                (second.close - second.open)
        );

    if (enclosingPairs.length === 0) return null;

    const pair = enclosingPairs[0];
    return createSafeDeleteCandidate(
        editor.posFromIndex(lineStartIndex(content, pair.open)),
        editor.posFromIndex(
            includeFollowingLineBreak(content, pair.close + 1)
        ),
        'javascript-block',
        'Khối JavaScript tại con trỏ'
    );
}

function findCssBlockCandidate() {
    const content = editor.getValue();
    const cursorIndex = editor.indexFromPos(editor.getCursor());
    const pairs = buildBracePairs(content)
        .filter(pair =>
            cursorIndex >= pair.open && cursorIndex <= pair.close
        )
        .sort(
            (first, second) =>
                first.close - first.open -
                (second.close - second.open)
        );

    if (pairs.length === 0) return null;

    const pair = pairs[0];
    const start = lineStartIndex(content, pair.open);
    const end = includeFollowingLineBreak(content, pair.close + 1);
    const header = content
        .slice(start, pair.open)
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .trim();

    return createSafeDeleteCandidate(
        editor.posFromIndex(start),
        editor.posFromIndex(end),
        'css-block',
        header || 'Khối CSS tại con trỏ'
    );
}

function buildHtmlTagPairs(content) {
    const voidTags = new Set([
        'area', 'base', 'br', 'col', 'embed', 'hr', 'img',
        'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'
    ]);
    const tagRegex = /<\/?([A-Za-z][\w:-]*)\b[^>]*>/g;
    const stack = [];
    const pairs = [];
    let match;

    while ((match = tagRegex.exec(content))) {
        const raw = match[0];
        const name = match[1].toLowerCase();
        const isClosing = /^<\//.test(raw);
        const isSelfClosing = /\/\s*>$/.test(raw);

        if (isClosing) {
            for (let index = stack.length - 1; index >= 0; index--) {
                if (stack[index].name !== name) continue;

                const opening = stack[index];
                stack.splice(index, 1);
                pairs.push({
                    name,
                    start: opening.start,
                    end: tagRegex.lastIndex
                });
                break;
            }
        } else if (!isSelfClosing && !voidTags.has(name)) {
            stack.push({
                name,
                start: match.index,
                end: tagRegex.lastIndex
            });
        } else {
            pairs.push({
                name,
                start: match.index,
                end: tagRegex.lastIndex
            });
        }
    }

    return pairs;
}

function findHtmlBlockCandidate() {
    const content = editor.getValue();
    const cursorIndex = editor.indexFromPos(editor.getCursor());
    const pairs = buildHtmlTagPairs(content)
        .filter(pair =>
            cursorIndex >= pair.start && cursorIndex <= pair.end
        )
        .sort(
            (first, second) =>
                first.end - first.start -
                (second.end - second.start)
        );

    if (pairs.length === 0) return null;

    const pair = pairs[0];
    return createSafeDeleteCandidate(
        editor.posFromIndex(lineStartIndex(content, pair.start)),
        editor.posFromIndex(includeFollowingLineBreak(content, pair.end)),
        'html-element',
        `<${pair.name}>…</${pair.name}>`
    );
}

function findAutomaticSafeDeleteCandidate() {
    const selected = getSelectionSafeDeleteCandidate();
    if (selected) return selected;

    const mode = files[currentFile] && files[currentFile].mode;
    if (mode === 'css') return findCssBlockCandidate();
    if (mode === 'htmlmixed') return findHtmlBlockCandidate();
    return findJavaScriptBlockCandidate();
}

function getTextOutsideCandidate(candidate) {
    const content = editor.getValue();
    const startIndex = editor.indexFromPos(candidate.from);
    const endIndex = editor.indexFromPos(candidate.to);

    return content.slice(0, startIndex) + content.slice(endIndex);
}

function countOccurrencesAcrossProject(regex, candidate) {
    let count = 0;

    Object.keys(files).forEach(fileName => {
        const content = fileName === currentFile
            ? getTextOutsideCandidate(candidate)
            : files[fileName].content;
        const flags = regex.flags.includes('g')
            ? regex.flags
            : regex.flags + 'g';
        const matches = content.match(new RegExp(regex.source, flags));
        count += matches ? matches.length : 0;
    });

    return count;
}

function analyzeSafeDeleteCandidate(candidate) {
    const warnings = [];
    const text = candidate.text;
    const totalLines = editor.lineCount();
    const removedLines = candidate.endLine - candidate.startLine + 1;

    [
        ['{', '}'],
        ['(', ')'],
        ['[', ']']
    ].forEach(([open, close]) => {
        const openCount = text.split(open).length - 1;
        const closeCount = text.split(close).length - 1;

        if (openCount !== closeCount) {
            warnings.push(
                `Số dấu ${open} và ${close} không cân bằng (${openCount}/${closeCount}).`
            );
        }
    });

    if (totalLines > 0 && removedLines / totalLines >= 0.5) {
        warnings.push(
            `Đoạn này chiếm khoảng ${Math.round(
                (removedLines / totalLines) * 100
            )}% file hiện tại.`
        );
    }

    const criticalTokens = [
        'ios_editor_pro_files',
        'code-editor',
        'file-selector',
        'preview-overlay',
        'console-output',
        'runCode',
        'switchFile',
        'persistFiles'
    ];
    const foundCritical = criticalTokens.filter(token => text.includes(token));

    if (foundCritical.length > 0) {
        warnings.push(
            'Đoạn chọn chứa thành phần quan trọng: ' +
            foundCritical.join(', ') + '.'
        );
    }

    const functionNames = new Set();
    [
        /\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/g,
        /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?(?:function\b|(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>)/g,
        /\bclass\s+([A-Za-z_$][\w$]*)\b/g
    ].forEach(pattern => {
        let match;
        while ((match = pattern.exec(text))) {
            functionNames.add(match[1]);
        }
    });

    functionNames.forEach(name => {
        const references = countOccurrencesAcrossProject(
            new RegExp(`\\b${escapeRegExp(name)}\\b`, 'g'),
            candidate
        );

        if (references > 0) {
            warnings.push(
                `${name} còn xuất hiện ${references} lần ngoài đoạn sắp xóa.`
            );
        }
    });

    const ids = new Set();
    const classes = new Set();
    let attributeMatch;
    const idPattern = /\bid\s*=\s*["']([^"']+)["']/g;
    const classPattern = /\bclass\s*=\s*["']([^"']+)["']/g;

    while ((attributeMatch = idPattern.exec(text))) {
        ids.add(attributeMatch[1]);
    }

    while ((attributeMatch = classPattern.exec(text))) {
        attributeMatch[1]
            .split(/\s+/)
            .filter(Boolean)
            .forEach(name => classes.add(name));
    }

    ids.forEach(id => {
        const references = countOccurrencesAcrossProject(
            new RegExp(escapeRegExp(id), 'g'),
            candidate
        );
        if (references > 0) {
            warnings.push(
                `ID “${id}” còn được nhắc tới ${references} lần ở nơi khác.`
            );
        }
    });

    classes.forEach(className => {
        const references = countOccurrencesAcrossProject(
            new RegExp(escapeRegExp(className), 'g'),
            candidate
        );
        if (references > 0) {
            warnings.push(
                `Class “${className}” còn được nhắc tới ${references} lần ở nơi khác.`
            );
        }
    });

    return Array.from(new Set(warnings));
}

function getSafeDeleteTypeLabel(type) {
    const labels = {
        selection: 'Đoạn bôi đen',
        'line-range': 'Khoảng dòng',
        'javascript-function': 'Hàm JavaScript',
        'javascript-block': 'Khối JavaScript',
        'css-block': 'Khối CSS',
        'html-element': 'Phần tử HTML'
    };

    return labels[type] || 'Cụm code';
}

function renderSafeDeleteCandidate(candidate) {
    if (!candidate) {
        showToast('Không nhận diện được cụm code tại vị trí này');
        return;
    }

    safeDeleteCandidate = candidate;
    highlightSafeDeleteCandidate(candidate);

    const warnings = analyzeSafeDeleteCandidate(candidate);
    const lineCount = candidate.endLine - candidate.startLine + 1;
    const previewLimit = 16000;
    const previewText = candidate.text.length > previewLimit
        ? candidate.text.slice(0, previewLimit) +
          '\n\n… Nội dung xem trước đã được rút gọn …'
        : candidate.text;

    const warningHtml = warnings.length
        ? `
            <div class="safe-delete-warning-list">
                ${warnings.map(warning => `
                    <div class="safe-delete-warning-item">
                        <i class="fa-solid fa-triangle-exclamation"></i>
                        <span>${escapeHtml(warning)}</span>
                    </div>
                `).join('')}
            </div>
        `
        : `
            <div class="safe-delete-status">
                <i class="fa-solid fa-shield-halved"></i>
                <span>
                    Chưa phát hiện tham chiếu rõ ràng bên ngoài đoạn chọn.
                    Đây chỉ là kiểm tra hỗ trợ, không bảo đảm logic 100%.
                </span>
            </div>
        `;

    showToolsDetail(
        'Xem trước khi xóa',
        `
            <div class="safe-delete-status ${warnings.length ? 'warning' : ''}">
                <i class="fa-solid ${
                    warnings.length
                        ? 'fa-triangle-exclamation'
                        : 'fa-circle-info'
                }"></i>
                <span>
                    <strong>${escapeHtml(candidate.label)}</strong><br>
                    ${escapeHtml(currentFile)} • dòng
                    ${candidate.startLine}–${candidate.endLine}
                    • ${lineCount} dòng
                </span>
            </div>

            <div class="safe-delete-badge-row">
                <span class="safe-delete-badge">
                    ${escapeHtml(getSafeDeleteTypeLabel(candidate.type))}
                </span>
                <span class="safe-delete-badge">
                    ${candidate.text.length.toLocaleString('vi-VN')} ký tự
                </span>
                <span class="safe-delete-badge">Backup tự động</span>
            </div>

            ${warningHtml}

            <div class="safe-delete-preview">
                <div class="safe-delete-preview-header">
                    <strong>Nội dung sẽ bị xóa</strong>
                    <span class="safe-delete-preview-meta">
                        Dòng ${candidate.startLine}–${candidate.endLine}
                    </span>
                </div>
                <pre class="safe-delete-code-preview">${escapeHtml(
                    previewText
                )}</pre>
            </div>

            <button
                id="safe-delete-confirm-button"
                class="safe-delete-danger-btn"
                type="button"
            >
                <i class="fa-solid fa-trash-can"></i>
                Tạo backup và xóa cụm này
            </button>
        `
    );

    document
        .getElementById('safe-delete-confirm-button')
        ?.addEventListener('click', performSafeDelete);
}

function openSafeDeleteTool() {
    safeDeleteCandidate = null;
    clearSafeDeleteHighlight();

    const cursorLine = editor.getCursor().line + 1;
    const selection = getSelectionSafeDeleteCandidate();

    showToolsDetail(
        'Xóa cụm code an toàn',
        `
            <div class="safe-delete-status">
                <i class="fa-solid fa-shield-halved"></i>
                <span>
                    App chỉ xóa sau khi bạn xem trước và xác nhận.
                    Một bản backup toàn bộ project sẽ được tạo tự động.
                </span>
            </div>

            <div class="safe-delete-mode-tabs">
                <button
                    id="safe-delete-auto-button"
                    class="safe-delete-tab active"
                    type="button"
                >Tự nhận diện</button>

                <button
                    id="safe-delete-selection-button"
                    class="safe-delete-tab"
                    type="button"
                    ${selection ? '' : 'disabled'}
                >Đoạn bôi đen</button>

                <button
                    id="safe-delete-lines-button"
                    class="safe-delete-tab"
                    type="button"
                >Theo số dòng</button>
            </div>

            <div id="safe-delete-method-content">
                <div class="tools-form">
                    <div class="safe-delete-status">
                        <i class="fa-solid fa-crosshairs"></i>
                        <span>
                            Con trỏ đang ở dòng ${cursorLine}.
                            App sẽ thử nhận diện toàn bộ hàm JavaScript,
                            khối CSS hoặc thẻ HTML bao quanh vị trí này.
                        </span>
                    </div>

                    <button
                        id="safe-delete-detect-button"
                        class="tools-primary-btn"
                        type="button"
                    >
                        <i class="fa-solid fa-wand-magic-sparkles"></i>
                        Nhận diện cụm tại con trỏ
                    </button>
                </div>
            </div>
        `
    );

    bindSafeDeleteToolEvents();
}

function setSafeDeleteActiveTab(activeId) {
    [
        'safe-delete-auto-button',
        'safe-delete-selection-button',
        'safe-delete-lines-button'
    ].forEach(id => {
        const button = document.getElementById(id);
        if (button) {
            button.classList.toggle('active', id === activeId);
        }
    });
}

function bindSafeDeleteToolEvents() {
    const autoButton = document.getElementById('safe-delete-auto-button');
    const selectionButton = document.getElementById(
        'safe-delete-selection-button'
    );
    const linesButton = document.getElementById('safe-delete-lines-button');
    const detectButton = document.getElementById('safe-delete-detect-button');

    detectButton?.addEventListener('click', () => {
        renderSafeDeleteCandidate(findAutomaticSafeDeleteCandidate());
    });

    autoButton?.addEventListener('click', () => {
        setSafeDeleteActiveTab('safe-delete-auto-button');
        const content = document.getElementById('safe-delete-method-content');
        if (!content) return;

        const cursorLine = editor.getCursor().line + 1;
        content.innerHTML = `
            <div class="tools-form">
                <div class="safe-delete-status">
                    <i class="fa-solid fa-crosshairs"></i>
                    <span>
                        Con trỏ đang ở dòng ${cursorLine}.
                        App sẽ thử nhận diện cụm bao quanh vị trí này.
                    </span>
                </div>
                <button
                    id="safe-delete-detect-button"
                    class="tools-primary-btn"
                    type="button"
                >
                    <i class="fa-solid fa-wand-magic-sparkles"></i>
                    Nhận diện cụm tại con trỏ
                </button>
            </div>
        `;

        document
            .getElementById('safe-delete-detect-button')
            ?.addEventListener('click', () => {
                renderSafeDeleteCandidate(findAutomaticSafeDeleteCandidate());
            });
    });

    selectionButton?.addEventListener('click', () => {
        const candidate = getSelectionSafeDeleteCandidate();

        if (!candidate) {
            showToast('Bạn chưa bôi đen đoạn code nào');
            return;
        }

        setSafeDeleteActiveTab('safe-delete-selection-button');
        renderSafeDeleteCandidate(candidate);
    });

    linesButton?.addEventListener('click', () => {
        setSafeDeleteActiveTab('safe-delete-lines-button');
        const content = document.getElementById('safe-delete-method-content');
        if (!content) return;

        const cursorLine = editor.getCursor().line + 1;
        content.innerHTML = `
            <div class="tools-form">
                <div class="safe-delete-range-grid">
                    <div class="tools-input-group">
                        <label class="tools-input-label" for="safe-delete-start-line">
                            Từ dòng
                        </label>
                        <input
                            id="safe-delete-start-line"
                            class="tools-input"
                            type="number"
                            inputmode="numeric"
                            min="1"
                            max="${editor.lineCount()}"
                            value="${cursorLine}"
                        >
                    </div>

                    <div class="tools-input-group">
                        <label class="tools-input-label" for="safe-delete-end-line">
                            Đến dòng
                        </label>
                        <input
                            id="safe-delete-end-line"
                            class="tools-input"
                            type="number"
                            inputmode="numeric"
                            min="1"
                            max="${editor.lineCount()}"
                            value="${cursorLine}"
                        >
                    </div>
                </div>

                <button
                    id="safe-delete-range-preview-button"
                    class="tools-primary-btn"
                    type="button"
                >
                    <i class="fa-solid fa-eye"></i>
                    Xem trước khoảng dòng
                </button>
            </div>
        `;

        document
            .getElementById('safe-delete-range-preview-button')
            ?.addEventListener('click', () => {
                const startInput = document.getElementById(
                    'safe-delete-start-line'
                );
                const endInput = document.getElementById(
                    'safe-delete-end-line'
                );
                const candidate = getLineRangeSafeDeleteCandidate(
                    startInput && startInput.value,
                    endInput && endInput.value
                );

                if (!candidate) {
                    showToast(
                        `Khoảng dòng phải hợp lệ, từ 1 đến ${editor.lineCount()}`
                    );
                    return;
                }

                renderSafeDeleteCandidate(candidate);
            });
    });
}

function performSafeDelete() {
    const candidate = safeDeleteCandidate;

    if (!candidate) {
        showToast('Chưa có cụm code được chọn');
        return;
    }

    if (candidate.fileName !== currentFile) {
        alert('Bạn đã chuyển sang file khác. Hãy chọn lại cụm code cần xóa.');
        return;
    }

    const currentRangeText = editor.getRange(candidate.from, candidate.to);
    if (currentRangeText !== candidate.text) {
        alert(
            'Nội dung code đã thay đổi sau lúc xem trước. ' +
            'Hãy chọn lại cụm code để tránh xóa nhầm.'
        );
        return;
    }

    const warnings = analyzeSafeDeleteCandidate(candidate);
    const lineCount = candidate.endLine - candidate.startLine + 1;
    const accepted = confirm(
        `XÓA CỤM CODE NÀY?\n\n` +
        `File: ${currentFile}\n` +
        `Dòng: ${candidate.startLine}–${candidate.endLine}\n` +
        `Tổng cộng: ${lineCount} dòng\n` +
        `Cảnh báo phát hiện: ${warnings.length}\n\n` +
        'App sẽ tạo backup toàn bộ project trước khi xóa.'
    );

    if (!accepted) return;

    const backupCreated = createBackupSnapshot(
        `Trước khi xóa dòng ${candidate.startLine}–${candidate.endLine} trong ${currentFile}`,
        false
    );

    if (!backupCreated) {
        const continueWithoutBackup = confirm(
            'Không thể tạo backup, có thể do bộ nhớ trình duyệt đã đầy.\n\n' +
            'Bạn có chắc vẫn muốn tiếp tục xóa không?'
        );
        if (!continueWithoutBackup) return;
    }

    clearSafeDeleteHighlight();
    const bookmark = editor.setBookmark(candidate.from, { insertLeft: true });

    editor.operation(() => {
        editor.replaceRange(
            '',
            candidate.from,
            candidate.to,
            'safe-delete'
        );
    });

    files[currentFile].content = editor.getValue();
    persistFiles();

    lastSafeDeletion = {
        fileName: currentFile,
        deletedText: candidate.text,
        fallbackPosition: {
            line: candidate.from.line,
            ch: candidate.from.ch
        },
        bookmark,
        deletedAt: Date.now(),
        label: candidate.label
    };

    safeDeleteCandidate = null;
    closeToolsPanel();
    showSafeDeleteUndoBar(
        `Đã xóa ${lineCount} dòng trong ${currentFile}`
    );
    editor.focus();
}

function showSafeDeleteUndoBar(message) {
    const bar = document.getElementById('safe-delete-undo');
    const text = document.getElementById('safe-delete-undo-text');
    if (!bar) return;

    if (text) text.textContent = message;
    bar.classList.add('show');
    clearTimeout(safeDeleteUndoTimeout);
    safeDeleteUndoTimeout = setTimeout(hideSafeDeleteUndoBar, 15000);
}

function hideSafeDeleteUndoBar() {
    document.getElementById('safe-delete-undo')?.classList.remove('show');
}

function undoLastSafeDeletion() {
    if (!lastSafeDeletion) {
        showToast('Không còn thao tác xóa để hoàn tác');
        hideSafeDeleteUndoBar();
        return;
    }

    if (lastSafeDeletion.fileName !== currentFile) {
        alert(
            `Thao tác vừa xóa thuộc file ${lastSafeDeletion.fileName}.\n\n` +
            'Hãy dùng Lịch sử sao lưu để khôi phục an toàn.'
        );
        return;
    }

    let position = null;
    if (
        lastSafeDeletion.bookmark &&
        typeof lastSafeDeletion.bookmark.find === 'function'
    ) {
        position = lastSafeDeletion.bookmark.find();
    }

    if (!position) position = lastSafeDeletion.fallbackPosition;

    editor.operation(() => {
        editor.replaceRange(
            lastSafeDeletion.deletedText,
            position,
            position,
            'safe-delete-undo'
        );
    });

    if (
        lastSafeDeletion.bookmark &&
        typeof lastSafeDeletion.bookmark.clear === 'function'
    ) {
        lastSafeDeletion.bookmark.clear();
    }

    files[currentFile].content = editor.getValue();
    persistFiles();
    lastSafeDeletion = null;
    hideSafeDeleteUndoBar();
    showToast('Đã hoàn tác việc xóa cụm code');
    editor.refresh();
    editor.focus();
}



// =========================================================
// VERSION 1.4 - NHẬP VÀ XUẤT DỰ ÁN ZIP
// =========================================================

const ZIP_MAX_ARCHIVE_BYTES = 30 * 1024 * 1024;
const ZIP_MAX_TOTAL_BYTES = 25 * 1024 * 1024;
const ZIP_MAX_SINGLE_FILE_BYTES = 4 * 1024 * 1024;
const ZIP_MAX_FILE_COUNT = 300;

const ZIP_TEXT_EXTENSIONS = new Set([
    'html', 'htm', 'css', 'js', 'mjs', 'cjs', 'json',
    'txt', 'md', 'xml', 'svg', 'csv', 'ts', 'tsx', 'jsx',
    'yml', 'yaml', 'ini', 'conf', 'env', 'gitignore'
]);

let zipOperationInProgress = false;

function closeDropdownMenu() {
    const menu = document.getElementById('dropdown-menu');
    if (menu) menu.classList.remove('active');
}

function saveCurrentEditorContent() {
    if (!files[currentFile]) return;
    files[currentFile].content = editor.getValue();
    persistFiles();
}

function getFileExtension(fileName) {
    const cleanName = fileName.split('/').pop() || '';
    const dotIndex = cleanName.lastIndexOf('.');

    if (dotIndex === -1) {
        return cleanName.toLowerCase();
    }

    return cleanName.substring(dotIndex + 1).toLowerCase();
}

function isSupportedZipTextFile(fileName) {
    const lowerName = fileName.toLowerCase();
    const leafName = lowerName.split('/').pop() || '';

    if (
        leafName === '.gitignore' ||
        leafName === '.env' ||
        leafName === 'license' ||
        leafName === 'readme'
    ) {
        return true;
    }

    return ZIP_TEXT_EXTENSIONS.has(getFileExtension(fileName));
}

function normalizeZipPath(rawPath) {
    const normalized = String(rawPath || '')
        .replace(/\\/g, '/')
        .replace(/^\/+/, '');

    const safeParts = [];

    normalized.split('/').forEach(part => {
        const cleanPart = part.trim();

        if (!cleanPart || cleanPart === '.') return;

        if (cleanPart === '..') {
            safeParts.pop();
            return;
        }

        safeParts.push(cleanPart);
    });

    return safeParts.join('/');
}

function getUniqueProjectFileName(fileName, occupiedNames) {
    if (!occupiedNames.has(fileName)) {
        occupiedNames.add(fileName);
        return fileName;
    }

    const slashIndex = fileName.lastIndexOf('/');
    const directory = slashIndex >= 0
        ? fileName.substring(0, slashIndex + 1)
        : '';
    const leafName = slashIndex >= 0
        ? fileName.substring(slashIndex + 1)
        : fileName;

    const metadata = parseFileMetadata(leafName);
    let counter = 1;
    let candidate = `${directory}${metadata.baseName}_${counter}${metadata.ext}`;

    while (occupiedNames.has(candidate)) {
        counter++;
        candidate = `${directory}${metadata.baseName}_${counter}${metadata.ext}`;
    }

    occupiedNames.add(candidate);
    return candidate;
}

function looksLikeBinaryData(bytes) {
    if (!bytes || bytes.length === 0) return false;

    const sampleLength = Math.min(bytes.length, 4096);
    let nullCount = 0;
    let controlCount = 0;

    for (let index = 0; index < sampleLength; index++) {
        const value = bytes[index];

        if (value === 0) nullCount++;

        if (
            value < 9 ||
            (value > 13 && value < 32)
        ) {
            controlCount++;
        }
    }

    return nullCount > 0 || controlCount / sampleLength > 0.12;
}

function decodeZipText(bytes) {
    let text = new TextDecoder('utf-8').decode(bytes);

    if (text.charCodeAt(0) === 0xFEFF) {
        text = text.slice(1);
    }

    return text;
}

function chooseImportedStartFile(importedNames) {
    if (importedNames.includes('index.html')) {
        return 'index.html';
    }

    const nestedIndex = importedNames
        .filter(name => name.toLowerCase().endsWith('/index.html'))
        .sort((a, b) => a.length - b.length)[0];

    if (nestedIndex) return nestedIndex;

    const firstHtml = importedNames.find(name => {
        const lowerName = name.toLowerCase();
        return lowerName.endsWith('.html') || lowerName.endsWith('.htm');
    });

    return firstHtml || importedNames[0];
}

function createZipDownloadName() {
    const now = new Date();
    const pad = number => String(number).padStart(2, '0');

    return [
        'ios-code-project-',
        now.getFullYear(),
        pad(now.getMonth() + 1),
        pad(now.getDate()),
        '-',
        pad(now.getHours()),
        pad(now.getMinutes()),
        '.zip'
    ].join('');
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

async function importZipProject(event) {
    closeDropdownMenu();

    const input = event && event.target
        ? event.target
        : document.getElementById('zip-input');
    const zipFile = input && input.files
        ? input.files[0]
        : null;

    if (!zipFile) return;

    if (zipOperationInProgress) {
        showToast('Một thao tác ZIP khác đang chạy');
        input.value = '';
        return;
    }

    if (typeof JSZip === 'undefined') {
        alert('Không tải được thư viện JSZip. Hãy kiểm tra kết nối Internet rồi mở lại ứng dụng.');
        input.value = '';
        return;
    }

    if (zipFile.size > ZIP_MAX_ARCHIVE_BYTES) {
        alert('File ZIP lớn hơn 30 MB. Vui lòng chia dự án thành file nhỏ hơn.');
        input.value = '';
        return;
    }

    zipOperationInProgress = true;
    showToast('Đang kiểm tra và giải nén ZIP...', 60000);

    try {
        const zip = await JSZip.loadAsync(zipFile);
        const allEntries = Object.values(zip.files).filter(entry => !entry.dir);

        if (allEntries.length > ZIP_MAX_FILE_COUNT) {
            throw new Error(`ZIP có quá nhiều file. Giới hạn hiện tại là ${ZIP_MAX_FILE_COUNT} file.`);
        }

        const importedItems = [];
        let skippedCount = 0;
        let totalBytes = 0;

        for (const entry of allEntries) {
            const safeName = normalizeZipPath(entry.name);
            const leafName = safeName.split('/').pop() || '';

            if (
                !safeName ||
                safeName.startsWith('__MACOSX/') ||
                leafName === '.DS_Store' ||
                !isSupportedZipTextFile(safeName)
            ) {
                skippedCount++;
                continue;
            }

            const bytes = await entry.async('uint8array');

            if (bytes.length > ZIP_MAX_SINGLE_FILE_BYTES) {
                skippedCount++;
                continue;
            }

            totalBytes += bytes.length;

            if (totalBytes > ZIP_MAX_TOTAL_BYTES) {
                throw new Error('Tổng dữ liệu sau giải nén lớn hơn 25 MB. Đã dừng để tránh làm treo trình duyệt.');
            }

            if (looksLikeBinaryData(bytes)) {
                skippedCount++;
                continue;
            }

            importedItems.push({
                name: safeName,
                content: decodeZipText(bytes)
            });
        }

        if (importedItems.length === 0) {
            throw new Error('Không tìm thấy file code dạng văn bản phù hợp trong ZIP.');
        }

        const replaceCurrentProject = confirm(
            `Đã tìm thấy ${importedItems.length} file code trong ZIP.\n\n` +
            'Nhấn OK: mở ZIP thành dự án mới và thay danh sách file hiện tại.\n' +
            'Nhấn Hủy: gộp vào dự án hiện tại; file trùng tên sẽ được đổi tên an toàn.\n\n' +
            'Dữ liệu hiện tại sẽ được sao lưu trước khi nhập.'
        );

        createBackupSnapshot('Trước khi nhập dự án ZIP', false);
        saveCurrentEditorContent();

        const targetFiles = replaceCurrentProject ? {} : cloneData(files);
        const occupiedNames = new Set(Object.keys(targetFiles));
        const importedNames = [];

        importedItems.forEach(item => {
            // Luôn xử lý trùng tên, kể cả khi hai đường dẫn trong ZIP
            // trở thành cùng một tên sau bước chuẩn hóa an toàn.
            const finalName = getUniqueProjectFileName(
                item.name,
                occupiedNames
            );

            targetFiles[finalName] = {
                mode: parseFileMetadata(finalName).mode,
                content: item.content
            };

            importedNames.push(finalName);
        });

        files = targetFiles;
        currentFile = chooseImportedStartFile(importedNames);

        persistFiles();
        renderDropdown();
        switchFile(currentFile, { skipSaveCurrent: true });

        const skippedMessage = skippedCount > 0
            ? `, bỏ qua ${skippedCount} file không hỗ trợ`
            : '';

        showToast(`Đã nhập ${importedNames.length} file từ ZIP${skippedMessage}`, 3500);
    } catch (error) {
        console.error('Lỗi nhập ZIP:', error);
        alert('Không thể nhập ZIP:\n' + (error && error.message ? error.message : error));
        showToast('Nhập ZIP không thành công');
    } finally {
        zipOperationInProgress = false;
        if (input) input.value = '';
    }
}

async function exportProjectZip() {
    closeDropdownMenu();

    if (zipOperationInProgress) {
        showToast('Một thao tác ZIP khác đang chạy');
        return;
    }

    if (typeof JSZip === 'undefined') {
        alert('Không tải được thư viện JSZip. Hãy kiểm tra kết nối Internet rồi mở lại ứng dụng.');
        return;
    }

    saveCurrentEditorContent();

    const fileNames = Object.keys(files);

    if (fileNames.length === 0) {
        showToast('Dự án hiện tại không có file để xuất');
        return;
    }

    zipOperationInProgress = true;
    showToast('Đang đóng gói dự án ZIP...', 60000);

    try {
        const zip = new JSZip();
        const occupiedNames = new Set();

        fileNames.forEach(originalName => {
            const safeName = normalizeZipPath(originalName) || 'untitled.txt';
            const finalName = getUniqueProjectFileName(safeName, occupiedNames);
            const content = files[originalName] && typeof files[originalName].content === 'string'
                ? files[originalName].content
                : '';

            zip.file(finalName, content, {
                binary: false,
                createFolders: true,
                date: new Date()
            });
        });

        const blob = await zip.generateAsync({
            type: 'blob',
            compression: 'DEFLATE',
            compressionOptions: { level: 6 },
            platform: 'UNIX'
        });

        const downloadName = createZipDownloadName();
        downloadBlobFile(blob, downloadName);
        showToast(`Đã xuất ${fileNames.length} file thành ZIP`, 3000);
    } catch (error) {
        console.error('Lỗi xuất ZIP:', error);
        alert('Không thể xuất ZIP:\n' + (error && error.message ? error.message : error));
        showToast('Xuất ZIP không thành công');
    } finally {
        zipOperationInProgress = false;
    }
}

// Phím tắt hỗ trợ máy tính và bàn phím rời
window.addEventListener('keydown', event => {
    const modifier = event.ctrlKey || event.metaKey;

    if (modifier && event.key.toLowerCase() === 'f') {
        event.preventDefault();
        openToolsPanel();
        openSearchTool();
        return;
    }

    if (modifier && event.key.toLowerCase() === 'g') {
        event.preventDefault();
        openToolsPanel();
        openGoToLineTool();
        return;
    }

    if (modifier && event.shiftKey && event.key.toLowerCase() === 'p') {
        event.preventDefault();
        openToolsPanel();
        return;
    }

    if (modifier && event.shiftKey && event.key.toLowerCase() === 'x') {
        event.preventDefault();
        openToolsPanel();
        openSafeDeleteTool();
        return;
    }

    if (event.key === 'Escape') {
        closeToolsPanel();
    }
});

// Lưu ngay nội dung hiện tại trước khi đóng hoặc tải lại trang
window.addEventListener('beforeunload', () => {
    if (files[currentFile]) {
        files[currentFile].content = editor.getValue();
        persistFiles();
    }
});

// --- TỐI ƯU ĐỒNG BỘ VISUAL VIEWPORT (BÀN PHÍM IOS) ---
if (window.visualViewport) {
    const adjustViewport = () => {
        document.body.style.height = window.visualViewport.height + 'px';
        window.scrollTo(0, 0);

        setTimeout(() => {
            editor.refresh();

            const activeElement = document.activeElement;
            if (activeElement && activeElement.classList && activeElement.classList.contains('CodeMirror-scroll')) {
                const cursor = editor.getCursor();
                editor.scrollIntoView(cursor);
            }
        }, 50);
    };

    window.visualViewport.addEventListener('resize', adjustViewport);
    window.visualViewport.addEventListener('scroll', adjustViewport);
    adjustViewport();
}

// Khởi chạy App
switchFile(currentFile, { skipSaveCurrent: true });
updateToolsCurrentFile();
