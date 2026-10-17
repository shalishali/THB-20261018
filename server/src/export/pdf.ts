// PDF 导出（API-33）：复用 Word 构建产物，经 LibreOffice 无头转换成 PDF。
// 依赖服务器已安装 LibreOffice（与文档解析同源）；可用 SOFFICE_PATH 指定可执行文件路径。
// LibreOffice 查找逻辑与解析模块同源：env SOFFICE_PATH → PATH → 常见安装路径逐个探测。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CONVERT_TIMEOUT_MS = 180_000;

/** 多路径探测 LibreOffice 可执行文件（同源 convert.mjs 逻辑，含 Windows 常见安装路径）。 */
function findSofficeExecutable(): string | null {
  const candidates = ([
    process.env.SOFFICE_PATH?.trim(),
    process.env.LIBREOFFICE_PATH?.trim(),
    'soffice',
    'libreoffice',
    'C:\\Program Files\\LibreOffice\\program\\soffice.exe',
    'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe',
  ] as (string | undefined)[])
    .map((item) => item?.trim())
    .filter((item): item is string => Boolean(item));

  const checked = new Set<string>();
  for (const candidate of candidates) {
    const key = candidate.toLowerCase();
    if (checked.has(key)) continue;
    checked.add(key);

    if (path.isAbsolute(candidate)) {
      if (fs.existsSync(candidate)) return candidate;
      continue;
    }

    // 相对路径（PATH 中的命令）：用 where / which 验证可执行
    try {
      const check = require('node:child_process').spawnSync(candidate, ['--version'], { timeout: 5000, windowsHide: true });
      if (check.status === 0) return candidate;
    } catch {
      /* 不可执行，继续下一个 */
    }
  }
  return null;
}

function runSoffice(executable: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true });
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('PDF 转换超时（180 秒）'));
    }, CONVERT_TIMEOUT_MS);
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(new Error(`PDF 转换失败：无法启动 LibreOffice（${error.message}）。请确认服务器已安装并在 PATH 中，或配置 SOFFICE_PATH。`));
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`PDF 转换失败（退出码 ${code}）：${stderr.slice(0, 300)}`));
    });
  });
}

/** docx Buffer → PDF Buffer（临时目录转换，finally 清理）。 */
export async function convertDocxBufferToPdf(docx: Buffer): Promise<Buffer> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yibiao-pdf-'));
  try {
    const sourcePath = path.join(dir, 'source.docx');
    fs.writeFileSync(sourcePath, docx);

    const executable = findSofficeExecutable();
    if (!executable) {
      throw new Error('未找到 LibreOffice 可执行文件。请安装 LibreOffice 或通过 SOFFICE_PATH 环境变量指定路径。');
    }

    await runSoffice(executable, ['--headless', '--norestore', '--convert-to', 'pdf', '--outdir', dir, sourcePath]);
    const pdfPath = path.join(dir, 'source.pdf');
    if (!fs.existsSync(pdfPath)) {
      throw new Error('PDF 转换失败：LibreOffice 未产出 PDF 文件');
    }
    return fs.readFileSync(pdfPath);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
