// 仪表盘：项目统计卡片 + 项目列表（搜索/筛选/新建/查看/删除）。对标 92 Dashboard.vue。
// 视觉沿用应用设计令牌与既有面板/表格/弹窗词汇，不再使用内联深色样式。
import { useMemo, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchProjectStats, deleteProject, updateProject, type Project } from '../../../shared/api/projects';
import { fetchProjectTimeline, type ProjectTimeline, type ProjectTimelineStep } from '../../../shared/api/analytics';
import { useProject } from '../../../app/ProjectContext';
import { useAuth } from '../../../shared/api/auth';
import { useToast } from '../../../shared/ui';
import { markPendingAutoUpload } from '../../technical-plan/autoUpload';
import BlockCreateProjectDialog from '../../../components/BlockCreateProjectDialog';
import type { SectionId } from '../../../shared/types/navigation';

interface DashboardPageProps {
  onSectionChange: (section: SectionId) => void;
}

const STATUS_META: Record<string, { label: string; color: string }> = {
  draft: { label: '草稿', color: '#98a2b3' },
  active: { label: '进行中', color: '#2174fd' },
  submitted: { label: '已提交', color: '#5b54d3' },
  completed: { label: '已完成', color: '#168a4a' },
};

// 类别徽标：与状态列同款 pill（span 内联徽标，而非 td 背景）。
// 「生成技术方案」显示「生成」，「已有方案扩写」显示「扩写」；workflowKind 缺省的老项目归「生成」。
const WORKFLOW_KIND_META: Record<string, { label: string; color: string }> = {
  'technical-plan': { label: '生成', color: '#2174fd' },
  'existing-plan-expansion': { label: '扩写', color: '#b45309' },
};

function workflowKindMeta(kind: string | null | undefined): { label: string; color: string } {
  return WORKFLOW_KIND_META[kind ?? ''] ?? WORKFLOW_KIND_META['technical-plan'];
}

function formatDate(iso: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function formatDateTime(iso: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

function formatDuration(ms: number | null): string {
  if (ms == null || !Number.isFinite(ms)) return '—';
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds} 秒`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return seconds ? `${minutes} 分 ${seconds} 秒` : `${minutes} 分`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return restMinutes ? `${hours} 小时 ${restMinutes} 分` : `${hours} 小时`;
}

function formatTokenCount(value: number | null | undefined): string {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return '—';
  return Math.round(num).toLocaleString('zh-CN');
}

const TIMELINE_STATUS_META: Record<string, { label: string; color: string }> = {
  done: { label: '已完成', color: '#168a4a' },
  success: { label: '已完成', color: '#168a4a' },
  running: { label: '进行中', color: '#2174fd' },
  pending: { label: '未开始', color: '#98a2b3' },
  error: { label: '失败', color: '#d92d20' },
  paused: { label: '已暂停', color: '#b45309' },
  pausing: { label: '暂停中', color: '#b45309' },
};

function timelineStatusMeta(status: string): { label: string; color: string } {
  return TIMELINE_STATUS_META[status] ?? { label: status || '未知', color: '#98a2b3' };
}

function DashboardPage({ onSectionChange }: DashboardPageProps) {
  const { projects, switchTo, createAndSwitch } = useProject();
  const { user } = useAuth();
  const { showToast } = useToast();
  const qc = useQueryClient();
  const { data: stats } = useQuery({ queryKey: ['projects', 'stats'], queryFn: fetchProjectStats });

  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [showCreate, setShowCreate] = useState(false);
  const [blockProject, setBlockProject] = useState<Project | null>(null);
  const [blockBusy, setBlockBusy] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editingName, setEditingName] = useState('');
  const [timelineProject, setTimelineProject] = useState<Project | null>(null);
  const [timeline, setTimeline] = useState<ProjectTimeline | null>(null);
  const [timelineLoading, setTimelineLoading] = useState(false);
  const [timelineError, setTimelineError] = useState('');

  const openTimeline = async (project: Project) => {
    setTimelineProject(project);
    setTimeline(null);
    setTimelineError('');
    setTimelineLoading(true);
    try {
      setTimeline(await fetchProjectTimeline(project.id));
    } catch (error) {
      setTimelineError(error instanceof Error ? error.message : '读取步骤耗时失败');
    } finally {
      setTimelineLoading(false);
    }
  };

  const filtered = useMemo(() => {
    const kw = search.trim().toLowerCase();
    return projects.filter((p) => {
      if (statusFilter !== 'all' && p.status !== statusFilter) return false;
      if (!kw) return true;
      return p.name.toLowerCase().includes(kw)
        || p.projectCode.toLowerCase().includes(kw)
        || (p.ownerName || '').toLowerCase().includes(kw);
    });
  }, [projects, search, statusFilter]);

  const handleOpen = async (p: Project) => {
    try {
      await switchTo(p.id);
      onSectionChange(p.isComplete ? 'project-summary' : 'technical-plan');
    } catch (err) {
      showToast(`切换失败：${err instanceof Error ? err.message : String(err)}`, 'error');
    }
  };

  // 只有「正在生成方案」的项目才阻止新建：未完成但空闲的项目不拦（第5点原逻辑过宽，2026-10-19 修正）。
  // 管理员豁免；后端 POST 也有同样的守卫兜底。
  const firstGenerating = () => projects.find((p) => p.isGenerating === true) ?? null;

  // "上传招标文件"直达流：直接创建项目（服务端以项目编号占位命名），跳转 STEP01 上传；
  // 目录生成完成后服务端会用解析出的项目名称自动回填（没提取到则保持编号）。
  const handleQuickUpload = async () => {
    if (user?.role !== 'admin') {
      const generating = firstGenerating();
      if (generating) {
        setBlockProject(generating);
        return;
      }
    }
    try {
      const created = await createAndSwitch('', '');
      await qc.invalidateQueries({ queryKey: ['projects', 'stats'] });
      // 直达流：进入 STEP01 后自动弹出文件选择窗口，无需再点一次"上传"
      markPendingAutoUpload();
      showToast(`项目 ${created.projectCode} 已创建，请选择招标文件`, 'success');
      onSectionChange('technical-plan');
    } catch (err) {
      // 后端守卫兜底：列表过期/竞态下 POST 仍可能 409，带冲突编号则弹阻断框。
      const ex = err as { response?: { status?: number; data?: { conflictingProjectCode?: string } } };
      if (ex.response?.status === 409 && ex.response.data?.conflictingProjectCode) {
        const conflicting = projects.find((p) => p.projectCode === ex.response!.data!.conflictingProjectCode);
        if (conflicting) {
          setBlockProject(conflicting);
          return;
        }
      }
      showToast(`创建失败：${err instanceof Error ? err.message : String(err)}`, 'error');
    }
  };

  const handleBlockContinue = async () => {
    if (!blockProject) return;
    try {
      await switchTo(blockProject.id);
      setBlockProject(null);
      onSectionChange('technical-plan');
    } catch (err) {
      showToast(`切换失败：${err instanceof Error ? err.message : String(err)}`, 'error');
    }
  };

  const handleBlockDelete = async () => {
    if (!blockProject) return;
    if (!window.confirm(`确认删除未完成项目「${blockProject.name}」？其工作区数据将被清空，此操作不可撤销。`)) return;
    setBlockBusy(true);
    try {
      await deleteProject(blockProject.id);
      await qc.invalidateQueries({ queryKey: ['projects'] });
      await qc.invalidateQueries({ queryKey: ['projects', 'stats'] });
      setBlockProject(null);
      showToast('已删除未完成项目，可继续新建', 'success');
      void handleQuickUpload();
    } catch (err) {
      showToast(`删除失败：${err instanceof Error ? err.message : String(err)}`, 'error');
    } finally {
      setBlockBusy(false);
    }
  };

  const handleDelete = async (p: Project) => {
    if (!window.confirm(`确认删除项目「${p.name}」？其工作区数据将被清空，此操作不可撤销。`)) return;
    try {
      await deleteProject(p.id);
      await qc.invalidateQueries({ queryKey: ['projects'] });
      await qc.invalidateQueries({ queryKey: ['projects', 'stats'] });
      showToast('项目已删除', 'success');
    } catch (err) {
      showToast(`删除失败：${err instanceof Error ? err.message : String(err)}`, 'error');
    }
  };

  const startRename = (p: Project) => {
    setEditingId(p.id);
    setEditingName(p.name);
  };

  const cancelRename = () => {
    setEditingId(null);
    setEditingName('');
  };

  const commitRename = async (p: Project) => {
    const trimmed = editingName.trim();
    if (!trimmed) {
      showToast('项目名称不能为空', 'error');
      setEditingId(null);
      setEditingName('');
      return;
    }
    if (trimmed === p.name) {
      setEditingId(null);
      setEditingName('');
      return;
    }
    try {
      await updateProject(p.id, { name: trimmed });
      await qc.invalidateQueries({ queryKey: ['projects'] });
      await qc.invalidateQueries({ queryKey: ['projects', 'stats'] });
      showToast('项目名称已更新', 'success');
    } catch (err) {
      showToast(`重命名失败：${err instanceof Error ? err.message : String(err)}`, 'error');
    } finally {
      setEditingId(null);
      setEditingName('');
    }
  };

  const cards = [
    { label: '项目总数', value: stats?.total ?? 0, hint: '全部项目' },
    { label: '进行中项目', value: stats?.inProgress ?? 0, hint: '未完成项目（生成中 / 待导出）' },
    { label: '本月新增', value: stats?.thisMonth ?? 0, hint: '本月新建项目' },
    { label: '完成率', value: `${stats?.completionRate ?? 0}%`, hint: '已完成项目占比' },
  ];

  return (
    <div className="dashboard-page">
      <div className="dashboard-shell">
        <header className="dashboard-head">
          <div className="dashboard-head-text">
            <span className="section-kicker">项目仪表盘</span>
            <h2>项目总览与统计</h2>
            <p>查看全部项目、运行中的生成任务与完成进度，新建或进入项目工作区。</p>
          </div>
          <button type="button" className="primary-action" onClick={() => { void handleQuickUpload(); }}>
            + 上传招标文件
          </button>
        </header>

        {/* 统计卡片 */}
        <div className="dashboard-stats">
          {cards.map((c) => (
            <article key={c.label} className="dashboard-stat">
              <span className="dashboard-stat-label">{c.label}</span>
              <span className="dashboard-stat-value">{c.value}</span>
              <span className="dashboard-stat-hint">{c.hint}</span>
            </article>
          ))}
        </div>

        {/* 资质到期提醒卡片已随 DB-04/FE-04 下线（模块待 API-21 整体裁剪） */}

        {/* 工具栏 */}
        <div className="dashboard-toolbar">
          <input
            type="text"
            className="dashboard-input"
            placeholder="搜索项目编号 / 名称 / 创建人"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <select
            className="dashboard-select"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
          >
            <option value="all">全部状态</option>
            <option value="draft">草稿</option>
            <option value="active">进行中</option>
            <option value="submitted">已提交</option>
            <option value="completed">已完成</option>
          </select>
        </div>

        {/* 项目表 */}
        <table className="dashboard-table">
          <thead>
            <tr>
              {/* 管理员看全站项目，需要区分归属；普通用户只看到自己的项目，不显示该列 */}
              {user?.role === 'admin' && <th>创建人</th>}
              <th className="col-code">编号</th>
              <th className="col-kind">类别</th>
              <th>项目名称</th>
              <th className="col-status">状态</th>
              <th>进度</th>
              <th>更新时间</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && (
              <tr>
                <td colSpan={user?.role === 'admin' ? 8 : 7} className="dashboard-empty">
                  {projects.length === 0 ? '暂无项目，点击右上角「新建项目」开始' : '无匹配项目'}
                </td>
              </tr>
            )}
            {filtered.map((p) => {
              const meta = STATUS_META[p.status] ?? STATUS_META.draft;
              return (
                <tr key={p.id}>
                  {user?.role === 'admin' && <td className="col-owner">{p.ownerName || '—'}</td>}
                  <td><code>{p.projectCode}</code></td>
                  <td>
                    <span className="dashboard-pill" style={{ color: workflowKindMeta(p.workflowKind).color, background: `${workflowKindMeta(p.workflowKind).color}1f` }}>
                      {workflowKindMeta(p.workflowKind).label}
                    </span>
                  </td>
                  <td className="col-name">
                    {editingId === p.id ? (
                      <input
                        type="text"
                        className="dashboard-rename-input"
                        value={editingName}
                        autoFocus
                        onChange={(e) => setEditingName(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') { e.preventDefault(); void commitRename(p); }
                          else if (e.key === 'Escape') { e.preventDefault(); cancelRename(); }
                        }}
                        onBlur={() => void commitRename(p)}
                      />
                    ) : (
                      <strong onDoubleClick={() => startRename(p)} title="双击编辑">{p.name}</strong>
                    )}
                    {p.description ? <small>{p.description}</small> : null}
                  </td>
                  <td>
                    <span
                      className="dashboard-pill"
                      style={{ color: meta.color, background: `${meta.color}1f` }}
                    >
                      {meta.label}
                    </span>
                  </td>
                  <td>
                    <div className="dashboard-progress">
                      <span className="dashboard-progress-track">
                        <span
                          className="dashboard-progress-fill"
                          style={{ width: `${p.progress ?? 0}%` }}
                        />
                      </span>
                      <span className="dashboard-progress-value">{p.progress ?? 0}%</span>
                    </div>
                  </td>
                  <td>{formatDate(p.updatedAt)}</td>
                  <td>
                    <div className="dashboard-row-actions">
                      <button type="button" className="text-button" onClick={() => void handleOpen(p)}>查看</button>
                      {user?.role === 'admin' && (
                        <button type="button" className="text-button" onClick={() => void openTimeline(p)}>详细情况</button>
                      )}
                      <button type="button" className="text-button is-danger" onClick={() => void handleDelete(p)}>删除</button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <BlockCreateProjectDialog
        open={!!blockProject}
        conflictingProject={blockProject}
        busy={blockBusy}
        onContinue={() => { void handleBlockContinue(); }}
        onDelete={() => { void handleBlockDelete(); }}
        onCancel={() => setBlockProject(null)}
      />

      <Dialog.Root open={!!timelineProject} onOpenChange={(open) => { if (!open) setTimelineProject(null); }}>
        <Dialog.Portal>
          <Dialog.Overlay className="content-regenerate-modal" />
          <Dialog.Content className="dashboard-timeline-dialog">
            <div className="content-regenerate-card-head">
              <div>
                <span className="section-kicker">项目步骤耗时</span>
                <Dialog.Title>{timelineProject?.name || '项目详细情况'}</Dialog.Title>
                <Dialog.Description>
                  {timelineProject?.projectCode || ''}{timelineProject?.ownerName ? ` · ${timelineProject.ownerName}` : ''}
                  {timelineProject?.createdAt ? ` · 创建于 ${formatDateTime(timelineProject.createdAt)}` : ''}
                </Dialog.Description>
              </div>
              <Dialog.Close className="detail-help-close" type="button" aria-label="关闭详细情况">×</Dialog.Close>
            </div>

            <div className="dashboard-timeline-body">
              {timelineLoading && <p className="dashboard-timeline-empty">正在读取步骤耗时…</p>}
              {timelineError && <p className="dashboard-timeline-error">{timelineError}</p>}
              {timeline && (
                <>
                  <div className="dashboard-timeline-summary">
                    <span>总耗时</span>
                    <strong>{formatDuration(timeline.totalDurationMs)}</strong>
                    <small>创建 → {timeline.project.lastExportedAt ? '最近导出' : '最近更新'}</small>
                  </div>
                  <table className="dashboard-timeline-table">
                    <colgroup>
                      <col className="col-step" />
                      <col className="col-status" />
                      <col className="col-time" />
                      <col className="col-time" />
                      <col className="col-duration" />
                      <col className="col-token" />
                      <col className="col-token" />
                      <col className="col-token" />
                      <col className="col-note" />
                    </colgroup>
                    <thead>
                      <tr>
                        <th>步骤</th>
                        <th>状态</th>
                        <th>开始时间</th>
                        <th>结束时间</th>
                        <th>耗时</th>
                        <th>输入 tok</th>
                        <th>输出 tok</th>
                        <th>合计 tok</th>
                        <th>说明</th>
                      </tr>
                    </thead>
                    <tbody>
                      {timeline.steps.map((step: ProjectTimelineStep) => {
                        const statusMeta = timelineStatusMeta(step.status);
                        return (
                          <tr key={step.key}>
                            <td><strong>{step.label}</strong></td>
                            <td className="dashboard-timeline-status">
                              <span className="dashboard-pill" style={{ color: statusMeta.color, background: `${statusMeta.color}1f` }}>
                                {statusMeta.label}
                              </span>
                            </td>
                            <td className="dashboard-timeline-time">{formatDateTime(step.startAt)}</td>
                            <td className="dashboard-timeline-time">{formatDateTime(step.endAt)}</td>
                            <td className="dashboard-timeline-duration">{formatDuration(step.durationMs)}</td>
                            <td className="dashboard-timeline-token">{formatTokenCount(step.inputTokens)}</td>
                            <td className="dashboard-timeline-token">{formatTokenCount(step.outputTokens)}</td>
                            <td className="dashboard-timeline-token dashboard-timeline-token-strong">{formatTokenCount(step.totalTokens)}</td>
                            <td className="dashboard-timeline-note">{step.note || '—'}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  <div className="dashboard-timeline-token-summary">
                    <span className="dashboard-timeline-token-summary-title">Token 汇总</span>
                    <div><small>调用</small><strong>{timeline.tokens.calls.toLocaleString('zh-CN')} 次</strong></div>
                    <div><small>输入</small><strong>{timeline.tokens.inputTokens.toLocaleString('zh-CN')}</strong></div>
                    <div><small>输出</small><strong>{timeline.tokens.outputTokens.toLocaleString('zh-CN')}</strong></div>
                    <div><small>合计</small><strong>{timeline.tokens.totalTokens.toLocaleString('zh-CN')}</strong></div>
                    {timeline.tokens.unassignedTokens > 0 && (
                      <em>其中 {timeline.tokens.unassignedTokens.toLocaleString('zh-CN')} tokens 未归属到具体步骤</em>
                    )}
                  </div>
                  <p className="dashboard-timeline-hint">
                    耗时按各步骤任务记录的 startedAt / updatedAt 计算；正文生成包含暂停等待时间；导出为最近一次成功导出的时间。
                  </p>
                </>
              )}
            </div>

            <div className="content-regenerate-actions">
              <Dialog.Close className="secondary-action" type="button">关闭</Dialog.Close>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}



export default DashboardPage;
