// PDF 导出（API-33）：复用 Word 构建产物，经 LibreOffice 无头转换成 PDF。
// 依赖服务器已安装 LibreOffice（与文档解析同源）；可用 SOFFICE_PATH 指定可执行文件路径。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CONVERT_TIMEOUT_MS = 180_000;

function runSoffice(args: string[]): Promise<void> {
  const executable = process.env.SOFFICE_PATH?.trim() || 'soffice';
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
    await runSoffice(['--headless', '--norestore', '--convert-to', 'pdf', '--outdir', dir, sourcePath]);
    const pdfPath = path.join(dir, 'source.pdf');
    if (!fs.existsSync(pdfPath)) {
      throw new Error('PDF 转换失败：LibreOffice 未产出 PDF 文件');
    }
    return fs.readFileSync(pdfPath);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
