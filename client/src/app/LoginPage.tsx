// 认证页：验证码登录（默认）/ 忘记密码（短信重置）/ 密码登录（手机号或管理员账号）。
//
// 手机号 + 短信验证码是默认登录方式；未注册手机号验证通过后自动建号（短信已验证手机号真实性）。
// 已登录用户可在顶栏头像设置密码，之后也可用手机号/管理员账号 + 密码登录。
// 登录页不出现“注册”按钮；拉新归因不要求手填邀请码：从邀请链接 ?invite= 与渠道参数自动采集。
// 初始管理员 admin 没有手机号，密码登录入口保留（该账号由服务端强制 mustChangePassword 首登改密）。
// 短信发送不再要求图形验证码（产品决定）；密码登录仍保留图形验证码防爆破。
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { useAuth, fetchCaptcha, type CaptchaChallenge } from '../shared/api/auth';
import { useSystemSettings } from '../shared/api/system-settings';
import { sendVisitBeacon } from '../shared/api/analytics';
import OpenSourceNotice from '../components/OpenSourceNotice';
import InitialPasswordChangeDialog from './InitialPasswordChangeDialog';
import { LoginMarketing } from './LoginMarketing';
import { applyFavicon } from '../shared/ui/favicon';
import logoUrl from '../../assets/icon_256.png';

const PHONE_RE = /^1[3-9]\d{9}$/;
const SMS_CODE_RE = /^\d{6}$/;
const RESEND_SECONDS = 60;

type AuthMode = 'sms' | 'reset' | 'admin';

export default function LoginPage() {
  const {
    loginWithSms,
    loginWithPassword,
    sendSmsCode,
    resetPasswordWithSms,
    initialPasswordChange,
    changeInitialPassword,
    clearInitialPasswordChange,
  } = useAuth();
  const { data: systemSettings } = useSystemSettings();
  const systemName = systemSettings?.systemName || '投好标';
  const logoSrc = systemSettings?.logoDataUrl || logoUrl;

  useEffect(() => {
    sendVisitBeacon('/login');
  }, []);

  useEffect(() => {
    document.title = `${systemName} - AI标书制作平台`;
    applyFavicon(logoSrc);
  }, [systemName, logoSrc]);

  const [mode, setMode] = useState<AuthMode>('sms');
  const [phone, setPhone] = useState('');
  const [smsCode, setSmsCode] = useState('');
  const [adminUser, setAdminUser] = useState('');
  const [password, setPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  // 隐藏归因参数：不从界面收集，仅从邀请链接/渠道参数自动读取。
  const [inviteCode, setInviteCode] = useState('');
  const [acquisitionSource, setAcquisitionSource] = useState('');
  // 默认勾选协议：短信验证码登录即视为同意；用户仍可手动取消。
  const [agreed, setAgreed] = useState(true);
  const [captcha, setCaptcha] = useState<CaptchaChallenge | null>(null);
  const [captchaError, setCaptchaError] = useState(false);
  const [captchaCode, setCaptchaCode] = useState('');
  const [countdown, setCountdown] = useState(0);
  const [devCode, setDevCode] = useState('');
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [busy, setBusy] = useState(false);
  const initialPasswordExpiryRef = useRef<number | null>(null);

  const loadCaptcha = useCallback(async () => {
    setCaptchaCode('');
    setCaptchaError(false);
    try {
      setCaptcha(await fetchCaptcha());
    } catch {
      setCaptcha(null);
      setCaptchaError(true);
    }
  }, []);

  // 仅密码登录需要图形验证码；短信登录不再加载验证码。
  useEffect(() => {
    if (mode === 'admin') void loadCaptcha();
  }, [mode, loadCaptcha]);

  // 拉新归因：登录页不要求用户填邀请码，从邀请链接/渠道参数静默采集。
  // - 邀请链接：?invite=CODE（兼容旧版 ?code= / ?ref=）
  // - 渠道来源：?utm_source= / ?from= / ?channel=（仅保留短标识）
  // 参数只用于首次建号归因；已注册用户登录不会覆盖既有关系。
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const invite = (params.get('invite') || params.get('ref') || params.get('code') || '')
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '')
      .slice(0, 12);
    if (invite) setInviteCode(invite);
    const rawSource = (params.get('utm_source') || params.get('from') || params.get('channel') || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, '')
      .slice(0, 32);
    if (rawSource) setAcquisitionSource(rawSource);
  }, []);

  // 重发倒计时
  useEffect(() => {
    if (countdown <= 0) return undefined;
    const timer = setTimeout(() => setCountdown((value) => Math.max(0, value - 1)), 1000);
    return () => clearTimeout(timer);
  }, [countdown]);

  const returnInitialPasswordChangeToLogin = useCallback((message: string) => {
    initialPasswordExpiryRef.current = null;
    clearInitialPasswordChange();
    setMode('sms');
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
    setDevCode('');
    setSmsCode('');
    setPassword('');
    setConfirm('');
    setNewPassword('');
    setCountdown(0);
  };

  const readError = (err: unknown, fallback: string) => {
    const ex = err as { response?: { data?: { error?: string } }; message?: string };
    return ex.response?.data?.error || ex.message || fallback;
  };

  const onSendCode = async () => {
    if (busy) return;
    if (!PHONE_RE.test(phone.trim())) {
      setError('请输入有效的 11 位手机号');
      return;
    }
    setBusy(true);
    setError('');
    setInfo('');
    try {
      const result = await sendSmsCode(phone.trim(), mode === 'reset' ? 'reset' : 'login');
      setCountdown(RESEND_SECONDS);
      setDevCode(result.devCode || '');
      setInfo(result.devCode ? '开发模式：验证码已在上方显示（生产环境会发送短信）' : '验证码已发送，请注意查收短信');
    } catch (err) {
      setError(readError(err, '验证码发送失败，请稍后重试'));
    } finally {
      setBusy(false);
    }
  };

  const onSmsLogin = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (!PHONE_RE.test(phone.trim())) {
      setError('请输入有效的 11 位手机号');
      return;
    }
    if (!SMS_CODE_RE.test(smsCode.trim())) {
      setError('请输入 6 位数字验证码');
      return;
    }
    if (!agreed) {
      setError('请先阅读并勾选《用户协议》与《隐私政策》');
      return;
    }
    setBusy(true);
    setError('');
    setInfo('');
    try {
      await loginWithSms(phone.trim(), smsCode.trim(), {
        agree: agreed,
        inviteCode: inviteCode || undefined,
        source: acquisitionSource || undefined,
      });
    } catch (err) {
      setError(readError(err, '登录失败，请重试'));
    } finally {
      setBusy(false);
    }
  };

  const onResetPassword = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (!PHONE_RE.test(phone.trim())) {
      setError('请输入有效的 11 位手机号');
      return;
    }
    if (!SMS_CODE_RE.test(smsCode.trim())) {
      setError('请输入 6 位数字验证码');
      return;
    }
    if (newPassword.length < 8) {
      setError('新密码至少 8 位');
      return;
    }
    if (newPassword !== confirm) {
      setError('两次输入的密码不一致');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const result = await resetPasswordWithSms(phone.trim(), smsCode.trim(), newPassword, confirm);
      switchMode('sms');
      setInfo(result.message || '密码已重置，请使用验证码登录');
    } catch (err) {
      setError(readError(err, '重置失败，请重试'));
    } finally {
      setBusy(false);
    }
  };

  const onAdminLogin = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (!adminUser.trim() || !password) {
      setError('请输入账号/手机号和密码');
      return;
    }
    if (!captcha || !captchaCode.trim()) {
      setError('请输入图形验证码');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await loginWithPassword(adminUser.trim(), password, {
        captchaId: captcha.captchaId,
        captchaCode: captchaCode.trim(),
      });
    } catch (err) {
      setError(readError(err, '登录失败，请重试'));
      void loadCaptcha();
    } finally {
      setBusy(false);
    }
  };

  const subtitle =
    mode === 'sms'
      ? '手机号验证码登录，首次登录自动创建账号'
      : mode === 'reset'
        ? '通过手机验证码重置密码'
        : '手机号或管理员账号 + 密码登录';
  const submitLabel = busy
    ? '处理中…'
    : mode === 'sms'
      ? '登录'
      : mode === 'reset'
        ? '重置密码'
        : '登录';
  return (
    <div className="login-page">
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

      <LoginMarketing onRegister={() => switchMode('sms')} />

      <div className="login-panel">
        <form
          className="login-card"
          onSubmit={mode === 'sms' ? onSmsLogin : mode === 'reset' ? onResetPassword : onAdminLogin}
        >
          <h2 className="login-card-title">欢迎使用{systemName}</h2>
          <p className="login-card-hint">{subtitle}</p>

          {mode === 'admin' && (
            <label className="login-field">
              <span>账号 / 手机号</span>
              <input
                value={adminUser}
                onChange={(e) => setAdminUser(e.target.value)}
                placeholder="请输入手机号或管理员账号"
                autoComplete="username"
              />
            </label>
          )}

          {mode !== 'admin' && (
            <label className="login-field">
              <span>手机号</span>
              <input
                value={phone}
                onChange={(e) => setPhone(e.target.value.replace(/\D/g, '').slice(0, 11))}
                placeholder="请输入 11 位手机号"
                inputMode="numeric"
                maxLength={11}
                autoComplete="tel"
              />
            </label>
          )}

          {mode !== 'admin' && (
            <label className="login-field">
              <span className="login-field-head">
                <span>短信验证码</span>
                {mode === 'sms' && (
                  <button type="button" className="login-forgot-link" onClick={() => switchMode('reset')}>
                    忘记密码？
                  </button>
                )}
              </span>
              <div className="login-captcha-row">
                <input
                  value={smsCode}
                  onChange={(e) => setSmsCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  placeholder="6 位数字"
                  inputMode="numeric"
                  maxLength={6}
                  autoComplete="one-time-code"
                />
                <button
                  type="button"
                  className="login-send-code"
                  onClick={() => void onSendCode()}
                  disabled={busy || countdown > 0}
                >
                  {countdown > 0 ? `${countdown}s 后重发` : '获取验证码'}
                </button>
              </div>
            </label>
          )}

          {devCode && (
            <p className="login-message is-success">开发模式验证码：<strong>{devCode}</strong></p>
          )}

          {mode === 'admin' && (
            <label className="login-field">
              <span>密码</span>
              <div className="login-input-wrap">
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="请输入密码"
                  autoComplete="current-password"
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
            </label>
          )}

          {mode === 'reset' && (
            <>
              <label className="login-field">
                <span>新密码</span>
                <div className="login-input-wrap">
                  <input
                    type={showPassword ? 'text' : 'password'}
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    placeholder="至少 8 位"
                    autoComplete="new-password"
                  />
                  <button
                    type="button"
                    className="login-eye"
                    onClick={() => setShowPassword((v) => !v)}
                    aria-label={showPassword ? '隐藏密码' : '显示密码'}
                  >
                    {showPassword ? <EyeOffIcon /> : <EyeIcon />}
                  </button>
                </div>
              </label>
              <label className="login-field">
                <span>确认新密码</span>
                <div className="login-input-wrap">
                  <input
                    type={showConfirm ? 'text' : 'password'}
                    value={confirm}
                    onChange={(e) => setConfirm(e.target.value)}
                    placeholder="再次输入新密码"
                    autoComplete="new-password"
                  />
                  <button
                    type="button"
                    className="login-eye"
                    onClick={() => setShowConfirm((v) => !v)}
                    aria-label={showConfirm ? '隐藏确认密码' : '显示确认密码'}
                  >
                    {showConfirm ? <EyeOffIcon /> : <EyeIcon />}
                  </button>
                </div>
              </label>
            </>
          )}

          {mode === 'admin' && (
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
                  aria-label={captchaError ? '图形验证码加载失败，点击重试' : '图形验证码'}
                  onClick={() => void loadCaptcha()}
                >
                  {captcha?.image ? (
                    <img src={captcha.image} alt="图形验证码" />
                  ) : (
                    <span className="login-captcha-retry">
                      {captchaError ? '加载失败，点击重试' : '加载中…'}
                    </span>
                  )}
                </button>
              </div>
            </label>
          )}

          {mode === 'sms' && (
            <label className="login-agree-check">
              <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
              <span>
                已阅读并同意
                <a href="/agreement-user.html" target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>《用户协议》</a>
                与
                <a href="/agreement-privacy.html" target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>《隐私政策》</a>
              </span>
            </label>
          )}

          {error && <p className="login-message is-error">{error}</p>}
          {info && <p className="login-message is-success">{info}</p>}

          <button type="submit" className="primary-action login-submit" disabled={busy}>
            {submitLabel}
          </button>

          <div className="login-aux-links">
            {mode === 'sms' && (
              <button type="button" className="login-link-button" onClick={() => switchMode('admin')}>
                密码登录
              </button>
            )}
            {mode !== 'sms' && (
              <button type="button" className="login-link-button" onClick={() => switchMode('sms')}>
                返回验证码登录
              </button>
            )}
          </div>
        </form>
      </div>

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
