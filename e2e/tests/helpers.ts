import { expect, type APIRequestContext, type Page } from '@playwright/test';

export const API_BASE = process.env.E2E_API_BASE || 'http://127.0.0.1:3000/api';

/** 从图形验证码 SVG 中按序提取字符（服务端按序渲染 <text>，与单测同法） */
export function extractCaptchaCode(svg: string): string {
  return [...svg.matchAll(/<text[^>]*>([A-Z2-9])<\/text>/g)].map((m) => m[1]).join('');
}

/** 走 API 发送一条登录验证码，返回 mock 模式下回显的 devCode */
export async function requestLoginCode(request: APIRequestContext, phone: string): Promise<string> {
  const captchaRes = await request.get(`${API_BASE}/captcha`);
  expect(captchaRes.ok()).toBeTruthy();
  const { captchaId, svg } = await captchaRes.json();
  const sendRes = await request.post(`${API_BASE}/sms/send`, {
    data: { phone, purpose: 'login', captchaId, captchaCode: extractCaptchaCode(svg) },
  });
  const body = await sendRes.json();
  expect(sendRes.ok(), `sms/send 失败: ${JSON.stringify(body)}`).toBeTruthy();
  expect(body.devCode, 'SMS_PROVIDER=mock 且非生产环境才回显 devCode').toBeTruthy();
  return body.devCode as string;
}

/** 纯 API 登录（新手机号 + 同意协议），返回正式访问令牌与用户快照 */
export async function loginViaApi(
  request: APIRequestContext,
  phone: string,
): Promise<{ token: string; user: Record<string, unknown> }> {
  const code = await requestLoginCode(request, phone);
  const res = await request.post(`${API_BASE}/login-sms`, { data: { phone, code, agree: true } });
  const body = await res.json();
  expect(res.ok(), `login-sms 失败: ${JSON.stringify(body)}`).toBeTruthy();
  expect(typeof body.token).toBe('string');
  expect(body.user).toBeTruthy();
  return { token: body.token as string, user: body.user as Record<string, unknown> };
}

/** 生成一个必然未注册的测试手机号（139 + 8 位时间戳） */
export function uniquePhone(): string {
  return `139${String(Date.now()).slice(-8)}`;
}

/**
 * 写入令牌 + 用户快照后刷新，跳过登录页进入应用。
 * 注意：AuthProvider 首屏从 localStorage 的 yibiao_user 恢复登录态，只写 token 会仍停留在登录页。
 */
export async function enterAppWithToken(
  page: Page,
  token: string,
  user: Record<string, unknown>,
): Promise<void> {
  await page.goto('/');
  await page.evaluate(([t, u]) => {
    localStorage.setItem('yibiao_token', t);
    localStorage.setItem('yibiao_user', JSON.stringify(u));
  }, [token, user]);
  await page.reload();
}
