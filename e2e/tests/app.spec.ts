import { expect, test } from '@playwright/test';
import { API_BASE, enterAppWithToken, loginViaApi, uniquePhone } from './helpers';

// 主链路 2：登录后进入应用 + 项目 CRUD（真实数据库）
test.describe('登录后应用与项目', () => {
  test('注入令牌后进入应用并拿到当前用户', async ({ page, request }) => {
    const { token, user } = await loginViaApi(request, uniquePhone());
    await enterAppWithToken(page, token, user);

    // 应用壳层出现（侧边栏/仪表盘），登录卡不再显示
    await expect(page.getByRole('heading', { name: /欢迎使用/ })).toBeHidden({ timeout: 20_000 });
    await expect(page.getByText('仪表盘').first()).toBeVisible({ timeout: 20_000 });

    const me = await request.get(`${API_BASE}/me`, { headers: { Authorization: `Bearer ${token}` } });
    expect(me.ok()).toBeTruthy();
    const body = await me.json();
    expect(body.user?.role).toBe('user');
    expect(body.user?.phone).toBeTruthy();
  });

  test('项目创建 → 列表可见 → 改名 → 删除', async ({ request }) => {
    const { token } = await loginViaApi(request, uniquePhone());
    const auth = { Authorization: `Bearer ${token}` };

    const created = await request.post(`${API_BASE}/projects`, {
      headers: auth,
      data: { name: `E2E 项目 ${Date.now()}` },
    });
    expect(created.ok()).toBeTruthy();
    const project = await created.json();
    expect(project.id).toBeTruthy();
    expect(project.projectCode).toMatch(/^XM\d{4}-\d{4,}$/);

    try {
      const list = await request.get(`${API_BASE}/projects`, { headers: auth });
      const projects = await list.json();
      expect(projects.some((p: { id: number }) => p.id === project.id)).toBeTruthy();

      const patched = await request.patch(`${API_BASE}/projects/${project.id}`, {
        headers: auth,
        data: { description: 'E2E 更新说明' },
      });
      expect(patched.ok()).toBeTruthy();

      // 普通用户不能访问用户管理
      const users = await request.get(`${API_BASE}/users`, { headers: auth });
      expect(users.status()).toBe(403);
    } finally {
      const deleted = await request.delete(`${API_BASE}/projects/${project.id}`, { headers: auth });
      expect(deleted.ok()).toBeTruthy();
    }
  });

  test('未登录访问受保护接口返回 401', async ({ request }) => {
    const me = await request.get(`${API_BASE}/me`);
    expect(me.status()).toBe(401);
  });
});
