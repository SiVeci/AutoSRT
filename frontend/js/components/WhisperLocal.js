const { ref, computed, watch } = Vue;
import { store, connectSystemDownloadMonitor } from '../store.js';
import { getModels, deleteModel, downloadModel } from '../api.js';

export default {
    name: 'WhisperLocal',
    template: `
        <div>
            <el-alert v-if="store.systemInfo?.device === 'cuda'" title="已检测到 NVIDIA GPU，当前处于 CUDA 硬件加速模式。" :description="'显卡型号: ' + store.systemInfo.gpu_name" type="success" show-icon style="margin-bottom: 20px;" :closable="false"></el-alert>
            <el-alert v-else-if="store.systemInfo?.device === 'cpu'" title="未检测到受支持的 NVIDIA 显卡，已自动降级为 CPU 慢速计算模式。" description="推理可能会非常耗时，建议使用较小的模型 (如 tiny/base) 或切换到云端 API 引擎。" type="warning" show-icon style="margin-bottom: 20px;" :closable="false"></el-alert>

            <!-- 本地引擎：基础设置卡片 -->
            <el-card shadow="never" style="margin-bottom: 20px; border: 1px solid #ebeef5; border-top: none;">
                <template #header>
                    <div class="card-title"><el-icon style="margin-right:4px;"><Setting /></el-icon>基础设置 (Basic)</div>
                </template>
                <el-form :model="store.config" label-width="140px" size="default" label-position="left">
                    <el-form-item>
                        <template #label>
                            <span style="display: inline-flex; align-items: center;">
                                模型大小
                                <el-tooltip content="模型体积越大，识别准确率越高，但需要的显存和处理时间也成倍增加。" placement="top" trigger="click">
                                    <el-icon style="margin-left: 4px; cursor: pointer; color: #909399;" @click.stop.prevent><QuestionFilled /></el-icon>
                                </el-tooltip>
                            </span>
                        </template>
                        <el-select v-model="store.config.model_settings.model_size" placeholder="选择模型" filterable style="width: 100%;" @visible-change="handleVisibleChange">
                            <el-option-group v-for="group in store.dicts.models" :key="group.label" :label="group.label">
                                <el-option v-for="model in group.options" :key="model.id" :label="model.id" :value="model.id" :disabled="store.downloadingModels[model.id] !== undefined">
                                    <span style="float: left">{{ model.id }}</span>
                                    <span style="float: right; color: #8492a6; font-size: 13px; display: flex; align-items: center; gap: 8px; height: 100%;">
                                        <span v-if="store.downloadingModels[model.id] !== undefined" style="color: #409EFF; font-size: 12px; margin-right: 5px;">
                                            <el-icon class="is-loading"><Loading /></el-icon>
                                            正在下载，已获取 {{ store.downloadingModels[model.id] }} MB...
                                        </span>
                                        <template v-else>
                                            <span v-if="model.downloaded" style="color: #909399; font-size: 12px; margin-right: 5px;">模型大小：{{ formatBytes(model.size_bytes) }}</span>
                                            <el-tag v-if="model.downloaded" type="success" size="small" effect="plain" style="border-radius: 12px; padding: 0 6px;"><el-icon style="margin-right:2px;"><CircleCheck /></el-icon>已下载</el-tag>
                                            <el-button v-if="model.downloaded" type="danger" link style="padding: 0; height: auto;" @click.stop.prevent="handleDeleteModel(model)" title="删除此模型以释放空间"><el-icon><Delete /></el-icon></el-button>
                                            <el-tag v-if="!model.downloaded" type="info" size="small" effect="plain" style="border-radius: 12px; padding: 0 6px; cursor: pointer;" @click.stop.prevent="handleDownloadModel(model)" title="点击手动从后台下载该模型"><el-icon style="margin-right:2px;"><Cloudy /></el-icon>云端</el-tag>
                                        </template>
                                    </span>
                                </el-option>
                            </el-option-group>
                        </el-select>
                    </el-form-item>
                    
                    <el-form-item>
                        <template #label>
                            <span style="display: inline-flex; align-items: center;">
                                识别语言
                                <el-tooltip content="指定原视频语言。自动检测可能在无声前奏中误判，明确指定可提升准确率和速度。" placement="top" trigger="click">
                                    <el-icon style="margin-left: 4px; cursor: pointer; color: #909399;" @click.stop.prevent><QuestionFilled /></el-icon>
                                </el-tooltip>
                            </span>
                        </template>
                        <el-select v-model="store.config.transcribe_settings.language" placeholder="自动检测 (Auto)" clearable filterable style="width: 100%;">
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
                                闲置释放时间
                                <el-tooltip content="当识别任务完成后，模型在显存中继续驻留的倒计时。如果在该时间内没有新的识别任务，模型将自动从显存卸载。填 0 代表永不自动释放。" placement="top" trigger="click">
                                    <el-icon style="margin-left: 4px; cursor: pointer; color: #909399;" @click.stop.prevent><QuestionFilled /></el-icon>
                                </el-tooltip>
                            </span>
                        </template>
                        <el-input-number v-model="store.config.transcribe_settings.idle_timeout" :min="0" :max="3600" :step="60"></el-input-number>
                        <span style="margin-left: 8px; color: #909399;">秒 (0 代表不释放)</span>
                    </el-form-item>
                </el-form>
            </el-card>

            <!-- 高级设置折叠面板 -->
            <el-card shadow="never" style="margin-bottom: 20px; border: 1px solid #ebeef5;">
                <el-collapse style="border-top: none; border-bottom: none;">
                <el-collapse-item name="1">
                    <template #title>
                        <span class="card-title"><el-icon style="margin-right: 5px;"><Tools /></el-icon> 高级设置 (Advanced Settings)</span>
                    </template>
                    
                    <el-tabs type="border-card" size="small" stretch>
                        <!-- 第一类：文本与上下文 -->
                        <el-tab-pane label="文本/上下文">
                            <el-form :model="store.config" size="small" label-position="top">
                                <el-form-item>
                                    <template #label>
                                        <span style="display: inline-flex; align-items: center;">
                                            Initial Prompt (初始提示词)
                                            <el-tooltip content="提供专有名词、人名或特定语言风格，引导模型正确输出。例如：'这是一个关于 EchoSRT 的教程。'" placement="top" trigger="click"><el-icon style="margin-left: 4px; cursor: pointer; color: #909399;" @click.stop.prevent><QuestionFilled /></el-icon></el-tooltip>
                                        </span>
                                    </template>
                                    <el-input type="textarea" v-model="store.config.transcribe_settings.initial_prompt" placeholder="引导词、专有名词、人名等 (空则不使用)"></el-input>
                                </el-form-item>
                                <el-form-item>
                                    <template #label>
                                        <span style="display: inline-flex; align-items: center;">
                                            Hotwords (热词增强)
                                            <el-tooltip content="提供热词，模型会在遇到模糊发音时优先匹配这些词汇（部分底层引擎可能不支持）。" placement="top" trigger="click"><el-icon style="margin-left: 4px; cursor: pointer; color: #909399;" @click.stop.prevent><QuestionFilled /></el-icon></el-tooltip>
                                        </span>
                                    </template>
                                    <el-input type="textarea" v-model="store.config.transcribe_settings.hotwords" placeholder="希望模型优先识别的词语"></el-input>
                                </el-form-item>
                                <el-row :gutter="20">
                                    <el-col :span="12">
                                        <el-checkbox v-model="store.config.transcribe_settings.condition_on_previous_text">
                                            <span style="display: inline-flex; align-items: center;">参考上一句 (减少幻觉)<el-tooltip content="让模型结合上一句的内容来识别当前句。若视频背景噪音大，关闭此项有时能减少胡言乱语（幻觉）。" placement="top" trigger="click"><el-icon style="margin-left: 4px; cursor: pointer; color: #909399;" @click.stop.prevent><QuestionFilled /></el-icon></el-tooltip></span>
                                        </el-checkbox>
                                    </el-col>
                                    <el-col :span="12">
                                        <el-checkbox v-model="store.config.transcribe_settings.suppress_blank">
                                            <span style="display: inline-flex; align-items: center;">抑制空白输出<el-tooltip content="如果模型预测结果为纯空白，强制其重试生成文字。建议保持开启。" placement="top" trigger="click"><el-icon style="margin-left: 4px; cursor: pointer; color: #909399;" @click.stop.prevent><QuestionFilled /></el-icon></el-tooltip></span>
                                        </el-checkbox>
                                    </el-col>
                                </el-row>
                                <el-form-item style="margin-top: 15px;">
                                    <template #label>
                                        <span style="display: inline-flex; align-items: center;">抑制词 ID 数组 (Suppress Tokens)<el-tooltip content="强制禁止模型输出特定的 Token 内部 ID。-1 通常代表抑制某些非发音标记。" placement="top" trigger="click"><el-icon style="margin-left: 4px; cursor: pointer; color: #909399;" @click.stop.prevent><QuestionFilled /></el-icon></el-tooltip></span>
                                    </template>
                                    <el-input v-model="suppressTokensStr" placeholder="例如: -1"></el-input>
                                </el-form-item>
                            </el-form>
                        </el-tab-pane>

                        <!-- 第二类：解码与搜索 -->
                        <el-tab-pane label="解码/搜索">
                            <el-form :model="store.config" size="small" label-position="right" label-width="120px">
                                <el-form-item>
                                    <template #label>
                                        <span style="display: inline-flex; align-items: center;">Beam Size<el-tooltip content="束搜索候选数量。值越大（如5-10）结果越准但越慢；设为1（贪婪解码）速度最快但可能出错。" placement="top" trigger="click"><el-icon style="margin-left: 4px; cursor: pointer; color: #909399;" @click.stop.prevent><QuestionFilled /></el-icon></el-tooltip></span>
                                    </template>
                                    <el-input-number v-model="store.config.transcribe_settings.beam_size" :min="1" :max="20"></el-input-number>
                                </el-form-item>
                                <el-form-item>
                                    <template #label>
                                        <span style="display: inline-flex; align-items: center;">Best Of<el-tooltip content="当非贪婪解码时，保留的最佳候选结果数。一般与 Beam Size 保持一致。" placement="top" trigger="click"><el-icon style="margin-left: 4px; cursor: pointer; color: #909399;" @click.stop.prevent><QuestionFilled /></el-icon></el-tooltip></span>
                                    </template>
                                    <el-input-number v-model="store.config.transcribe_settings.best_of" :min="1" :max="20"></el-input-number>
                                </el-form-item>
                                <el-form-item>
                                    <template #label>
                                        <span style="display: inline-flex; align-items: center;">Patience<el-tooltip content="束搜索耐心因子。默认 1.0。调大可探索更多可能路径，改善结果，但增加耗时。" placement="top" trigger="click"><el-icon style="margin-left: 4px; cursor: pointer; color: #909399;" @click.stop.prevent><QuestionFilled /></el-icon></el-tooltip></span>
                                    </template>
                                    <el-input-number v-model="store.config.transcribe_settings.patience" :step="0.1" :min="0"></el-input-number>
                                </el-form-item>
                                <el-form-item>
                                    <template #label>
                                        <span style="display: inline-flex; align-items: center;">长度/重复惩罚<el-tooltip content="左侧: 控制输出句子的长短倾向（<1短句，>1长句）。右侧: 惩罚重复词汇，防止陷入死循环复读（>1生效）。" placement="top" trigger="click"><el-icon style="margin-left: 4px; cursor: pointer; color: #909399;" @click.stop.prevent><QuestionFilled /></el-icon></el-tooltip></span>
                                    </template>
                                    <el-input-number v-model="store.config.transcribe_settings.length_penalty" :step="0.1" style="width: 100px; margin-right: 10px;"></el-input-number>
                                    <el-input-number v-model="store.config.transcribe_settings.repetition_penalty" :step="0.1" :min="1.0" style="width: 100px;"></el-input-number>
                                </el-form-item>
                                
                                <el-divider border-style="dashed">
                                    <span style="display: inline-flex; align-items: center;">Temperature 递进数组<el-tooltip content="当识别质量不达标时，模型会按此数组依次提升温度值，增加随机性并重试解码。" placement="top" trigger="click"><el-icon style="margin-left: 4px; cursor: pointer; color: #909399;" @click.stop.prevent><QuestionFilled /></el-icon></el-tooltip></span>
                                </el-divider>
                                <div v-for="(temp, index) in store.config.transcribe_settings.temperature" :key="index" style="display: flex; align-items: center; margin-bottom: 8px;">
                                    <el-tag type="info" style="margin-right: 10px; width: 40px; text-align: center;"># {{ index + 1 }}</el-tag>
                                    <el-input-number v-model="store.config.transcribe_settings.temperature[index]" :step="0.2" :min="0.0" :max="1.0" style="width: 110px;"></el-input-number>
                                    <el-button type="primary" circle size="small" @click="addTemperature(index)" style="margin-left: 10px;"><el-icon><Plus /></el-icon></el-button>
                                    <el-button type="danger" circle size="small" @click="removeTemperature(index)" :disabled="store.config.transcribe_settings.temperature.length <= 1" style="margin-left: 5px;"><el-icon><Minus /></el-icon></el-button>
                                </div>
                            </el-form>
                        </el-tab-pane>

                        <!-- 第三类：阈值过滤 -->
                        <el-tab-pane label="阈值过滤">
                            <el-form :model="store.config" size="small" label-position="right" label-width="180px">
                                <el-form-item>
                                    <template #label>
                                        <span style="display: inline-flex; align-items: center;">VAD 智能静音过滤<el-tooltip content="在识别前剔除无声或纯噪音片段。强烈推荐开启，大幅提升速度并减少环境噪音导致的幻觉！" placement="top" trigger="click"><el-icon style="margin-left: 4px; cursor: pointer; color: #909399;" @click.stop.prevent><QuestionFilled /></el-icon></el-tooltip></span>
                                    </template>
                                    <el-switch v-model="store.config.vad_settings.vad_filter" active-text="强烈推荐开启"></el-switch>
                                </el-form-item>
                                <el-form-item>
                                    <template #label>
                                        <span style="display: inline-flex; align-items: center;">压缩比阈值<el-tooltip content="当某段文本的压缩比高于此值时，模型会认为自己在重复废话，并触发温度回退重试。" placement="top" trigger="click"><el-icon style="margin-left: 4px; cursor: pointer; color: #909399;" @click.stop.prevent><QuestionFilled /></el-icon></el-tooltip></span>
                                    </template>
                                    <el-input-number v-model="store.config.transcribe_settings.compression_ratio_threshold" :step="0.1"></el-input-number>
                                </el-form-item>
                                <el-form-item>
                                    <template #label>
                                        <span style="display: inline-flex; align-items: center;">对数概率阈值<el-tooltip content="如果识别结果的平均置信度（Log Prob）低于此值，将触发温度回退重试。" placement="top" trigger="click"><el-icon style="margin-left: 4px; cursor: pointer; color: #909399;" @click.stop.prevent><QuestionFilled /></el-icon></el-tooltip></span>
                                    </template>
                                    <el-input-number v-model="store.config.transcribe_settings.log_prob_threshold" :step="0.1"></el-input-number>
                                </el-form-item>
                                <el-form-item>
                                    <template #label>
                                        <span style="display: inline-flex; align-items: center;">无声判定阈值<el-tooltip content="如果某段音频被判定为完全静音的概率高于此值，将直接跳过不输出文字。" placement="top" trigger="click"><el-icon style="margin-left: 4px; cursor: pointer; color: #909399;" @click.stop.prevent><QuestionFilled /></el-icon></el-tooltip></span>
                                    </template>
                                    <el-input-number v-model="store.config.transcribe_settings.no_speech_threshold" :step="0.05" :min="0" :max="1"></el-input-number>
                                </el-form-item>
                                <el-form-item>
                                    <template #label>
                                        <span style="display: inline-flex; align-items: center;">幻觉静音截断阈值<el-tooltip content="遇到长达此设置（秒）的静音时，强行截断当前句子，防止模型产生幻觉。空则默认禁用。" placement="top" trigger="click"><el-icon style="margin-left: 4px; cursor: pointer; color: #909399;" @click.stop.prevent><QuestionFilled /></el-icon></el-tooltip></span>
                                    </template>
                                    <el-input v-model="nullableFields.hallucination_silence_threshold" placeholder="空则禁用 (Null)"></el-input>
                                </el-form-item>
                                <el-form-item>
                                    <template #label>
                                        <span style="display: inline-flex; align-items: center;">语言探测阈值<el-tooltip content="在多语言模式下，如果检测到新语言的置信度低于此值，将强制退回前一个语言的设定。" placement="top" trigger="click"><el-icon style="margin-left: 4px; cursor: pointer; color: #909399;" @click.stop.prevent><QuestionFilled /></el-icon></el-tooltip></span>
                                    </template>
                                    <el-slider v-model="store.config.transcribe_settings.language_detection_threshold" :min="0" :max="1" :step="0.1" show-input></el-slider>
                                </el-form-item>
                            </el-form>
                        </el-tab-pane>

                        <!-- 第四类：杂项 -->
                        <el-tab-pane label="系统/杂项">
                            <el-form :model="store.config" size="small" label-position="right" label-width="140px">
                                <el-form-item>
                                    <template #label>
                                        <span style="display: inline-flex; align-items: center;">翻译为纯英文<el-tooltip content="无视原视频语言，强制 Whisper 模型直接听译并输出纯英文字幕（单向操作）。" placement="top" trigger="click"><el-icon style="margin-left: 4px; cursor: pointer; color: #909399;" @click.stop.prevent><QuestionFilled /></el-icon></el-tooltip></span>
                                    </template>
                                    <el-switch v-model="store.config.transcribe_settings.task" active-value="translate" inactive-value="transcribe"></el-switch>
                                </el-form-item>
                                <el-form-item>
                                    <template #label>
                                        <span style="display: inline-flex; align-items: center;">多语言交替模式<el-tooltip content="允许在同一个音频中自动识别出交替出现的多种不同语言（需要配合常规多语言模型使用）。" placement="top" trigger="click"><el-icon style="margin-left: 4px; cursor: pointer; color: #909399;" @click.stop.prevent><QuestionFilled /></el-icon></el-tooltip></span>
                                    </template>
                                    <el-switch v-model="store.config.transcribe_settings.multilingual"></el-switch>
                                </el-form-item>
                                <el-form-item>
                                    <template #label>
                                        <span style="display: inline-flex; align-items: center;">词级时间戳 (Word)<el-tooltip content="精确到每一个单词的发音时间戳，而不是按长句子划分时间。会略微拖慢速度。" placement="top" trigger="click"><el-icon style="margin-left: 4px; cursor: pointer; color: #909399;" @click.stop.prevent><QuestionFilled /></el-icon></el-tooltip></span>
                                    </template>
                                    <el-switch v-model="store.config.transcribe_settings.word_timestamps"></el-switch>
                                </el-form-item>
                                <el-form-item>
                                    <template #label>
                                        <span style="display: inline-flex; align-items: center;">关闭时间戳<el-tooltip content="强制模型不计算和输出时间戳。警告：开启后可能导致生成 SRT 字幕文件失败！" placement="top" trigger="click"><el-icon style="margin-left: 4px; cursor: pointer; color: #909399;" @click.stop.prevent><QuestionFilled /></el-icon></el-tooltip></span>
                                    </template>
                                    <el-switch v-model="store.config.transcribe_settings.without_timestamps" active-color="#f56c6c"></el-switch>
                                </el-form-item>
                                <el-form-item>
                                    <template #label>
                                        <span style="display: inline-flex; align-items: center;">最大新 Token 数<el-tooltip content="限制每次切片最多生成的文字标记数量。留空表示无限制。" placement="top" trigger="click"><el-icon style="margin-left: 4px; cursor: pointer; color: #909399;" @click.stop.prevent><QuestionFilled /></el-icon></el-tooltip></span>
                                    </template>
                                    <el-input v-model="nullableFields.max_new_tokens" placeholder="空则无限制 (Null)"></el-input>
                                </el-form-item>
                                <el-form-item>
                                    <template #label>
                                        <span style="display: inline-flex; align-items: center;">音频切片长度 (秒)<el-tooltip content="强制将音频切分成固定的秒数送入模型。留空则由模型自动判断切分。" placement="top" trigger="click"><el-icon style="margin-left: 4px; cursor: pointer; color: #909399;" @click.stop.prevent><QuestionFilled /></el-icon></el-tooltip></span>
                                    </template>
                                    <el-input v-model="nullableFields.chunk_length" placeholder="空则自动 (Null)"></el-input>
                                </el-form-item>
                                <el-form-item>
                                    <template #label>
                                        <span style="display: inline-flex; align-items: center;">模型下载存放目录<el-tooltip content="指定模型文件在本地硬盘的存放路径文件夹。" placement="top" trigger="click"><el-icon style="margin-left: 4px; cursor: pointer; color: #909399;" @click.stop.prevent><QuestionFilled /></el-icon></el-tooltip></span>
                                    </template>
                                    <el-input v-model="store.config.model_settings.download_root"></el-input>
                                </el-form-item>
                                <el-form-item>
                                    <template #label>
                                        <span style="display: inline-flex; align-items: center;">HF Token (选填)<el-tooltip content="Hugging Face 访问令牌。用于自动下载某些受权限保护的模型资产。" placement="top" trigger="click"><el-icon style="margin-left: 4px; cursor: pointer; color: #909399;" @click.stop.prevent><QuestionFilled /></el-icon></el-tooltip></span>
                                    </template>
                                    <el-input v-model="store.config.secrets.hf_token" type="password" show-password></el-input>
                                </el-form-item>
                                <el-form-item>
                                    <template #label>
                                        <span style="display: inline-flex; align-items: center;">
                                            模型下载代理
                                            <el-tooltip content="从 Hugging Face 或其他来源下载本地模型时，通过配置的全局网络代理进行下载。" placement="top" trigger="click">
                                                <el-icon style="margin-left: 4px; cursor: pointer; color: #909399;" @click.stop.prevent><QuestionFilled /></el-icon>
                                            </el-tooltip>
                                        </span>
                                    </template>
                                    <el-switch v-model="store.config.system_settings.use_proxy_for_model_download" :disabled="!store.config.system_settings.enable_global_proxy"></el-switch>
                                </el-form-item>
                            </el-form>
                        </el-tab-pane>
                    </el-tabs>
                </el-collapse-item>
                </el-collapse>
            </el-card>
        </div>
    `,
    setup() {
        const pinnedCodes = ['zh', 'en', 'ja', 'ko', 'fr', 'de', 'es', 'ru'];
        const pinnedLanguages = computed(() => store.dicts.languages.filter(l => pinnedCodes.includes(l.code)));
        const otherLanguages = computed(() => store.dicts.languages.filter(l => !pinnedCodes.includes(l.code)));

        const suppressTokensStr = ref(store.config.transcribe_settings.suppress_tokens ? store.config.transcribe_settings.suppress_tokens.join(",") : "-1");
        const nullableFields = ref({
            hallucination_silence_threshold: store.config.transcribe_settings.hallucination_silence_threshold ?? "",
            max_new_tokens: store.config.transcribe_settings.max_new_tokens ?? "",
            chunk_length: store.config.transcribe_settings.chunk_length ?? ""
        });

        watch(suppressTokensStr, (val) => {
            store.config.transcribe_settings.suppress_tokens = val.split(",").map(s => parseInt(s.trim())).filter(n => !isNaN(n));
        });
        
        watch(nullableFields, (val) => {
            const parseNull = (v) => (v === "" || v === null || v === undefined) ? null : Number(v);
            store.config.transcribe_settings.hallucination_silence_threshold = parseNull(val.hallucination_silence_threshold);
            store.config.transcribe_settings.max_new_tokens = parseNull(val.max_new_tokens);
            store.config.transcribe_settings.chunk_length = parseNull(val.chunk_length);
        }, { deep: true });
        
        // 修复 Bug 4: 清空下拉框引发的引擎空指针崩溃
        watch(() => store.config.transcribe_settings.language, (val) => {
            if (val === "") {
                store.config.transcribe_settings.language = null;
            }
        });

        const formatBytes = (bytes) => {
            if (!bytes || bytes === 0) return '0 MB';
            if (bytes > 1024 * 1024 * 1024) return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
            return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
        };

        const addTemperature = (index) => {
            const tempArray = store.config.transcribe_settings.temperature;
            let nextVal = tempArray[index] + 0.2;
            if (nextVal > 1.0) nextVal = 1.0;
            tempArray.splice(index + 1, 0, parseFloat(nextVal.toFixed(1)));
        };
        
        const removeTemperature = (index) => {
            const tempArray = store.config.transcribe_settings.temperature;
            if (tempArray.length > 1) tempArray.splice(index, 1);
        };
        
        const handleVisibleChange = async (visible) => {
            if (visible) {
                try { store.dicts.models = await getModels(); } catch(e) {}
            }
        };

        const handleDeleteModel = async (model) => {
            const sizeStr = model.size_bytes > 1024 * 1024 * 1024 
                ? (model.size_bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB'
                : (model.size_bytes / (1024 * 1024)).toFixed(2) + ' MB';
                
            try {
                await ElementPlus.ElMessageBox.confirm(
                    `确定要彻底删除本地模型 <strong>[${model.id}]</strong> 吗？<br/>这将为您释放约 <strong style="color: #F56C6C;">${sizeStr}</strong> 的磁盘空间。`, 
                    '清理模型存储', 
                    { confirmButtonText: '确定删除', cancelButtonText: '取消', type: 'warning', dangerouslyUseHTMLString: true }
                );
                
                const loading = ElementPlus.ElLoading.service({ lock: true, text: '正在清理模型文件并释放显存...' });
                try {
                    await deleteModel(model.id);
                    ElementPlus.ElMessage.success(`模型 [${model.id}] 删除成功，已释放 ${sizeStr} 空间！`);
                    store.dicts.models = await getModels();
                } catch (e) {
                    ElementPlus.ElMessage.error(e.message);
                } finally {
                    loading.close();
                }
            } catch (e) {}
        };

        const handleDownloadModel = async (model) => {
            try {
                await ElementPlus.ElMessageBox.confirm(
                    `确定要手动后台下载模型 <strong>[${model.id}]</strong> 吗？<br/>该模型体积约为 1~3 GB，视网络情况可能需要几分钟到十几分钟。<br/>下载期间您可以关闭或刷新网页，后台下载不会中断。`, 
                    '确认下载', 
                    { confirmButtonText: '开始下载', cancelButtonText: '取消', type: 'info', dangerouslyUseHTMLString: true }
                );
                
                await downloadModel(model.id, store.config);
                
                store.downloadingModels[model.id] = 0;
                connectSystemDownloadMonitor(
                    model.id,
                    async () => {
                        ElementPlus.ElMessage.success(`模型 [${model.id}] 后台下载完成！`);
                        store.dicts.models = await getModels();
                    },
                    async (err) => {
                        ElementPlus.ElMessage.error(`下载失败或中断: ${err.message}`);
                        store.dicts.models = await getModels();
                    }
                );
            } catch (e) {
                if (e !== 'cancel') ElementPlus.ElMessage.error(e.message || "请求下载失败");
            }
        };

        return { 
            store, pinnedLanguages, otherLanguages, 
            suppressTokensStr, nullableFields, formatBytes,
            addTemperature, removeTemperature, handleVisibleChange, handleDeleteModel, handleDownloadModel
        };
    }
};