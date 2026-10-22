// 设置登录密码：用户点击顶栏头像打开。登录态内即可设置/修改，不要求旧密码
// （短信自动建号时旧密码是服务端随机串，用户并不知道）；成功后不刷新 token。
import { useEffect, useState, type FormEvent } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useAuth } from '../shared/api/auth';

interface SetPasswordDialogProps {
  open: boolean;
  onClose: () => void;
  onSuccess?: () => void;
}

function SetPasswordDialog({ open, onClose, onSuccess }: SetPasswordDialogProps) {
  const { setPassword } = useAuth();
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setNewPassword('');
      setConfirmPassword('');
      setError('');
      setBusy(false);
    }
  }, [open]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    if (newPassword.length < 8) {
      setError('密码至少 8 位');
      return;
    }
    if (newPassword !== confirmPassword) {
      setError('两次输入的密码不一致');
      return;
    }
    setBusy(true);
    try {
      await setPassword(newPassword, confirmPassword);
      onClose();
      onSuccess?.();
    } catch (err) {
      const message = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
      setError(message || '设置失败，请稍后重试');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={(nextOpen) => { if (!nextOpen && !busy) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="content-regenerate-modal" />
        <Dialog.Content className="confirm-dialog set-password-dialog">
          <Dialog.Title className="confirm-dialog-title">设置登录密码</Dialog.Title>
          <Dialog.Description className="confirm-dialog-desc">
            设置后可使用手机号（或管理员账号）+ 密码登录；短信验证码登录仍然可用。
          </Dialog.Description>
          <form className="set-password-form" onSubmit={submit}>
            <label className="set-password-field">
              <span>新密码</span>
              <input
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder="至少 8 位"
                autoComplete="new-password"
                minLength={8}
                required
                autoFocus
              />
            </label>
            <label className="set-password-field">
              <span>确认新密码</span>
              <input
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder="再输入一次"
                autoComplete="new-password"
                minLength={8}
                required
              />
            </label>
            {error && <p className="set-password-error" role="alert">{error}</p>}
            <div className="confirm-dialog-actions">
              <Dialog.Close asChild>
                <button type="button" className="secondary-action" disabled={busy}>取消</button>
              </Dialog.Close>
              <button type="submit" className="primary-action" disabled={busy}>
                {busy ? '保存中…' : '保存密码'}
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export default SetPasswordDialog;
