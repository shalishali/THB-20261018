import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadImage } from './images';

// SSRF 加固回归：导出图片加载必须拒绝内网/环回/链路本地地址（含云 metadata）。
test('http 图片拒绝私网与链路本地字面量 IP', async () => {
  await assert.rejects(() => loadImage('http://127.0.0.1:3000/secret.png'));
  await assert.rejects(() => loadImage('http://169.254.169.254/latest/meta-data/'));
  await assert.rejects(() => loadImage('http://10.0.0.5/img.png'));
  await assert.rejects(() => loadImage('http://192.168.1.10/img.png'));
  await assert.rejects(() => loadImage('http://[::1]/img.png'));
});

test('http 图片拒绝内网主机名与本地路径缺省不读盘', async () => {
  await assert.rejects(() => loadImage('http://localhost/img.png'));
  await assert.rejects(() => loadImage('http://intranet.corp.local/img.png'));
  // file:// 走本地路径分支：无 baseDir 时返回 null（不读盘），而不是抛错或读文件
  assert.equal(await loadImage('file:///etc/passwd'), null);
});

// 本地路径钳制回归：无 baseDir 不读盘；越出 baseDir 拒绝；工作区内正常读取。
test('本地文件读取被钳制在 baseDir 内', async () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yibiao-img-test-'));
  try {
    const inside = path.join(baseDir, 'a.png');
    const PNG_BYTES = Buffer.from(
      '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000154a24f5f0000000049454e44ae426082',
      'hex',
    );
    fs.writeFileSync(inside, PNG_BYTES);
    const outside = path.join(path.dirname(baseDir), 'outside.png');

    assert.equal(await loadImage('a.png', {}), null); // 无 baseDir → 不读本地文件
    assert.equal(await loadImage(outside, { baseDir }), null); // 越出 baseDir → 按无图处理

    const loaded = await loadImage('a.png', { baseDir });
    assert.ok(loaded);
    assert.equal(loaded.type, 'png');
    // 注意：`await x()?.type` 按规范解析为 `await (x()?.type)`（先取属性再 await，恒为 undefined），
    // 必须先 await 再取属性
    assert.equal((await loadImage(inside, { baseDir }))?.type, 'png');
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});
