const { ref, computed } = Vue;
import { store, addLog, connectTaskMonitor } from '../store.js';
import { executeTask, retryTask, getLlmModels, updateConfig, getLocalLlmModels } from '../api.js';

export default {
    name: 'TabLLM',
    template: `
        <div class="llm-container">
            <el-alert title="提示" type="info" show-icon style="margin-bottom: 20px;" :closable="false">
                使用大语言模型 (如 DeepSeek, Qwen, ChatGPT 等) 对提取出的原生字幕进行上下文连贯的批量翻译和润色。
            </el-alert>

            <el-tabs v-model="store.config.llm_settings.engine" style="margin-bottom: 20px;" stretch>
                <!-- 引擎 1: 本地离线引擎 -->
                <el-tab-pane name="local">
                    <template #label>
                        <span style="font-weight: bold; font-size: 14px; display: inline-flex; align-items: center;">
                            <el-icon style="margin-right:4px;"><Monitor /></el-icon>本地离线引擎
                            <el-icon v-if="store.config.llm_settings.engine === 'local'" style="margin-left: 5px; color: #67C23A; font-weight: bold;"><Check /></el-icon>
                        </span>
                    </template>
                    <el-card shadow="never" style="border: 1px solid #ebeef5; border-top: none;">
                        <template #header>
                            <span class="card-title"><el-icon style="margin-right:4px;"><Setting /></el-icon>本地模型配置</span>
                        </template>
                        <el-form label-width="140px" label-position="left" size="default">
                            <el-form-item>
                                <template #label>
                                    <span style="display: inline-flex; align-items: center;">
                                        本地模型文件
                                        <el-tooltip content="请将下载好的 .gguf 格式模型文件放入项目根目录的 models/llm/ 文件夹中。系统会自动扫描该目录。" placement="top" trigger="click">
                                            <el-icon style="margin-left: 4px; cursor: pointer; color: #909399;" @click.stop.prevent><QuestionFilled /></el-icon>
                                        </el-tooltip>
                                    </span>
                                </template>
                                <div style="display: flex; gap: 10px; width: 100%;">
                                    <el-select v-model="store.config.llm_settings.local_settings.model_path" placeholder="请选择 models/llm 目录下的 GGUF 模型" filterable style="flex: 1;">
                                        <el-option v-for="m in localModels" :key="m" :label="m" :value="m"></el-option>
                                    </el-select>
                                    <el-button type="primary" plain @click="refreshLocalModels" :loading="isFetchingLocalModels" title="重新扫描 models/llm 目录">
                                        <el-icon><Refresh /></el-icon>
                                    </el-button>
                                </div>
                                <div style="font-size: 12px; color: #909399; margin-top: 5px;">
                                    请将 .gguf 格式的量化模型放入项目的 <code>models/llm/</code> 目录下。
                                </div>
                            </el-form-item>

                            <el-form-item>
                                <template #label>
                                    <span style="display: inline-flex; align-items: center;">
                                        GPU 加速层数
                                        <el-tooltip content="决定将多少层模型神经网络卸载到显卡的 VRAM 中。填 -1 代表尽可能全部加载到 GPU 显存以获得最快速度。如果遇到 Out Of Memory 报错，请适当调低此数值以使用 CPU 内存作为补充。" placement="top" trigger="click">
                                            <el-icon style="margin-left: 4px; cursor: pointer; color: #909399;" @click.stop.prevent><QuestionFilled /></el-icon>
                                        </el-tooltip>
                                    </span>
                                </template>
                                <el-slider v-model="store.config.llm_settings.local_settings.n_gpu_layers" :min="-1" :max="128" :step="1" show-input></el-slider>
                                <div style="font-size: 12px; color: #909399; line-height: 1.2;">
                                    -1 代表尽可能全部加载到显存。如果显存不足，请调低此数值。
                                </div>
                            </el-form-item>

                            <el-form-item>
                                <template #label>
                                    <span style="display: inline-flex; align-items: center;">
                                        上下文长度
                                        <el-tooltip content="模型一次能处理的最大 Token 数量。翻译时系统会自动保留上一批次的最后几句作为上下文。建议设置为 4096 或 8192。设置过高会急剧增加显存占用，设置过低可能导致翻译到一半时因超长而截断。" placement="top" trigger="click">
                                            <el-icon style="margin-left: 4px; cursor: pointer; color: #909399;" @click.stop.prevent><QuestionFilled /></el-icon>
                                        </el-tooltip>
                                    </span>
                                </template>
                                <el-input-number v-model="store.config.llm_settings.local_settings.n_ctx" :min="512" :max="131072" :step="512"></el-input-number>
                            </el-form-item>

                            <el-form-item>
                                <template #label>
                                    <span style="display: inline-flex; align-items: center;">
                                        闲置释放时间
                                        <el-tooltip content="当翻译任务完成后，模型在显存中继续驻留的倒计时。如果在该时间内没有新的翻译任务，模型将自动从显存卸载。填 0 代表永不自动释放。" placement="top" trigger="click">
                                            <el-icon style="margin-left: 4px; cursor: pointer; color: #909399;" @click.stop.prevent><QuestionFilled /></el-icon>
                                        </el-tooltip>
                                    </span>
                                </template>
                                <el-input-number v-model="store.config.llm_settings.local_settings.idle_timeout" :min="0" :max="3600" :step="60"></el-input-number>
                                <span style="margin-left: 8px; color: #909399;">秒 (0 代表不释放)</span>
                            </el-form-item>
                        </el-form>
                    </el-card>
                </el-tab-pane>

                <!-- 引擎 2: 在线 API 模式 -->
                <el-tab-pane name="api">
                    <template #label>
                        <span style="font-weight: bold; font-size: 14px; display: inline-flex; align-items: center;">
                            <el-icon style="margin-right:4px;"><Cloudy /></el-icon>在线 API 模式
                            <el-icon v-if="store.config.llm_settings.engine === 'api'" style="margin-left: 5px; color: #67C23A; font-weight: bold;"><Check /></el-icon>
                        </span>
                    </template>
                    <el-card shadow="never" style="border: 1px solid #ebeef5; border-top: none;">
                        <template #header>
                            <div style="display: flex; justify-content: space-between; align-items: center;">
                                <span class="card-title"><el-icon style="margin-right:4px;"><Setting /></el-icon>API 配置</span>
                                <div style="display: flex; align-items: center; gap: 10px;">
                                    <span style="font-size: 13px; color: #909399;">切换方案:</span>
                                    <el-select v-model="store.config.llm_settings.active_profile_id" size="small" style="width: 150px;">
                                        <el-option v-for="p in store.config.llm_settings.profiles" :key="p.id" :label="p.name" :value="p.id"></el-option>
                                    </el-select>
                                    <el-dropdown trigger="click" @command="handleProfileCommand">
                                        <el-button type="info" size="small" plain icon="Operation"></el-button>
                                        <template #dropdown>
                                            <el-dropdown-menu>
                                                <el-dropdown-item command="add" icon="Plus">新增方案</el-dropdown-item>
                                                <el-dropdown-item command="rename" icon="Edit">重命名当前方案</el-dropdown-item>
                                                <el-dropdown-item command="delete" icon="Delete" divided style="color: #F56C6C;">删除当前方案</el-dropdown-item>
                                            </el-dropdown-menu>
                                        </template>
                                    </el-dropdown>
                                </div>
                            </div>
                        </template>
                        <el-form :model="activeProfile" label-width="140px" label-position="left" size="default">
                            <el-form-item>
                                <template #label>
                                    <span style="display: inline-flex; align-items: center;">
                                        API Base URL
                                        <el-tooltip content="兼容 OpenAI 格式的 API 接口地址。官方接口请填 https://api.openai.com/v1，第三方或中转代理服务请填入对应地址。" placement="top" trigger="click">
                                            <el-icon style="margin-left: 4px; cursor: pointer; color: #909399;" @click.stop.prevent><QuestionFilled /></el-icon>
                                        </el-tooltip>
                                    </span>
                                </template>
                                <el-input v-model="activeProfile.base_url" placeholder="例如: https://api.openai.com/v1"></el-input>
                            </el-form-item>

                            <el-form-item label="API Key">
                                <el-input v-model="activeProfile.api_key" type="password" show-password placeholder="sk-..."></el-input>
                            </el-form-item>

                            <el-form-item>
                                <template #label>
                                    <span style="display: inline-flex; align-items: center;">
                                        API 访问代理
                                        <el-tooltip content="调用大语言模型 API 时，通过配置的全局网络代理进行访问。" placement="top" trigger="click">
                                            <el-icon style="margin-left: 4px; cursor: pointer; color: #909399;" @click.stop.prevent><QuestionFilled /></el-icon>
                                        </el-tooltip>
                                    </span>
                                </template>
                                <el-switch v-model="store.config.llm_settings.use_network_proxy" :disabled="!store.config.system_settings.enable_global_proxy"></el-switch>
                            </el-form-item>

                            <el-form-item>
                                <template #label>
                                    <span style="display: inline-flex; align-items: center;">
                                        Model Name
                                        <el-tooltip content="指定用于翻译的大语言模型名称。官方接口可填 'gpt-4o' 等，中转代理请视服务商支持填写。点击右侧按钮可直接拉取可用列表。" placement="top" trigger="click">
                                            <el-icon style="margin-left: 4px; cursor: pointer; color: #909399;" @click.stop.prevent><QuestionFilled /></el-icon>
                                        </el-tooltip>
                                    </span>
                                </template>
                                <div style="display: flex; gap: 10px; width: 100%;">
                                    <el-select v-model="activeProfile.model_name" placeholder="请选择或输入模型名称" filterable allow-create default-first-option style="flex: 1;">
                                        <el-option v-for="model in store.dicts.llm_models" :key="model" :label="model" :value="model"></el-option>
                                    </el-select>
                                    <el-button type="primary" plain @click="refreshModels" :loading="isFetchingModels" title="从 API 供应商拉取可用模型">
                                        <el-icon><Refresh /></el-icon>
                                    </el-button>
                                </div>
                            </el-form-item>
                        </el-form>
                    </el-card>
                </el-tab-pane>
            </el-tabs>

            <el-card shadow="never" style="margin-bottom: 20px; border: 1px solid #ebeef5;">
                <template #header>
                    <span class="card-title"><el-icon style="margin-right:4px;"><Operation /></el-icon>通用翻译参数</span>
                </template>
                <el-collapse v-model="activeCollapse" style="border-top: none; border-bottom: none;">
                    <el-collapse-item name="1">
                        <template #title>
                            <span style="color: #909399; font-size: 13px;">点击展开设置目标语言、批次大小、Prompt 等</span>
                        </template>
                        <el-form :model="activeProfile" label-width="140px" label-position="left" size="default">
                            <el-form-item>
                                <template #label>
                                    <span style="display: inline-flex; align-items: center;">
                                        目标语言
                                        <el-tooltip content="指定原声字幕需要被翻译成的目标语言。大模型将根据此选项生成对应的译文。" placement="top" trigger="click">
                                            <el-icon style="margin-left: 4px; cursor: pointer; color: #909399;" @click.stop.prevent><QuestionFilled /></el-icon>
                                        </el-tooltip>
                                    </span>
                                </template>
                                <el-select v-model="store.config.llm_settings.target_language" placeholder="选择翻译目标语言" filterable style="width: 100%;">
                                    <el-option-group label="常用语言">
                                        <el-option v-for="lang in pinnedLanguages" :key="lang.code" :label="\`\${lang.name} (\${lang.code})\`" :value="lang.code"></el-option>
                                    </el-option-group>
                                    <el-option-group label="其他语言 (A-Z)">
                                        <el-option v-for="lang in otherLanguages" :key="lang.code" :label="\`\${lang.name} (\${lang.code})\`" :value="lang.code"></el-option>
                                    </el-option-group>
                                </el-select>
                            </el-form-item>

                            <el-form-item>
                                <template #label>
                                    <span style="display: inline-flex; align-items: center;">
                                        翻译批次大小
                                        <el-tooltip content="每次发给大模型的字幕行数。太小会导致缺乏上下文，太大可能超出模型单次输出上限或导致漏翻。" placement="top" trigger="click">
                                            <el-icon style="margin-left: 4px; cursor: pointer; color: #909399;" @click.stop.prevent><QuestionFilled /></el-icon>
                                        </el-tooltip>
                                    </span>
                                </template>
                                <el-slider v-model="activeProfile.batch_size" :min="10" :max="200" :step="10" show-input></el-slider>
                            </el-form-item>

                            <el-form-item>
                                <template #label>
                                    <span style="display: inline-flex; align-items: center;">
                                        并发请求数
                                        <el-tooltip content="同时发送给大模型的翻译请求数。数字越大越快，但过大易触发 API 限流 (429报错)。本地模型请设为1。" placement="top" trigger="click">
                                            <el-icon style="margin-left: 4px; cursor: pointer; color: #909399;" @click.stop.prevent><QuestionFilled /></el-icon>
                                        </el-tooltip>
                                    </span>
                                </template>
                                <el-slider v-model="activeProfile.concurrent_workers" :min="1" :max="20" :step="1" show-input></el-slider>
                            </el-form-item>

                            <el-form-item>
                                <template #label>
                                    <span style="display: inline-flex; align-items: center;">
                                        Max Tokens
                                        <el-tooltip content="大模型单次返回的最大 Token 数量。带深度思考的模型需要留出充足的空间，建议设为 8192。" placement="top" trigger="click">
                                            <el-icon style="margin-left: 4px; cursor: pointer; color: #909399;" @click.stop.prevent><QuestionFilled /></el-icon>
                                        </el-tooltip>
                                    </span>
                                </template>
                                <el-input-number v-model="activeProfile.max_tokens" :min="1024" :max="131072" :step="1024" style="width: 150px;"></el-input-number>
                            </el-form-item>

                            <el-form-item>
                                <template #label>
                                    <span style="display: inline-flex; align-items: center;">
                                        Temperature
                                        <el-tooltip content="控制大模型输出的随机性。数值越低越严谨，越高越发散。翻译任务通常建议保持 1.0 或适当降低。" placement="top" trigger="click">
                                            <el-icon style="margin-left: 4px; cursor: pointer; color: #909399;" @click.stop.prevent><QuestionFilled /></el-icon>
                                        </el-tooltip>
                                    </span>
                                </template>
                                <el-slider v-model="activeProfile.temperature" :min="0" :max="2.0" :step="0.1" show-input></el-slider>
                            </el-form-item>

                            <el-form-item>
                                <template #label>
                                    <span style="display: inline-flex; align-items: center;">
                                        网络超时设置
                                        <el-tooltip content="左侧: 连接超时(秒)；右侧: 等待模型响应的最长超时(秒)。遇到极慢的模型时请调大右侧数值以防止假死报错。" placement="top" trigger="click">
                                            <el-icon style="margin-left: 4px; cursor: pointer; color: #909399;" @click.stop.prevent><QuestionFilled /></el-icon>
                                        </el-tooltip>
                                    </span>
                                </template>
                                <div style="display: flex; gap: 10px; align-items: center;">
                                    <el-input-number v-model="activeProfile.timeout_settings.connect" :min="3" :max="60" :step="1" placeholder="连接" style="width: 100px;"></el-input-number>
                                    <span>/</span>
                                    <el-input-number v-model="activeProfile.timeout_settings.read" :min="30" :max="1800" :step="10" placeholder="读取" style="width: 120px;"></el-input-number>
                                    <span style="color: #909399; font-size: 13px;">秒</span>
                                </div>
                            </el-form-item>

                            <el-form-item>
                                <template #label>
                                    <span style="display: inline-flex; align-items: center;">
                                        System Prompt
                                        <el-tooltip content="控制大模型的翻译风格指令。前缀语言指令会自动生成，你可以在此定制附加的风格要求。" placement="top" trigger="click">
                                            <el-icon style="margin-left: 4px; cursor: pointer; color: #909399;" @click.stop.prevent><QuestionFilled /></el-icon>
                                        </el-tooltip>
                                    </span>
                                </template>
                                <div style="width: 100%; display: flex; flex-direction: column; gap: 8px;">
                                    <div style="background-color: #f5f7fa; padding: 10px 15px; border-radius: 4px; border: 1px solid #e4e7ed; color: #606266; font-size: 13px; white-space: pre-wrap; line-height: 1.5; max-height: 150px; overflow-y: auto;">{{ fixedPrompt }}</div>
                                    <el-input type="textarea" v-model="activeProfile.system_prompt" :rows="5"
                                        placeholder="[在此输入附加的自定义风格和格式要求，例如：请输出双语字幕，第一行中文...]&#10;留空则使用内置的【高质量通用影视翻译】格式要求。"
                                    ></el-input>
                                </div>
                            </el-form-item>
                        </el-form>
                    </el-collapse-item>
                </el-collapse>
            </el-card>

            <!-- 操作按钮与状态指示 -->
            <div class="action-bar">
                <el-button 
                    type="primary" 
                    size="large" 
                    @click="runTranslate" 
                    :loading="store.isProcessing"
                    :disabled="!store.assets.hasOriginalSrt"
                >
                    <el-icon style="margin-right: 5px;"><ChatDotSquare /></el-icon> 
                    {{ ((store.pipelineStatus[store.taskId]?.current_step === 'interrupted' || store.pipelineStatus[store.taskId]?.current_step === 'error') && (store.pipelineStatus[store.taskId]?.interrupted_step === 'translating' || store.pipelineStatus[store.taskId]?.interrupted_step === 'pending_translate')) ? '继续执行 (断点重试)' : '开始执行智能翻译' }}
                </el-button>
                
                <span v-if="!store.assets.hasOriginalSrt" class="status-text-error">
                    请先在前方提供原声字幕
                </span>
                <span v-else-if="store.assets.hasTranslatedSrt" class="status-text-success">
                    翻译字幕已生成，请在右侧下载
                </span>
            </div>
        </div>
    `,
    setup() {        const isFetchingModels = ref(false);
        const isFetchingLocalModels = ref(false);
        const localModels = ref([]);
        const activeCollapse = ref([]); // 默认折叠状态

        const activeProfile = computed(() => {
            const id = store.config.llm_settings.active_profile_id;
            return store.config.llm_settings.profiles.find(p => p.id === id) || store.config.llm_settings.profiles[0];
        });

        const refreshLocalModels = async () => {
            isFetchingLocalModels.value = true;
            try {
                localModels.value = await getLocalLlmModels();
                if (localModels.value.length === 0) {
                    ElementPlus.ElMessage.info("未在 models/llm 目录下检测到 GGUF 模型文件。");
                }
            } catch (e) {
                ElementPlus.ElMessage.error("获取本地模型失败: " + e.message);
            } finally {
                isFetchingLocalModels.value = false;
            }
        };

        // 初始加载一次本地模型列表
        refreshLocalModels();

        // 方案管理逻辑
        const handleProfileCommand = async (command) => {
            const settings = store.config.llm_settings;
            if (command === 'add') {
                const newId = 'profile_' + Date.now();
                const newProfile = JSON.parse(JSON.stringify(activeProfile.value));
                newProfile.id = newId;
                newProfile.name = '新方案_' + newId.substring(newId.length - 4);
                settings.profiles.push(newProfile);
                settings.active_profile_id = newId;
                ElementPlus.ElMessage.success("已创建并切换到新方案，请修改配置后点击保存。");
            } else if (command === 'rename') {
                try {
                    const { value } = await ElementPlus.ElMessageBox.prompt('请输入方案名称', '重命名方案', {
                        inputValue: activeProfile.value.name,
                        confirmButtonText: '确定',
                        cancelButtonText: '取消'
                    });
                    if (value) activeProfile.value.name = value;
                } catch (e) {}
            } else if (command === 'delete') {
                if (settings.profiles.length <= 1) {
                    ElementPlus.ElMessage.warning("至少需要保留一个方案！");
                    return;
                }
                try {
                    await ElementPlus.ElMessageBox.confirm('确定要删除当前方案吗？', '警告', { type: 'warning' });
                    const idx = settings.profiles.findIndex(p => p.id === settings.active_profile_id);
                    settings.profiles.splice(idx, 1);
                    settings.active_profile_id = settings.profiles[0].id;
                    ElementPlus.ElMessage.success("方案已删除");
                } catch (e) {}
            }
        };

        const pinnedCodes = ['zh', 'en', 'ja', 'ko', 'fr', 'de', 'es', 'ru'];
        const pinnedLanguages = computed(() => store.dicts.languages.filter(l => pinnedCodes.includes(l.code)));
        const otherLanguages = computed(() => store.dicts.languages.filter(l => !pinnedCodes.includes(l.code)));

        const fixedPrompt = computed(() => {
            const lang = store.dicts.languages.find(l => l.code === store.config.llm_settings.target_language);
            const langName = lang ? lang.name : '中文';
            return `你是一位精通各国文化的专业影视字幕翻译。\n任务：将用户提供的 SRT 字幕片段翻译成【${langName}】。\n\n### 格式死命令：\n1. 保留原文结构：这是字幕片段，不要合并，不要遗漏。\n2. 保留时间轴：所有时间戳必须原样保留，不得修改。\n3. 只输出结果：不要加废话，直接输出 SRT 格式文本。`;
        });

        const refreshModels = async () => {
            if (!activeProfile.value.api_key) {
                ElementPlus.ElMessage.warning("请先填写 API Key！");
                return;
            }
            isFetchingModels.value = true;
            try {
                const models = await getLlmModels(activeProfile.value.api_key, activeProfile.value.base_url);
                store.dicts.llm_models = models;
                ElementPlus.ElMessage.success(`成功拉取 ${models.length} 个可用对话模型！`);
            } catch (e) {
                ElementPlus.ElMessage.error(e.message);
            } finally {
                isFetchingModels.value = false;
            }
        };

        const runTranslate = async () => {
            if (!store.taskId || !store.assets.hasOriginalSrt) return;
            
            if (store.config.llm_settings.engine === 'api' && !activeProfile.value.api_key) {
                ElementPlus.ElMessage.warning("执行失败：请先填写大模型的 API Key！");
                return;
            }
            
            if (store.config.llm_settings.engine === 'local' && !store.config.llm_settings.local_settings.model_path) {
                ElementPlus.ElMessage.warning("执行失败：请先选择本地模型文件！");
                return;
            }

            store.isProcessing = true;
            store.activeStep = 4;
            
            const statusObj = store.pipelineStatus[store.taskId];
            const currentStatus = statusObj?.current_step;
            const interruptedStep = statusObj?.interrupted_step;
            const isRetry = (currentStatus === 'interrupted' || currentStatus === 'error') && (interruptedStep === 'translating' || interruptedStep === 'pending_translate');
            addLog(isRetry ? "正在尝试断点重试任务..." : "启动大模型智能翻译流...", "info");

            connectTaskMonitor(
                store.taskId,
                () => {
                    store.assets.hasTranslatedSrt = true;
                    store.activeStep = 5;
                    addLog("智能翻译全部完成！", "success");
                    ElementPlus.ElMessage.success("翻译成功！请点击右上角下载熟肉字幕。");
                },
                () => {}
            );

            try { await updateConfig(store.config); } catch (e) {}

            try {
                if (isRetry) {
                    await retryTask(store.taskId);
                } else {
                    await executeTask(store.taskId, ["translate"], store.config);
                }
            } catch (e) {
                addLog(`请求启动翻译失败: ${e.message}`, "error");
                store.isProcessing = false;
            }
        };

        return { 
            store, isFetchingModels, isFetchingLocalModels, localModels, activeCollapse, pinnedLanguages, otherLanguages, fixedPrompt, 
            activeProfile, handleProfileCommand, refreshModels, refreshLocalModels, runTranslate 
        };
    }
};