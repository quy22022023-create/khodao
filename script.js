// Khởi tạo file mặc định ban đầu: chỉ có duy nhất file 'new'
let defaultFiles = {
    'new': { 
        mode: 'javascript', 
        content: '// Bắt đầu viết mã của bạn tại đây...\n' 
    }
};

let files = JSON.parse(localStorage.getItem('ios_editor_pro_files')) || defaultFiles;
let currentFile = Object.keys(files)[0] || 'new';

// Biến lưu độ lệch dòng để tính toán chính xác vị trí lỗi
let offsetHTML = 0;
let offsetJS = 0;

const editor = CodeMirror.fromTextArea(document.getElementById("code-editor"), {
    theme: "dracula",
    lineNumbers: true,
    lineWrapping: true,
    indentUnit: 4,
    tabSize: 4,
    autoCloseBrackets: true,
    autoCloseTags: true,
    matchBrackets: true,
    styleActiveLine: true,
    extraKeys: {"Ctrl-Space": "autocomplete"}
});

// Hàm xoá bôi đỏ dòng lỗi
function clearErrorLines() {
    editor.eachLine(function(line) {
        editor.removeLineClass(line, 'background', 'error-line');
    });
}

// --- TỐI ƯU HIỆU SUẤT LƯU FILE: DEBOUNCE ---
let saveTimeout;
editor.on("change", () => {
    clearErrorLines(); 
    clearTimeout(saveTimeout);
    
    // Đợi 500ms sau khi ngừng gõ mới lưu vào localStorage để tối ưu RAM/Pin trên iOS
    saveTimeout = setTimeout(() => {
        if (files[currentFile]) {
            files[currentFile].content = editor.getValue();
            localStorage.setItem('ios_editor_pro_files', JSON.stringify(files));
        }
    }, 500);
});

// Kích hoạt gợi ý Code tự động
editor.on("inputRead", function(cm, change) {
    if (change.origin !== "+input" || change.text.length !== 1) return;
    let char = change.text[0];
    if (/[a-zA-Z\.]/.test(char) || char === '<') {
        setTimeout(function() {
            if (!cm.state.completionActive) {
                cm.showHint({ completeSingle: false });
            }
        }, 100);
    }
});

// Lắng nghe tín hiệu Console và BẮT LỖI TỪ IFRAME
window.addEventListener('message', function(event) {
    if (event.data && event.data.type) {
        const output = document.getElementById('console-output');
        const div = document.createElement('div');
        div.className = event.data.type === 'error' ? 'console-error' : 'console-log';
        
        let displayLog = '> ' + event.data.log;

        if (event.data.type === 'error' && event.data.line) {
            let errorLine = parseInt(event.data.line);
            let actualLine = -1;
            let currentMode = files[currentFile] ? files[currentFile].mode : '';

            if (currentMode === 'javascript') {
                actualLine = errorLine - offsetJS - 1; 
            } else if (currentMode === 'htmlmixed') {
                actualLine = errorLine - offsetHTML - 1;
            }

            if (actualLine >= 0) {
                displayLog = '> Lỗi dòng ' + (actualLine + 1) + ': ' + event.data.log;
                editor.addLineClass(actualLine, 'background', 'error-line');
            }
        }

        div.textContent = displayLog;
        output.appendChild(div);
        output.scrollTop = output.scrollHeight; 
    }
});

function undoCode() { editor.undo(); editor.focus(); }
function redoCode() { editor.redo(); editor.focus(); }

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
    let mode = 'javascript'; // Mặc định
    
    const lastDotIndex = fileName.lastIndexOf('.');
    
    // Nếu có dấu chấm và không phải ký tự đầu tiên (ví dụ .env)
    if (lastDotIndex > 0) {
        baseName = fileName.substring(0, lastDotIndex);
        ext = fileName.substring(lastDotIndex + 1).toLowerCase();
    }
    
    switch (ext) {
        case 'html': case 'htm': 
            mode = 'htmlmixed'; break;
        case 'css': 
            mode = 'css'; break;
        case 'js': case 'json': default: 
            mode = 'javascript'; break;
    }
    
    return { baseName, ext: ext ? `.${ext}` : '', mode };
}

function renderDropdown() {
    const selector = document.getElementById('file-selector');
    selector.innerHTML = ''; 
    for (let fileName in files) {
        const option = document.createElement('option');
        option.value = fileName;
        option.innerText = fileName;
        if (fileName === currentFile) { option.selected = true; }
        selector.appendChild(option);
    }
}

function onFileSelectChange() {
    const selector = document.getElementById('file-selector');
    switchFile(selector.value);
}

function switchFile(fileName) {
    currentFile = fileName;
    editor.setOption("mode", files[fileName].mode);
    editor.setValue(files[fileName].content);
    clearErrorLines();
    renderDropdown();
    setTimeout(() => editor.refresh(), 50);
}

function addNewFile() {
    let name = prompt("Tên file mới (VD: app.min.js, style.css):");
    if (!name) return;
    
    if (files[name]) {
        let counter = 1;
        const meta = parseFileMetadata(name);
        let newName = `${meta.baseName}_${counter}${meta.ext}`;
        while(files[newName]) {
            counter++; newName = `${meta.baseName}_${counter}${meta.ext}`;
        }
        name = newName;
    }
    
    const finalMeta = parseFileMetadata(name);
    files[name] = { mode: finalMeta.mode, content: '' };
    switchFile(name);
}

function renameCurrentFile() {
    let newName = prompt("Nhập tên mới cho file (VD: index.html, main.js):", currentFile);
    if (!newName || newName === currentFile) return;
    
    if (files[newName]) {
        alert("Tên file này đã tồn tại!");
        return;
    }
    
    const meta = parseFileMetadata(newName);
    files[newName] = { mode: meta.mode, content: files[currentFile].content };
    delete files[currentFile];
    currentFile = newName;
    
    localStorage.setItem('ios_editor_pro_files', JSON.stringify(files));
    switchFile(currentFile);
}

function deleteCurrentFile() {
    if (Object.keys(files).length <= 1) {
        alert("Bạn phải giữ lại ít nhất một file hệ thống.");
        return;
    }
    if (confirm(`Bạn có chắc chắn muốn xoá file [${currentFile}] không?`)) {
        delete files[currentFile];
        currentFile = Object.keys(files)[0]; 
        renderDropdown();
        switchFile(currentFile);
    }
}

function clearCurrentCode() {
    if (confirm(`Xoá toàn bộ code trong file [${currentFile}]?`)) {
        editor.setValue("");
        files[currentFile].content = "";
        localStorage.setItem('ios_editor_pro_files', JSON.stringify(files));
        clearErrorLines();
    }
}

function resetAllData() {
    const warning = "CẢNH BÁO: Hành động này sẽ xoá sạch TẤT CẢ các file hiện tại.\n\nTiếp tục?";
    if (confirm(warning)) {
        localStorage.removeItem('ios_editor_pro_files');
        location.reload(); 
    }
}

// --- TỐI ƯU HOÁ TRẢI NGHIỆM DÁN BẢN SAO CHO IOS ---
async function pasteFromClipboard() {
    try {
        const text = await navigator.clipboard.readText();
        if (text) {
            editor.focus();
            editor.replaceSelection(text);
        }
    } catch (err) {
        // Fallback cho trình duyệt chặn quyền hoặc không có HTTPS
        alert("Trình duyệt không cấp quyền truy cập Clipboard. Vui lòng ấn giữ vào màn hình và chọn 'Dán'.");
    }
}

async function importFiles(event) {
    const uploadedFiles = event.target.files;
    if (uploadedFiles.length === 0) return;
    
    let lastFileName = currentFile;
    
    const readPromises = Array.from(uploadedFiles).map(file => {
        return new Promise((resolve) => {
            const reader = new FileReader();
            reader.onload = e => {
                const content = e.target.result;
                let fileName = file.name;
                
                if (files[fileName]) {
                    let counter = 1;
                    const meta = parseFileMetadata(fileName);
                    let newName = `${meta.baseName}_${counter}${meta.ext}`;
                    while(files[newName]) {
                        counter++;
                        newName = `${meta.baseName}_${counter}${meta.ext}`;
                    }
                    fileName = newName;
                }
                
                const metaFinal = parseFileMetadata(fileName);
                files[fileName] = { mode: metaFinal.mode, content: content };
                resolve(fileName);
            };
            reader.readAsText(file);
        });
    });
    
    const importedNames = await Promise.all(readPromises);
    lastFileName = importedNames[importedNames.length - 1]; 
    
    if (files['new']) { delete files['new']; }
    if (!files[currentFile]) { currentFile = lastFileName; }
    
    localStorage.setItem('ios_editor_pro_files', JSON.stringify(files));
    event.target.value = ''; 
    
    renderDropdown();
    switchFile(currentFile);
    alert(`Đã nhập ${uploadedFiles.length} file!`);
}

function exportFiles() {
    let exportAll = confirm("Xuất TẤT CẢ các file (OK) hay chỉ file hiện tại (Cancel)?");
    if (exportAll) {
        let delay = 0;
        for (let fileName in files) {
            setTimeout(() => { downloadSingleFile(fileName, files[fileName].content); }, delay);
            delay += 400; 
        }
    } else {
        downloadSingleFile(currentFile, files[currentFile].content);
    }
}

function downloadSingleFile(filename, content) {
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

function toggleConsole() {
    const vConsole = document.getElementById('virtual-console');
    vConsole.classList.toggle('active');
}

function closePreview() {
    const overlay = document.getElementById('preview-overlay');
    const iframe = document.getElementById('preview');
    overlay.classList.remove('active');
    
    document.getElementById('virtual-console').classList.remove('active');
    
    // --- TỐI ƯU BỘ NHỚ ---
    if (iframe.src && iframe.src.startsWith('blob:')) {
        URL.revokeObjectURL(iframe.src);
    }
    iframe.src = "about:blank"; 
    
    setTimeout(() => {
        editor.refresh();
        editor.focus();
    }, 450); // Cập nhật lại khung sau khi animation Spring đóng xong
}

function runCode() {
    clearErrorLines(); 

    const overlay = document.getElementById('preview-overlay');
    const iframeContainer = document.getElementById('iframe-container');
    overlay.classList.add('active');
    
    document.getElementById('console-output').innerHTML = '';
    
    let htmlContent = "";
    if (files['index.html']) {
        htmlContent = files['index.html'].content;
    } else {
        let firstHtml = Object.keys(files).find(k => k.endsWith('.html'));
        htmlContent = firstHtml ? files[firstHtml].content : "<body></body>";
    }

    let cssContent = "";
    let jsContent = "";

    for (let f in files) {
        let isCSS = f.endsWith('.css') || files[f].mode === 'css';
        let isJS = f.endsWith('.js') || files[f].mode === 'javascript';
        
        if (isCSS) cssContent += `\n/* File: ${f} */\n${files[f].content}`;
        if (isJS) jsContent += `\n// File: ${f}\n${files[f].content}`;
    }

    const consoleInterceptor = `
        <script>
            window.onerror = function(message, source, lineno, colno, error) {
                window.parent.postMessage({ type: 'error', log: message, line: lineno }, '*');
                return true; 
            };
            const originalLog = console.log;
            console.log = function(...args) {
                const msg = args.map(a => typeof a === 'object' ? JSON.stringify(a) : a).join(' ');
                window.parent.postMessage({ type: 'log', log: msg }, '*');
                originalLog.apply(console, args);
            };
            const originalError = console.error;
            console.error = function(...args) {
                const msg = args.map(a => typeof a === 'object' ? JSON.stringify(a) : a).join(' ');
                window.parent.postMessage({ type: 'error', log: msg }, '*'); 
                originalError.apply(console, args);
            };
        <\/script>
    `;

    let headPart = [
        "<!DOCTYPE html>",
        "<html>",
        "<head>",
        "<meta charset=\"UTF-8\">",
        "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\">",
        consoleInterceptor,
        "<style>",
        cssContent,
        "</style>",
        "</head>",
        "<body>"
    ].join('\n');
    
    let bodyPart = htmlContent + "\n<script>\n";

    offsetHTML = headPart.split('\n').length; 
    offsetJS = offsetHTML + bodyPart.split('\n').length - 1;

    const finalSource = headPart + "\n" + htmlContent + `\n<script>\n${jsContent}\n<\/script>\n</body>\n</html>`;

    const blob = new Blob([finalSource], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    
    // --- LÀM SẠCH IFRAME CŨ (Chống Memory Leak trên RAM iOS) ---
    const oldIframe = document.getElementById('preview');
    if (oldIframe) {
        if (oldIframe.src.startsWith('blob:')) {
            URL.revokeObjectURL(oldIframe.src);
        }
        oldIframe.remove();
    }
    
    // Khởi tạo Iframe mới tinh để cắt đứt các event listener hoặc bộ nhớ rác bị kẹt
    const newIframe = document.createElement('iframe');
    newIframe.id = 'preview';
    newIframe.src = url;
    iframeContainer.appendChild(newIframe);
}

// --- TỐI ƯU HOÁ ĐỒNG BỘ VISUAL VIEWPORT (BÀN PHÍM IOS) ---
if (window.visualViewport) {
    const adjustViewport = () => {
        document.body.style.height = window.visualViewport.height + 'px';
        window.scrollTo(0, 0); 
        
        // Buộc CodeMirror render lại và cuộn con trỏ lên vùng nhìn thấy được
        setTimeout(() => {
            editor.refresh();
            if (document.activeElement.classList.contains('CodeMirror-scroll')) {
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
switchFile(currentFile);
