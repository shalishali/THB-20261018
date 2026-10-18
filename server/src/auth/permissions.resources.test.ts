import assert from 'node:assert/strict';
import test from 'node:test';
import type { PrismaClient } from '@prisma/client';

import { ASSIGNABLE_MODULE_IDS, DEFAULT_OPEN_MODULE_IDS, createRequireModule, parseModules } from './permissions';

test('资源下载不再是可授予模块', () => {
  assert.equal((ASSIGNABLE_MODULE_IDS as readonly string[]).includes('resources'), false);
});

test('历史 modules 中的 resources 会被权限解析过滤', () => {
  assert.deepEqual(parseModules('["resources","docs","resources"]'), ['docs']);
});

test('格式管理是默认开放模块，新注册用户无需授予', () => {
  assert.equal((DEFAULT_OPEN_MODULE_IDS as readonly string[]).includes('template-settings'), true);
});

test('默认开放模块门禁对未授予的普通用户放行（不返回 403）', async () => {
  const prisma = { user: { findUnique: async () => ({ modules: '[]' }) } } as unknown as PrismaClient;
  const req = { user: { id: 1, role: 'user' } } as never;
  let forbidden = false;
  const reply = {
    code: () => {
      forbidden = true;
      return { send: () => undefined };
    },
  } as never;
  await createRequireModule(prisma, 'template-settings')(req, reply);
  assert.equal(forbidden, false);
});

test('非默认开放模块未授予仍返回 403', async () => {
  const prisma = { user: { findUnique: async () => ({ modules: '[]' }) } } as unknown as PrismaClient;
  const req = { user: { id: 1, role: 'user' } } as never;
  let forbidden = false;
  const reply = {
    code: () => {
      forbidden = true;
      return { send: () => undefined };
    },
  } as never;
  await createRequireModule(prisma, 'knowledge-base')(req, reply);
  assert.equal(forbidden, true);
});
