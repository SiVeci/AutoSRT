const { reactive } = Vue;
import { WS_BASE, getModels } from './api.js';

/* 全局状态管理 (轻量级 Pinia 替代) */
export const store = reactive({
    // --- 全局应用控制 ---
    appVersion: "v1.3.0",
    showGlobalSettings: false,

    // --- 任务核心状态 ---
    taskId: null,
    currentTaskName: "",
    activeStep: 0,
    isProcessing: false,
    
    // --- 全局流水线状态 (存储所有正在车间跑的任务) ---
    pipelineStatus: {},
    
    // --- 资产就绪状态 (用于控制各 Tab 的按钮是否可用) ---
    assets: {
        hasVideo: false,
        hasAudio: false,
        hasOriginalSrt: false,
        hasTranslatedSrt: false
    },

    // --- 下载模型进度记录 ---
    downloadingModels: {},

    // --- 跨组件的细粒度状态 (用于断线恢复) ---
    taskState: {
        extractedTime: "",
        downloadedMB: null
    },

    // --- 全局日志系统 ---
    logs: [],

    // --- 硬件系统信息 ---
    systemInfo: { device: "unknown", gpu_name: "" },

    // --- 强制刷新工作区列表的触发器 ---
    refreshTasksTrigger: 0,

    // --- 全局配置参数 (完整镜像后端的 config.json 结构) ---
    config: {
        system_settings: { network_proxy: "", enable_global_proxy: false, use_proxy_for_model_download: false, vram_mutual_exclusion: true },
        secrets: { hf_token: "" },
        model_settings: { model_size: "medium", download_root: "models" },
        transcribe_settings: { 
            engine: "local",
            idle_timeout: 300,
            language: null, 
            task: "transcribe",
            temperature: [0.0, 0.2, 0.4, 0.6, 0.8, 1.0],
            suppress_tokens: [-1]
        },
        vad_settings: { vad_filter: true },
        ffmpeg_settings: { audio_track: "0:a:0", start_time: "", end_time: "" },
        llm_settings: {
            engine: "api",
            active_profile_id: "default",
            profiles: [
                {
                    id: "default",
                    name: "默认方案",
                    api_key: "",
                    base_url: "https://api.openai.com/v1",
                    model_name: "gpt-4o",
                    batch_size: 50,
                    concurrent_workers: 3,
                    max_tokens: 8192,
                    temperature: 1.0,
                    system_prompt: "",
                    timeout_settings: { connect: 15, read: 300 }
                }
            ],
            local_settings: {
                model_path: "",
                n_gpu_layers: -1,
                n_ctx: 4096,
                idle_timeout: 300
            },
            target_language: "zh",
            use_network_proxy: false
        },
        online_asr_settings: {
            active_profile_id: "default",
            profiles: [
                {
                    id: "default",
                    name: "默认方案",
                    api_key: "",
                    base_url: "https://api.openai.com/v1",
                    model_name: "whisper-1",
                    prompt: "",
                    translate: false,
                    speaker_labels: false,
                    word_timestamps: false,
                    timeout_settings: { connect: 15, read: 300 }
                }
            ],
            language: null,
            use_network_proxy: false
        },
        library: {
            library_paths: [],
            allowed_extensions: [],
            auto_scan_enabled: false
        }
    },

    // --- 字典数据 (从后端拉取的下拉框选项) ---
    dicts: {
        languages: [],
        models: [],
        llm_models: [],
        asr_models: []
    }
});

// 统一的日志追加方法
export const addLog = (message, type = "info") => {
    const time = new Date().toLocaleTimeString();
    store.logs.push({ time, message, type });
    
    // [防卡顿] 限制日志最大保留条数，防止处理超长音频时 Vue 响应式数组无限膨胀导致浏览器 OOM
    if (store.logs.length > 1000) {
        store.logs.shift();
    }
};

// --- 通用 WebSocket 监视器 (支持复用与状态路由) ---
let currentWs = null;
export const connectTaskMonitor = (taskId, onSuccess, onError) => {
    if (currentWs) {
        currentWs.close();
    }
    
    const ws = new WebSocket(`${WS_BASE}/ws/progress/${taskId}`);
    currentWs = ws;

    ws.onopen = () => addLog("已成功连接到后端实时监视器...", "success");
    ws.onerror = () => { 
        addLog("WebSocket 连接异常或中断！", "error"); 
        store.isProcessing = false; 
        if (onError) onError(new Error("WS_ERROR"));
    };
    
    ws.onmessage = (event) => {
        const data = JSON.parse(event.data);
        if (data.status === "processing") {
            // 1. 路由全局进度条
            if (data.step === "extract_audio") store.activeStep = 2;
            else if (data.step === "downloading" || data.step === "transcribing") store.activeStep = 3;
            else if (data.step === "translating") store.activeStep = 4;

            // 2. 路由 Tab 专属特有状态
            if (data.extracted_time) store.taskState.extractedTime = data.extracted_time;
            if (data.step === "downloading" && data.downloaded_mb !== undefined) {
                store.taskState.downloadedMB = data.downloaded_mb;
            } else if (data.step === "transcribing") {
                if (store.taskState.downloadedMB !== null) {
                    getModels().then(res => { store.dicts.models = res; }).catch(() => {});
                }
                store.taskState.downloadedMB = null;
            }

            // 3. 路由日志打印
            if (data.progress) {
                addLog(`[${data.progress}] ${data.text}`, "progress");
            } else if (data.message) {
                if (data.message.includes("❌")) addLog(data.message, "error");
                else if (data.message.includes("⚠️")) addLog(data.message, "warning");
                else addLog(data.message, "info");
            }
        } else if (data.status === "completed") {
            store.isProcessing = false;
            
            // 兜底处理：只要后端传了完成 message，就打印到控制台
            if (data.message) {
                addLog(data.message, "success");
            }
            
            if (onSuccess) onSuccess(data);
            ws.close();
            currentWs = null;
        } else if (data.status === "error") {
            store.isProcessing = false;
            addLog(`发生错误: ${data.message}`, "error");
            if (onError) onError(new Error(data.message));
            ws.close();
            currentWs = null;
        }
    };
    return ws;
};

export const connectSystemDownloadMonitor = (modelId, onSuccess, onError) => {
    const wsId = `sys_download_${modelId}`;
    const ws = new WebSocket(`${WS_BASE}/ws/progress/${wsId}`);

    ws.onmessage = (event) => {
        const data = JSON.parse(event.data);
        if (data.status === "processing" && data.step === "downloading") {
            store.downloadingModels[modelId] = data.downloaded_mb;
        } else if (data.status === "completed") {
            delete store.downloadingModels[modelId];
            if (onSuccess) onSuccess(data);
            ws.close();
        } else if (data.status === "error") {
            delete store.downloadingModels[modelId];
            if (onError) onError(new Error(data.message));
            ws.close();
        }
    };
    return ws;
};