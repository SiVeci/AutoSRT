/* 封装所有的后端 API 请求与 WebSocket 连接逻辑 */
export const API_BASE = window.location.origin;
export const WS_BASE = `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}`;

// --- 通用 GET 请求 ---
async function fetchGet(endpoint) {
    const res = await fetch(`${API_BASE}${endpoint}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
    return await res.json();
}

// --- 配置与字典接口 ---
export const getSystemInfo = () => fetchGet('/api/system/info');
export const getConfig = () => fetchGet('/api/config');
export const updateConfig = async (config) => {
    const res = await fetch(`${API_BASE}/api/config`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(config)
    });
    if (!res.ok) throw new Error("保存配置失败");
    return await res.json();
};
export const restoreConfig = async () => {
    const res = await fetch(`${API_BASE}/api/config/restore`, { method: "POST" });
    if (!res.ok) throw new Error("恢复配置失败");
    return await res.json();
};

export const testProxy = async (proxyUrl) => {
    const res = await fetch(`${API_BASE}/api/proxy/test`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ proxy_url: proxyUrl })
    });
    if (!res.ok) {
        let errMsg = "代理连通性测试失败";
        try { errMsg = (await res.json()).detail || errMsg; } catch(e) {}
        throw new Error(errMsg);
    }
    return await res.json();
};

export const getLanguages = () => fetchGet('/api/languages');
export const getModels = () => fetchGet('/api/models');

export const deleteModel = async (modelId) => {
    const res = await fetch(`${API_BASE}/api/models/${encodeURIComponent(modelId)}`, { method: "DELETE" });
    if (!res.ok) {
        let errMsg = "删除失败";
        try { errMsg = (await res.json()).detail || errMsg; } catch(e) {}
        throw new Error(errMsg);
    }
    return await res.json();
};

export const downloadModel = async (modelId, config) => {
    const res = await fetch(`${API_BASE}/api/models/${encodeURIComponent(modelId)}/download`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(config)
    });
    if (!res.ok) {
        let errMsg = "下载请求失败";
        try { errMsg = (await res.json()).detail || errMsg; } catch(e) {}
        throw new Error(errMsg);
    }
    return await res.json();
};

export const getDownloadStatus = () => fetchGet('/api/models/download_status');

export const getLlmModels = async (api_key, base_url) => {
    const res = await fetch(`${API_BASE}/api/llm/models`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ api_key, base_url })
    });
    if (!res.ok) {
        let errMsg = "获取模型列表失败";
        try { errMsg = (await res.json()).detail || errMsg; } catch(e) {}
        throw new Error(errMsg);
    }
    return await res.json();
};

export const getLocalLlmModels = () => fetchGet('/api/llm/local_models');

export const getAsrModels = async (api_key, base_url) => {
    const res = await fetch(`${API_BASE}/api/asr/models`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ api_key, base_url })
    });
    if (!res.ok) {
        let errMsg = "获取模型列表失败";
        try { errMsg = (await res.json()).detail || errMsg; } catch(e) {}
        throw new Error(errMsg);
    }
    return await res.json();
};

// --- 核心操作接口 ---
export const uploadAsset = (file, assetType, taskId, onProgress) => {
    return new Promise((resolve, reject) => {
        const formData = new FormData();
        formData.append("file", file);
        if (taskId) formData.append("task_id", taskId);

        const xhr = new XMLHttpRequest();
        xhr.upload.onprogress = (e) => {
            if (e.lengthComputable && onProgress) {
                const percent = Math.round((e.loaded / e.total) * 100);
                onProgress(percent);
            }
        };
        xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300) {
                try { resolve(JSON.parse(xhr.responseText)); } catch (err) { reject(new Error("解析响应失败")); }
            } else {
                let errMsg = `HTTP ${xhr.status}`;
                try { errMsg = JSON.parse(xhr.responseText).detail || errMsg; } catch(e) {}
                reject(new Error(errMsg));
            }
        };
        xhr.onerror = () => reject(new Error("网络异常或跨域拦截"));
        xhr.open("POST", `${API_BASE}/api/upload/${assetType}`, true);
        xhr.send(formData);
    });
};

export const executeTask = async (taskId, steps, config) => {
    const payload = { task_id: taskId, steps, ...config };
    const res = await fetch(`${API_BASE}/api/task/execute`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
    });
    if (!res.ok) {
        let errMsg = "请求失败";
        try { errMsg = (await res.json()).detail || errMsg; } catch(e) {}
        throw new Error(errMsg);
    }
    return await res.json();
};

export const retryTask = async (taskId) => {
    const res = await fetch(`${API_BASE}/api/task/${taskId}/retry`, {
        method: "POST"
    });
    if (!res.ok) {
        let errMsg = "重试请求失败";
        try { errMsg = (await res.json()).detail || errMsg; } catch(e) {}
        throw new Error(errMsg);
    }
    return await res.json();
};

export const getTasks = () => fetchGet('/api/tasks');
export const getTaskAssets = (taskId) => fetchGet(`/api/task/${taskId}/assets`);
export const deleteTask = async (taskId) => {
    const res = await fetch(`${API_BASE}/api/task/${taskId}`, { method: "DELETE" });
    if (!res.ok) throw new Error("删除任务失败");
    return await res.json();
};

export const getTaskStatus = (taskId) => fetchGet(`/api/task/${taskId}/status`);
export const getPipelineStatus = () => fetchGet(`/api/pipeline/status`);

export const cancelTask = async (taskId) => {
    const res = await fetch(`${API_BASE}/api/task/${taskId}/cancel`, { method: "POST" });
    if (!res.ok) throw new Error("取消任务失败");
    return await res.json();
};

export const cancelAllTasks = async () => {
    const res = await fetch(`${API_BASE}/api/tasks/cancel_all`, { method: "POST" });
    if (!res.ok) throw new Error("中断全部任务失败");
    return await res.json();
};

export const deleteTaskAsset = async (taskId, assetType) => {
    const res = await fetch(`${API_BASE}/api/task/${taskId}/asset/${assetType}`, { method: "DELETE" });
    if (!res.ok) {
        let errMsg = "资产删除失败";
        try { errMsg = (await res.json()).detail || errMsg; } catch(e) {}
        throw new Error(errMsg);
    }
    return await res.json();
};

export const reorderTasks = async (taskIds) => {
    const res = await fetch(`${API_BASE}/api/tasks/reorder`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(taskIds)
    });
    if (!res.ok) throw new Error("排序保存失败");
    return await res.json();
};

// --- 媒体库接口 ---
export const getLibraryPaths = () => fetchGet('/api/library/paths');
export const addLibraryPath = async (path) => {
    const res = await fetch(`${API_BASE}/api/library/paths`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path })
    });
    if (!res.ok) {
        let errMsg = "添加路径失败";
        try { errMsg = (await res.json()).detail || errMsg; } catch(e) {}
        throw new Error(errMsg);
    }
    return await res.json();
};
export const deleteLibraryPath = async (path) => {
    const res = await fetch(`${API_BASE}/api/library/paths`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path })
    });
    if (!res.ok) throw new Error("删除路径失败");
    return await res.json();
};
export const scanLibrary = () => {
    return fetch(`${API_BASE}/api/library/scan`, { method: "POST" }).then(res => res.json());
};
export const getDiscoveries = () => fetchGet('/api/library/discoveries');
export const importFromLibrary = async (paths) => {
    const res = await fetch(`${API_BASE}/api/library/import`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paths })
    });
    if (!res.ok) {
        let errMsg = "导入失败";
        try { errMsg = (await res.json()).detail || errMsg; } catch(e) {}
        throw new Error(errMsg);
    }
    return await res.json();
};

export const downloadAsset = async (taskId, assetType, baseName) => {
    const url = `${window.location.origin}/api/download/${taskId}?type=${assetType}`;
    if ('showSaveFilePicker' in window) {
        try {
            const response = await fetch(url);
            if (!response.ok) throw new Error("获取文件流失败");
            
            let filename = baseName;
            const disposition = response.headers.get('content-disposition');
            if (disposition && disposition.includes('filename=')) {
                filename = decodeURIComponent(disposition.split('filename=')[1].replace(/["']/g, ''));
            } else if (disposition && disposition.includes('filename*=')) {
                filename = decodeURIComponent(disposition.split("''")[1]);
            } else {
                if (assetType === 'video') filename += '.mp4';
                else if (assetType === 'audio') filename += '.wav';
                else if (assetType === 'original') filename += '.srt';
                else if (assetType === 'translated') filename += '_translated.srt';
            }

            const handle = await window.showSaveFilePicker({ suggestedName: filename });
            const writable = await handle.createWritable();
            
            const contentLength = response.headers.get('content-length');
            const total = contentLength ? parseInt(contentLength, 10) : 0;
            let loaded = 0;
            const reader = response.body.getReader();
            
            const loading = ElementPlus.ElLoading.service({ lock: true, text: '正在保存至本地... [ 0% ]' });
            let lastTime = Date.now();
            let lastLoaded = 0;

            try {
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    await writable.write(value);
                    loaded += value.length;
                    
                    const now = Date.now();
                    if (now - lastTime > 500) {
                        const speed = (((loaded - lastLoaded) / ((now - lastTime) / 1000)) / 1024 / 1024).toFixed(1);
                        const percent = total ? Math.round((loaded / total) * 100) : '?';
                        const loadingTextEl = document.querySelector('.el-loading-text');
                        if (loadingTextEl) loadingTextEl.textContent = `正在保存至本地... [ ${percent}% ] (${speed} MB/s)`;
                        lastTime = now;
                        lastLoaded = loaded;
                    }
                }
                await writable.close();
                loading.close();
                ElementPlus.ElMessage.success("文件保存成功！");
            } catch (err) {
                await writable.abort();
                loading.close();
                throw err;
            }
        } catch (err) {
            if (err.name !== 'AbortError') ElementPlus.ElMessage.error("下载意外中断: " + err.message);
        }
    } else {
        window.open(url, "_blank");
        ElementPlus.ElNotification({ title: "下载指令已发送", message: "由于浏览器限制，请在原生下载管理器中查看进度。", type: "success" });
    }
};