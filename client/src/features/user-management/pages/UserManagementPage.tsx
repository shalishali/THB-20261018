// 用户管理：编辑账号 + 删除（禁删自己）。注册审批与状态切换已随 SaaS 自助注册模式移除（FE-05）。
// 视觉沿用应用设计令牌与既有面板/表格/弹窗词汇，不再使用内联深色样式。
import * as Dialog from '@radix-ui/react-dialog';
import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  deleteUser,
  fetchUsers,
  updateUser,
  type SystemUser,
  type UserUpdatePatch,
} from '../../../shared/api/users';
import { useAuth } from '../../../shared/api/auth';
import { useToast } from '../../../shared/ui';
import { formatQuotaChars } from '../../../shared/api/quota';
import QuotaAdjustDialog from '../components/QuotaAdjustDialog';
import { ASSIGNABLE_MODULES, GRANTABLE_MODULE_IDS } from '../../../shared/permissions';

const ROLE_LABEL: Record<string, string> = { admin: '管理员', user: '用户' };
const USERS_PAGE_SIZE = 20;
const MODULE_LABEL: Record<string, string> = Object.fromEntries(
  ASSIGNABLE_MODULES.map((m) => [m.id, m.label]),
);

function buildPageNumbers(current: number, total: number): Array<number | 'ellipsis'> {
  if (total <= 7) return Array.from({ length: total }, (_, index) => index + 1);
  const pages = new Set<number>([1, total, current - 1, current, current + 1]);
  const sorted = Array.from(pages).filter((page) => page >= 1 && page <= total).sort((a, b) => a - b);
  const result: Array<number | 'ellipsis'> = [];
  sorted.forEach((page, index) => {
    if (index > 0 && page - sorted[index - 1] > 1) result.push('ellipsis');
    result.push(page);
  });
  return result;
}

function formatDate(iso: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function UserManagementPage() {
  const { user: me } = useAuth();
  const { showToast } = useToast();
  const qc = useQueryClient();
  const [editing, setEditing] = useState<SystemUser | null>(null);
  const [quotaUser, setQuotaUser] = useState<SystemUser | null>(null);
  const [keywordDraft, setKeywordDraft] = useState('');
  const [keyword, setKeyword] = useState('');
  const [roleFilter, setRoleFilter] = useState('');
  const [page, setPage] = useState(1);

  const { data, isLoading } = useQuery({
    queryKey: ['users', page, keyword, roleFilter],
    queryFn: () => fetchUsers({ page, pageSize: USERS_PAGE_SIZE, keyword, role: roleFilter }),
  });

  // 服务端会把页码夹到有效范围（筛选后页数变少），这里同步回本地页码。
  useEffect(() => {
    if (data?.page && data.page !== page) setPage(data.page);
  }, [data?.page, page]);

  const total = data?.total ?? 0;
  const totalPages = data?.totalPages ?? 1;
  const pageNumbers = buildPageNumbers(page, totalPages);

  const applyFilters = () => {
    setPage(1);
    setKeyword(keywordDraft.trim());
  };
  const resetFilters = () => {
    setKeywordDraft('');
    setKeyword('');
    setRoleFilter('');
    setPage(1);
  };

  const invalidate = async () => {
    await qc.invalidateQueries({ queryKey: ['users'] });
  };

  const wrap = async (label: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
      await invalidate();
      showToast(`${label}成功`, 'success');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const anyErr = err as { response?: { data?: { error?: string } } };
      showToast(`${label}失败：${anyErr.response?.data?.error || msg}`, 'error');
    }
  };

  const handleDelete = async (u: SystemUser) => {
    if (!window.confirm(`确认删除账号「${u.displayName || u.phone || u.username}」？此操作不可撤销。`)) return;
    await wrap('删除', () => deleteUser(u.id));
  };

  return (
    <div className="user-mgmt-page">
      <div className="user-mgmt-shell">
        <header className="user-mgmt-head">
          <div className="user-mgmt-head-text">
            <span className="section-kicker">用户管理</span>
            <h2>账号与权限</h2>
            <p>管理账号的角色与模板/格式权限。用户注册即激活，无需人工审批。</p>
          </div>
        </header>

        <div className="user-mgmt-toolbar">
          <div className="user-mgmt-filters">
            <input
              className="user-mgmt-search"
              type="search"
              value={keywordDraft}
              onChange={(event) => setKeywordDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') applyFilters();
              }}
              placeholder="搜索手机号 / 用户名 / 姓名 / 部门"
              aria-label="搜索用户"
            />
            <select
              className="user-mgmt-role-filter"
              value={roleFilter}
              onChange={(event) => {
                setRoleFilter(event.target.value);
                setPage(1);
              }}
              aria-label="按角色筛选"
            >
              <option value="">全部角色</option>
              <option value="admin">管理员</option>
              <option value="user">用户</option>
            </select>
            <button type="button" className="secondary-action" onClick={applyFilters}>查询</button>
            <button type="button" className="secondary-action" onClick={resetFilters}>重置</button>
          </div>
          <span className="user-mgmt-total">共 {total} 个用户</span>
        </div>

        {/* 表 */}
        <table className="user-mgmt-table">
          <thead>
            <tr>
              <th>手机号</th>
              <th>角色</th>
              <th>当前余额</th>
              <th>累计充值</th>
              <th>权限</th>
              <th>创建时间</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {isLoading && (
              <tr><td colSpan={7} className="user-mgmt-empty">加载中…</td></tr>
            )}
            {!isLoading && data?.users.length === 0 && (
              <tr><td colSpan={7} className="user-mgmt-empty">{keyword || roleFilter ? '没有匹配的用户' : '暂无用户'}</td></tr>
            )}
            {data?.users.map((u) => {
              const isSelf = me?.id === u.id;
              return (
                <tr key={u.id}>
                  <td>{u.phone || u.username}</td>
                  <td>{ROLE_LABEL[u.role] ?? u.role}</td>
                  <td className="user-mgmt-quota">
                    <span className="user-mgmt-quota-main">{formatQuotaChars(u.quotaChars)}</span>
                    <span className="user-mgmt-quota-used">已用 {formatQuotaChars(u.quotaUsedChars)}</span>
                  </td>
                  <td>{(u.totalRechargeCents ?? 0) > 0 ? `¥${((u.totalRechargeCents ?? 0) / 100).toFixed(2).replace(/\.00$/, '')}` : '—'}</td>
                  <td className="user-mgmt-perm">
                    {u.role === 'admin'
                      ? '全部'
                      : u.modules.length === 0
                        ? '默认'
                        : u.modules.map((m) => MODULE_LABEL[m] ?? m).join('、')}
                  </td>
                  <td>{formatDate(u.createdAt)}</td>
                  <td>
                    <div className="user-mgmt-row-actions">
                      <button type="button" className="text-button" onClick={() => setQuotaUser(u)}>额度</button>
                      <button type="button" className="text-button" onClick={() => setEditing(u)}>编辑</button>
                      {!isSelf && (
                        <button type="button" className="text-button is-danger" onClick={() => void handleDelete(u)}>删除</button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>

        <div className="user-mgmt-pager">
          <span className="user-mgmt-pager-info">第 {page} / {totalPages} 页 · 每页 {USERS_PAGE_SIZE} 条</span>
          <div className="user-mgmt-pager-actions">
            <button type="button" className="secondary-action" onClick={() => setPage((prev) => Math.max(1, prev - 1))} disabled={page <= 1}>
              上一页
            </button>
            {pageNumbers.map((item, index) => item === 'ellipsis' ? (
              <span className="user-mgmt-pager-ellipsis" key={`ellipsis-${index}`}>…</span>
            ) : (
              <button
                type="button"
                key={item}
                className={`user-mgmt-pager-number${item === page ? ' is-active' : ''}`}
                onClick={() => setPage(item)}
                aria-current={item === page ? 'page' : undefined}
              >
                {item}
              </button>
            ))}
            <button type="button" className="secondary-action" onClick={() => setPage((prev) => Math.min(totalPages, prev + 1))} disabled={page >= totalPages}>
              下一页
            </button>
          </div>
        </div>
      </div>

      <QuotaAdjustDialog
        open={!!quotaUser}
        onOpenChange={(next) => { if (!next) setQuotaUser(null); }}
        user={quotaUser}
        onAdjusted={() => { void invalidate(); }}
      />

      <EditUserModal
        target={editing}
        onClose={() => setEditing(null)}
        onSaved={async () => {
          await invalidate();
          setEditing(null);
          showToast('已保存', 'success');
        }}
        onError={(msg) => showToast(msg, 'error')}
      />
    </div>
  );
}

interface EditUserModalProps {
  target: SystemUser | null;
  onClose: () => void;
  onSaved: () => Promise<void> | void;
  onError: (msg: string) => void;
}

function EditUserModal({ target, onClose, onSaved, onError }: EditUserModalProps) {
  return (
    <Dialog.Root
      open={Boolean(target)}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="content-regenerate-modal" />
        {target ? (
          <EditUserForm key={target.id} target={target} onClose={onClose} onSaved={onSaved} onError={onError} />
        ) : null}
      </Dialog.Portal>
    </Dialog.Root>
  );
}

interface EditUserFormProps {
  target: SystemUser;
  onClose: () => void;
  onSaved: () => Promise<void> | void;
  onError: (msg: string) => void;
}

function EditUserForm({ target, onClose, onSaved, onError }: EditUserFormProps) {
  const [role, setRole] = useState(target.role);
  const [modules, setModules] = useState<string[]>(target.modules ?? []);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);

  const toggleModule = (id: string) => {
    setModules((prev) => (prev.includes(id) ? prev.filter((m) => m !== id) : [...prev, id]));
  };

  const submit = async () => {
    const patch: UserUpdatePatch = {};
    if (role !== target.role) patch.role = role;
    // 角色为管理员时 modules 无意义（管理员拥有全部权限），仅普通用户下发 modules。
    if (role === 'user') {
      const orig = (target.modules ?? []).slice().sort().join(',');
      const next = modules.slice().sort().join(',');
      if (orig !== next) patch.modules = modules;
    }
    if (password) patch.password = password;
    if (Object.keys(patch).length === 0) {
      onError('无待更新字段');
      return;
    }
    setBusy(true);
    try {
      await updateUser(target.id, patch);
      await onSaved();
    } catch (err) {
      const anyErr = err as { response?: { data?: { error?: string } } };
      const msg = err instanceof Error ? err.message : String(err);
      onError(`保存失败：${anyErr.response?.data?.error || msg}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog.Content className="edit-user-dialog">
      <Dialog.Title>编辑账号</Dialog.Title>
      <Dialog.Description className="sr-only">编辑账号的角色、模块权限或重置密码。</Dialog.Description>
      <p className="edit-user-dialog-sub">手机号：{target.phone || target.username}（不可修改）</p>
      <div className="edit-user-dialog-body">
        <label className="user-mgmt-field">
          角色
          <select value={role} onChange={(e) => setRole(e.target.value)}>
            <option value="admin">管理员</option>
            <option value="user">用户</option>
          </select>
        </label>

        <div className="user-mgmt-checkbox-group">
          <span className="user-mgmt-checkbox-title">功能模块权限</span>
          {role === 'admin' ? (
            <p className="user-mgmt-checkbox-hint">管理员拥有全部功能模块权限。</p>
          ) : (
            ASSIGNABLE_MODULES.map((m) => {
              const grantable = (GRANTABLE_MODULE_IDS as string[]).includes(m.id);
              const checked = grantable && modules.includes(m.id);
              return (
                <label
                  key={m.id}
                  className={`user-mgmt-checkbox${grantable ? '' : ' is-disabled'}`}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={!grantable}
                    onChange={() => grantable && toggleModule(m.id)}
                  />
                  {m.label}
                  {!grantable ? <small>（仅管理员）</small> : null}
                </label>
              );
            })
          )}
        </div>

        <label className="user-mgmt-field">
          重置密码（留空不改，至少 8 位）
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" />
        </label>
      </div>
      <div className="user-mgmt-dialog-actions">
        <Dialog.Close asChild>
          <button type="button" className="secondary-action">取消</button>
        </Dialog.Close>
        <button type="button" className="primary-action" onClick={() => void submit()} disabled={busy}>
          {busy ? '保存中…' : '保存'}
        </button>
      </div>
    </Dialog.Content>
  );
}

export default UserManagementPage;
