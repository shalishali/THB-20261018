// 应用顶栏：右上角展示字数额度 + 当前用户身份 + 退出按钮。退出走 useAuth().logout（纯客户端，
// main.tsx 的 !user 守卫会自动落回登录页）。顶栏挂在 main-area 顶部，与 sidebar 收起无关。
// 退出前弹 token 风格二次确认框，避免误触。
import { useEffect, useState } from 'react';
import { useAuth } from '../shared/api/auth';
import { useSystemSettings } from '../shared/api/system-settings';
import { applyFavicon } from '../shared/ui/favicon';
import { formatQuotaChars, openQuotaDialog, QUOTA_REFRESH_EVENT } from '../shared/api/quota';
import ConfirmDialog from './ConfirmDialog';
import logoUrl from '../../assets/icon_256.png';

const ROLE_LABEL: Record<string, string> = { admin: '管理员', user: '用户' };

interface AppTopbarProps {
  showThemeToggle?: boolean;
}

function AppTopbar(_props: AppTopbarProps) {
  const { user, logout, refreshUser } = useAuth();
  const { data: systemSettings } = useSystemSettings();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const systemName = systemSettings?.systemName || '投好标';
  const logoSrc = systemSettings?.logoDataUrl || logoUrl;

  // 浏览器标签标题跟随系统名（DB 可配）。未登录态在 LoginPage 同步。
  useEffect(() => {
    document.title = systemName;
  }, [systemName]);

  // Favicon 跟随系统 Logo（DB 可配）：管理员更换 Logo 后浏览器标签图标同步更新。
  useEffect(() => {
    applyFavicon(logoSrc);
  }, [logoSrc]);

  // 导出扣费/充值入账后广播 quota:refresh → 立即拉 /me 更新额度（不等 60s 轮询）。
  useEffect(() => {
    const handler = () => { void refreshUser(); };
    window.addEventListener(QUOTA_REFRESH_EVENT, handler);
    return () => window.removeEventListener(QUOTA_REFRESH_EVENT, handler);
  }, [refreshUser]);

  if (!user) return null;

  const name = user.displayName || user.username;
  const initial = (name || '?').trim().charAt(0).toUpperCase();
  const roleLabel = ROLE_LABEL[user.role] ?? user.role;

  return (
    <header className="app-topbar">
      <div className="app-topbar-brand">
        <img src={logoSrc} alt="" />
        <strong>{systemName}</strong>
      </div>
      <div className="topbar-user">
        <button
          type="button"
          className="topbar-quota"
          onClick={openQuotaDialog}
          title="字数额度：导出 Word 时按正文字数扣减，点击充值"
          aria-label={`字数额度 ${formatQuotaChars(user.quotaChars)}，点击充值`}
        >
          <QuotaIcon />
          <span>额度 {formatQuotaChars(user.quotaChars)}</span>
        </button>
        <span className="topbar-avatar" aria-hidden="true">{initial}</span>
        <span className="topbar-user-meta">
          <strong>{name}</strong>
          <small>{roleLabel}</small>
        </span>
        <button type="button" className="topbar-logout" onClick={() => setConfirmOpen(true)} aria-label="退出登录">
          <LogoutIcon />
          <span>退出</span>
        </button>
      </div>
      <ConfirmDialog
        open={confirmOpen}
        title="确认退出登录？"
        description="退出后需要重新登录才能继续使用。"
        confirmText="退出"
        cancelText="取消"
        onConfirm={() => { logout(); setConfirmOpen(false); }}
        onCancel={() => setConfirmOpen(false)}
      />
    </header>
  );
}

function QuotaIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v10M14.8 9.2c-.5-1-1.6-1.5-2.8-1.5-1.5 0-2.7.8-2.7 2.1 0 2.7 5.4 1.5 5.4 4.2 0 1.3-1.2 2.1-2.7 2.1-1.3 0-2.4-.6-2.9-1.6" />
    </svg>
  );
}

function ThemeIcon({ dark }: { dark: boolean }) {
  return dark ? (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20.2 14.1A8.2 8.2 0 0 1 9.9 3.8 8.2 8.2 0 1 0 20.2 14.1Z" />
      <path d="M16.8 4.8h.01M19.4 8h.01" />
    </svg>
  ) : (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="3.6" />
      <path d="M12 2.8v2M12 19.2v2M2.8 12h2M19.2 12h2M5.5 5.5l1.4 1.4M17.1 17.1l1.4 1.4M18.5 5.5l-1.4 1.4M6.9 17.1l-1.4 1.4" />
    </svg>
  );
}

function LogoutIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M15 17l5-5-5-5" />
      <path d="M20 12H9" />
      <path d="M9 5H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h3" />
    </svg>
  );
}

export default AppTopbar;
