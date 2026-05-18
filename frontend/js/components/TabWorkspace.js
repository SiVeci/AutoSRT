const { ref, onMounted, watch, nextTick, computed } = Vue;
import { store, addLog, connectTaskMonitor } from '../store.js';
import { uploadAsset, getTasks, deleteTask, executeTask, retryTask, testProxy, getTaskAssets, deleteTaskAsset, reorderTasks, updateConfig, scanLibrary, getDiscoveries, importFromLibrary, cancelTask, cancelAllTasks } from '../api.js';

export default {
    name: 'TabWorkspace',
    template: `
        <div class="workspace-container">
            <el-alert title="提示" type="info" show-icon style="margin-bottom: 20px;" :closable="false">
                请将需要处理的视频或音频源文件拖拽至下方区域以新建任务。在此处上传的任何格式音频都会自动经过标准化重采样，以获取最佳的 AI 识别准确率。
            </el-alert>
        
            <el-card shadow="never" style="margin-bottom: 20px; border: 1px solid #ebeef5;">
                <template #header>
                    <div class="card-title"><el-icon style="margin-right:4px;"><Folder /></el-icon>新建任务</div>
                </template>
            <el-upload
                class="compact-upload"
                drag
                multiple
                action="#"
                :auto-upload="true"
                :http-request="handleUpload"
                :show-file-list="false"
                accept="video/*,audio/*"
                :disabled="isUploading"
            >
                <div class="el-upload__text" style="display: flex; align-items: center; justify-content: center; gap: 10px;">
                    <el-icon style="font-size: 24px; color: #409EFF;"><upload-filled /></el-icon>
                    <span style="font-size: 15px;">拖拽上传源文件 (视频/音频)，或 <em>点击浏览</em></span>
                </div>
            </el-upload>
            
            <!-- 上传进度条 -->
            <div v-if="isUploading" style="margin-top: 20px;">
                <el-progress :percentage="currentUploadProgress" :stroke-width="18" text-inside></el-progress>
                <div style="text-align: center; margin-top: 8px; font-size: 13px; color: #909399;">
                    <el-icon class="is-loading" style="margin-right: 5px;"><Loading /></el-icon>
                    正在上传: <strong>{{ currentUploadName }}</strong> (队列排队: {{ queueRemaining }} 个)...
                </div>
            </div>
            </el-card>

            <el-card shadow="never" style="margin-bottom: 20px; border: 1px solid #ebeef5;">
                <template #header>
                    <div style="display: flex; justify-content: space-between; align-items: center; width: 100%;">
                        <span class="card-title"><el-icon style="margin-right:4px;"><DataBoard /></el-icon>流水线看板与资产库</span>
                        <div style="display: flex; gap: 10px;">
                            <el-dropdown trigger="click" @command="handleClearCommand" :disabled="taskList.length === 0">
                                <el-button type="danger" size="small" plain>
                                    <el-icon><Delete /></el-icon> 资产清理 <el-icon class="el-icon--right"><ArrowDown /></el-icon>
                                </el-button>
                                <template #dropdown>
                                    <el-dropdown-menu>
                                        <el-dropdown-item command="all" icon="DeleteFilled">清空全部任务</el-dropdown-item>
                                        <el-dropdown-item divided command="video" icon="VideoCamera">清理本地视频</el-dropdown-item>
                                        <el-dropdown-item command="audio" icon="Headset">清理音频</el-dropdown-item>
                                        <el-dropdown-item command="original" icon="Document">清理原声字幕</el-dropdown-item>
                                        <el-dropdown-item command="translated" icon="ChatDotSquare">清理翻译字幕</el-dropdown-item>
                                    </el-dropdown-menu>
                                </template>
                            </el-dropdown>
                            <el-button type="danger" size="small" :disabled="!isAnyTaskRunning" @click="handleCancelAllTasks">
                                中断全部任务
                            </el-button>
                            <el-button type="success" size="small" plain :disabled="selectedTasks.length === 0" @click="batchRun(false)">
                                批量提取+识别
                            </el-button>
                            <el-button type="primary" size="small" :disabled="selectedTasks.length === 0" @click="batchRun(true)">
                                批量全量(含翻译)
                            </el-button>
                            <el-divider direction="vertical"></el-divider>
                            <el-button type="warning" size="small" plain @click="handleOpenLibraryScanner">
                                <el-icon><Search /></el-icon> 扫描媒体库
                            </el-button>
                        </div>
                    </div>
                </template>
                
                <!-- 注意: 增加了 row-key="task_id" 才能保证 Vue 与 Sortable 共同操作时虚拟 DOM 不崩溃 -->
                <el-table :data="taskList" row-key="task_id" style="width: 100%" height="320" v-loading="isLoadingTasks" :empty-text="'暂无任务记录'" @selection-change="handleSelectionChange">
                    <el-table-column width="40" align="center">
                        <template #default="scope">
                            <div style="display: flex; align-items: center; justify-content: center; height: 100%;">
                                <el-icon 
                                    class="drag-handle" 
                                    :class="{'is-disabled': isTaskRunning(scope.row.task_id)}" 
                                    style="font-size: 18px;" 
                                    title="按住拖拽进行排序">
                                    <svg viewBox="0 0 24 24" fill="currentColor">
                                        <path d="M3 18h18v-2H3v2zm0-5h18v-2H3v2zm0-7v2h18V6H3z"></path>
                                    </svg>
                                </el-icon>
                            </div>
                        </template>
                    </el-table-column>
                    <el-table-column type="selection" width="50"></el-table-column>
                    <el-table-column prop="base_name" label="任务名称 (源文件名)" min-width="180" show-overflow-tooltip></el-table-column>
                    <el-table-column label="实时状态" width="130">
                        <template #default="scope">
                            <el-tag v-if="store.pipelineStatus[scope.row.task_id]" size="small" :type="getStatusType(store.pipelineStatus[scope.row.task_id].current_step)" effect="dark">
                                {{ getStatusText(store.pipelineStatus[scope.row.task_id].current_step) }}
                            </el-tag>
                            <el-tag v-else-if="scope.row.current_step && scope.row.current_step !== 'idle'" size="small" :type="getStatusType(scope.row.current_step)" effect="plain">
                                {{ getStatusText(scope.row.current_step) }}
                            </el-tag>
                            <el-tag v-else size="small" type="info">已空闲</el-tag>
                        </template>
                    </el-table-column>
                    <el-table-column label="资产检查" width="200">
                        <template #default="scope">
                            <div style="display: flex; align-items: center; gap: 4px;">
                                <!-- 映射视频 (外部绝对路径) -->
                                <el-dropdown v-if="scope.row.has_abs_video" trigger="click" @command="(cmd) => handleAssetCommand(cmd, scope.row, 'video')">
                                    <el-tag size="small" type="primary" effect="plain" style="cursor: pointer;">视频</el-tag>
                                    <template #dropdown>
                                        <el-dropdown-menu>
                                            <el-dropdown-item command="download" icon="Download">下载</el-dropdown-item>
                                        </el-dropdown-menu>
                                    </template>
                                </el-dropdown>
                                <!-- 本地视频 (拖拽上传) -->
                                <el-dropdown v-else-if="scope.row.has_video" trigger="click" @command="(cmd) => handleAssetCommand(cmd, scope.row, 'video')">
                                    <el-tag size="small" type="success" effect="plain" style="cursor: pointer;">视频</el-tag>
                                    <template #dropdown>
                                        <el-dropdown-menu>
                                            <el-dropdown-item command="download" icon="Download">下载</el-dropdown-item>
                                            <el-dropdown-item command="delete" icon="Delete" :disabled="getAssetCount(scope.row) <= 1" :title="getAssetCount(scope.row) <= 1 ? '最后一份资产，如需清理请直接删除该任务' : ''">删除</el-dropdown-item>
                                        </el-dropdown-menu>
                                    </template>
                                </el-dropdown>
                                <el-tag v-else size="small" type="info" effect="plain">视频</el-tag>
                                
                                <el-dropdown v-if="scope.row.has_audio" trigger="click" @command="(cmd) => handleAssetCommand(cmd, scope.row, 'audio')">
                                    <el-tag size="small" type="success" effect="plain" style="cursor: pointer;">音频</el-tag>
                                    <template #dropdown>
                                        <el-dropdown-menu>
                                            <el-dropdown-item command="download" icon="Download">下载</el-dropdown-item>
                                            <el-dropdown-item command="delete" icon="Delete" :disabled="getAssetCount(scope.row) <= 1" :title="getAssetCount(scope.row) <= 1 ? '最后一份资产，如需清理请直接删除该任务' : ''">删除</el-dropdown-item>
                                        </el-dropdown-menu>
                                    </template>
                                </el-dropdown>
                                <el-tag v-else size="small" type="info" effect="plain">音频</el-tag>
                                
                                <el-dropdown v-if="scope.row.has_original_srt" trigger="click" @command="(cmd) => handleAssetCommand(cmd, scope.row, 'original')">
                                    <el-tag size="small" type="success" effect="plain" style="cursor: pointer;">原声</el-tag>
                                    <template #dropdown>
                                        <el-dropdown-menu>
                                            <el-dropdown-item command="download" icon="Download">下载</el-dropdown-item>
                                            <el-dropdown-item command="delete" icon="Delete" :disabled="getAssetCount(scope.row) <= 1" :title="getAssetCount(scope.row) <= 1 ? '最后一份资产，如需清理请直接删除该任务' : ''">删除</el-dropdown-item>
                                        </el-dropdown-menu>
                                    </template>
                                </el-dropdown>
                                <el-tag v-else size="small" type="info" effect="plain">原声</el-tag>
                                
                                <el-dropdown v-if="scope.row.has_translated_srt" trigger="click" @command="(cmd) => handleAssetCommand(cmd, scope.row, 'translated')">
                                    <el-tag size="small" type="success" effect="plain" style="cursor: pointer;">翻译</el-tag>
                                    <template #dropdown>
                                        <el-dropdown-menu>
                                            <el-dropdown-item command="download" icon="Download">下载</el-dropdown-item>
                                            <el-dropdown-item command="delete" icon="Delete" :disabled="getAssetCount(scope.row) <= 1" :title="getAssetCount(scope.row) <= 1 ? '最后一份资产，如需清理请直接删除该任务' : ''">删除</el-dropdown-item>
                                        </el-dropdown-menu>
                                    </template>
                                </el-dropdown>
                                <el-tag v-else size="small" type="info" effect="plain">翻译</el-tag>
                            </div>
                        </template>
                    </el-table-column>
                    <el-table-column label="焦点操作" width="160" fixed="right">
                        <template #default="scope">
                            <el-button size="small" type="primary" plain @click="loadTask(scope.row)" :disabled="store.taskId === scope.row.task_id">监视</el-button>
                            <el-button v-if="isTaskRunning(scope.row.task_id)" size="small" type="danger" @click="handleCancelTask(scope.row.task_id)">中断</el-button>
                            <el-button v-else size="small" type="danger" plain @click="removeTask(scope.row)">删除</el-button>
                        </template>
                    </el-table-column>
                </el-table>
            </el-card>

            <el-dialog v-model="showLibraryModal" width="800px">
                <template #header>
                    <el-icon style="margin-right:4px;"><Search /></el-icon> 媒体库扫描发现
                </template>
                <div style="margin-bottom: 15px; color: #606266; font-size: 14px;">
                    共发现 <strong style="color: #409EFF;">{{ scanResults.length }}</strong> 个新视频。勾选并点击“导入”即可将其转为正式任务。
                </div>
                <el-table :data="scanResults" @selection-change="handleLibrarySelectionChange" max-height="450">
                    <el-table-column type="selection" width="55"></el-table-column>
                    <el-table-column prop="filename" label="文件名" min-width="200" show-overflow-tooltip></el-table-column>
                    <el-table-column prop="path" label="原始路径" min-width="350" show-overflow-tooltip>
                        <template #default="scope">
                            <span style="font-size: 12px; color: #909399;">{{ scope.row.path }}</span>
                        </template>
                    </el-table-column>
                    <el-table-column prop="size" label="大小" width="100">
                        <template #default="scope">
                            {{ (scope.row.size / 1024 / 1024).toFixed(1) }} MB
                        </template>
                    </el-table-column>
                </el-table>
                <template #footer>
                    <div style="display: flex; justify-content: space-between; align-items: center;">
                        <div style="color: #909399; font-size: 13px;">已选择 {{ selectedLibraryFiles.length }} 个文件</div>
                        <div>
                            <el-button @click="showLibraryModal = false">取 消</el-button>
                            <el-button type="primary" :disabled="selectedLibraryFiles.length === 0" :loading="isImporting" @click="handleImportFromLibrary">
                                立即导入工作区
                            </el-button>
                        </div>
                    </div>
                </template>
            </el-dialog>
        </div>
    `,
    setup() {
        const isUploading = ref(false);
        const currentUploadProgress = ref(0);
        const currentUploadName = ref("");
        const queueRemaining = ref(0);
        const taskList = ref([]);
        const selectedTasks = ref([]);
        const isLoadingTasks = ref(false);
        
        const fetchTasks = async () => {
            isLoadingTasks.value = true;
            try { taskList.value = await getTasks(); } 
            catch (e) { ElementPlus.ElMessage.error("获取历史任务失败"); }
            finally { isLoadingTasks.value = false; }
        };

        // 初始化拖拽引擎 (Sortable.js)
        let sortableInstance = null;
        const initSortable = () => {
            const el = document.querySelector('.workspace-container .el-table__body-wrapper tbody');
            if (!el || !window.Sortable) return;
            if (sortableInstance) sortableInstance.destroy(); // 避免重复绑定内存泄漏

            sortableInstance = Sortable.create(el, {
                handle: '.drag-handle:not(.is-disabled)',
                animation: 150,
                ghostClass: 'sortable-ghost',
                onEnd: async (evt) => {
                    const { oldIndex, newIndex } = evt;
                    if (oldIndex === newIndex || newIndex === undefined) return;

                    // 防呆核心：计算锁定区 (空气墙) 边界
                    let lastRunningIndex = -1;
                    taskList.value.forEach((t, idx) => { if (isTaskRunning(t.task_id)) lastRunningIndex = idx; });

                    // 越界拦截：严禁插队或跨越运行中的任务
                    if (newIndex <= lastRunningIndex || oldIndex <= lastRunningIndex) {
                        ElementPlus.ElMessage.warning("无法越过正在执行的任务！已开始的队列不支持插队。");
                        // 强制清空再写入数组，使得 Vue 的虚拟 DOM 能把 Sortable 修改的真实 DOM 完美复原
                        const clone = [...taskList.value];
                        taskList.value = [];
                        nextTick(() => { taskList.value = clone; });
                        return;
                    }

                    // 合法拖拽，重组本地数组并向后端持久化
                    const clone = [...taskList.value];
                    const item = clone.splice(oldIndex, 1)[0];
                    clone.splice(newIndex, 0, item);
                    
                    taskList.value = []; // 先清空一次同步 DOM
                    nextTick(async () => {
                        taskList.value = clone;
                        try { await reorderTasks(clone.map(t => t.task_id)); } 
                        catch (e) { ElementPlus.ElMessage.error("排序保存失败，即将恢复原状"); fetchTasks(); }
                    });
                }
            });
        };

        onMounted(() => {
            fetchTasks();
        });
        
        watch(() => store.refreshTasksTrigger, fetchTasks);

        // 监听列表数据的变化，在 DOM 更新后重新挂载 Sortable
        watch(() => taskList.value.length, () => {
            nextTick(() => { initSortable(); });
        });

        // 本地维护一个上一秒的活跃任务集合，用于精确捕获任务终结的瞬间
        const previousRunningTasks = new Set();
        // 同样维护一个上一秒的活跃任务状态映射，用于捕获状态切换
        const previousTaskStates = new Map();

        // 智能状态监听：增量更新 (局部刷新)，只查变化的任务，杜绝全量扫盘
        watch(() => store.pipelineStatus, async (currentStatus) => {
            if (!currentStatus) return;
            const tasksToRefresh = [];
            const currentRunningTaskIds = Object.keys(currentStatus);
            
            // 1. 检测活跃任务的状态切换 (例如提取 -> 识别)
            for (const taskId of currentRunningTaskIds) {
                const currentStep = currentStatus[taskId]?.current_step;
                const previousStep = previousTaskStates.get(taskId);
                
                if (currentStep !== previousStep && ['pending_transcribe', 'transcribing', 'pending_translate', 'translating'].includes(currentStep)) {
                    tasksToRefresh.push(taskId);
                }
                // 更新状态映射
                previousTaskStates.set(taskId, currentStep);
            }
            
            // 2. 核心补丁：检测生命周期结束的任务 (Completed/Error/Cancelled)
            // 如果一个任务存在于 "上一秒的活跃集合"，但不存在于 "当前的活跃集合"
            // 说明它刚刚结束，必须去后端捞一次最终的底稿状态（包括最终资产和最终 current_step）
            previousRunningTasks.forEach(taskId => {
                if (!currentRunningTaskIds.includes(taskId) && !tasksToRefresh.includes(taskId)) {
                    tasksToRefresh.push(taskId);
                    previousTaskStates.delete(taskId);
                }
            });
            
            // 3. 更新 "上一秒活跃集合" 为 "当前活跃集合"
            previousRunningTasks.clear();
            currentRunningTaskIds.forEach(id => previousRunningTasks.add(id));
            
            if (tasksToRefresh.length > 0) {
                // 增加 1.5 秒延迟，确保后端文件系统彻底落盘并刷新目录元数据，避免因 size 为 0 导致判断失败
                setTimeout(async () => {
                    for (const taskId of tasksToRefresh) {
                        try {
                            const targetIndex = taskList.value.findIndex(t => t.task_id === taskId);
                            if (targetIndex === -1) {
                                // 任务已从本地视图中被用户删除，直接跳过请求，防止 404
                                continue;
                            }
                            
                            const latestData = await getTaskAssets(taskId);
                            if (targetIndex !== -1) {
                                // O(1) 局部精准更新，UI 绝对无闪烁
                                taskList.value[targetIndex].has_video = latestData.has_video;
                                taskList.value[targetIndex].has_abs_video = latestData.has_abs_video;
                                taskList.value[targetIndex].has_audio = latestData.has_audio;
                                taskList.value[targetIndex].has_original_srt = latestData.has_original_srt;
                                taskList.value[targetIndex].has_translated_srt = latestData.has_translated_srt;
                                taskList.value[targetIndex].current_step = latestData.current_step;
                            }
                            
                            // 同步更新焦点任务资产，修复 Bug 1：实现下载按钮按阶段依次点亮
                            if (taskId === store.taskId) {
                                store.assets.hasVideo = latestData.has_video;
                                store.assets.hasAudio = latestData.has_audio;
                                store.assets.hasOriginalSrt = latestData.has_original_srt;
                                store.assets.hasTranslatedSrt = latestData.has_translated_srt;
                            }
                        } catch (e) {
                            console.warn(`[局部刷新] 无法获取任务 ${taskId} 的最新资产状态`, e);
                        }
                    }
                }, 1500);
            }
        });

        const handleSelectionChange = (val) => { selectedTasks.value = val; };

        const getStatusType = (step) => {
            const map = {
                'pending_extract': 'info', 'extracting': 'warning',
                'pending_transcribe': 'info', 'transcribing': 'warning',
                'pending_translate': 'info', 'translating': 'warning',
                'completed': 'success', 'error': 'danger', 'cancelled': 'info',
                'interrupted': 'warning'
            };
            return map[step] || 'info';
        };
        const getStatusText = (step) => {
            const map = {
                'pending_extract': '排队提音中', 'extracting': '正在提音',
                'pending_transcribe': '排队识别中', 'transcribing': '正在识别',
                'pending_translate': '排队翻译中', 'translating': '正在翻译',
                'completed': '完毕收工', 'error': '发生错误', 'cancelled': '已取消',
                'interrupted': '异常中断'
            };
            return map[step] || step;
        };

        const getAssetCount = (row) => {
            let count = 0;
            if (row.has_video) count++;
            if (row.has_audio) count++;
            if (row.has_original_srt) count++;
            if (row.has_translated_srt) count++;
            return count;
        };

        const handleAssetCommand = async (cmd, row, assetType) => {
            if (cmd === 'delete') {
                try {
                    const assetNameMap = { video: '视频', audio: '音频', original: '原声字幕', translated: '翻译字幕' };
                    await ElementPlus.ElMessageBox.confirm(`确定要彻底删除该任务的 <strong>[${assetNameMap[assetType]}]</strong> 吗？<br/>此操作将释放硬盘空间且不可恢复！`, '删除资产', { confirmButtonText: '确定删除', cancelButtonText: '取消', type: 'warning', dangerouslyUseHTMLString: true });
                    await deleteTaskAsset(row.task_id, assetType);
                    
                    const latestData = await getTaskAssets(row.task_id);
                    const targetIndex = taskList.value.findIndex(t => t.task_id === row.task_id);
                    if (targetIndex !== -1) {
                        taskList.value[targetIndex].has_video = latestData.has_video;
                        taskList.value[targetIndex].has_abs_video = latestData.has_abs_video;
                        taskList.value[targetIndex].has_audio = latestData.has_audio;
                        taskList.value[targetIndex].has_original_srt = latestData.has_original_srt;
                        taskList.value[targetIndex].has_translated_srt = latestData.has_translated_srt;
                    }
                    if (row.task_id === store.taskId) {
                        store.assets.hasVideo = latestData.has_video;
                        store.assets.hasAudio = latestData.has_audio;
                        store.assets.hasOriginalSrt = latestData.has_original_srt;
                        store.assets.hasTranslatedSrt = latestData.has_translated_srt;
                    }
                    ElementPlus.ElMessage.success(`${assetNameMap[assetType]}已成功删除`);
                } catch (e) {
                    if (e !== 'cancel') ElementPlus.ElMessage.error(e.message || "删除失败");
                }
            } else if (cmd === 'download') {
                import('../api.js').then(({ downloadAsset }) => {
                    downloadAsset(row.task_id, assetType, row.base_name);
                });
            }
        };

        const isTaskRunning = (taskId) => {
            const step = store.pipelineStatus[taskId]?.current_step;
            return ['pending_extract', 'extracting', 'pending_transcribe', 'transcribing', 'pending_translate', 'translating'].includes(step);
        };

        const isAnyTaskRunning = computed(() => {
            const statusObj = store.pipelineStatus || {};
            return Object.values(statusObj).some(status => 
                ['pending_extract', 'extracting', 'pending_transcribe', 'transcribing', 'pending_translate', 'translating'].includes(status?.current_step)
            );
        });

        // 多文件批量串行上传队列
        const uploadQueue = [];
        let isProcessingQueue = false;
        
        const processUploadQueue = async () => {
            if (isProcessingQueue || uploadQueue.length === 0) return;
            isProcessingQueue = true;
            isUploading.value = true;

            try {
                while (uploadQueue.length > 0) {
                    const options = uploadQueue.shift();
                    queueRemaining.value = uploadQueue.length;
                    currentUploadName.value = options.file.name;
                    currentUploadProgress.value = 0;
                    addLog(`开始上传源文件: ${options.file.name} (队列剩余: ${uploadQueue.length} 个)...`, "info");
                    
                    try {
                        // 智能判断上传的是视频还是纯音频，并调用后端 API
                        const assetType = options.file.type.startsWith('audio') ? 'audio' : 'video';
                        const res = await uploadAsset(options.file, assetType, null, (percent) => {
                            currentUploadProgress.value = percent;
                        });
                        addLog(`上传成功！任务分配 ID: ${res.task_id}`, "success");
                    } catch (e) {
                        addLog(`上传失败 [${options.file.name}]: ${e.message}`, "error");
                    } finally {
                        // 每当有一个文件物理上传完毕，立刻刷新一次看板，实现“边传边显示”的效果
                        fetchTasks();
                    }
                }
            } finally {
                isProcessingQueue = false;
                // 修复 Bug 2：尾部递归侦测，彻底消灭高频拖拽产生的幽灵文件
                if (uploadQueue.length > 0) {
                    processUploadQueue();
                } else {
                    isUploading.value = false;
                    ElementPlus.ElMessage.success("批量上传分配完成，请在列表中勾选任务下发执行！");
                }
            }
        };
        
        let uploadDebounceTimer = null;
        const handleUpload = (options) => {
            // 拦截默认的并发上传，将文件加入排队数组
            uploadQueue.push(options);
            // 巧用防抖(Debounce)：等待 Element Plus 把同一批拖入的文件全部塞进队列后，再统一唤醒消费者
            if (uploadDebounceTimer) clearTimeout(uploadDebounceTimer);
            uploadDebounceTimer = setTimeout(() => {
                processUploadQueue();
            }, 100);
        };

        // 批量将任务下发到后端 Worker 车间
        const batchRun = async (includeTranslation) => {
            if (selectedTasks.value.length === 0) return;
            
            // 获取并解析当前激活的方案进行 API Key 校验 (防御性编程)
            const transcribeEngine = store.config.transcribe_settings?.engine;
            if (transcribeEngine === 'api') {
                const asrSettings = store.config.online_asr_settings;
                const asrProfiles = asrSettings?.profiles || [];
                const asrActiveId = asrSettings?.active_profile_id;
                const asrProfile = asrProfiles.find(p => p.id === asrActiveId) || asrProfiles[0];
                
                if (!asrProfile || !asrProfile.api_key) {
                    console.warn("[BatchRun] ASR API Key missing in profile:", asrProfile);
                    ElementPlus.ElMessage.warning("批量任务包含云端识别，请先在【云端 API 识别】页填写并保存 API Key！");
                    return;
                }
            }

            if (includeTranslation) {
                const llmSettings = store.config.llm_settings;
                const llmProfiles = llmSettings?.profiles || [];
                const llmActiveId = llmSettings?.active_profile_id;
                const llmProfile = llmProfiles.find(p => p.id === llmActiveId) || llmProfiles[0];
                
                if (!llmProfile || !llmProfile.api_key) {
                    console.warn("[BatchRun] LLM API Key missing in profile:", llmProfile);
                    ElementPlus.ElMessage.warning("执行全量流水线前，请先在【LLM 翻译】页填写并保存 API Key！");
                    return;
                }
            }

            // 代理连通性前置测试拦截
            const proxyUrl = store.config.system_settings.network_proxy;
            const enableProxy = store.config.system_settings.enable_global_proxy;
            if (enableProxy && proxyUrl) {
                try {
                    addLog(`正在测试代理服务器连通性: ${proxyUrl}`, "info");
                    await testProxy(proxyUrl);
                    addLog(`代理服务器连通性测试通过`, "success");
                } catch (e) {
                    addLog(`代理测试失败，已终止任务调度: ${e.message}`, "error");
                    ElementPlus.ElMessage.error(`代理服务器连接失败，请检查设置`);
                    return; // 连通性测试不通过，直接阻断后续流水线分发
                }
            }

            // 解耦 I/O：批量派发前先发送一次配置保存，杜绝后端 I/O 风暴
            try { await updateConfig(store.config); } catch (e) {}

            for (const task of selectedTasks.value) {
                // 嗅探任务状态，如果是异常中断则直接走重试逻辑
                const currentStatus = store.pipelineStatus[task.task_id]?.current_step;
                if (currentStatus === 'interrupted' || currentStatus === 'error') {
                    try {
                        await retryTask(task.task_id);
                        addLog(`任务 ${task.base_name} 正在尝试断点续传重试...`, "success");
                    } catch (e) {
                        addLog(`任务 ${task.base_name} 重试失败: ${e.message}`, "error");
                    }
                    continue; // 跳过常规下发逻辑
                }

                const steps = [];
                if (!task.has_audio && task.has_video) steps.push("extract");
                
                // 如果用户想要全量翻译，且已有原声字幕，则静默跳过识别步骤
                if (!(includeTranslation && task.has_original_srt)) {
                    if (task.has_audio || steps.includes("extract")) steps.push("transcribe");
                }
                if (includeTranslation) steps.push("translate");

                if (steps.length > 0) {
                    try {
                        await executeTask(task.task_id, steps, store.config);
                        addLog(`任务 ${task.base_name} 已加入调度车间`, "success");
                    } catch (e) {
                        addLog(`任务 ${task.base_name} 调度失败: ${e.message}`, "error");
                    }
                }
            }
            ElementPlus.ElMessage.success("批量分配完成，请在看板中观察流转进度！");
        };

        const loadTask = (task) => {
            store.taskId = task.task_id;
            store.currentTaskName = task.base_name;
            store.assets = {
                hasVideo: task.has_video,
                hasAudio: task.has_audio,
                hasOriginalSrt: task.has_original_srt,
                hasTranslatedSrt: task.has_translated_srt
            };
            
            // 清空旧日志，迎接焦点任务的新日志
            store.logs.splice(0, store.logs.length);
            addLog(`焦点已切换至监视任务: ${task.base_name}`, "info");
            
            // 清空细粒度状态，防止 SPA 状态泄漏产生视觉残影
            store.taskState.extractedTime = "";
            store.taskState.downloadedMB = null;

            // 切断并重新连接 WS，绑定到新任务的输出流
            connectTaskMonitor(task.task_id, null, null);

            // 智能推导进度条应该亮到哪一步
            if (task.has_translated_srt) store.activeStep = 5;
            else if (task.has_original_srt) store.activeStep = 4;
            else if (task.has_audio) store.activeStep = 3;
            else if (task.has_video) store.activeStep = 2;
            else store.activeStep = 1;
            
            addLog(`已加载历史任务: ${task.base_name}`, "info");
            ElementPlus.ElMessage.success("任务加载成功！");
        };

        const handleCancelTask = async (taskId) => {
            try {
                await cancelTask(taskId);
                ElementPlus.ElMessage.success("已发送中断信号");
            } catch (e) {
                ElementPlus.ElMessage.error(`中断失败: ${e.message}`);
            }
        };

        const handleCancelAllTasks = async () => {
            try {
                await ElementPlus.ElMessageBox.confirm(
                    '确认要中断所有正在执行的任务吗？这将强制停止底层进程。',
                    '高危操作',
                    { confirmButtonText: '确定中断', cancelButtonText: '取消', type: 'error' }
                );
                
                await cancelAllTasks();
                ElementPlus.ElMessage.success("已发送中断信号，等待底层进程退出...");
            } catch (e) {
                if (e !== 'cancel') {
                    ElementPlus.ElMessage.error(`操作失败: ${e.message}`);
                }
            }
        };

        const removeTask = async (task) => {
            try {
                await ElementPlus.ElMessageBox.confirm(`确定要彻底删除任务 "${task.base_name}" 及其所有产生的文件吗？此操作不可逆。`, '警告', { confirmButtonText: '删除', cancelButtonText: '取消', type: 'warning' });
                await deleteTask(task.task_id);
                if (store.taskId === task.task_id) {
                    store.taskId = null;
                    store.activeStep = 0;
                }
                ElementPlus.ElMessage.success("任务已删除");
                fetchTasks();
            } catch (e) { if(e !== 'cancel') ElementPlus.ElMessage.error(e.message || "删除失败"); }
        };

        const clearAllTasks = async () => {
            if (taskList.value.length === 0) return;
            try {
                await ElementPlus.ElMessageBox.confirm('确定要清空所有历史任务及其产生的物理文件吗？此操作将腾出大量磁盘空间且不可逆。', '高危预警', { 
                    confirmButtonText: '全部清空', 
                    cancelButtonText: '取消', 
                    type: 'error' 
                });

                isLoadingTasks.value = true;
                let successCount = 0;
                // 串行发出删除请求，避免前端网络拥塞和后端磁盘 I/O 风暴
                for (const task of taskList.value) {
                    try {
                        await deleteTask(task.task_id);
                        successCount++;
                    } catch (e) {}
                }

                if (!isTaskRunning(store.taskId)) {
                    store.taskId = null;
                    store.activeStep = 0;
                    store.assets = { hasVideo: false, hasAudio: false, hasOriginalSrt: false, hasTranslatedSrt: false };
                }

                ElementPlus.ElMessage.success(`清理完成！已释放 ${successCount} 个任务的磁盘空间。`);
                fetchTasks();
            } catch (e) { /* 用户点击取消 */ }
        };

        const handleClearCommand = async (cmd) => {
            if (cmd === 'all') {
                clearAllTasks();
                return;
            }

            const assetNameMap = { video: '本地视频', audio: '音频', original: '原声字幕', translated: '翻译字幕' };
            const targetName = assetNameMap[cmd];

            try {
                await ElementPlus.ElMessageBox.confirm(
                    `确定要批量删除所有任务的 <strong>[${targetName}]</strong> 吗？<br/>此操作将释放硬盘空间且不可恢复！`, 
                    '批量清理资产', 
                    { confirmButtonText: '确定清理', cancelButtonText: '取消', type: 'warning', dangerouslyUseHTMLString: true }
                );

                let successCount = 0;
                let skippedCount = 0;
                const loading = ElementPlus.ElLoading.service({ lock: true, text: `正在批量清理 ${targetName}...` });

                try {
                    for (const task of taskList.value) {
                        // 检查该任务是否有目标资产
                        if (cmd === 'video' && !task.has_video) continue;
                        if (cmd === 'audio' && !task.has_audio) continue;
                        if (cmd === 'original' && !task.has_original_srt) continue;
                        if (cmd === 'translated' && !task.has_translated_srt) continue;

                        // 清理视频时，跳过外部映射视频
                        if (cmd === 'video' && task.has_abs_video) {
                            skippedCount++;
                            continue;
                        }

                        try {
                            await deleteTaskAsset(task.task_id, cmd);
                            successCount++;
                        } catch (err) {
                            // 后端拦截（如最后一份资产）计入跳过
                            skippedCount++;
                        }
                    }
                } finally {
                    loading.close();
                    fetchTasks(); // 刷新列表以更新 UI 状态
                    
                    if (skippedCount > 0) {
                        ElementPlus.ElMessage.warning(`清理完成：成功删除 ${successCount} 份，跳过 ${skippedCount} 份 (受保护的映射文件或不可删除的最后一份资产)。`);
                    } else if (successCount > 0) {
                        ElementPlus.ElMessage.success(`清理完成：成功释放了 ${successCount} 份 ${targetName}！`);
                    } else {
                        ElementPlus.ElMessage.info(`没有找到需要清理的 ${targetName}。`);
                    }
                }
            } catch (e) { /* 用户取消 */ }
        };

        // --- 媒体库扫描逻辑 ---
        const showLibraryModal = ref(false);
        const scanResults = ref([]);
        const selectedLibraryFiles = ref([]);
        const isImporting = ref(false);

        const handleOpenLibraryScanner = async () => {
            const loading = ElementPlus.ElLoading.service({ lock: true, text: '正在深度扫描媒体库...' });
            try {
                const res = await scanLibrary();
                scanResults.value = res.new_files;
                if (scanResults.value.length === 0) {
                    ElementPlus.ElMessage.info("未发现新的视频文件");
                } else {
                    showLibraryModal.value = true;
                }
            } catch (e) {
                ElementPlus.ElMessage.error("扫描失败，请检查设置中的路径是否正确");
            } finally {
                loading.close();
            }
        };

        const handleLibrarySelectionChange = (val) => {
            selectedLibraryFiles.value = val;
        };

        const handleImportFromLibrary = async () => {
            if (selectedLibraryFiles.value.length === 0) return;
            isImporting.value = true;
            try {
                const paths = selectedLibraryFiles.value.map(f => f.path);
                const res = await importFromLibrary(paths);
                ElementPlus.ElMessage.success(res.message);
                showLibraryModal.value = false;
                fetchTasks();
            } catch (e) {
                ElementPlus.ElMessage.error(e.message || "导入失败");
            } finally {
                isImporting.value = false;
            }
        };

        return {
            isUploading,
            currentUploadProgress,
            currentUploadName,
            queueRemaining,
            taskList,
            selectedTasks,
            isLoadingTasks,
            handleSelectionChange,
            isTaskRunning,
            handleUpload,
            loadTask,
            handleCancelTask,
            handleCancelAllTasks,
            isAnyTaskRunning,
            removeTask,
            handleClearCommand,
            batchRun,
            getStatusType,
            getStatusText,
            getAssetCount,
            handleAssetCommand,
            store,
            // 媒体库相关
            showLibraryModal,
            scanResults,
            selectedLibraryFiles,
            isImporting,
            handleOpenLibraryScanner,
            handleLibrarySelectionChange,
            handleImportFromLibrary
        };
        }
        };