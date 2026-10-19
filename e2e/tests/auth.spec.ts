import { expect, test } from '@playwright/test';
import { API_BASE, requestLoginCode, uniquePhone } from './helpers';

// 主链路 1：登录页 → 短信验证码登录（未注册自动建号）→ 进入应用
test.describe('短信登录', () => {
  test('登录页正常渲染', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: /欢迎使用/ })).toBeVisible();
    await expect(page.getByPlaceholder('请输入 11 位手机号')).toBeVisible();
    await expect(page.getByPlaceholder('6 位数字')).toBeVisible();
  });

  test('验证码登录成功并建立会话', async ({ page, request }) => {
    const phone = uniquePhone();
    const code = await requestLoginCode(request, phone);

    await page.goto('/');
    await page.getByPlaceholder('请输入 11 位手机号').fill(phone);
    await page.getByPlaceholder('6 位数字').fill(code);
    // 首次登录需勾选协议（新手机号）
    const agree = page.locator('.login-agree-check input[type="checkbox"]');
    if (await agree.count()) await agree.check();
    await page.getByRole('button', { name: /登录 \/ 注册/ }).click();

    // 登录成功：登录卡消失、localStorage 拿到 token
    await expect(page.getByRole('heading', { name: /欢迎使用/ })).toBeHidden({ timeout: 20_000 });
    const token = await page.evaluate(() => localStorage.getItem('yibiao_token'));
    expect(token && token.length > 20).toBeTruthy();
  });

  test('错误验证码被拒绝并提示', async ({ page }) => {
    const phone = uniquePhone();
    await page.goto('/');
    await page.getByPlaceholder('请输入 11 位手机号').fill(phone);
    await page.getByPlaceholder('6 位数字').fill('000000');
    const agree = page.locator('.login-agree-check input[type="checkbox"]');
    if (await agree.count()) await agree.check();
    await page.getByRole('button', { name: /登录 \/ 注册/ }).click();

    // 未发送过验证码 → 服务端返回「验证码已失效」；登录页展示错误而不是进入应用
    await expect(page.locator('.login-message.is-error')).toBeVisible({ timeout: 20_000 });
    const token = await page.evaluate(() => localStorage.getItem('yibiao_token'));
    expect(token).toBeNull();
  });

  test('旧注册接口已下线（410）', async ({ request }) => {
    const res = await request.post(`${API_BASE}/register`, { data: { phone: uniquePhone(), password: 'Whatever1!' } });
    expect(res.status()).toBe(410);
  });
});
