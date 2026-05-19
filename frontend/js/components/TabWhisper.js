const { ref } = Vue;
import WhisperLocal from './WhisperLocal.js';
import WhisperApi from './WhisperApi.js';
import { store, addLog, connectTaskMonitor } from '../store.js';
import { executeTask, retryTask, updateConfig, uploadAsset } from '../api.js';

export default {
    name: 'TabWhisper',
    components: { WhisperLocal, WhisperApi },
    template: `
        <div class="whisper-container">
            <el-alert title="提示" type="info" show-icon style="margin-bottom: 20px;" :closable="false">
                将提取出的音频输入 faster-whisper 引擎进行识别，生成带有精确时间轴的原始语言字幕 (SRT)。如果你已有现成的原生字幕文件，可直接在此处上传，跳过本页的识别步骤。
            </el-alert>

            <el-card shadow="never" style="margin-bottom: 20px; border: 1px solid #ebeef5;">
                <template #header>
                    <div class="card-title"><el-icon style="margin-right:4px;"><Upload /></el-icon>独立字幕输入通道</div>
                </template>
                <div class="section-desc">
                    如果您已经拥有外部的生肉字幕文件，可在此直接上传，跳过识别步骤。
                </div>
                <el-upload
                    action="#"
                    :auto-upload="true"
                    :http-request="handleSrtUpload"
                    :show-file-list="false"
                    accept=".srt,.vtt"
                    :disabled="store.isProcessing || isUploading"
                >
                    <el-button type="success" plain :loading="isUploading">
                        <el-icon style="margin-right: 5px;"><Upload /></el-icon> 直接上传外部字幕 (绕过识别)
                    </el-button>
                </el-upload>
            </el-card>

            <el-tabs v-model="store.config.transcribe_settings.engine" style="margin-bottom: 20px;" stretch>
                <!-- 引擎 1: 本地 GPU -->
                <el-tab-pane name="local">
                    <template #label>
                        <span style="font-weight: bold; font-size: 14px; display: inline-flex; align-items: center;">
                            <el-icon style="margin-right:4px;"><Monitor /></el-icon>本地 GPU 引擎
                            <el-icon v-if="store.config.transcribe_settings.engine === 'local'" style="margin-left: 5px; color: #67C23A; font-weight: bold;"><Check /></el-icon>
                        </span>
                    </template>
                    <whisper-local></whisper-local>
                </el-tab-pane>
                
                <!-- 引擎 2: 云端 API -->
                <el-tab-pane name="api">
                    <template #label>
                        <span style="font-weight: bold; font-size: 14px; display: inline-flex; align-items: center;">
                            <el-icon style="margin-right:4px;"><Cloudy /></el-icon>云端 API 引擎
                            <el-icon v-if="store.config.transcribe_settings.engine === 'api'" style="margin-left: 5px; color: #67C23A; font-weight: bold;"><Check /></el-icon>
                        </span>
                    </template>
                    <whisper-api></whisper-api>
                </el-tab-pane>
            </el-tabs>

            <!-- 操作按钮与状态指示 -->
            <div class="action-bar">
                <el-button 
                    type="primary" 
                    size="large" 
                    @click="runTranscribe" 
                    :loading="store.isProcessing"
                    :disabled="!store.assets.hasAudio"
                >
                <el-icon style="margin-right: 5px;"><Microphone /></el-icon>
                <span v-if="(store.pipelineStatus[store.taskId]?.current_step === 'interrupted' || store.pipelineStatus[store.taskId]?.current_step === 'error') && (store.pipelineStatus[store.taskId]?.interrupted_step === 'transcribing' || store.pipelineStatus[store.taskId]?.interrupted_step === 'pending_transcribe')">
                    继续执行 (断点重试)
                </span>
                <span v-else>
                    {{ store.config.transcribe_settings.engine === 'api' ? ' 启动云端 API 识别' : ' 启动本地模型识别' }}
                </span>
                </el-button>
                
                <span v-if="store.assets.hasOriginalSrt" class="status-text-success">
                    原声字幕已生成，可前往翻译
                </span>
                <span v-else-if="!store.assets.hasAudio" class="status-text-error">
                    请先在前方提供音频
                </span>
            </div>
            
            <!-- 模型下载进度提示 -->
            <div v-if="store.taskState.downloadedMB !== null && store.isProcessing && store.activeStep === 3" style="margin-top: 15px;">
                <div style="display: inline-flex; justify-content: center; align-items: center; padding: 10px 15px; background-color: #ecf5ff; color: #409EFF; border-radius: 4px; font-size: 14px;">
                    <el-icon class="is-loading" style="margin-right: 8px; font-size: 18px;"><Loading /></el-icon>
                    <span>首次加载较慢，正在读取或下载模型... (已下载: {{ store.taskState.downloadedMB }} MB)</span>
                </div>
            </div>
        </div>
    `,
    setup() {
        const isUploading = ref(false);

        const handleSrtUpload = async (options) => {
            addLog(`开始上传外部生肉字幕: ${options.file.name}...`, "info");
            isUploading.value = true;
            try {
                const res = await uploadAsset(options.file, 'srt', store.taskId, null);
                store.taskId = res.task_id;
                store.currentTaskName = options.file.name;
                store.assets.hasOriginalSrt = true;
                store.activeStep = 4;
                store.refreshTasksTrigger++;
                addLog(`外部字幕上传成功！任务 ID: \${res.task_id}`, "success");
                ElementPlus.ElMessage.success("生肉字幕上传成功，可以直接前往【LLM 翻译】！");
            } catch (e) {
                addLog(`字幕上传失败: \${e.message}`, "error");
                ElementPlus.ElMessage.error(`上传失败: \${e.message}`);
            } finally {
                isUploading.value = false;
            }
        };

        // 启动识别
        const runTranscribe = async () => {
            if (!store.taskId || !store.assets.hasAudio) return;

            // 如果是 API 引擎，额外校验 API Key
            if (store.config.transcribe_settings.engine === 'api') {
                const asrActiveId = store.config.online_asr_settings.active_profile_id;
                const asrProfile = store.config.online_asr_settings.profiles.find(p => p.id === asrActiveId) || store.config.online_asr_settings.profiles[0];
                if (!asrProfile || !asrProfile.api_key) {
                    ElementPlus.ElMessage.warning("使用云端识别前，请先在【云端 API 识别】页填写 API Key！");
                    return;
                }
            }

            store.isProcessing = true;
            store.activeStep = 3; // 进度条跳到原声识别
            store.taskState.downloadedMB = null;

            const statusObj = store.pipelineStatus[store.taskId];
            const currentStatus = statusObj?.current_step;
            const interruptedStep = statusObj?.interrupted_step;
            const isRetry = (currentStatus === 'interrupted' || currentStatus === 'error') && (interruptedStep === 'transcribing' || interruptedStep === 'pending_transcribe');
            const engineName = store.config.transcribe_settings.engine === 'api' ? "云端 API" : "本地 Whisper";
            addLog(isRetry ? "正在尝试断点重试任务..." : `启动 ${engineName} 识别引擎...`, "info");

            connectTaskMonitor(
                store.taskId,
                () => {
                    store.assets.hasOriginalSrt = true;
                    store.activeStep = 4; // 进入 LLM 翻译待命状态
                    addLog("原声字幕提取完毕！", "success");
                    ElementPlus.ElMessage.success("识别成功！已生成 SRT 原生字幕。");
                },
                () => {}
            );

            // 执行前单独触发落盘保存
            try { await updateConfig(store.config); } catch (e) {}

            try {
                if (isRetry) {
                    await retryTask(store.taskId);
                } else {
                    await executeTask(store.taskId, ["transcribe"], store.config);
                }
            } catch (e) {
                addLog(`请求启动任务失败: ${e.message}`, "error");
                store.isProcessing = false;
            }
        };

        return { store, isUploading, handleSrtUpload, runTranscribe };
    }
};