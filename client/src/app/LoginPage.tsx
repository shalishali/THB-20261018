// 认证页（认证阶段 FE-14/15）：登录 / 注册 / 忘记密码 / 重置密码四模式。
// 登录与注册均需图形验证码（API-02）；注册支持 ?invite= 邀请码归因（API-06）；
// 忘记密码走邮箱（API-04/05）：申请重置链接 → /reset-password?token= 设置新密码。
// 视觉沿用应用设计令牌与面板/输入/按钮词汇，与仪表盘、用户管理等特性保持同一浅色主题。
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import {
  useAuth,
  fetchCaptcha,
  requestPasswordReset,
  resetPassword,
  type CaptchaChallenge,
} from '../shared/api/auth';
import { useSystemSettings } from '../shared/api/system-settings';
import { sendVisitBeacon } from '../shared/api/analytics';
import OpenSourceNotice from '../components/OpenSourceNotice';
import InitialPasswordChangeDialog from './InitialPasswordChangeDialog';
import { LoginMarketing } from './LoginMarketing';
import logoUrl from '../../assets/icon_256.png';

const PHONE_RE = /^1[3-9]\d{9}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type AuthMode = 'login' | 'register' | 'forgot' | 'reset';

export default function LoginPage() {
  const {
    login,
    register,
    initialPasswordChange,
    changeInitialPassword,
    clearInitialPasswordChange,
  } = useAuth();
  const { data: systemSettings } = useSystemSettings();
  const systemName = systemSettings?.systemName || '投好标';
  const logoSrc = systemSettings?.logoDataUrl || logoUrl;

  // 访问埋点：匿名访问登录页也计（"多少人访问了网站"）
  useEffect(() => {
    sendVisitBeacon('/login');
  }, []);

  // 浏览器标签标题跟随系统名（DB 可配）。登录态在 AppTopbar 同步。
  useEffect(() => {
    // 运行时标题保留品牌词与关键词（覆盖 head 静态 SEO 标题时不再丢失「AI标书」等收录词）
    document.title = `${systemName} - AI标书制作平台`;
  }, [systemName]);

  const [mode, setMode] = useState<AuthMode>('login');
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  // 密码明文/密文切换（眼睛图标）
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [email, setEmail] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [captcha, setCaptcha] = useState<CaptchaChallenge | null>(null);
  const [captchaCode, setCaptchaCode] = useState('');
  // 登录即注册：未注册手机号直接登录时自动建号，协议勾选为前置条件
  const [loginAgreed, setLoginAgreed] = useState(false);
  function EyeIcon() {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
        <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" />
        <circle cx="12" cy="12" r="2.8" />
      </svg>
    );
  }
  function EyeOffIcon() {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
        <path d="M4 4l16 16" />
        <path d="M9.9 5.9A9.8 9.8 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a17.6 17.6 0 0 1-2.3 3.1M6.6 6.6A16.9 16.9 0 0 0 2.5 12S6 18.5 12 18.5a9.7 9.7 0 0 0 3.4-.6" />
        <path d="M9.9 9.9a2.8 2.8 0 0 0 4 4" />
      </svg>
    );
  }
  const [resetToken, setResetToken] = useState('');
  const [resetLink, setResetLink] = useState('');
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [busy, setBusy] = useState(false);
  const initialPasswordExpiryRef = useRef<number | null>(null);

  // 图形验证码（API-02）：登录/注册共用；输错或提交失败后刷新一张。
  const loadCaptcha = useCallback(async () => {
    setCaptchaCode('');
    try {
      setCaptcha(await fetchCaptcha());
    } catch {
      setCaptcha(null);
    }
  }, []);

  // 启动时解析 URL（FE-14/15）：?token=xxx（/reset-password 链接落点）进入重置模式；
  // ?invite=XXX（或 ?code=XXX）预填注册邀请码，用于邀请注册归因（API-06）。
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const token = params.get('token');
    if (token) {
      setResetToken(token);
      setMode('reset');
      return;
    }
    const invite = (params.get('invite') || params.get('code') || '').trim();
    if (invite) setInviteCode(invite.toUpperCase());
  }, []);

  useEffect(() => {
    void loadCaptcha();
  }, [loadCaptcha]);

  const returnInitialPasswordChangeToLogin = useCallback((message: string) => {
    initialPasswordExpiryRef.current = null;
    clearInitialPasswordChange();
    setMode('login');
    setPassword('');
    setConfirm('');
    setInfo('');
    setError(message);
  }, [clearInitialPasswordChange]);

  const onInitialPasswordExpired = useCallback(() => {
    returnInitialPasswordChangeToLogin('改密凭证已过期，请重新登录');
  }, [returnInitialPasswordChangeToLogin]);

  useEffect(() => {
    if (initialPasswordChange) {
      initialPasswordExpiryRef.current = initialPasswordChange.expiresAt;
      return;
    }
    const previousExpiry = initialPasswordExpiryRef.current;
    if (previousExpiry !== null && Date.now() >= previousExpiry) {
      onInitialPasswordExpired();
    }
  }, [initialPasswordChange, onInitialPasswordExpired]);

  const switchMode = (next: AuthMode) => {
    setMode(next);
    setError('');
    setInfo('');
    setResetLink('');
    if (next === 'login' || next === 'register') {
      void loadCaptcha();
    }
  };

  const onLogin = async (e: FormEvent) => {
    e.preventDefault();
    // 登录态接受手机号或管理员账号（如 admin），仅做非空校验；手机号格式校验只在注册态。
    if (!phone.trim()) {
      setError('请输入账号');
      return;
    }
    if (!captcha || !captchaCode.trim()) {
      setError('请输入图形验证码');
      return;
    }
    // 登录即注册：未注册手机号将自动建号，协议勾选为前置条件（服务端亦强校验）。
    if (!loginAgreed) {
      setError('请先勾选下方「已阅读并同意《用户协议》与《隐私政策》」');
      return;
    }
    setBusy(true);
    setError('');
    setInfo('');
    try {
      const result = await login(phone, password, {
        captchaId: captcha.captchaId,
        captchaCode: captchaCode.trim(),
      }, { autoRegister: true, agree: loginAgreed });
      if (result === 'password-change-required') {
        setPassword('');
      }
    } catch (err) {
      const ex = err as { response?: { data?: { error?: string } } };
      setError(ex.response?.data?.error || '登录失败');
      void loadCaptcha();
    } finally {
      setBusy(false);
    }
  };

  const onRegister = async (e: FormEvent) => {
    e.preventDefault();
    if (!PHONE_RE.test(phone)) {
      setError('请输入有效的 11 位手机号');
      return;
    }
    if (password.length < 8) {
      setError('密码至少 8 位');
      return;
    }
    if (password !== confirm) {
      setError('两次密码不一致');
      return;
    }
    if (!captcha || !captchaCode.trim()) {
      setError('请输入图形验证码');
      return;
    }
    setBusy(true);
    setError('');
    setInfo('');
    try {
      // 注册即自动登录：服务端直接签发会话令牌，本页随即被应用主界面替换
      await register(phone, password, {
        captchaId: captcha.captchaId,
        captchaCode: captchaCode.trim(),
        inviteCode: inviteCode.trim(),
      });
      setConfirm('');
      setPassword('');
      setError('');
    } catch (err) {
      const ex = err as { response?: { data?: { error?: string } } };
      setError(ex.response?.data?.error || '注册失败');
      void loadCaptcha();
    } finally {
      setBusy(false);
    }
  };

  // 忘记密码（FE-15/API-04）：提交邮箱申请重置链接。
  // 开发模式（SMTP 未接入，二期 API-29）响应会带回 devResetUrl，直接展示为可点链接。
  const onForgot = async (e: FormEvent) => {
    e.preventDefault();
    if (!EMAIL_RE.test(email.trim())) {
      setError('请输入有效的邮箱地址');
      return;
    }
    setBusy(true);
    setError('');
    setInfo('');
    setResetLink('');
    try {
      const result = await requestPasswordReset(email.trim());
      setInfo(result.message);
      if (result.devResetUrl) setResetLink(result.devResetUrl);
    } catch (err) {
      const ex = err as { response?: { data?: { error?: string } } };
      setError(ex.response?.data?.error || '申请失败，请稍后重试');
    } finally {
      setBusy(false);
    }
  };

  // 重置密码（FE-15/API-05）：token 来自邮件/开发模式链接（?token=xxx），成功后回登录页。
  const onReset = async (e: FormEvent) => {
    e.preventDefault();
    if (!resetToken) {
      setError('重置链接无效，请重新申请');
      return;
    }
    if (password.length < 8) {
      setError('密码至少 8 位');
      return;
    }
    if (password !== confirm) {
      setError('两次密码不一致');
      return;
    }
    setBusy(true);
    setError('');
    setInfo('');
    try {
      const result = await resetPassword(resetToken, password, confirm);
      setPassword('');
      setConfirm('');
      setResetToken('');
      window.history.replaceState({}, '', '/');
      setMode('login');
      setInfo(result.message);
    } catch (err) {
      const ex = err as { response?: { data?: { error?: string } } };
      setError(ex.response?.data?.error || '重置失败，请重新申请');
    } finally {
      setBusy(false);
    }
  };

  const needCaptcha = mode === 'login' || mode === 'register';
  const subtitle =
    mode === 'login'
      ? '登录以进入工作台'
      : mode === 'register'
        ? '注册成功即可直接登录'
        : mode === 'forgot'
          ? '输入注册邮箱，申请密码重置链接'
          : '设置新密码';
  const submitLabel = busy
    ? '提交中…'
    : mode === 'login'
      ? '立即登录'
      : mode === 'register'
        ? '注册'
        : mode === 'forgot'
          ? '申请重置链接'
          : '重置密码';

  return (
    <div className="login-page">
      {/* 顶部固定品牌条：淡蓝色，logo + 系统名 + 锚点导航（跟随管理员设置） */}
      <header className="login-topbar">
        <img src={logoSrc} alt="" />
        <span className="name">{systemName}</span>
        <nav className="login-topbar-nav">
          <a href="#lm-features">产品功能</a>
          <a href="#lm-pricing">定价</a>
          <a href="#lm-scenes">适用场景</a>
          <a href="/docs/使用/01-生成技术方案.md" target="_blank" rel="noreferrer">帮助文档</a>
        </nav>
      </header>

      {/* 左侧营销栏（窄屏堆叠到表单下方）：产品介绍 + 登录同屏，免去营销页/应用两级跳转 */}
      <LoginMarketing onRegister={() => switchMode('register')} />


      {/* 右侧表单区 */}
      <div className="login-panel">
      <form
        className="login-card"
        onSubmit={mode === 'login' ? onLogin : mode === 'register' ? onRegister : mode === 'forgot' ? onForgot : onReset}
      >

        <h2 className="login-card-title">欢迎使用{systemName}</h2>

        {(mode === 'login' || mode === 'register') && (
          <div className="login-tabs" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'login'}
              className={`login-tab${mode === 'login' ? ' is-active' : ''}`}
              onClick={() => switchMode('login')}
            >
              登录
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'register'}
              className={`login-tab${mode === 'register' ? ' is-active' : ''}`}
              onClick={() => switchMode('register')}
            >
              注册
            </button>
          </div>
        )}

        {(mode === 'login' || mode === 'register' || mode === 'forgot') && (
          <label className="login-field">
            <span>{mode === 'login' ? '账号' : mode === 'register' ? '手机号' : '邮箱'}</span>
            <input
              value={mode === 'forgot' ? email : phone}
              onChange={(e) => (mode === 'forgot' ? setEmail(e.target.value) : setPhone(e.target.value))}
              placeholder={
                mode === 'login'
                  ? '请输入手机号'
                  : mode === 'register'
                    ? '请输入 11 位手机号'
                    : '请输入注册时填写的邮箱'
              }
              maxLength={mode === 'register' ? 11 : undefined}
              autoComplete={mode === 'login' ? 'username' : mode === 'register' ? 'tel' : 'email'}
            />
          </label>
        )}

        {mode === 'register' && (
          <>
            <label className="login-field">
              <span>邀请码（选填）</span>
              <input
                value={inviteCode}
                onChange={(e) => setInviteCode(e.target.value.toUpperCase())}
                placeholder="选填；通过邀请链接打开会自动填入"
                maxLength={12}
                autoComplete="off"
              />
            </label>
          </>
        )}

        {(mode === 'login' || mode === 'register' || mode === 'reset') && (
          <label className="login-field">
            <span className="login-field-head">
              <span>密码</span>
              {mode === 'login' && (
                <button type="button" className="login-forgot-link" onClick={() => switchMode('forgot')}>
                  忘记密码？
                </button>
              )}
            </span>
            <div className="login-input-wrap">
              <input
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={mode === 'login' ? '请输入密码' : '至少 8 位'}
                autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              />
              <button
                type="button"
                className="login-eye"
                onClick={() => setShowPassword((v) => !v)}
                aria-label={showPassword ? '隐藏密码' : '显示密码'}
                title={showPassword ? '隐藏密码' : '显示密码'}
              >
                {showPassword ? <EyeOffIcon /> : <EyeIcon />}
              </button>
            </div>
            {mode === 'login' && (
              <label className="login-agree-check">
                <input
                  type="checkbox"
                  checked={loginAgreed}
                  onChange={(e) => setLoginAgreed(e.target.checked)}
                />
                <span>
                  已阅读并同意
                  <a href="/agreement-user.html" target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>《用户协议》</a>
                  与
                  <a href="/agreement-privacy.html" target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>《隐私政策》</a>
                </span>
              </label>
            )}
          </label>
        )}

        {(mode === 'register' || mode === 'reset') && (
          <label className="login-field">
            <span>确认密码</span>
            <div className="login-input-wrap">
              <input
                type={showConfirm ? 'text' : 'password'}
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                placeholder="再次输入密码"
                autoComplete="new-password"
              />
              <button
                type="button"
                className="login-eye"
                onClick={() => setShowConfirm((v) => !v)}
                aria-label={showConfirm ? '隐藏确认密码' : '显示确认密码'}
                title={showConfirm ? '隐藏确认密码' : '显示确认密码'}
              >
                {showConfirm ? <EyeOffIcon /> : <EyeIcon />}
              </button>
            </div>
          </label>
        )}

        {needCaptcha && (
          <label className="login-field">
            <span>图形验证码</span>
            <div className="login-captcha-row">
              <input
                value={captchaCode}
                onChange={(e) => setCaptchaCode(e.target.value.toUpperCase())}
                placeholder="输入右侧 4 位字符"
                maxLength={4}
                autoComplete="off"
              />
              <button
                type="button"
                className="login-captcha-image"
                title="看不清？点击换一张"
                onClick={() => void loadCaptcha()}
                dangerouslySetInnerHTML={{ __html: captcha?.svg ?? '' }}
              />
            </div>
          </label>
        )}

        {error && <p className="login-message is-error">{error}</p>}
        {info && <p className="login-message is-success">{info}</p>}
        {resetLink && (
          <p className="login-message is-success login-reset-link">
            开发模式重置链接（正式邮件发送于二期接入）：
            <a href={resetLink}>打开重置页面</a>
          </p>
        )}

        <button type="submit" className="primary-action login-submit" disabled={busy}>
          {submitLabel}
        </button>

        {mode === 'login' && (
          <p className="login-card-hint">未注册的手机号将自动创建账号并登录，注册即送 10 万字额度</p>
        )}

        {mode === 'register' && (
          <p className="login-agreement">
            注册即代表同意
            <a href="/agreement-user.html" target="_blank" rel="noreferrer">《用户协议》</a>
            与
            <a href="/agreement-privacy.html" target="_blank" rel="noreferrer">《隐私政策》</a>
          </p>
        )}

        <div className="login-aux-links">
          {mode === 'forgot' && (
            <button type="button" className="login-link-button" onClick={() => switchMode('login')}>
              返回登录
            </button>
          )}
          {mode === 'reset' && (
            <button
              type="button"
              className="login-link-button"
              onClick={() => {
                window.history.replaceState({}, '', '/');
                switchMode('login');
              }}
            >
              返回登录
            </button>
          )}
        </div>
      </form>
      </div>

      {/* 全局页脚：开源与二次开发说明移出登录卡片，落在整页最底部 */}
      <footer className="login-footer">
        <OpenSourceNotice variant="login" />
      </footer>

      <InitialPasswordChangeDialog
        key={initialPasswordChange?.expiresAt ?? 'closed'}
        open={initialPasswordChange !== null}
        expiresAt={initialPasswordChange?.expiresAt ?? null}
        onSubmit={changeInitialPassword}
        onExpired={onInitialPasswordExpired}
        onTerminalError={returnInitialPasswordChangeToLogin}
      />
    </div>
  );
}
