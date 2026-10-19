import * as Dialog from '@radix-ui/react-dialog';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, DragEvent } from 'react';
import { useToast } from '../../../shared/ui';
import { useAuth } from '../../../shared/api/auth';
import { useConfirmAction } from '../hooks/useConfirmAction';
import type { BackgroundTaskState, SaveOutlineRequest, TechnicalPlanWorkflowKind } from '../types';
import { DEFAULT_OUTLINE_MODE } from '../../../shared/types';
import type {
  OutlineData,
  OutlineExpansionMode,
  OutlineItem,
  OutlineMode,
  OutlineWordControlOptions,
} from '../../../shared/types';
import type { ExportFormatConfig } from '../../../shared/types/exportFormat';
import { DEFAULT_EXPORT_FORMAT } from '../../../shared/types/exportFormat';
import { formatOutlineTitle } from '../../../shared/utils/outlineNumbering';

interface OutlineEditPageProps {
  workflowKind: TechnicalPlanWorkflowKind;
  projectOverview: string;
  techRequirements: string;
  outlineExpansionMode: OutlineExpansionMode;
  referenceKnowledgeDocumentIds: string[];
  mirrorProcurementEnabled: boolean;
  outlineWordControlOptions?: OutlineWordControlOptions;
  outlineMode?: OutlineMode;
  outlineData: OutlineData | null;
  task?: BackgroundTaskState;
  contentTaskStatus?: BackgroundTaskState['status'];
  onOutlineConfigChange: (config: { referenceKnowledgeDocumentIds: string[]; outlineExpansionMode: OutlineExpansionMode; mirrorProcurementEnabled: boolean; outlineWordControlOptions: OutlineWordControlOptions; outlineMode: OutlineMode }) => void;
  onOutlineSaved: (request: SaveOutlineRequest) => Promise<void>;
  onSortGuardChange?: (guard: OutlineSortGuard | null) => void;
  autoStartGeneration?: boolean;
}

interface OutlineSortGuard {
  hasUnsavedSort: () => boolean;
  saveSort: () => Promise<void>;
  discardSort: () => void;
}

interface RenumberResult {
  outline: OutlineItem[];
  idMap: Record<string, string>;
}

interface OutlineLocation {
  parentId: string | null;
  level: number;
  index: number;
}

interface DropTargetState {
  itemId: string;
  position: 'before' | 'after';
  valid: boolean;
}

// 全文字数预设常驻面板：滑块范围 0~10 万字（步进 0.5），0 表示不控制，默认 3 万字。
const WORD_PRESET_SLIDER_MAX_WAN = 10;
const WORD_PRESET_SLIDER_STEP = 0.5;
const WORD_PRESET_DEFAULT_WAN = 3;
// 滑块单值映射为字数区间：最少 = 滑块值，最多 = 滑块值 × 1.2（保留 20% 上浮余量，取整到 0.1 万）。
const WORD_PRESET_MAX_RATIO = 1.2;
// 滑块范围（0~10 万）之外可经输入框自定义更大字数（上限 200 万防爆），0 表示不控制。
const WORD_PRESET_INPUT_MAX_WAN = 200;

function roundWan(value: number) {
  return Math.round(value * 10) / 10;
}

function wordPresetSliderValue(options: OutlineWordControlOptions) {
  return options.minWordsWan > 0 ? options.minWordsWan : options.maxWordsWan > 0 ? options.maxWordsWan : 0;
}

function applyWordPresetSlider(options: OutlineWordControlOptions, wan: number): OutlineWordControlOptions {
  if (wan <= 0) {
    return { ...options, minWordsWan: 0, maxWordsWan: 0 };
  }
  return { ...options, minWordsWan: roundWan(wan), maxWordsWan: roundWan(wan * WORD_PRESET_MAX_RATIO) };
}

// 从已保存配置推导面板初始值：从未设置过（min/max 均 0）时默认 3 万字。
function initialWordControlOptions(value: Partial<OutlineWordControlOptions> | undefined): OutlineWordControlOptions {
  const normalized = normalizeOutlineWordControlOptions(value);
  return normalized.minWordsWan <= 0 && normalized.maxWordsWan <= 0
    ? applyWordPresetSlider(normalized, WORD_PRESET_DEFAULT_WAN)
    : normalized;
}
const outlineExpansionModeLabels: Record<OutlineExpansionMode, string> = {
  'original-only': '仅使用原方案目录',
  'ai-complement': 'AI基于原方案补充',
};
const outlineExpansionModeOptions: Array<{ value: OutlineExpansionMode; title: string; description: string }> = [
  {
    value: 'original-only',
    title: outlineExpansionModeLabels['original-only'],
    description: '提取并补漏原方案目录后直接作为新目录；知识库不参与目录补充，但会用于后续全局事实和正文生成。',
  },
  {
    value: 'ai-complement',
    title: outlineExpansionModeLabels['ai-complement'],
    description: '保留原方案一级目录，在其基础上补充招标评分项缺口，并可继续使用知识库增强。',
  },
];
function collectOutlineIds(items: OutlineItem[], ids = new Set<string>()) {
  items.forEach((item) => {
    ids.add(item.id);
    if (item.children?.length) {
      collectOutlineIds(item.children, ids);
    }
  });
  return ids;
}

function collectRootIds(items: OutlineItem[]) {
  return new Set(items.map((item) => item.id));
}

function subtreeHasContent(item: OutlineItem): boolean {
  if (item.content?.trim()) {
    return true;
  }
  return Boolean(item.children?.some((child) => subtreeHasContent(child)));
}

function formatDuration(milliseconds: number) {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const minutes = Math.floor(totalSeconds / 60).toString().padStart(2, '0');
  const seconds = (totalSeconds % 60).toString().padStart(2, '0');
  return `${minutes}:${seconds}`;
}

function normalizeWordWan(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number * 100) / 100 : 0;
}

function normalizeOutlineWordControlOptions(value: Partial<OutlineWordControlOptions> | undefined): OutlineWordControlOptions {
  return {
    minWordsWan: normalizeWordWan(value?.minWordsWan),
    maxWordsWan: normalizeWordWan(value?.maxWordsWan),
    wordsPerSectionWan: normalizeWordWan(value?.wordsPerSectionWan),
    forceSectionWords: value?.forceSectionWords === true,
  };
}

function renumberOutlineItemsWithIdMap(items: OutlineItem[], parentPrefix = ''): RenumberResult {
  const idMap: Record<string, string> = {};
  const outline = items.map((item, index) => {
    const id = parentPrefix ? `${parentPrefix}.${index + 1}` : `${index + 1}`;
    const childResult = item.children?.length ? renumberOutlineItemsWithIdMap(item.children, id) : null;
    idMap[item.id] = id;
    if (childResult) {
      Object.assign(idMap, childResult.idMap);
    }
    return {
      ...item,
      id,
      children: childResult?.outline,
    };
  });

  return { outline, idMap };
}

function createIdentityIdMap(items: OutlineItem[], idMap: Record<string, string> = {}) {
  items.forEach((item) => {
    idMap[item.id] = item.id;
    if (item.children?.length) {
      createIdentityIdMap(item.children, idMap);
    }
  });
  return idMap;
}

function composeIdMap(baseMap: Record<string, string>, stepMap: Record<string, string>) {
  return Object.fromEntries(Object.entries(baseMap).map(([oldId, currentId]) => [oldId, stepMap[currentId] || currentId]));
}

function findOutlineLocation(items: OutlineItem[], itemId: string, parentId: string | null = null, level = 0): OutlineLocation | null {
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (item.id === itemId) {
      return { parentId, level, index };
    }
    if (item.children?.length) {
      const child = findOutlineLocation(item.children, itemId, item.id, level + 1);
      if (child) return child;
    }
  }
  return null;
}

function reorderSiblingItems(items: OutlineItem[], draggedId: string, targetId: string, position: 'before' | 'after') {
  const draggedIndex = items.findIndex((item) => item.id === draggedId);
  const targetIndex = items.findIndex((item) => item.id === targetId);
  if (draggedIndex < 0 || targetIndex < 0 || draggedIndex === targetIndex) {
    return items;
  }

  const next = [...items];
  const [dragged] = next.splice(draggedIndex, 1);
  const adjustedTargetIndex = next.findIndex((item) => item.id === targetId);
  const insertIndex = position === 'before' ? adjustedTargetIndex : adjustedTargetIndex + 1;
  next.splice(insertIndex, 0, dragged);
  return next;
}

function reorderOutlineSiblings(items: OutlineItem[], parentId: string | null, draggedId: string, targetId: string, position: 'before' | 'after'): OutlineItem[] {
  if (parentId === null) {
    return reorderSiblingItems(items, draggedId, targetId, position);
  }

  return items.map((item) => {
    if (item.id === parentId) {
      return {
        ...item,
        children: reorderSiblingItems(item.children || [], draggedId, targetId, position),
      };
    }
    return item.children?.length
      ? { ...item, children: reorderOutlineSiblings(item.children, parentId, draggedId, targetId, position) }
      : item;
  });
}

function updateOutlineItem(items: OutlineItem[], itemId: string, updater: (item: OutlineItem) => OutlineItem): OutlineItem[] {
  return items.map((item) => {
    if (item.id === itemId) {
      return updater(item);
    }

    return {
      ...item,
      children: item.children ? updateOutlineItem(item.children, itemId, updater) : undefined,
    };
  });
}

function deleteOutlineItem(items: OutlineItem[], itemId: string): OutlineItem[] {
  return items.flatMap((item) => {
    if (item.id === itemId) {
      return [];
    }

    return [{
      ...item,
      children: item.children ? deleteOutlineItem(item.children, itemId) : undefined,
    }];
  });
}

function findOutlineItem(items: OutlineItem[], itemId: string): OutlineItem | null {
  for (const item of items) {
    if (item.id === itemId) {
      return item;
    }
    const child = item.children ? findOutlineItem(item.children, itemId) : null;
    if (child) {
      return child;
    }
  }
  return null;
}

function OutlineEditPage({
  workflowKind,
  projectOverview,
  techRequirements,
  outlineExpansionMode,
  referenceKnowledgeDocumentIds,
  mirrorProcurementEnabled,
  outlineWordControlOptions,
  outlineMode,
  outlineData,
  task,
  contentTaskStatus,
  onOutlineConfigChange,
  onOutlineSaved,
  onSortGuardChange,
  autoStartGeneration = false,
}: OutlineEditPageProps) {
  const { user } = useAuth();
  const [expandedItems, setExpandedItems] = useState<Set<string>>(new Set());
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [editingItemId, setEditingItemId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [startingOutline, setStartingOutline] = useState(false);
  const [progressCollapsed, setProgressCollapsed] = useState(false);
  const [generationDialogOpen, setGenerationDialogOpen] = useState(false);
  const [draftOutlineExpansionMode, setDraftOutlineExpansionMode] = useState<OutlineExpansionMode>(outlineExpansionMode);
  const [draftKnowledgeDocumentIds] = useState<string[]>(referenceKnowledgeDocumentIds);
  const [draftMirrorProcurement, setDraftMirrorProcurement] = useState<boolean>(mirrorProcurementEnabled);
  // 全文字数预设：滑块/输入框即时更新本地值，点「保存并生成」时随配置一并持久化。
  const [liveWordControlOptions, setLiveWordControlOptions] = useState<OutlineWordControlOptions>(() => initialWordControlOptions(outlineWordControlOptions));
  const [wordPresetInput, setWordPresetInput] = useState<string>(() => String(roundWan(wordPresetSliderValue(initialWordControlOptions(outlineWordControlOptions)))));
  const [developerMode, setDeveloperMode] = useState(false);
  const [draftForceOutlineAgentRepair, setDraftForceOutlineAgentRepair] = useState(false);
  const [localStartAt, setLocalStartAt] = useState<number | null>(null);
  const [nowTick, setNowTick] = useState(() => Date.now());
  const [sorting, setSorting] = useState(false);
  const [draftOutlineData, setDraftOutlineData] = useState<OutlineData | null>(null);
  const [exportFormat, setExportFormat] = useState<ExportFormatConfig>(DEFAULT_EXPORT_FORMAT);
  const [sortDirty, setSortDirty] = useState(false);
  const [savingSort, setSavingSort] = useState(false);
  const [draggingItemId, setDraggingItemId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTargetState | null>(null);
  const logListRef = useRef<HTMLDivElement | null>(null);
  const sortIdMapRef = useRef<Record<string, string>>({});
  // 自动启动只消费一次（StrictMode 下挂载 effect 会执行两次，防止重复拉起目录生成任务）。
  const autoStartConsumedRef = useRef(false);
  const { showToast } = useToast();
  const { confirmAsync: confirmOutlineAction, dialogElement: outlineConfirmDialog } = useConfirmAction();
  const activeOutlineData = sorting ? draftOutlineData : outlineData;
  const selectedItem = activeOutlineData && selectedItemId ? findOutlineItem(activeOutlineData.outline, selectedItemId) : null;
  const taskRunning = task?.status === 'running';
  const taskFailed = task?.status === 'error';
  const generating = startingOutline || taskRunning;
  const isExpansionWorkflow = workflowKind === 'existing-plan-expansion';
  // 本轮 STEP03 仅开放「技术文件独立成册」：历史 aligned 配置在页面内统一归一为独立成册，
  // 保证界面展示、保存配置与实际生成任务三处的生成范围一致。
  const currentOutlineMode: OutlineMode = outlineMode === 'aligned' ? DEFAULT_OUTLINE_MODE : outlineMode ?? DEFAULT_OUTLINE_MODE;
  const contentMutationLocked = contentTaskStatus === 'running' || contentTaskStatus === 'pausing' || contentTaskStatus === 'paused';
  const outlineMutationLocked = generating || contentMutationLocked || savingSort;
  const progressLogs = task?.logs || [];
  const latestLog = progressLogs[progressLogs.length - 1];
  const progress = generating
    ? Math.max(5, Math.min(99, task?.progress || 5))
    : taskFailed
      ? Math.max(0, Math.min(99, task?.progress || 0))
      : outlineData || task?.status === 'success'
        ? 100
        : 0;
  const statusText = generating ? '运行中' : taskFailed ? '失败' : outlineData ? '已完成' : '未开始';
  const aiStatusTitle = generating ? 'AI 正在工作' : taskFailed ? '生成失败' : outlineData ? '目录已生成' : '等待生成';
  const statusMessage = taskFailed ? task?.error || latestLog || '目录生成失败，请查看开发者日志。' : latestLog || '点击生成目录后，这里会显示目录生成、审核和修正过程。';
  const startedAt = task?.started_at ? Date.parse(task.started_at) : NaN;
  const updatedAt = task?.updated_at ? Date.parse(task.updated_at) : NaN;
  const effectiveStartedAt = Number.isFinite(startedAt) ? startedAt : localStartAt;
  const elapsedText = generating && effectiveStartedAt ? `已运行 ${formatDuration(nowTick - effectiveStartedAt)}` : '';
  const staleText = generating && Number.isFinite(updatedAt) ? `最近更新 ${Math.floor(Math.max(0, nowTick - updatedAt) / 1000)} 秒前` : '';

  useEffect(() => {
    let cancelled = false;
    window.yibiao?.config.load().then((cfg) => {
      if (cancelled) return;
      setDeveloperMode(Boolean(cfg?.developer_mode));
      if (!cfg?.developer_mode) {
        setDraftForceOutlineAgentRepair(false);
      }
      if (cfg?.export_format) {
        setExportFormat(cfg.export_format);
      }
    }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (activeOutlineData?.outline?.length) {
      const validIds = collectOutlineIds(activeOutlineData.outline);
      setExpandedItems((prev) => {
        const next = new Set([...prev].filter((id) => validIds.has(id)));
        return next.size || sorting ? next : collectRootIds(activeOutlineData.outline);
      });
      setSelectedItemId((prev) => (prev && validIds.has(prev) ? prev : activeOutlineData.outline[0]?.id || null));
      return;
    }

    setExpandedItems(new Set());
    setSelectedItemId(null);
  }, [activeOutlineData]);

  useEffect(() => {
    if (task?.status) {
      setStartingOutline(false);
      if (task.status !== 'running') {
        setLocalStartAt(null);
      }
    }
  }, [task?.status]);

  useEffect(() => {
    if (!generating) {
      return;
    }

    const timer = window.setInterval(() => setNowTick(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [generating]);

  useEffect(() => {
    if (logListRef.current) {
      logListRef.current.scrollTop = logListRef.current.scrollHeight;
    }
  }, [progressLogs.length]);

  // STEP 02 点「下一步」进入本页时：先弹字数设置，下一步确认一级目录后再生成。
  useEffect(() => {
    if (!autoStartGeneration || autoStartConsumedRef.current) {
      return;
    }
    autoStartConsumedRef.current = true;
    if (generating || contentMutationLocked) {
      // 目录任务已在运行或被正文任务锁定时不重复启动。
      return;
    }
    void beginGenerationFlow();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!generationDialogOpen) {
      return;
    }

    setDraftOutlineExpansionMode(isExpansionWorkflow ? outlineExpansionMode : 'ai-complement');
    setDraftMirrorProcurement(mirrorProcurementEnabled);
    setDraftForceOutlineAgentRepair(false);
    const nextOptions = initialWordControlOptions(outlineWordControlOptions);
    setLiveWordControlOptions(nextOptions);
    setWordPresetInput(String(roundWan(wordPresetSliderValue(nextOptions))));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [generationDialogOpen]);

  // 全文字数滑块：拖动即时更新本地值，点「保存并生成」时随配置一并持久化。
  const handleWordPresetChange = (wan: number) => {
    setLiveWordControlOptions((prev) => applyWordPresetSlider(prev, wan));
  };

  // 自定义字数输入框：输入过程实时应用有效数值（文本保留用户输入原样），失焦/回车时规整显示。
  const commitWordPresetInput = (raw: string, finalize: boolean) => {
    setWordPresetInput(raw);
    const trimmed = raw.trim();
    const parsed = Number(trimmed);
    if (trimmed !== '' && Number.isFinite(parsed) && parsed >= 0) {
      const wan = Math.min(roundWan(parsed), WORD_PRESET_INPUT_MAX_WAN);
      handleWordPresetChange(wan);
      if (finalize) {
        setWordPresetInput(String(wan));
      }
    } else if (finalize) {
      setWordPresetInput(String(roundWan(wordPresetSliderValue(liveWordControlOptions))));
    }
  };

  const openGenerationDialog = () => {
    if (sorting) {
      showToast('请先保存当前目录排序', 'info');
      return;
    }
    const lockMessage = getMutationLockMessage();
    if (lockMessage) {
      showToast(lockMessage, 'info');
      return;
    }
    if (!projectOverview || !techRequirements) {
      showToast('请先完成招标文件解析', 'info');
      return;
    }

    setDraftOutlineExpansionMode(isExpansionWorkflow ? outlineExpansionMode : 'ai-complement');
    setDraftMirrorProcurement(mirrorProcurementEnabled);
    setGenerationDialogOpen(true);
  };

  // 进入 STEP03/点「生成目录」：直接打开字数设置，保存后启动任务；一级目录由任务自动提取，不再人工确认。
  const beginGenerationFlow = async () => {
    openGenerationDialog();
  };

  const generateOutline = async () => {
    const lockMessage = getMutationLockMessage();
    if (lockMessage) {
      throw new Error(lockMessage);
    }
    if (!projectOverview || !techRequirements) {
      showToast('请先完成招标文件解析', 'info');
      return;
    }

    if (outlineData?.outline?.length) {
      const ok = await confirmOutlineAction({
        title: '确认重新生成目录',
        description: '重新生成将清除当前目录及全部正文内容，并根据新配置重新生成。此操作不可撤销，是否继续？',
        confirmText: '重新生成',
      });
      if (!ok) {
        return;
      }
    }

    const nextOutlineExpansionMode = isExpansionWorkflow ? draftOutlineExpansionMode : 'ai-complement';
    onOutlineConfigChange({
      referenceKnowledgeDocumentIds: draftKnowledgeDocumentIds,
      outlineMode: currentOutlineMode,
      outlineExpansionMode: nextOutlineExpansionMode,
      mirrorProcurementEnabled: draftMirrorProcurement,
      outlineWordControlOptions: liveWordControlOptions,
    });
    setGenerationDialogOpen(false);
    await startOutlineTask();
  };

  const startOutlineTask = async () => {
    const lockMessage = getMutationLockMessage();
    if (lockMessage) {
      showToast(lockMessage, 'info');
      return;
    }
    try {
      const startedNow = Date.now();
      setStartingOutline(true);
      setLocalStartAt(startedNow);
      setNowTick(startedNow);
      const nextOutlineExpansionMode = isExpansionWorkflow ? draftOutlineExpansionMode : 'ai-complement';
      await window.yibiao?.tasks.startOutlineGeneration({
        outline_mode: currentOutlineMode,
        reference_knowledge_document_ids: draftKnowledgeDocumentIds,
        outline_expansion_mode: nextOutlineExpansionMode,
        mirror_procurement: draftMirrorProcurement,
        outline_word_control_options: liveWordControlOptions,
        debug_force_outline_agent_repair: developerMode && user?.role === 'admin' && draftForceOutlineAgentRepair,
      });
      showToast('目录生成任务已在后台启动', 'success');
    } catch (error) {
      setStartingOutline(false);
      setLocalStartAt(null);
      showToast(error instanceof Error ? error.message : '启动目录生成任务失败', 'error');
    }
  };

  const getMutationLockMessage = () => {
    if (generating) return '目录生成任务正在运行，当前目录暂不可编辑';
    if (contentMutationLocked) return '正文生成任务正在运行或暂停中，请结束后再调整目录';
    return '';
  };

  const saveOutlineChange = async (outline: OutlineItem[], reason: SaveOutlineRequest['reason'], affectedNodeIds: string[] = []) => {
    if (!outlineData) {
      return;
    }
    const lockMessage = getMutationLockMessage();
    if (lockMessage) {
      showToast(lockMessage, 'info');
      return;
    }

    const renumbered = renumberOutlineItemsWithIdMap(outline);
    await onOutlineSaved({
      outlineData: { ...outlineData, outline: renumbered.outline },
      reason,
      idMap: renumbered.idMap,
      affectedNodeIds,
    });
  };

  const startEditing = (item: OutlineItem) => {
    if (sorting || outlineMutationLocked) {
      return;
    }
    setSelectedItemId(item.id);
    setEditingItemId(item.id);
    setEditTitle(item.title);
    setEditDescription(item.description);
  };

  const saveEditing = async () => {
    if (!outlineData || !editingItemId || sorting || outlineMutationLocked) {
      return;
    }

    const existingItem = findOutlineItem(outlineData.outline, editingItemId);
    if (existingItem?.content?.trim()) {
      const ok = await confirmOutlineAction({
        title: '确认修改目录项',
        description: '修改后该章节正文将被清除，需在正文生成环节重新生成。其他章节不受影响。',
        confirmText: '确认修改',
      });
      if (!ok) {
        return;
      }
    }

    try {
      await saveOutlineChange(updateOutlineItem(outlineData.outline, editingItemId, (item) => ({
        ...item,
        title: editTitle.trim() || item.title,
        description: editDescription.trim(),
      })), 'edit', [editingItemId]);
      setEditingItemId(null);
      showToast('目录项已更新，相关正文已清空', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '保存目录项失败', 'error');
    }
  };

  const addRootItem = async () => {
    if (!outlineData || sorting || outlineMutationLocked) {
      return;
    }

    const newItem: OutlineItem = {
      id: `${outlineData.outline.length + 1}`,
      title: '新目录项',
      description: '请编辑描述',
    };
    try {
      await saveOutlineChange([...outlineData.outline, newItem], 'add-root');
      setSelectedItemId(newItem.id);
      setEditingItemId(newItem.id);
      setEditTitle(newItem.title);
      setEditDescription(newItem.description);
      showToast('一级目录已添加', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '添加一级目录失败', 'error');
    }
  };

  const addChildItem = async (parentId: string) => {
    if (!outlineData || sorting || outlineMutationLocked) {
      return;
    }

    const parent = findOutlineItem(outlineData.outline, parentId);
    const nextIndex = (parent?.children?.length || 0) + 1;
    const newItem: OutlineItem = {
      id: `${parentId}.${nextIndex}`,
      title: '新目录项',
      description: '请编辑描述',
    };

    try {
      await saveOutlineChange(updateOutlineItem(outlineData.outline, parentId, (item) => ({
        ...item,
        children: [...(item.children || []), newItem],
      })), 'add-child', [parentId]);
      setExpandedItems((prev) => new Set(prev).add(parentId));
      setSelectedItemId(newItem.id);
      setEditingItemId(newItem.id);
      setEditTitle(newItem.title);
      setEditDescription(newItem.description);
      showToast('子目录已添加，父目录正文已清空', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '添加子目录失败', 'error');
    }
  };

  const removeItem = async (itemId: string) => {
    if (!outlineData || sorting || outlineMutationLocked) {
      return;
    }
    const removedItem = findOutlineItem(outlineData.outline, itemId);
    const removedIds = removedItem ? [...collectOutlineIds([removedItem])] : [itemId];
    if (removedItem && subtreeHasContent(removedItem)) {
      const ok = await confirmOutlineAction({
        title: '确认删除目录项',
        description: '删除将移除该章节及其全部子项与正文内容，且不可恢复。是否继续？',
        confirmText: '确认删除',
      });
      if (!ok) {
        return;
      }
    }
    try {
      const nextOutline = deleteOutlineItem(outlineData.outline, itemId);
      if (!nextOutline.length) {
        showToast('至少保留一个目录项', 'info');
        return;
      }
      await saveOutlineChange(nextOutline, 'delete', removedIds);
      setSelectedItemId(null);
      showToast('目录项已删除', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '删除目录项失败', 'error');
    }
  };

  const toggleExpanded = (itemId: string) => {
    setExpandedItems((prev) => {
      const next = new Set(prev);
      if (next.has(itemId)) {
        next.delete(itemId);
      } else {
        next.add(itemId);
      }
      return next;
    });
  };

  const expandAllItems = () => {
    if (activeOutlineData?.outline?.length) {
      setExpandedItems(collectOutlineIds(activeOutlineData.outline));
    }
  };

  const collapseAllItems = () => {
    setExpandedItems(new Set());
  };

  const startSorting = () => {
    if (!outlineData?.outline?.length) {
      return;
    }
    const lockMessage = getMutationLockMessage();
    if (lockMessage) {
      showToast(lockMessage, 'info');
      return;
    }

    setDraftOutlineData(outlineData);
    sortIdMapRef.current = createIdentityIdMap(outlineData.outline);
    setSorting(true);
    setSortDirty(false);
    setEditingItemId(null);
    setDraggingItemId(null);
    setDropTarget(null);
    showToast('仅支持同级目录排序；拖动只在前端调整，点击保存排序后才会写入数据库。', 'info');
  };

  const discardSorting = () => {
    setSorting(false);
    setDraftOutlineData(null);
    setSortDirty(false);
    setSavingSort(false);
    setDraggingItemId(null);
    setDropTarget(null);
    sortIdMapRef.current = {};
  };

  const saveSorting = async () => {
    if (!draftOutlineData?.outline?.length) {
      discardSorting();
      return;
    }
    if (!sortDirty) {
      discardSorting();
      return;
    }
    const lockMessage = getMutationLockMessage();
    if (lockMessage) {
      throw new Error(lockMessage);
    }

    setSavingSort(true);
    try {
      await onOutlineSaved({
        outlineData: draftOutlineData,
        reason: 'sort',
        idMap: sortIdMapRef.current,
      });
      discardSorting();
      showToast('目录排序已保存', 'success');
    } finally {
      setSavingSort(false);
    }
  };

  useEffect(() => {
    if (!onSortGuardChange) return;
    onSortGuardChange({
      hasUnsavedSort: () => sorting && sortDirty,
      saveSort: saveSorting,
      discardSort: discardSorting,
    });
    return () => onSortGuardChange(null);
  }, [onSortGuardChange, sorting, sortDirty, draftOutlineData]);

  const getDropPosition = (event: DragEvent<HTMLElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return event.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
  };

  const canDropOnTarget = (draggedId: string, targetId: string) => {
    if (!activeOutlineData?.outline?.length || draggedId === targetId) return false;
    const dragged = findOutlineLocation(activeOutlineData.outline, draggedId);
    const target = findOutlineLocation(activeOutlineData.outline, targetId);
    return Boolean(dragged && target && dragged.parentId === target.parentId && dragged.level === target.level);
  };

  const handleDragStart = (event: DragEvent<HTMLDivElement>, item: OutlineItem) => {
    if (!sorting) {
      return;
    }
    setDraggingItemId(item.id);
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', item.id);
  };

  const handleDragOver = (event: DragEvent<HTMLDivElement>, item: OutlineItem) => {
    if (!sorting || !draggingItemId) {
      return;
    }
    event.preventDefault();
    const valid = canDropOnTarget(draggingItemId, item.id);
    event.dataTransfer.dropEffect = valid ? 'move' : 'none';
    setDropTarget({ itemId: item.id, position: getDropPosition(event), valid });
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>, item: OutlineItem) => {
    event.preventDefault();
    if (!sorting || !draftOutlineData?.outline?.length || !draggingItemId) {
      return;
    }

    const valid = canDropOnTarget(draggingItemId, item.id);
    if (!valid) {
      setDraggingItemId(null);
      setDropTarget(null);
      showToast('只能同级目录排序', 'info');
      return;
    }

    const sourceLocation = findOutlineLocation(draftOutlineData.outline, draggingItemId);
    if (!sourceLocation) {
      setDraggingItemId(null);
      setDropTarget(null);
      return;
    }

    const position = dropTarget?.itemId === item.id ? dropTarget.position : getDropPosition(event);
    const reordered = reorderOutlineSiblings(draftOutlineData.outline, sourceLocation.parentId, draggingItemId, item.id, position);
    const renumbered = renumberOutlineItemsWithIdMap(reordered);
    sortIdMapRef.current = composeIdMap(sortIdMapRef.current, renumbered.idMap);
    setDraftOutlineData({ ...draftOutlineData, outline: renumbered.outline });
    setExpandedItems((prev) => new Set([...prev].map((id) => renumbered.idMap[id] || id)));
    setSelectedItemId((prev) => (prev ? renumbered.idMap[prev] || prev : prev));
    setSortDirty(true);
    setDraggingItemId(null);
    setDropTarget(null);
  };

  const handleDragEnd = () => {
    setDraggingItemId(null);
    setDropTarget(null);
  };

  const renderItem = (item: OutlineItem, level = 0) => {
    const hasChildren = Boolean(item.children?.length);
    const isExpanded = expandedItems.has(item.id);
    const isActive = selectedItemId === item.id;
    const isDragging = draggingItemId === item.id;
    const isDropTarget = dropTarget?.itemId === item.id;
    const dropClass = isDropTarget
      ? dropTarget.valid
        ? ` is-drop-${dropTarget.position}`
        : ' is-drop-invalid'
      : '';

    return (
      <div className="outline-tree-node" key={item.id} style={{ '--outline-level': level } as CSSProperties}>
        <div
          className={`outline-tree-item${isActive ? ' is-active' : ''}${sorting ? ' is-sorting' : ''}${isDragging ? ' is-dragging' : ''}${dropClass}`}
          draggable={sorting}
          onDragStart={(event) => handleDragStart(event, item)}
          onDragOver={(event) => handleDragOver(event, item)}
          onDrop={(event) => handleDrop(event, item)}
          onDragEnd={handleDragEnd}
        >
          {sorting && <span className="outline-tree-drag-handle" aria-hidden="true">⋮⋮</span>}
          <button
            type="button"
            className={`outline-tree-toggle${hasChildren ? '' : ' is-leaf'}${isExpanded ? ' is-expanded' : ''}`}
            onClick={() => hasChildren && toggleExpanded(item.id)}
            disabled={!hasChildren}
            aria-label={hasChildren ? `${isExpanded ? '折叠' : '展开'} ${item.title}` : `${item.title} 无子目录`}
          >
            {hasChildren ? '›' : '•'}
          </button>
          <button
            type="button"
            className="outline-tree-content"
            onClick={() => setSelectedItemId(item.id)}
            onDoubleClick={() => hasChildren && toggleExpanded(item.id)}
          >
            <strong>{formatOutlineTitle(item.id, item.title, exportFormat.headings[Math.min(item.id.split('.').length - 1, 5)])}</strong>
          </button>
        </div>
        {hasChildren && isExpanded && item.children?.map((child) => renderItem(child, level + 1))}
      </div>
    );
  };

  const renderOutlineExpansionModePicker = () => {
    if (!isExpansionWorkflow) {
      return null;
    }

    return (
      <section className="outline-generation-config-section outline-expansion-mode-section">
        <div className="outline-generation-config-head">
          <strong>原方案目录使用方式</strong>
          <span>{outlineExpansionModeLabels[draftOutlineExpansionMode]}</span>
        </div>
        <div className="outline-expansion-mode-switch">
          {outlineExpansionModeOptions.map((option) => {
            const selected = draftOutlineExpansionMode === option.value;
            return (
              <button
                type="button"
                className={`outline-expansion-mode-option${selected ? ' is-selected' : ''}`}
                key={option.value}
                onClick={() => setDraftOutlineExpansionMode(option.value)}
                disabled={generating}
                aria-pressed={selected}
              >
                <strong>{option.title}</strong>
                <span>{option.description}</span>
              </button>
            );
          })}
        </div>
      </section>
    );
  };

  return (
    <div className="plan-step-body outline-generation-page">
      <section className="outline-command-bar">
        <div>
          <span className="section-kicker">STEP 03</span>
          <strong>目录生成</strong>
          <p>{isExpansionWorkflow ? `当前原方案目录使用方式：${outlineExpansionModeLabels[outlineExpansionMode]}。` : '从上一步进入后自动开始目录生成；如需调整全文字数等配置，点击右上角设置。'}</p>
        </div>
        <div className="outline-command-actions">
          <button
            type="button"
            className="outline-config-action"
            onClick={() => { void beginGenerationFlow(); }}
            disabled={generating || sorting || contentMutationLocked || !projectOverview || !techRequirements}
            aria-label="生成目录"
            title="生成目录"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <path d="M12 15.5A3.5 3.5 0 1 0 12 8a3.5 3.5 0 0 0 0 7.5Z" />
              <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.05.05a2 2 0 0 1-2.83 2.83l-.05-.05a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.04 1.56V21a2 2 0 0 1-4 0v-.08a1.7 1.7 0 0 0-1.04-1.56 1.7 1.7 0 0 0-1.87.34l-.05.05a2 2 0 0 1-2.83-2.83l.05-.05A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.56-1.04H3a2 2 0 0 1 0-4h.08A1.7 1.7 0 0 0 4.6 8.93a1.7 1.7 0 0 0-.34-1.87l-.05-.05a2 2 0 0 1 2.83-2.83l.05.05a1.7 1.7 0 0 0 1.87.34A1.7 1.7 0 0 0 10 3.01V3a2 2 0 0 1 4 0v.08a1.7 1.7 0 0 0 1.04 1.56 1.7 1.7 0 0 0 1.87-.34l.05-.05a2 2 0 0 1 2.83 2.83l-.05.05a1.7 1.7 0 0 0-.34 1.87 1.7 1.7 0 0 0 1.56 1.04H21a2 2 0 0 1 0 4h-.08A1.7 1.7 0 0 0 19.4 15Z" />
            </svg>
          </button>
        </div>
      </section>

      <section className="outline-generation-workspace">
        <aside className="outline-progress-panel">
          <div className="analysis-result-head">
            <strong>生成过程</strong>
            <span>{statusText}</span>
          </div>
          <div className={`content-outline-stats outline-progress-summary${progressCollapsed ? ' is-collapsed' : ''}`}>
            <button type="button" onClick={() => setProgressCollapsed((prev) => !prev)} aria-expanded={!progressCollapsed}>
              <span>生成进度</span>
              <strong>{progress}%</strong>
              <em>{progressCollapsed ? '展开' : '折叠'}</em>
            </button>
            {!progressCollapsed && (
              <div className="content-outline-stats-body">
                <div className="content-generation-progress-track" aria-label={`目录生成进度 ${progress}%`}>
                  <span style={{ width: `${progress}%` }} />
                </div>
                <p>{statusMessage}</p>
                {(elapsedText || staleText) && (
                  <div className="outline-progress-meta">
                    {elapsedText && <span>{elapsedText}</span>}
                    {staleText && <span>{staleText}</span>}
                  </div>
                )}
                {taskFailed && <small>{task?.error || latestLog || '目录生成失败'}</small>}
              </div>
            )}
          </div>
          <div className="outline-progress-log" ref={logListRef}>
            {progressLogs.length ? progressLogs.map((item, index) => (
              <p className={index === progressLogs.length - 1 ? 'is-latest' : ''} key={`${item}-${index}`}>{item}</p>
            )) : <p>等待生成任务启动。</p>}
          </div>
        </aside>

        <section className="outline-tree-panel">
          <div className="analysis-result-head outline-tree-head">
            <div>
              <strong>目录结构</strong>
              <span>{activeOutlineData?.outline?.length || 0} 个一级目录{sorting ? ' · 排序中' : ''}</span>
            </div>
            <div className="outline-tree-tools">
              {sorting ? (
                <>
                  <button type="button" className="outline-save-sort-action" onClick={() => { void saveSorting().catch((error) => showToast(error instanceof Error ? error.message : '保存排序失败', 'error')); }} disabled={savingSort}>
                    {savingSort ? '正在保存...' : '保存排序'}
                  </button>
                  <button type="button" onClick={expandAllItems} disabled={!activeOutlineData?.outline?.length}>全部展开</button>
                  <button type="button" onClick={collapseAllItems} disabled={!activeOutlineData?.outline?.length}>全部折叠</button>
                </>
              ) : (
                <>
                {outlineData && (
                <button type="button" className="outline-add-root-action" onClick={() => { void addRootItem(); }} disabled={outlineMutationLocked}>
                  添加一级目录
                </button>
                )}
                {outlineData && (
                  <button type="button" onClick={startSorting} disabled={outlineMutationLocked || !outlineData?.outline?.length}>目录排序</button>
                )}
                <button type="button" onClick={expandAllItems} disabled={!activeOutlineData?.outline?.length}>全部展开</button>
                <button type="button" onClick={collapseAllItems} disabled={!activeOutlineData?.outline?.length}>全部折叠</button>
                </>
              )}
            </div>
          </div>
          {activeOutlineData?.outline?.length ? (
            <div className={`outline-tree-list${sorting ? ' is-sorting' : ''}`}>
              {activeOutlineData.outline.map((item) => renderItem(item))}
            </div>
          ) : (
            <div className="markdown-empty-state outline-empty-state">
              <strong>尚未生成目录</strong>
              <p>先完成招标文件解析，再生成技术方案目录。</p>
            </div>
          )}
        </section>

        <aside className="outline-detail-panel">
          <div className="analysis-result-head">
            <div>
              <strong>目录项详情</strong>
              <span>{selectedItem ? selectedItem.id : '未选择'}</span>
            </div>
          </div>
          {selectedItem ? (
            <div className="outline-detail-body">
              {(generating || contentMutationLocked || sorting) && (
                <div className="outline-detail-lock">
                  {sorting
                    ? '目录排序中，当前目录暂不可编辑。'
                    : contentMutationLocked
                      ? '正文生成任务正在运行或暂停中，当前目录暂不可编辑。'
                      : '目录生成任务正在运行，当前目录暂不可编辑，避免覆盖后台生成结果。'}
                </div>
              )}
              {editingItemId === selectedItem.id ? (
                <>
                  <label>
                    <span>标题</span>
                    <input value={editTitle} onChange={(event) => setEditTitle(event.target.value)} disabled={outlineMutationLocked || sorting} />
                  </label>
                  <label>
                    <span>描述</span>
                    <textarea value={editDescription} onChange={(event) => setEditDescription(event.target.value)} disabled={outlineMutationLocked || sorting} />
                  </label>
                  <div className="outline-detail-actions">
                    <button type="button" className="primary-action" onClick={() => { void saveEditing(); }} disabled={outlineMutationLocked || sorting}>保存</button>
                    <button type="button" className="secondary-action" onClick={() => setEditingItemId(null)}>取消</button>
                  </div>
                </>
              ) : (
                <>
                  <h3>{selectedItem.title}</h3>
                  <p>{selectedItem.description || '无描述'}</p>
                  {selectedItem.isMirror && (
                    <div className="outline-content-mode-badge">
                      <span>镜像搬运</span>
                      <small>跳过正文 LLM，逐字搬运招标采购需求原文。</small>
                    </div>
                  )}
                  {selectedItem.source_requirement_title && <small>来源评分项：{selectedItem.source_requirement_title}</small>}
                  <div className="outline-detail-actions">
                    <button type="button" className="primary-action" onClick={() => startEditing(selectedItem)} disabled={outlineMutationLocked || sorting}>编辑</button>
                    <button type="button" className="secondary-action" onClick={() => { void addChildItem(selectedItem.id); }} disabled={outlineMutationLocked || sorting}>添加子目录</button>
                    <button type="button" className="danger-action" onClick={() => { void removeItem(selectedItem.id); }} disabled={outlineMutationLocked || sorting}>删除</button>
                  </div>
                </>
              )}
            </div>
          ) : (
            <div className="markdown-empty-state outline-empty-state">
              <strong>选择一个目录项</strong>
              <p>在左侧目录树中选择章节后，可查看并编辑标题和描述。</p>
            </div>
          )}
        </aside>
      </section>

      <Dialog.Root open={generationDialogOpen} onOpenChange={setGenerationDialogOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="content-regenerate-modal" />
          <Dialog.Content className="outline-generation-config-card">
            <Dialog.Title className="sr-only">{outlineData ? '重新生成目录' : '生成目录'}</Dialog.Title>
            <Dialog.Description className="sr-only">拖动设置全文字数预设，点击「保存并生成」自动开始生成。</Dialog.Description>

            <div className="outline-generation-config-head">
              <strong>{outlineData ? '重新生成目录' : '生成目录'}</strong>
              <span>拖动设置全文字数预设，保存后自动开始生成。</span>
            </div>
            <div className={`outline-generation-config-body${isExpansionWorkflow ? ' has-expansion-mode' : ''}${developerMode ? ' has-dev-tools' : ''}`}>
              <div className="outline-generation-config-left">
                <section className="outline-generation-config-section outline-word-preset-section" aria-label="全文字数预设">
                  <div className="outline-word-preset-head">
                    <div className="outline-word-preset-info">
                      <strong>全文字数/页数预设</strong>
                      <span>拖动滑块或直接输入目标字数（可超过 10 万）；最多自动按 1.2 倍上浮，0 表示不控制。</span>
                    </div>
                    <label className="outline-word-preset-input">
                      <input
                        type="number"
                        min={0}
                        step={WORD_PRESET_SLIDER_STEP}
                        value={wordPresetInput}
                        onChange={(event) => commitWordPresetInput(event.target.value, false)}
                        onBlur={(event) => commitWordPresetInput(event.target.value, true)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') {
                            event.currentTarget.blur();
                          }
                        }}
                        disabled={generating}
                        aria-label="全文字数（万字）"
                      />
                      <span>万字</span>
                    </label>
                  </div>
                  <div className="outline-word-preset-slider">
                    <input
                      type="range"
                      min={0}
                      max={WORD_PRESET_SLIDER_MAX_WAN}
                      step={WORD_PRESET_SLIDER_STEP}
                      value={Math.min(wordPresetSliderValue(liveWordControlOptions), WORD_PRESET_SLIDER_MAX_WAN)}
                      onChange={(event) => {
                        const wan = Number(event.target.value);
                        handleWordPresetChange(wan);
                        setWordPresetInput(String(roundWan(wan)));
                      }}
                      disabled={generating}
                      aria-label="全文字数滑块（万字）"
                    />
                    <div className="outline-word-preset-scale" aria-hidden="true">
                      <span>不控制</span>
                      <span>5 万</span>
                      <span>10 万</span>
                    </div>
                  </div>
                  {wordPresetSliderValue(liveWordControlOptions) > 0 ? (
                    <p className="outline-word-preset-summary">
                      最少 {liveWordControlOptions.minWordsWan} 万字 · 最多 {liveWordControlOptions.maxWordsWan} 万字 · 约 {Math.max(1, Math.round((liveWordControlOptions.minWordsWan * 10000) / 500))} 页起（按 500 字/页粗估）
                    </p>
                  ) : (
                    <p className="outline-word-preset-summary">不控制全文字数，由 AI 按招标文件规模自行决定。</p>
                  )}
                  <div className="outline-word-preset-section-words">
                    <label className="outline-word-preset-section-input">
                      <span>每小节字数（万）</span>
                      <input
                        type="number"
                        min={0}
                        step={0.05}
                        value={liveWordControlOptions.wordsPerSectionWan}
                        onChange={(event) => setLiveWordControlOptions((prev) => ({ ...prev, wordsPerSectionWan: normalizeWordWan(event.target.value) }))}
                        disabled={generating}
                        aria-label="每小节字数（万）"
                      />
                    </label>
                    <label className="outline-v2-force-section-words">
                      <span>
                        <strong>强控小节字数</strong>
                        <small>开启后优先控制每小节字数；未开启时仅控制总字数。</small>
                      </span>
                      <span className="yb-switch-control">
                        <input
                          type="checkbox"
                          checked={liveWordControlOptions.forceSectionWords}
                          onChange={(event) => setLiveWordControlOptions((prev) => ({ ...prev, forceSectionWords: event.target.checked }))}
                          disabled={generating}
                        />
                        <span className="yb-switch-track" aria-hidden="true">
                          <span className="yb-switch-thumb" />
                        </span>
                      </span>
                    </label>
                  </div>
                </section>
                {renderOutlineExpansionModePicker()}
                <section className="outline-generation-config-section outline-mirror-procurement-section">
                  <div className="outline-mirror-procurement-row">
                    <div className="outline-mirror-procurement-info">
                      <strong>生成「项目概述」镜像章</strong>
                      <span>镜像招标「采购需求」原文作为「项目概述」独立顶级章节；关闭则仅按评分矩阵生成目录。</span>
                    </div>
                    <label className="yb-switch-control">
                      <input
                        type="checkbox"
                        checked={draftMirrorProcurement}
                        onChange={(event) => setDraftMirrorProcurement(event.target.checked)}
                      />
                      <span className="yb-switch-track" aria-hidden="true">
                        <span className="yb-switch-thumb" />
                      </span>
                    </label>
                  </div>
                </section>
                {developerMode && user?.role === 'admin' && (
                  <section className="outline-generation-config-section outline-agent-debug-section">
                    <label className="outline-agent-debug-option">
                      <span>
                        <strong>强制 Agent 修复目录</strong>
                        <small>本次目录生成会在最终保存前强制进入 OpenCode Agent 修复链路，用于验证 Agent workspace、结果 JSON 和程序校验。</small>
                      </span>
                      <span className="yb-switch-control">
                        <input
                          type="checkbox"
                          checked={draftForceOutlineAgentRepair}
                          onChange={(event) => setDraftForceOutlineAgentRepair(event.target.checked)}
                        />
                        <span className="yb-switch-track" aria-hidden="true">
                          <span className="yb-switch-thumb" />
                        </span>
                      </span>
                    </label>
                  </section>
                )}
              </div>
            </div>

            <div className="content-regenerate-actions">
              <Dialog.Close className="secondary-action" type="button">取消</Dialog.Close>
              <button type="button" className="primary-action" onClick={generateOutline} disabled={startingOutline || generating || contentMutationLocked || !projectOverview || !techRequirements}>
                {startingOutline || generating ? '正在启动生成...' : '保存并生成'}
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      {outlineConfirmDialog}
    </div>
  );
}

export default OutlineEditPage;


