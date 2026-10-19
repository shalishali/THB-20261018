import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAgentInstructions } from './toolEnvironment';

test('Windows 工作区指令：声明 PowerShell、不再推荐 Unix 命令', () => {
  const text = buildAgentInstructions('win32');
  assert.ok(text.includes('PowerShell'));
  assert.ok(!text.includes('可用命令：rg'), 'Windows 下不应再列出 rg 等 Unix 命令');
  assert.ok(text.includes('read'));
  assert.ok(text.includes('heredoc'));
  assert.ok(text.includes('node 脚本文件名'));
});

test('Linux 工作区指令：保留 Unix 命令清单并标注缺失工具', () => {
  const text = buildAgentInstructions('linux', ['rg', 'jq']);
  assert.ok(text.includes('rg、fd、jq'));
  assert.ok(text.includes('当前缺失：rg, jq'));
  assert.ok(!text.includes('PowerShell'));
});
