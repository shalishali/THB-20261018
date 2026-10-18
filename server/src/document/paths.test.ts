import assert from 'node:assert/strict';
import test from 'node:test';
import os from 'node:os';
import path from 'node:path';
import { createWorkspacePaths } from './paths';

// H1 加固回归：工作区 resolve 必须钳制在 workspaceDir 内（查重链路任意文件读取修复）。
test('工作区相对路径正常还原', () => {
  const paths = createWorkspacePaths(1, os.tmpdir());
  const resolved = paths.resolve('duplicate-check/sources/abc.docx');
  assert.equal(resolved, path.join(paths.duplicateCheckSourcesDir, 'abc.docx'));
});

test('绝对路径与 .. 上跳被拒绝', () => {
  const paths = createWorkspacePaths(1, os.tmpdir());
  assert.throws(() => paths.resolve('C:\\Windows\\system32\\config.sam'));
  assert.throws(() => paths.resolve('/etc/passwd'));
  assert.throws(() => paths.resolve('../../someone-else/workspace/technical-plan/tender.md'));
  assert.throws(() => paths.resolve('duplicate-check/../../../../etc/passwd'));
});

test('根目录本身与深嵌子路径允许', () => {
  const paths = createWorkspacePaths(1, os.tmpdir());
  assert.equal(paths.resolve(''), paths.workspaceDir);
  assert.equal(
    paths.resolve('a/b/c/d.md'),
    path.join(paths.workspaceDir, 'a', 'b', 'c', 'd.md'),
  );
});
