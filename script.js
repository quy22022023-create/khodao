let files = JSON.parse(localStorage.getItem('ios_editor_pro_files')) || {
    'new': { mode: 'htmlmixed', content: '\n' }
};
let currentFile = Object.keys(files)[0] || 'new';

const editor = CodeMirror.fromTextArea(document.getElementById("code-editor"), {
    theme: "dracula",
    lineNumbers: true,
    lineWrapping: true,
    indentUnit: 4,
    tabSize: 4
});

editor.on("change", () => {
    if (files[currentFile]) {
        files[currentFile].content = editor.getValue();
        localStorage.setItem('ios_editor_pro_files', JSON.stringify(files));
    }
});

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
    renderDropdown();
    setTimeout(() => editor.refresh(), 50);
}

function addNewFile() {
    let name = prompt("Tên file mới (VD: app.js, style.css):");
    if (!name) return;
    
    if (files[name]) {
        let counter = 1;
        let newName = `${name}_${counter}`;
        while(files[newName]) {
            counter++; newName = `${name}_${counter}`;
        }
        name = newName;
    }
    
    let mode = 'javascript';
    if (name.endsWith('.html')) mode = 'htmlmixed';
    else if (name.endsWith('.css')) mode = 'css';
    
    files[name] = { mode: mode, content: '' };
    switchFile(name);
}

function renameCurrentFile() {
    let newName = prompt("Nhập tên mới cho file (VD: index.html, main.js):", currentFile);
    if (!newName || newName === currentFile) return;

    if (files[newName]) {
        alert("Tên file này đã tồn tại!");
        return;
    }

    let mode = 'javascript';
    if (newName.endsWith('.html')) mode = 'htmlmixed';
    else if (newName.endsWith('.css')) mode = 'css';

    files[newName] = { mode: mode, content: files[currentFile].content };
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
    }
}

function resetAllData() {
    const warning = "CẢNH BÁO: Hành động này sẽ xoá sạch TẤT CẢ các file hiện tại và đưa ứng dụng về trạng thái mặc định.\n\nBạn có chắc chắn muốn tiếp tục không?";
    if (confirm(warning)) {
        localStorage.removeItem('ios_editor_pro_files');
        location.reload(); 
    }
}

async function pasteFromClipboard() {
    try {
        const text = await navigator.clipboard.readText();
        if (text) {
            editor.focus();
            editor.replaceSelection(text);
        }
    } catch (err) {
        alert("Không thể dán dữ liệu. Trình duyệt chưa được cấp quyền truy cập bộ nhớ tạm (Clipboard), hoặc trình duyệt của bạn chặn tính năng này.");
        console.error('Lỗi khi đọc Clipboard:', err);
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
                    let nameParts = fileName.split('.');
                    let ext = nameParts.length > 1 ? '.' + nameParts.pop() : '';
                    let baseName = nameParts.join('.');
                    let newName = `${baseName}_${counter}${ext}`;
                    while(files[newName]) {
                        counter++;
                        newName = `${baseName}_${counter}${ext}`;
                    }
                    fileName = newName;
                }

                let mode = 'javascript';
                if (fileName.endsWith('.html')) mode = 'htmlmixed';
                else if (fileName.endsWith('.css')) mode = 'css';

                files[fileName] = { mode: mode, content: content };
                resolve(fileName);
            };
            reader.readAsText(file);
        });
    });

    const importedNames = await Promise.all(readPromises);
    lastFileName = importedNames[importedNames.length - 1]; 
    
    localStorage.setItem('ios_editor_pro_files', JSON.stringify(files));
    event.target.value = ''; 
    switchFile(lastFileName);
    
    alert(`Đã nhập thành công ${uploadedFiles.length} file!`);
}

function exportFiles() {
    let exportAll = confirm("Tuỳ chọn Xuất file:\n\n- Nhấn [OK] để xuất TẤT CẢ các file.\n- Nhấn [Cancel] để chỉ xuất file hiện tại (" + currentFile + ").");
    
    if (exportAll) {
        let delay = 0;
        for (let fileName in files) {
            setTimeout(() => {
                downloadSingleFile(fileName, files[fileName].content);
            }, delay);
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

function closePreview() {
    const overlay = document.getElementById('preview-overlay');
    overlay.classList.remove('active');
    setTimeout(() => editor.refresh(), 300);
}

function runCode() {
    const overlay = document.getElementById('preview-overlay');
    overlay.classList.add('active');
    
    let html = '';
    let css = '', js = '';

    if (files['index.html']) {
        html = files['index.html'].content;
    } else {
        let firstHtml = Object.keys(files).find(k => k.endsWith('.html')) || 'new';
        if (files[firstHtml]) html = files[firstHtml].content;
    }

    for (let f in files) {
        if (f.endsWith('.css')) css += `<style>${files[f].content}</style>`;
        if (f.endsWith('.js')) js += `<script>${files[f].content}<\/script>`;
    }

    const preview = document.getElementById('preview').contentWindow.document;
    preview.open();
    preview.write(html + css + js);
    preview.close();
}

switchFile(currentFile);