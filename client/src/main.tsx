import React, { lazy, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { queryClient } from './shared/api/queryClient';
import { AuthProvider, useAuth } from './shared/api/auth';
import { installWebBridge } from './shared/api/bridge';
import LoginPage from './app/LoginPage';
import App from './App';
import AppProviders from './app/providers/AppProviders';
import WorkspaceDatabaseGate from './app/WorkspaceDatabaseGate';
import { ThemeProvider } from './shared/theme/ThemeProvider';
import './styles.css';

// 公开帮助中心独立于登录守卫和业务 App，未登录也能直接打开 /help。
const HelpCenterPage = lazy(() => import('./features/help/pages/HelpCenterPage'));

// Web 版入口：登录守卫 + 真 App。先装 Web 桥接 shim（复刻 window.yibiao 形状，底层走 shared/api + SSE），
// 登录后挂真实 App（AppProviders > WorkspaceDatabaseGate > App），与桌面 Electron 入口同构。
// 桌面专属能力（update / GPU / license / agent）由 bridge 的 no-op stub 降级（见 bridge.ts）。
installWebBridge();

function Root() {
  const { user } = useAuth();
  if (!user) return <LoginPage />;
  return (
    <AppProviders>
      <WorkspaceDatabaseGate>
        <App />
      </WorkspaceDatabaseGate>
    </AppProviders>
  );
}

function isPublicHelpPath() {
  if (typeof window === 'undefined') return false;
  return window.location.pathname.replace(/\/+$/, '') === '/help';
}

function Entry() {
  // 帮助中心不挂 AuthProvider，避免未登录访问时额外请求 /me 或跳回登录页。
  if (isPublicHelpPath()) {
    return (
      <Suspense
        fallback={
          <div className="help-boot" role="status" aria-live="polite">
            <img src="/icon.svg" alt="" />
            <span>帮助中心加载中…</span>
          </div>
        }
      >
        <HelpCenterPage />
      </Suspense>
    );
  }
  return (
    <AuthProvider>
      <Root />
    </AuthProvider>
  );
}

createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <Entry />
      </QueryClientProvider>
    </ThemeProvider>
  </React.StrictMode>
);
