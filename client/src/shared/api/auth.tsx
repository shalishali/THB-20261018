import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { http, publicHttp, TOKEN_KEY, USER_KEY, setActiveProjectId } from './http';
import { sseManager } from './sse';
import { queryClient } from './queryClient';
import {
  isActiveInitialPasswordChangeSession,
  isAuthenticatedResponse,
  isPasswordChangeRequiredResponse,
} from '../auth/initialPasswordRules';

export interface YibiaoUser {
  id: number;
  username: string;
  displayName: string | null;
  role: string;
  phone?: string | null;
  department?: string | null;
  modules?: string[];
  /** 字数额度余额（导出计费）；旧 localStorage 快照可能没有，取值时兜底 0 */
  quotaChars?: number;
}

export interface InitialPasswordChangeState {
  expiresAt: number;
}

export type LoginResult = 'authenticated' | 'password-change-required';
export type SmsPurpose = 'login' | 'reset';

export interface SmsSendResult {
  success: boolean;
  ttlSeconds: number;
  provider: string;
  /** 仅开发环境（SMS_PROVIDER=mock）返回，生产永不下发 */
  devCode?: string;
}

export interface AuthState {
  user: YibiaoUser | null;
  initialPasswordChange: InitialPasswordChangeState | null;
  /** 手机号 + 短信验证码登录（未注册且同意协议时自动建号；邀请码/来源由链接自动采集） */
  loginWithSms: (
    phone: string,
    code: string,
    options?: { agree?: boolean; inviteCode?: string; source?: string },
  ) => Promise<LoginResult>;
  /** 仅限无手机号的遗留账号（初始管理员）使用密码登录 */
  loginWithPassword: (
    username: string,
    password: string,
    captcha: { captchaId: string; captchaCode: string },
  ) => Promise<LoginResult>;
  /** 发送短信验证码（必须带图形验证码） */
  sendSmsCode: (
    phone: string,
    purpose: SmsPurpose,
    captcha: { captchaId: string; captchaCode: string },
  ) => Promise<SmsSendResult>;
  /** 手机号 + 短信验证码重置密码 */
  resetPasswordWithSms: (
    phone: string,
    code: string,
    newPassword: string,
    confirmPassword: string,
  ) => Promise<{ success: boolean; message: string }>;
  changeInitialPassword: (newPassword: string, confirmPassword: string) => Promise<void>;
  clearInitialPasswordChange: () => void;
  logout: () => void;
  refreshUser: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

interface InitialPasswordChangeSession extends InitialPasswordChangeState {
  token: string;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<YibiaoUser | null>(() => {
    const raw = localStorage.getItem(USER_KEY);
    try {
      return raw ? (JSON.parse(raw) as YibiaoUser) : null;
    } catch {
      return null;
    }
  });
  const [initialPasswordChange, setInitialPasswordChange] = useState<InitialPasswordChangeState | null>(null);
  const initialPasswordChangeSessionRef = useRef<InitialPasswordChangeSession | null>(null);
  const initialPasswordChangeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearInitialPasswordChange = useCallback(() => {
    if (initialPasswordChangeTimeoutRef.current) {
      clearTimeout(initialPasswordChangeTimeoutRef.current);
      initialPasswordChangeTimeoutRef.current = null;
    }
    initialPasswordChangeSessionRef.current = null;
    setInitialPasswordChange(null);
  }, []);

  const beginInitialPasswordChange = useCallback((token: string, expiresIn: number) => {
    clearInitialPasswordChange();
    const session: InitialPasswordChangeSession = {
      token,
      expiresAt: Date.now() + expiresIn * 1000,
    };
    initialPasswordChangeSessionRef.current = session;
    setInitialPasswordChange({ expiresAt: session.expiresAt });
    initialPasswordChangeTimeoutRef.current = setTimeout(() => {
      // A previous timer must never clear a newer restricted session.
      if (initialPasswordChangeSessionRef.current !== session) return;
      initialPasswordChangeSessionRef.current = null;
      initialPasswordChangeTimeoutRef.current = null;
      setInitialPasswordChange(null);
    }, Math.max(0, session.expiresAt - Date.now()));
  }, [clearInitialPasswordChange]);

  const completeLogin = useCallback((token: string, authenticatedUser: YibiaoUser) => {
    clearInitialPasswordChange();
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(USER_KEY, JSON.stringify(authenticatedUser));
    setUser(authenticatedUser);
    sseManager.start();
  }, [clearInitialPasswordChange]);

  const handleAuthResponse = useCallback((data: unknown): LoginResult => {
    if (isPasswordChangeRequiredResponse(data)) {
      sseManager.stop();
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(USER_KEY);
      setUser(null);
      beginInitialPasswordChange(data.password_change_token, data.expires_in);
      return 'password-change-required';
    }
    if (!isAuthenticatedResponse(data)) {
      throw new Error('登录响应无效');
    }
    completeLogin(data.token, data.user);
    return 'authenticated';
  }, [beginInitialPasswordChange, completeLogin]);

  // 手机号 + 短信验证码登录（面向普通用户的唯一登录方式）
  const loginWithSms = useCallback(async (
    phone: string,
    code: string,
    options?: { agree?: boolean; inviteCode?: string; source?: string },
  ): Promise<LoginResult> => {
    const { data } = await publicHttp.post<unknown>('/login-sms', {
      phone,
      code,
      agree: options?.agree === true,
      inviteCode: options?.inviteCode || undefined,
      source: options?.source || undefined,
    });
    return handleAuthResponse(data);
  }, [handleAuthResponse]);

  // 管理员兜底：仅无手机号的账号可用（服务端对手机号账号返回 403）
  const loginWithPassword = useCallback(async (
    username: string,
    password: string,
    captcha: { captchaId: string; captchaCode: string },
  ): Promise<LoginResult> => {
    const { data } = await publicHttp.post<unknown>('/login', {
      username,
      password,
      captchaId: captcha.captchaId,
      captchaCode: captcha.captchaCode,
    });
    return handleAuthResponse(data);
  }, [handleAuthResponse]);

  const sendSmsCode = useCallback(async (
    phone: string,
    purpose: SmsPurpose,
    captcha: { captchaId: string; captchaCode: string },
  ): Promise<SmsSendResult> => {
    const { data } = await publicHttp.post<SmsSendResult>('/sms/send', {
      phone,
      purpose,
      captchaId: captcha.captchaId,
      captchaCode: captcha.captchaCode,
    });
    return data;
  }, []);

  const resetPasswordWithSms = useCallback(async (
    phone: string,
    code: string,
    newPassword: string,
    confirmPassword: string,
  ): Promise<{ success: boolean; message: string }> => {
    const { data } = await publicHttp.post<{ success: boolean; message: string }>('/reset-password-sms', {
      phone,
      code,
      newPassword,
      confirmPassword,
    });
    return data;
  }, []);

  const changeInitialPassword = useCallback(async (newPassword: string, confirmPassword: string) => {
    const session = initialPasswordChangeSessionRef.current;
    if (!session || !isActiveInitialPasswordChangeSession(session, initialPasswordChangeSessionRef.current)) {
      clearInitialPasswordChange();
      throw new Error('改密凭证无效或已过期，请重新登录');
    }
    const { data } = await publicHttp.post<unknown>('/change-initial-password', {
      newPassword,
      confirmPassword,
    }, {
      headers: { Authorization: `Bearer ${session.token}` },
    });
    if (!isAuthenticatedResponse(data)) {
      throw new Error('改密响应无效');
    }
    if (!isActiveInitialPasswordChangeSession(session, initialPasswordChangeSessionRef.current)) {
      if (initialPasswordChangeSessionRef.current === session) {
        clearInitialPasswordChange();
      }
      throw new Error('改密凭证无效或已过期，请重新登录');
    }
    completeLogin(data.token, data.user);
  }, [clearInitialPasswordChange, completeLogin]);

  const logout = useCallback(() => {
    sseManager.stop();
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
    // 清掉查询缓存与活跃项目：否则同标签页换号会先显示上一账号数据，
    // 并被 ProjectContext 锁定到他人的 projectId（403 / SSE 连错项目）。
    queryClient.clear();
    setActiveProjectId(null);
    clearInitialPasswordChange();
    setUser(null);
  }, [clearInitialPasswordChange]);

  // 任意 401（token 过期/被吊销）由 http 拦截器广播：这里统一清登录态，不整页刷新。
  useEffect(() => {
    const onExpired = () => logout();
    window.addEventListener('yibiao:auth-expired', onExpired);
    return () => window.removeEventListener('yibiao:auth-expired', onExpired);
  }, [logout]);

  // 拉取当前用户最新信息（权限即时生效）：admin 改 modules / 停用账号后，
  // 前端靠这个把 localStorage 快照刷新——菜单/守卫自动跟上，无需重登。
  // 仅 401/403（token 失效或被停用）触发 logout；网络抖动等其他错静默，下次定时再试。
  const refreshUser = useCallback(async () => {
    try {
      const { data } = await http.get<{ user: YibiaoUser }>('/me');
      localStorage.setItem(USER_KEY, JSON.stringify(data.user));
      setUser(data.user);
    } catch (err) {
      const status = (err as { response?: { status?: number } })?.response?.status;
      if (status === 401 || status === 403) {
        logout();
      }
    }
  }, [logout]);

  // boot 时若已登录（token 在 LS），启动 SSE 总线。
  useEffect(() => {
    if (user) sseManager.start();
  }, [user]);

  useEffect(() => () => {
    if (initialPasswordChangeTimeoutRef.current) {
      clearTimeout(initialPasswordChangeTimeoutRef.current);
    }
  }, []);

  return <AuthContext.Provider value={{
    user,
    initialPasswordChange,
    loginWithSms,
    loginWithPassword,
    sendSmsCode,
    resetPasswordWithSms,
    changeInitialPassword,
    clearInitialPasswordChange,
    logout,
    refreshUser,
  }}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth 必须在 AuthProvider 内使用');
  return ctx;
}

// 图形验证码（API-02）：短信发送前的人机校验，返回 captchaId + 内联 SVG。
export interface CaptchaChallenge {
  captchaId: string;
  /** PNG data URL（image/png;base64,...） */
  image: string;
}

export async function fetchCaptcha(): Promise<CaptchaChallenge> {
  const { data } = await publicHttp.get<CaptchaChallenge>('/captcha');
  return data;
}
