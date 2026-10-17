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
import OpenSourceNotice from '../components/OpenSourceNotice';
import InitialPasswordChangeDialog from './InitialPasswordChangeDialog';
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

  // 浏览器标签标题跟随系统名（DB 可配）。登录态在 AppTopbar 同步。
  useEffect(() => {
    document.title = systemName;
  }, [systemName]);

  const [mode, setMode] = useState<AuthMode>('login');
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [email, setEmail] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [captcha, setCaptcha] = useState<CaptchaChallenge | null>(null);
  const [captchaCode, setCaptchaCode] = useState('');
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
    setBusy(true);
    setError('');
    setInfo('');
    try {
      const result = await login(phone, password, {
        captchaId: captcha.captchaId,
        captchaCode: captchaCode.trim(),
      });
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
      ? '登录'
      : mode === 'register'
        ? '注册'
        : mode === 'forgot'
          ? '申请重置链接'
          : '重置密码';

  return (
    <div className="login-page">
      {/* 左侧品牌海报区（窄屏隐藏）：价值主张 + 卖点 + 权益数字 */}
      <aside className="login-poster" aria-hidden="true">
        <div className="login-poster-brand">
          <img src={logoSrc} alt="" />
          <span>{systemName}</span>
        </div>
        <h1 className="login-poster-title">
          写标书，交给 AI；
          <br />
          <em>中不中标</em>，靠实力。
        </h1>
        <p className="login-poster-lead">
          上传招标文件，AI 自动解析评分办法与废标项，按字数预算生成技术方案，查重、废标项、一致性三重质检后导出 Word / PDF。
        </p>
        <ul className="login-poster-points">
          <li>
            <strong>字数强控</strong>
            <span>预算 3 万字 ≈ 写出 3 万字，不再删不忍删、交不敢交</span>
          </li>
          <li>
            <strong>缺证不编造</strong>
            <span>没有的业绩与人员写成符合招标要求的笼统口径，绝不张冠李戴</span>
          </li>
          <li>
            <strong>三重质检</strong>
            <span>查重 · 废标项 · 一致性审计，发现问题 AI 自动修复</span>
          </li>
        </ul>
        <div className="login-poster-stats">
          <div><strong>10 万字</strong><small>注册即送</small></div>
          <div><strong>免费</strong><small>解析与目录生成</small></div>
          <div><strong>40%</strong><small>邀请好友返利</small></div>
        </div>
      </aside>

      {/* 右侧表单区 */}
      <div className="login-panel">
      <form
        className="login-card"
        onSubmit={mode === 'login' ? onLogin : mode === 'register' ? onRegister : mode === 'forgot' ? onForgot : onReset}
      >

        {needCaptcha && (
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
                  ? '手机号 / admin'
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
            <span>密码</span>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={mode === 'login' ? '请输入密码' : '至少 8 位'}
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            />
          </label>
        )}

        {(mode === 'register' || mode === 'reset') && (
          <label className="login-field">
            <span>确认密码</span>
            <input
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              placeholder="再次输入密码"
              autoComplete="new-password"
            />
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

        {needCaptcha && (
          <p className="login-agreement">
            登录/注册即代表同意
            <a href="/agreement-user.html" target="_blank" rel="noreferrer">《用户协议》</a>
            与
            <a href="/agreement-privacy.html" target="_blank" rel="noreferrer">《隐私政策》</a>
          </p>
        )}

        <div className="login-aux-links">
          {mode === 'login' && (
            <button type="button" className="login-link-button" onClick={() => switchMode('forgot')}>
              忘记密码？
            </button>
          )}
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

        <OpenSourceNotice variant="login" />
      </form>
      </div>

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
