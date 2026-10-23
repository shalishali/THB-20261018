import * as Dialog from '@radix-ui/react-dialog';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useBidAnalysisCatalog, type BidAnalysisCatalogTask } from '../hooks/useBidAnalysisCatalog';
import { MarkdownFullscreenViewer, MarkdownRenderer, useToast } from '../../../shared/ui';
import { useConfirmAction } from '../hooks/useConfirmAction';
import BidSectionSelectorDialog from '../components/BidSectionSelectorDialog';
import type { BackgroundTaskState, BidAnalysisMode, BidAnalysisTasks, BidAnalysisTaskState, BidSectionExtractionStatus, BidSectionMode, DetectedBidSection, TechnicalPlanState } from '../types';

interface BidAnalysisPageProps {
  hasTenderFile: boolean;
  mode: BidAnalysisMode;
  selectedTaskIds: string[];
  bidSectionMode: BidSectionMode;
  bidSections: DetectedBidSection[];
  bidSectionExtractionTask?: BackgroundTaskState;
  bidSectionExtractionStatus: BidSectionExtractionStatus;
  bidSectionExtractionError?: string;
  selectedSectionTitle?: string;
  tasks: BidAnalysisTasks;
  task?: BackgroundTaskState;
  hasGeneratedOutline: boolean;
  onProgressChange: (progress: number) => void;
  startSignal?: number;
  onConfigSaved: (state: TechnicalPlanState) => void;
}

const modeOptions: Array<{ id: 'key' | 'full'; title: string; badge: string }> = [
  {
    id: 'key',
    title: '只解析关键项',
    badge: '默认',
  },
  {
    id: 'full',
    title: '完整解析',
    badge: '更多 Token',
  },
];

const GROUP_ORDER = ['关键项', '采购与响应', '投标流程', '评审要求', '主体与合同'];

// P2：仅展示项——解析结果只在本页展示，不参与下游目录/正文生成。
// 关键 5 项被大纲硬门槛消费、procurementList/responseFileRequirements 被偏离表与镜像大纲消费，
// 其余 11 项零下游消费（废标/查重有独立抽取任务），在设置弹窗中标注「仅展示」提示用户按需勾选。
const DISPLAY_ONLY_TASK_IDS = new Set([
  'agentInfo',
  'keyInfo',
  'marginInfo',
  'qualificationReview',
  'complianceCheck',
  'openBid',
  'evaluationBid',
  'businessScoring',
  'discardedBids',
  'signingProcess',
  'terminationCondition',
]);

// P0：免费多标段检测结果（GET /technical-plan/bid-sections，纯正则、不过模型）。
// totalDeclared 与 bridge 契约对齐为可选（检测不到声明的标段数时缺省）。
interface BidSectionDetectionResult {
  hasMultiple: boolean;
  totalDeclared?: number | null;
}

function groupOrderKey(groupName: string): string {
  const idx = GROUP_ORDER.indexOf(groupName);
  return idx === -1 ? `~${groupName}` : String(idx).padStart(2, '0');
}

interface BidTaskSelection {
  allIds: string[];
  requiredIds: string[];
  requiredIdSet: Set<string>;
}

function getModeLabel(mode: BidAnalysisMode) {
  if (mode === 'full') return '完整解析';
  if (mode === 'custom') return '自定义解析';
  return '只解析关键项';
}

const statusLabel: Record<BidAnalysisTaskState['status'], string> = {
  idle: '待解析',
  running: '解析中',
  success: '已完成',
  error: '失败',
};

// 解析等待过渡画面的运行计时：起点存在模块级，STEP 内切换页面再回来不会清零重计
// （浏览器整页刷新才会重置，属可接受边界）。任务结束（taskRunning=false）时清空。
let bidAnalysisRunStartedAt: number | null = null;

function formatElapsedSeconds(totalSeconds: number): string {
  if (totalSeconds < 60) {
    return `${totalSeconds} 秒`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds ? `${minutes} 分 ${seconds} 秒` : `${minutes} 分钟`;
}

// 按用时分段给宽慰文案，避免长耗时（单项 1 分钟量级）时用户误以为卡死。
function getRunningHint(elapsedSeconds: number): string {
  if (elapsedSeconds < 15) {
    return 'AI 正在阅读招标文件并提取关键信息，请保持页面打开。';
  }
  if (elapsedSeconds < 40) {
    return '模型正在生成内容，单个关键项通常需要 1 分钟左右，完成后自动展示。';
  }
  return '复杂招标文件解析耗时较长属正常现象；任务在后台执行，可稍后回到本页查看结果。';
}

const jsonFieldLabels: Record<string, string> = {
  project_name: '项目名称',
  project_number: '项目编号',
  project_type: '项目类型',
  project_budget: '项目预算',
  project_address: '项目地址',
  company_name: '公司名称',
  address: '地址',
  contact_person: '联系人',
  contact_phone: '联系电话',
  email: '联系邮箱',
  bank_account_name: '银行账户名称',
  bank_account_number: '银行账户账号',
  bank_account_address: '银行账户开户行',
  bank_account_address_detail: '银行账户开户行地址',
  bid_announcement_time: '招标公告发布日期',
  bid_file_get_way: '招标文件获取方式',
  bid_file_price: '招标文件售价',
  get_bid_file_time: '获取招标文件时间',
  bid_document_submission_location: '投标文件提交地点',
  bid_submission_deadline: '投标截止时间',
  bid_opening_time: '开标时间',
  bid_opening_address: '开标地点',
  other_notes: '其他注意事项',
  bidding_deposit: '投标保证金',
  payment_method: '缴纳方式',
  due_date: '截止日期',
  refund_conditions: '退还条件',
  non_refundable_conditions: '不予退还的情形',
  time_place: '时间地点',
  part_req: '参与要求',
  invalid_bid: '无效标认定',
  objection: '异议处理',
  bid_process: '开标流程',
  committee: '评标委员会组成',
  duties: '评标委员会职责',
  scoring: '评分构成',
  method: '评标方法类型',
  principles: '评标原则和方法细节',
  others: '其他信息',
  bid_notice: '中标公示',
  contract_sign: '合同签订',
  performance_bond: '履约保证金',
  contract_text: '合同文本',
  breach_termination: '违约解除',
  force_majeure: '不可抗力',
  contract_termination: '合同终止',
  dispute_resolution: '争议解决',
  implementation_period: '实施周期/工期/交付期限',
  delivery_scope: '交付范围',
  delivery_location: '交付/实施地点',
  acceptance_requirements: '验收要求',
  warranty_period: '质保期',
  after_sales_service: '售后服务要求',
  response_time: '响应时限',
  training_requirements: '培训要求',
  documentation_requirements: '资料/文档交付要求',
};

function tryParseJsonObject(content: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(content);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function formatJsonValue(value: unknown): string {
  if (value === null || value === undefined || value === '') {
    return '没有提及';
  }

  if (typeof value === 'object') {
    return JSON.stringify(value, null, 2);
  }

  return String(value);
}

function JsonResultTable({ content }: { content: string }) {
  const data = tryParseJsonObject(content);

  if (!data) {
    return (
      <MarkdownFullscreenViewer className="markdown-viewer bid-analysis-output" title="JSON 内容全屏预览">
        <MarkdownRenderer>
          {`\`\`\`json\n${content}\n\`\`\``}
        </MarkdownRenderer>
      </MarkdownFullscreenViewer>
    );
  }

  return (
    <div className="bid-analysis-json-table-wrap">
      <table className="bid-analysis-json-table">
        <tbody>
          {Object.entries(data).map(([key, value]) => (
            <tr key={key}>
              <th>{jsonFieldLabels[key] || key}</th>
              <td>{formatJsonValue(value)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function BidAnalysisPage({
  hasTenderFile,
  mode,
  selectedTaskIds,
  bidSectionMode,
  bidSections,
  bidSectionExtractionTask,
  bidSectionExtractionStatus,
  bidSectionExtractionError,
  selectedSectionTitle,
  tasks,
  task,
  hasGeneratedOutline,
  onProgressChange,
  startSignal,
  onConfigSaved,
}: BidAnalysisPageProps) {
  const { tasks: catalogTasks } = useBidAnalysisCatalog();

  const selection = useMemo<BidTaskSelection>(() => {
    const allIds = catalogTasks.map((task) => task.id);
    const requiredIds = catalogTasks.filter((task) => task.required).map((task) => task.id);
    return { allIds, requiredIds, requiredIdSet: new Set(requiredIds) };
  }, [catalogTasks]);

  // 选中态归一/模式推导：闭包捕获 selection（DB 目录驱动），取代旧的模块级常量。
  const normalizeSelectedTaskIds = (taskIds: string[]) => {
    const requestedIds = new Set(taskIds);
    return selection.allIds.filter((taskId) => selection.requiredIdSet.has(taskId) || requestedIds.has(taskId));
  };

  const getSelectedTaskIdsForMode = (nextMode: BidAnalysisMode, taskIds: string[]) => {
    if (nextMode === 'full') return selection.allIds;
    if (nextMode === 'custom') return normalizeSelectedTaskIds(taskIds);
    return selection.requiredIds;
  };

  const getModeForSelection = (taskIds: string[]): BidAnalysisMode => {
    const selectedIds = normalizeSelectedTaskIds(taskIds);
    if (selection.allIds.length > 0 && selectedIds.length === selection.allIds.length) return 'full';
    if (selectedIds.some((taskId) => !selection.requiredIdSet.has(taskId))) return 'custom';
    return 'key';
  };

  const [running, setRunning] = useState(false);
  const [fullRerunLocked, setFullRerunLocked] = useState(false);
  const [fullRerunSeenRunning, setFullRerunSeenRunning] = useState(false);
  const [selectedTaskId, setSelectedTaskId] = useState('projectOverview');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [draftSelectedTaskIds, setDraftSelectedTaskIds] = useState<string[]>(() => getSelectedTaskIdsForMode(mode, selectedTaskIds));
  const [draftBidSectionMode, setDraftBidSectionMode] = useState<BidSectionMode>(bidSectionMode);
  const [sectionSelectorOpen, setSectionSelectorOpen] = useState(false);
  const [selectingSection, setSelectingSection] = useState(false);
  const [pendingAnalysisAfterSection, setPendingAnalysisAfterSection] = useState<{ taskIds?: string[]; nextTaskIds: string[] } | null>(null);
  const [sectionModeWarning, setSectionModeWarning] = useState<{
    type: 'single-suspected-multiple' | 'multiple-not-detected';
    taskIds?: string[];
    nextTaskIds: string[];
  } | null>(null);
  const [progressCollapsed, setProgressCollapsed] = useState(false);
  // P0：挂载时免费多标段检测结果（供设置弹窗内开始解析前的标段确认兜底）。
  const [sectionDetection, setSectionDetection] = useState<BidSectionDetectionResult | null>(null);
  // P1：自动启动只尝试一次（无论成败），避免依赖变化反复触发。
  const autoStartAttemptedRef = useRef(false);
  const { showToast } = useToast();
  const { confirmAsync: confirmWipeAction, dialogElement: wipeConfirmDialog } = useConfirmAction();
  const effectiveSelectedTaskIds = useMemo(
    () => getSelectedTaskIdsForMode(mode, selectedTaskIds),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selection, mode, selectedTaskIds],
  );
  // 非关键项直接隐藏：页面只展示/统计关键项；effectiveSelectedTaskIds 仍作为解析范围（配置弹窗勾选的非关键项在后台解析）。
  const selectedTasks = useMemo(() => catalogTasks.filter((task) => task.required), [catalogTasks]);
  const requiredTasks = useMemo(() => catalogTasks.filter((task) => task.required), [catalogTasks]);
  // 侧栏分组按 groupName 动态聚合（DB 驱动），自定义项落到其 groupName 或「其他」。
  const sidebarGroups = useMemo(() => {
    const map = new Map<string, BidAnalysisCatalogTask[]>();
    for (const task of selectedTasks) {
      const name = task.groupName || '其他';
      const list = map.get(name);
      if (list) list.push(task);
      else map.set(name, [task]);
    }
    return Array.from(map.entries())
      .map(([name, items]) => ({ name, items }))
      .sort((a, b) => groupOrderKey(a.name).localeCompare(groupOrderKey(b.name)));
  }, [selectedTasks]);
  const visibleSelectedTaskId = selectedTasks.some((task) => task.id === selectedTaskId)
    ? selectedTaskId
    : selectedTasks[0]?.id || 'projectOverview';
  const activeTask = selectedTasks.find((task) => task.id === visibleSelectedTaskId) || selectedTasks[0];
  const activeTaskState = activeTask ? tasks[activeTask.id] : undefined;
  const activeTaskStatus = activeTaskState?.status || 'idle';
  const activeTaskContent = activeTaskState?.content || '';
  const doneCount = selectedTasks.filter((task) => {
    const status = tasks[task.id]?.status;
    return status === 'success' || status === 'error';
  }).length;
  const displayProgress = selectedTasks.length ? Math.round((doneCount / selectedTasks.length) * 100) : 0;
  const sectionTaskRunning = bidSectionExtractionTask?.status === 'running' || bidSectionExtractionTask?.status === 'pausing';
  const taskRunning = running || fullRerunLocked || sectionTaskRunning || task?.status === 'running';
  // 空数组的 every 会返回 true；任务目录尚未加载时不能据此判定“可以进入下一步”。
  const requiredDone = requiredTasks.length > 0
    && requiredTasks.every((task) => tasks[task.id]?.status === 'success' && String(tasks[task.id]?.content || '').trim());
  const isPromptCacheOptimizing = taskRunning
    && selectedTasks.length > 1
    && selectedTasks.some((task) => task.id === 'projectOverview')
    && tasks.projectOverview?.status === 'running'
    && doneCount === 0;
  const progressMessage = isPromptCacheOptimizing
    ? '正在优化提示词缓存'
    : requiredDone && taskRunning
      ? '关键项已解析完成，等待当前解析任务结束后进入下一步。'
      : requiredDone ? '招标文件解析任务已结束，可以进入下一步。' : '等待项目概述、技术评分、项目信息、甲方信息和交货服务要求解析成功。';
  const bidSectionConfigLabel = bidSectionMode === 'multiple'
    ? selectedSectionTitle ? `多标段 · ${selectedSectionTitle}` : '多标段 · 待选择'
    : '单标段';
  const configLabel = `${bidSectionConfigLabel} · ${getModeLabel(mode)}`;

  // 进度只按关键项统计（非关键项已隐藏，不再计入展示口径）。
  const syncProgressForSelection = () => {
    if (!requiredTasks.length) {
      return;
    }
    const nextDoneCount = requiredTasks.filter((task) => {
      const status = tasks[task.id]?.status;
      return status === 'success' || status === 'error';
    }).length;
    onProgressChange(Math.round((nextDoneCount / requiredTasks.length) * 100));
  };

  useEffect(() => {
    if (!fullRerunLocked) {
      return;
    }

    if (task?.status === 'running') {
      setFullRerunSeenRunning(true);
      return;
    }

    if (fullRerunSeenRunning && task?.status) {
      setFullRerunLocked(false);
      setFullRerunSeenRunning(false);
    }
  }, [fullRerunLocked, fullRerunSeenRunning, task?.status]);

  // 解析等待过渡画面：运行期间每秒刷新已用时；taskRunning 覆盖解析与多标段识别两类等待。
  const [runningElapsed, setRunningElapsed] = useState(0);

  useEffect(() => {
    if (!taskRunning) {
      bidAnalysisRunStartedAt = null;
      setRunningElapsed(0);
      return;
    }
    if (bidAnalysisRunStartedAt === null) {
      bidAnalysisRunStartedAt = Date.now();
    }
    const startedAt = bidAnalysisRunStartedAt;
    const tick = () => setRunningElapsed(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)));
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [taskRunning]);

  // STEP02：进入页面（STEP 01 点「下一步」后）即跑一次免费多标段检测（纯正则、不过模型），
  // 结果用于自动解析分流（单标段直接解析 / 多标段先选投标范围），设置弹窗内开始解析时也会复用兜底。
  // 组件按 step 条件渲染，重新进入会重挂载重跑——天然覆盖「STEP 01 上传成功后」场景。
  useEffect(() => {
    if (!hasTenderFile) {
      return;
    }
    let mounted = true;
    window.yibiao?.technicalPlan
      .checkBidSections()
      .then((detection) => {
        if (mounted) setSectionDetection(detection ?? null);
      })
      .catch(() => {
        // 检测失败按单标段处理，不阻断自动解析主流程。
        if (mounted) setSectionDetection({ hasMultiple: false });
      })
      .finally(() => undefined);
    return () => {
      mounted = false;
    };
  }, [hasTenderFile]);

  // STEP02：进入页面先判断单/多标段再自动解析——
  // 单标段：直接自动解析关键项；
  // 疑似多标段：切换多标段模式并启动 AI 标段识别，识别完成后自动弹出标段选择器，
  // 用户选定投标范围后经 pendingAnalysisAfterSection 继续解析。仅尝试一次防循环。
  useEffect(() => {
    if (autoStartAttemptedRef.current) return;
    if (!hasTenderFile || hasGeneratedOutline) return;
    if (bidSectionMode === 'multiple' && !selectedSectionTitle) {
      // 多标段待选段：已识别成功则标段选择器自动弹出（见下方常驻 effect）；
      // 从未识别过（idle）则自动启动 AI 识别，避免流程卡住。running/error 交给用户在设置弹窗处理。
      if (bidSectionExtractionStatus === 'idle') {
        autoStartAttemptedRef.current = true;
        setPendingAnalysisAfterSection({ taskIds: undefined, nextTaskIds: effectiveSelectedTaskIds });
        void window.yibiao?.tasks.startBidSectionExtraction({})
          .then(() => showToast('多标段识别任务已在后台启动，完成后请选择投标范围', 'info'))
          .catch((error) => {
            setPendingAnalysisAfterSection(null);
            showToast(error instanceof Error ? error.message : '启动多标段识别失败', 'error');
          });
      }
      return;
    }
    if (!catalogTasks.length) return; // 等 DB 任务目录加载完成
    if (sectionDetection === null) return; // 等免费多标段检测完成
    if (taskRunning) {
      autoStartAttemptedRef.current = true; // 已有任务在跑：无需自动启动
      return;
    }
    const hasAnyResult = effectiveSelectedTaskIds.some((taskId) => {
      const status = tasks[taskId]?.status;
      return status === 'success' || status === 'error' || status === 'running';
    });
    if (hasAnyResult) {
      autoStartAttemptedRef.current = true; // 解析过/失败过：不自动重跑
      return;
    }
    autoStartAttemptedRef.current = true;

    // 单标段模式下检测到疑似多标段：先切换多标段并识别标段，选段后自动继续解析。
    if (bidSectionMode === 'single' && sectionDetection.hasMultiple) {
      void (async () => {
        try {
          await saveConfig(effectiveSelectedTaskIds, false, 'multiple');
          setPendingAnalysisAfterSection({ taskIds: undefined, nextTaskIds: effectiveSelectedTaskIds });
          if (bidSectionExtractionStatus === 'success' && bidSections.length >= 2) {
            // 此前已识别过标段：标段选择器由多标段常驻 effect 自动弹出。
            showToast('检测到本招标文件疑似包含多个标段，请选择本次投标范围', 'info');
            return;
          }
          await window.yibiao?.tasks.startBidSectionExtraction({});
          showToast('检测到本招标文件疑似包含多个标段，正在识别标段，完成后请选择投标范围', 'info');
        } catch (error) {
          setPendingAnalysisAfterSection(null);
          showToast(error instanceof Error ? error.message : '启动多标段识别失败', 'error');
        }
      })();
      return;
    }

    // 单标段（或多标段已选定范围）：直接自动解析。
    void startAnalysis(undefined, effectiveSelectedTaskIds, { skipCheck: true }).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bidSectionExtractionStatus, bidSectionMode, bidSections.length, catalogTasks.length, effectiveSelectedTaskIds, hasGeneratedOutline, hasTenderFile, sectionDetection, selectedSectionTitle, taskRunning, tasks]);

  // STEP02：「下一步」合并了「开始解析」——父组件递增 startSignal 时自动启动解析（尊重已保存的解析配置）。
  const lastStartSignalRef = useRef(startSignal ?? 0);
  useEffect(() => {
    if (startSignal === undefined || startSignal === lastStartSignalRef.current) return;
    lastStartSignalRef.current = startSignal;
    if (!hasTenderFile || requiredDone || taskRunning) return;
    void startAnalysis(undefined, effectiveSelectedTaskIds, { skipCheck: true }).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startSignal]);

  useEffect(() => {
    setDraftBidSectionMode(bidSectionMode);
  }, [bidSectionMode]);

  useEffect(() => {
    if (bidSectionMode === 'multiple' && bidSectionExtractionStatus === 'success' && bidSections.length >= 2 && !selectedSectionTitle && !sectionTaskRunning) {
      setSectionSelectorOpen(true);
    }
  }, [bidSectionMode, bidSectionExtractionStatus, bidSections.length, selectedSectionTitle, sectionTaskRunning]);

  useEffect(() => {
    if (pendingAnalysisAfterSection && bidSectionExtractionStatus === 'error') {
      setPendingAnalysisAfterSection(null);
      showToast(bidSectionExtractionError || '多标段识别失败，请重新识别或改用单标段解析', 'error');
    }
  }, [bidSectionExtractionError, bidSectionExtractionStatus, pendingAnalysisAfterSection, showToast]);

  useEffect(() => {
    if (!settingsOpen) {
      return;
    }

    setDraftSelectedTaskIds(effectiveSelectedTaskIds);
    setDraftBidSectionMode(bidSectionMode);
  }, [bidSectionMode, effectiveSelectedTaskIds, settingsOpen]);

  const openSettingsDialog = () => {
    if (taskRunning) {
      showToast('招标文件解析任务正在运行，请等待任务结束后再调整配置', 'info');
      return;
    }
    setDraftSelectedTaskIds(effectiveSelectedTaskIds);
    setDraftBidSectionMode(bidSectionMode);
    setSettingsOpen(true);
  };

  const saveConfig = async (nextTaskIds = draftSelectedTaskIds, closeDialog = true, nextBidSectionMode = draftBidSectionMode) => {
    const normalizedTaskIds = normalizeSelectedTaskIds(nextTaskIds);
    const nextMode = getModeForSelection(normalizedTaskIds);
    const saved = await window.yibiao?.technicalPlan.saveBidAnalysisConfig({ mode: nextMode, selectedTaskIds: normalizedTaskIds, bidSectionMode: nextBidSectionMode });
    if (saved) {
      onConfigSaved(saved);
    }
    syncProgressForSelection();
    if (closeDialog) {
      setSettingsOpen(false);
      showToast('招标文件解析配置已保存', 'success');
    }
    return { mode: nextMode, selectedTaskIds: normalizedTaskIds, bidSectionMode: nextBidSectionMode };
  };

  const startBidAnalysisOnly = async (taskIds: string[] | undefined, nextTaskIds: string[], nextBidSectionMode: BidSectionMode) => {
    if (!hasTenderFile) {
      showToast('请先上传招标文件', 'info');
      return;
    }

    const normalizedTaskIds = normalizeSelectedTaskIds(nextTaskIds);
    const nextSelectedIdSet = new Set(normalizedTaskIds);
    const nextSelectedTasks = catalogTasks.filter((task) => nextSelectedIdSet.has(task.id));
    const retryTask = taskIds?.length === 1 ? nextSelectedTasks.find((task) => task.id === taskIds[0]) : undefined;
    const forceRerun = !taskIds?.length && nextSelectedTasks.length > 0 && nextSelectedTasks.every((task) => tasks[task.id]?.status === 'success');

    try {
      setRunning(true);
      if (forceRerun) {
        setFullRerunSeenRunning(false);
        setFullRerunLocked(true);
      }
      const configState = await saveConfig(normalizedTaskIds, false, nextBidSectionMode);
      const config = await window.yibiao?.config.load();
      await window.yibiao?.tasks.startBidAnalysis({
        mode: configState.mode,
        selected_task_ids: configState.selectedTaskIds,
        task_ids: taskIds,
        force_rerun: forceRerun,
      });
      setSettingsOpen(false);
      showToast(retryTask ? `${retryTask.label}重新解析任务已在后台启动` : '招标文件解析任务已在后台启动', 'success');
    } catch (error) {
      if (forceRerun) {
        setFullRerunLocked(false);
        setFullRerunSeenRunning(false);
      }
      showToast(error instanceof Error ? error.message : '启动解析任务失败', 'error');
    } finally {
      setRunning(false);
    }
  };

  const startAnalysis = async (taskIds?: string[], nextTaskIds = draftSelectedTaskIds, options: { skipCheck?: boolean; overrideMode?: BidSectionMode } = {}) => {
    if (!hasTenderFile) {
      showToast('请先上传招标文件', 'info');
      return;
    }

    const nextBidSectionMode = options.overrideMode || draftBidSectionMode;
    const normalizedTaskIds = normalizeSelectedTaskIds(nextTaskIds);

    if (!options.skipCheck) {
      try {
        // P0：优先复用挂载时的免费检测结果（组件生命周期内文件未变），避免重复请求。
        const detection = sectionDetection ?? await window.yibiao?.technicalPlan.checkBidSections();
        // 单标段 + 检测到疑似多标段时保留确认弹窗作为兜底（仅设置弹窗路径会走到这里）。
        if (nextBidSectionMode === 'single' && detection?.hasMultiple) {
          setSectionModeWarning({ type: 'single-suspected-multiple', taskIds, nextTaskIds: normalizedTaskIds });
          return;
        }
        if (nextBidSectionMode === 'multiple' && detection && !detection.hasMultiple) {
          setSectionModeWarning({ type: 'multiple-not-detected', taskIds, nextTaskIds: normalizedTaskIds });
          return;
        }
      } catch (error) {
        showToast(error instanceof Error ? error.message : '标段校验失败', 'error');
        return;
      }
    }

    if (nextBidSectionMode === 'multiple' && !selectedSectionTitle) {
      try {
        await saveConfig(normalizedTaskIds, false, 'multiple');
        setPendingAnalysisAfterSection({ taskIds, nextTaskIds: normalizedTaskIds });
        if (bidSectionExtractionStatus === 'success' && bidSections.length >= 2) {
          setSettingsOpen(false);
          setSectionSelectorOpen(true);
          return;
        }
        setSettingsOpen(false);
        await window.yibiao?.tasks.startBidSectionExtraction({});
        showToast('多标段识别任务已在后台启动', 'success');
      } catch (error) {
        setPendingAnalysisAfterSection(null);
        showToast(error instanceof Error ? error.message : '启动多标段识别失败', 'error');
      }
      return;
    }

    await startBidAnalysisOnly(taskIds, normalizedTaskIds, nextBidSectionMode);
  };

  const retryActiveTask = () => {
    if (!activeTask || activeTaskStatus !== 'error') {
      showToast('当前解析项没有失败，无需单独重试', 'info');
      return;
    }

    startAnalysis([activeTask.id], effectiveSelectedTaskIds);
  };

  const continueFromSectionModeWarning = (nextBidSectionMode: BidSectionMode) => {
    if (!sectionModeWarning) return;
    const pending = sectionModeWarning;
    setSectionModeWarning(null);
    setDraftBidSectionMode(nextBidSectionMode);
    void startAnalysis(pending.taskIds, pending.nextTaskIds, { skipCheck: true, overrideMode: nextBidSectionMode });
  };

  const startSectionExtractionOnly = async () => {
    if (!hasTenderFile) {
      showToast('请先上传招标文件', 'info');
      return;
    }
    try {
      await saveConfig(draftSelectedTaskIds, false, 'multiple');
      setSettingsOpen(false);
      await window.yibiao?.tasks.startBidSectionExtraction({});
      showToast('多标段识别任务已在后台启动', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '启动多标段识别失败', 'error');
    }
  };

  const handleSectionSelect = async (sectionId: string) => {
    if (hasGeneratedOutline) {
      const ok = await confirmWipeAction({
        title: '切换投标范围将清空现有进度',
        description: '切换投标范围会清除已生成的目录与全部正文，并重置到招标文件解析步骤。此操作不可撤销。是否继续？',
        confirmText: '确认切换',
      });
      if (!ok) {
        return;
      }
    }
    const selectedSection = bidSections.find((section) => section.id === sectionId);
    if (!selectedSection) {
      showToast('未找到选择的投标范围', 'error');
      return;
    }
    try {
      setSelectingSection(true);
      const result = await window.yibiao?.technicalPlan.selectBidSection(selectedSection);
      if (!result?.success || !result.state) {
        showToast(result?.message || '投标范围选择失败', 'error');
        return;
      }
      onConfigSaved(result.state);
      setSectionSelectorOpen(false);
      showToast(result.message || '已选择投标范围', 'success');
      if (pendingAnalysisAfterSection) {
        const pending = pendingAnalysisAfterSection;
        setPendingAnalysisAfterSection(null);
        await startBidAnalysisOnly(pending.taskIds, pending.nextTaskIds, 'multiple');
      }
    } catch (error) {
      showToast(error instanceof Error ? error.message : '投标范围选择失败', 'error');
    } finally {
      setSelectingSection(false);
    }
  };

  const handleSectionCancel = () => {
    setPendingAnalysisAfterSection(null);
    setSectionSelectorOpen(false);
  };

  const toggleDraftTask = (taskId: string) => {
    if (selection.requiredIdSet.has(taskId) || taskRunning) {
      return;
    }

    setDraftSelectedTaskIds((prev) => {
      const selectedSet = new Set(normalizeSelectedTaskIds(prev));
      if (selectedSet.has(taskId)) {
        selectedSet.delete(taskId);
      } else {
        selectedSet.add(taskId);
      }
      return selection.allIds.filter((id) => selectedSet.has(id));
    });
  };

  const selectPreset = (preset: 'key' | 'full') => {
    setDraftSelectedTaskIds(preset === 'full' ? selection.allIds : selection.requiredIds);
  };

  const openSectionSelectorFromConfig = async () => {
    try {
      await saveConfig(draftSelectedTaskIds, false, 'multiple');
      setSettingsOpen(false);
      setSectionSelectorOpen(true);
    } catch (error) {
      showToast(error instanceof Error ? error.message : '打开标段选择失败', 'error');
    }
  };

  const copyActiveResult = async () => {
    if (!activeTaskContent) {
      showToast('当前没有可复制的解析结果', 'info');
      return;
    }

    await navigator.clipboard.writeText(activeTaskContent);
    showToast('解析结果已复制', 'success');
  };

  const requireSectionModeChangeConfirm = async (): Promise<boolean> => {
    if (draftBidSectionMode === bidSectionMode || !hasGeneratedOutline) {
      return true;
    }
    return confirmWipeAction({
      title: '切换投标范围将清空现有进度',
      description: '切换投标范围会清除已生成的目录与全部正文，并重置到招标文件解析步骤。此操作不可撤销。是否继续？',
      confirmText: '确认切换',
    });
  };

  const renderConfigTask = (definition: BidAnalysisCatalogTask) => {
    const selected = normalizeSelectedTaskIds(draftSelectedTaskIds).includes(definition.id);
    const required = definition.required;

    return (
      <label className={`bid-analysis-config-item${selected ? ' is-selected' : ''}${required ? ' is-required' : ''}`} key={definition.id}>
        <input
          type="checkbox"
          checked={selected}
          disabled={required || taskRunning}
          onChange={() => toggleDraftTask(definition.id)}
        />
        <span>
          <strong>{definition.label}</strong>
        </span>
        {required ? <em>必选</em> : DISPLAY_ONLY_TASK_IDS.has(definition.id) && <em className="bid-analysis-display-only">仅展示</em>}
      </label>
    );
  };

  const draftMode = getModeForSelection(draftSelectedTaskIds);
  const draftSelectedCount = normalizeSelectedTaskIds(draftSelectedTaskIds).length;
  const hasExtractedBidSections = bidSectionExtractionStatus === 'success' && bidSections.length >= 2;
  const bidSectionActionLabel = sectionTaskRunning
    ? '识别中...'
    : hasExtractedBidSections
      ? selectedSectionTitle ? '更换' : '选择标段'
      : bidSectionExtractionStatus === 'error' ? '重新识别标段' : '识别标段';

  return (
    <div className="plan-step-body bid-analysis-page">
      <section className="bid-analysis-command-bar">
        <div>
          <span className="section-kicker">STEP 02</span>
          <strong>招标文件解析</strong>
          <p>点击右下角「下一步」自动解析关键项，完成后进入目录生成并自动开始。</p>
        </div>
        <div className="bid-analysis-config-chip" title="当前解析配置">
          <span>{configLabel}</span>
          <small>{selectedTasks.length} 项</small>
        </div>
        <div className="bid-analysis-command-actions">
          <button
            type="button"
            className="outline-config-action"
            onClick={openSettingsDialog}
            disabled={taskRunning}
            aria-label="打开招标文件解析配置"
            title="招标文件解析配置"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <path d="M12 15.5A3.5 3.5 0 1 0 12 8a3.5 3.5 0 0 0 0 7.5Z" />
              <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.05.05a2 2 0 0 1-2.83 2.83l-.05-.05a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.04 1.56V21a2 2 0 0 1-4 0v-.08a1.7 1.7 0 0 0-1.04-1.56 1.7 1.7 0 0 0-1.87.34l-.05.05a2 2 0 0 1-2.83-2.83l.05-.05A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.56-1.04H3a2 2 0 0 1 0-4h.08A1.7 1.7 0 0 0 4.6 8.93a1.7 1.7 0 0 0-.34-1.87l-.05-.05a2 2 0 0 1 2.83-2.83l.05.05a1.7 1.7 0 0 0 1.87.34A1.7 1.7 0 0 0 10 3.01V3a2 2 0 0 1 4 0v.08a1.7 1.7 0 0 0 1.04 1.56 1.7 1.7 0 0 0 1.87-.34l.05-.05a2 2 0 0 1 2.83 2.83l-.05.05a1.7 1.7 0 0 0-.34 1.87 1.7 1.7 0 0 0 1.56 1.04H21a2 2 0 0 1 0 4h-.08A1.7 1.7 0 0 0 19.4 15Z" />
            </svg>
          </button>
        </div>
      </section>

      <section className="bid-analysis-workspace">
        <aside className="bid-analysis-task-pane" aria-label="解析任务列表">
          <div className="analysis-result-head bid-analysis-task-head">
            <strong>核心信息</strong>
            <span>{doneCount}/{selectedTasks.length} 项</span>
          </div>
          <div className={`content-outline-stats bid-analysis-progress-summary${progressCollapsed ? ' is-collapsed' : ''}`}>
            <button type="button" onClick={() => setProgressCollapsed((prev) => !prev)} aria-expanded={!progressCollapsed}>
              <span>解析进度</span>
              <strong>{doneCount}/{selectedTasks.length}</strong>
              <em>{progressCollapsed ? '展开' : '折叠'}</em>
            </button>
            {!progressCollapsed && (
              <div className="content-outline-stats-body">
                <div className="content-generation-progress-track" aria-label={`解析进度 ${displayProgress}%`}>
                  <span style={{ width: `${displayProgress}%` }} />
                </div>
                <p>{progressMessage}</p>
              </div>
            )}
          </div>
          <div className="bid-analysis-task-list">
            {sidebarGroups.map((group) => {
              const groupTasks = group.items;
              if (!groupTasks.length) {
                return null;
              }

              return (
                <div className="bid-analysis-task-group" key={group.name}>
                  <span>{group.name}</span>
                  {groupTasks.map((task) => {
                    const status = tasks[task.id]?.status || 'idle';
                    const content = tasks[task.id]?.content || '';

                    return (
                      <button
                        type="button"
                        className={`bid-analysis-task-item is-${status}${visibleSelectedTaskId === task.id ? ' is-active' : ''}`}
                        key={task.id}
                        onClick={() => setSelectedTaskId(task.id)}
                      >
                        <strong>{task.label}</strong>
                        <small>{content ? `${content.length} 字` : task.description}</small>
                        <em>{statusLabel[status]}</em>
                      </button>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </aside>

        <article className="bid-analysis-reader">
          <div className="bid-analysis-reader-head">
            <div>
              <span className="section-kicker">解析结果</span>
              <strong>{activeTask?.label || '解析结果'}</strong>
              <p>{activeTask?.description || '选择左侧任务查看解析结果。'}</p>
            </div>
            <div className="bid-analysis-reader-actions">
              <span className={`bid-analysis-status is-${activeTaskStatus}`}>{statusLabel[activeTaskStatus]}</span>
              {activeTaskStatus === 'error' && (
                <button type="button" className="secondary-action" onClick={retryActiveTask} disabled={taskRunning || !hasTenderFile}>重新解析此项</button>
              )}
              <button type="button" className="secondary-action" onClick={copyActiveResult} disabled={!activeTaskContent}>复制</button>
            </div>
          </div>

          {activeTaskContent ? (
            activeTask?.output === 'json' ? (
              <JsonResultTable content={activeTaskContent} />
            ) : (
              <MarkdownFullscreenViewer className="markdown-viewer bid-analysis-output" title={`${activeTask?.label || '解析结果'}全屏预览`}>
                <MarkdownRenderer>
                  {activeTaskContent}
                </MarkdownRenderer>
              </MarkdownFullscreenViewer>
            )
          ) : activeTaskStatus === 'running' || (activeTaskStatus === 'idle' && taskRunning) ? (
            <div className="markdown-empty-state bid-analysis-empty bid-analysis-running">
              <div className="bid-analysis-running-dots" aria-hidden="true">
                <span />
                <span />
                <span />
              </div>
              <strong>
                {activeTaskStatus === 'running'
                  ? `正在解析「${activeTask?.label || '当前任务'}」`
                  : `「${activeTask?.label || '当前任务'}」即将开始解析`}
              </strong>
              <p>{getRunningHint(runningElapsed)}</p>
              <div className="bid-analysis-running-meta">
                <span>
                  已用时 <strong>{formatElapsedSeconds(runningElapsed)}</strong>
                </span>
                <span>
                  进度 <strong>{doneCount}/{selectedTasks.length}</strong> 项
                </span>
              </div>
              <div
                className="bid-analysis-running-track content-generation-progress-track is-active"
                aria-label={`解析进度 ${displayProgress}%`}
              >
                <span style={{ width: `${displayProgress}%` }} />
              </div>
            </div>
          ) : (
            <div className="markdown-empty-state bid-analysis-empty">
              <strong>{activeTaskStatus === 'error' ? activeTaskState?.error || '解析失败' : '等待解析结果'}</strong>
              <p>{activeTaskStatus === 'idle' ? '点击右下角「下一步」后自动开始解析；选择任一任务查看实时输出。' : '正在等待模型返回内容。'}</p>
            </div>
          )}
        </article>
      </section>

      <Dialog.Root open={settingsOpen} onOpenChange={setSettingsOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="content-regenerate-modal" />
          <Dialog.Content className="bid-analysis-config-card">
            <Dialog.Title className="sr-only">招标文件解析配置</Dialog.Title>
            <Dialog.Description className="sr-only">选择本次招标文件需要解析的项目。</Dialog.Description>

            <header className="bid-analysis-config-head">
              <div>
                <span className="section-kicker">解析配置</span>
                <strong>招标文件解析配置</strong>
              </div>
            </header>

            <div className="bid-analysis-config-body">
              <section className="bid-analysis-config-section is-compact">
                <div className="bid-analysis-config-section-head">
                  <strong>投标范围</strong>
                  <span>{draftBidSectionMode === 'multiple' ? '多标段' : '默认单标段'}</span>
                </div>
                <div className="bid-analysis-config-presets" role="group" aria-label="投标范围模式">
                  <button
                    type="button"
                    className={`bid-analysis-config-preset${draftBidSectionMode === 'single' ? ' is-active' : ''}`}
                    onClick={() => setDraftBidSectionMode('single')}
                    disabled={taskRunning}
                  >
                    <span>单标段</span>
                    <small>默认</small>
                  </button>
                  <button
                    type="button"
                    className={`bid-analysis-config-preset${draftBidSectionMode === 'multiple' ? ' is-active' : ''}`}
                    onClick={() => setDraftBidSectionMode('multiple')}
                    disabled={taskRunning}
                  >
                    <span>多标段</span>
                    <small>AI 识别</small>
                  </button>
                </div>
                {draftBidSectionMode === 'multiple' && (
                  <div className="bid-analysis-section-action">
                    {selectedSectionTitle && (
                      <>
                        <span className="bid-analysis-section-label">当前选择的标段</span>
                        <span className="bid-analysis-section-chip">{selectedSectionTitle}</span>
                      </>
                    )}
                    <button
                      type="button"
                      className="secondary-action bid-analysis-section-change"
                      onClick={() => {
                        if (hasExtractedBidSections) {
                          void openSectionSelectorFromConfig();
                          return;
                        }
                        void startSectionExtractionOnly();
                      }}
                      disabled={!hasTenderFile || taskRunning}
                    >
                      {bidSectionActionLabel}
                    </button>
                  </div>
                )}
              </section>

              <section className="bid-analysis-config-section is-compact">
                <div className="bid-analysis-config-section-head">
                  <strong>解析范围</strong>
                  <span>{getModeLabel(draftMode)}</span>
                </div>
                <div className="bid-analysis-config-presets" role="group" aria-label="快速选择解析项">
                  {modeOptions.map((option) => (
                    <button
                      type="button"
                      className={`bid-analysis-config-preset${draftMode === option.id ? ' is-active' : ''}`}
                      key={option.id}
                      onClick={() => selectPreset(option.id)}
                      disabled={taskRunning}
                    >
                      <span>{option.title}</span>
                      <small>{option.badge}</small>
                    </button>
                  ))}
                </div>
              </section>

              <section className="bid-analysis-config-section">
                <div className="bid-analysis-config-section-head">
                  <strong>关键项</strong>
                  <span>{selection.requiredIds.length} 项必选</span>
                </div>
                <div className="bid-analysis-config-grid">
                  {catalogTasks.filter((definition) => definition.required).map(renderConfigTask)}
                </div>
              </section>

              <section className="bid-analysis-config-section">
                <div className="bid-analysis-config-section-head">
                  <strong>其他项</strong>
                  <span>当前共选择 {draftSelectedCount} 项</span>
                </div>
                <p className="bid-analysis-config-note">
                  标注「仅展示」的解析项只在本页展示解析结果，不参与目录与正文生成；默认不解析，可按需勾选。
                </p>
                <div className="bid-analysis-config-grid">
                  {catalogTasks.filter((definition) => !definition.required).map(renderConfigTask)}
                </div>
              </section>
            </div>

            <div className="content-regenerate-actions bid-analysis-config-actions">
              <Dialog.Close className="secondary-action" type="button">取消</Dialog.Close>
              <button
                type="button"
                className="secondary-action"
                onClick={() => {
                  void requireSectionModeChangeConfirm().then((ok) => {
                    if (!ok) return;
                    void saveConfig().catch((error) => showToast(error instanceof Error ? error.message : '保存解析配置失败', 'error'));
                  });
                }}
                disabled={taskRunning}
              >
                保存配置
              </button>
              <button
                type="button"
                className="primary-action"
                onClick={() => {
                  void requireSectionModeChangeConfirm().then((ok) => {
                    if (ok) void startAnalysis(undefined, draftSelectedTaskIds);
                  });
                }}
                disabled={taskRunning || !hasTenderFile}
              >
                开始解析
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <Dialog.Root open={Boolean(sectionModeWarning)} onOpenChange={(open) => { if (!open) setSectionModeWarning(null); }}>
        <Dialog.Portal>
          <Dialog.Overlay className="content-regenerate-modal" />
          <Dialog.Content className="content-regenerate-card">
            <Dialog.Title className="content-regenerate-title">投标范围确认</Dialog.Title>
            <Dialog.Description className="content-regenerate-description">
              {sectionModeWarning?.type === 'single-suspected-multiple'
                ? '系统检测到招标文件疑似包含多个标段，建议切换为多标段解析，先选择本次投标范围后再解析。'
                : '系统没有通过规则检测到明确多标段结构，是否仍继续使用 AI 识别多标段？'}
            </Dialog.Description>
            <div className="content-regenerate-actions">
              {sectionModeWarning?.type === 'single-suspected-multiple' ? (
                <>
                  <button type="button" className="secondary-action" onClick={() => continueFromSectionModeWarning('single')}>继续单标段</button>
                  <button type="button" className="primary-action" onClick={() => continueFromSectionModeWarning('multiple')}>切换多标段</button>
                </>
              ) : (
                <>
                  <button type="button" className="secondary-action" onClick={() => continueFromSectionModeWarning('single')}>改为单标段</button>
                  <button type="button" className="primary-action" onClick={() => continueFromSectionModeWarning('multiple')}>继续 AI 识别</button>
                </>
              )}
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <BidSectionSelectorDialog
        open={sectionSelectorOpen}
        sections={bidSections}
        onSelect={handleSectionSelect}
        onCancel={handleSectionCancel}
        busy={selectingSection}
      />

      {wipeConfirmDialog}
    </div>
  );
}

export default BidAnalysisPage;
