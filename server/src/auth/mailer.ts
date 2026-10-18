// 邮件发送（一期 MVP，API-04）：真实 SMTP 投递属二期 API-29（完整邮件通知服务）。
// 一期策略：MAIL_DEV_MODE=true 时由 /forgot-password 响应带回 devResetUrl，
// 方便内网/试用环境走完"忘记密码 → 重置"闭环；默认关闭，只记日志不外发。
//
// 安全（务必保持）：devResetUrl 等同于"改密凭证直接回给调用方"，允许它在生产生效
// 就是任何人凭邮箱接管任意账号。因此这里双保险——
//   1) 默认 false（必须显式 MAIL_DEV_MODE=true 才开）；
//   2) NODE_ENV=production 时强制 false，即使环境变量误配也不回显。
// M1 加固：重置链接含一次性 token，任何模式都不写入服务端日志（日志常被采集/留存，
// 链接落日志等于把改密凭证写进磁盘）。接入真实 SMTP 时仅需替换 sendPasswordResetEmail 实现。
export interface MailSendResult {
  delivered: boolean;
  devMode: boolean;
}

export function isMailDevMode(): boolean {
  if (process.env.NODE_ENV === 'production') return false;
  return (process.env.MAIL_DEV_MODE ?? 'false').trim().toLowerCase() === 'true';
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
