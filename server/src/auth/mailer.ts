// 邮件发送（一期 MVP，API-04）：真实 SMTP 投递属二期 API-29（完整邮件通知服务）。
// 一期策略：MAIL_DEV_MODE=true（默认）时把重置链接写入服务端日志，并由
// /forgot-password 响应带回 devResetUrl，方便内网/试用环境走完"忘记密码 → 重置"闭环；
// MAIL_DEV_MODE=false 时只记日志不外发。接入真实 SMTP 时仅需替换 sendPasswordResetEmail 实现。
export interface MailSendResult {
  delivered: boolean;
  devMode: boolean;
}

export function isMailDevMode(): boolean {
  return (process.env.MAIL_DEV_MODE ?? 'true').trim().toLowerCase() !== 'false';
}

export async function sendPasswordResetEmail(to: string, resetUrl: string): Promise<MailSendResult> {
  const devMode = isMailDevMode();
  if (devMode) {
    console.log(`[mailer:dev] 密码重置链接 → ${to} : ${resetUrl}`);
  } else {
    console.warn('[mailer] SMTP 尚未接入（二期 API-29），重置链接仅记录日志：');
    console.log(`[mailer:pending] ${to} : ${resetUrl}`);
  }
  return { delivered: false, devMode };
}
