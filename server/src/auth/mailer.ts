// 邮件发送（一期 MVP，API-04）：真实 SMTP 投递属二期 API-29（完整邮件通知服务）。
// 一期策略：MAIL_DEV_MODE=true（默认）时由 /forgot-password 响应带回 devResetUrl，
// 方便内网/试用环境走完"忘记密码 → 重置"闭环；MAIL_DEV_MODE=false 时只记日志不外发。
// M1 加固：重置链接含一次性 token，任何模式都不再写入服务端日志（日志常被采集/留存，
// 链接落日志等于把改密凭证写进磁盘）。接入真实 SMTP 时仅需替换 sendPasswordResetEmail 实现。
export interface MailSendResult {
  delivered: boolean;
  devMode: boolean;
}

export function isMailDevMode(): boolean {
  return (process.env.MAIL_DEV_MODE ?? 'true').trim().toLowerCase() !== 'false';
}

export async function sendPasswordResetEmail(to: string, _resetUrl: string): Promise<MailSendResult> {
  const devMode = isMailDevMode();
  if (devMode) {
    console.log(`[mailer:dev] 密码重置邮件已生成 → ${to}（dev 模式：链接经 /forgot-password 响应 devResetUrl 返回，不写入日志）`);
  } else {
    console.warn(`[mailer] SMTP 尚未接入（二期 API-29），${to} 的重置邮件未能实际投递（链接不落日志）`);
  }
  return { delivered: false, devMode };
}
