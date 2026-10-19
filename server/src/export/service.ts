// 导出编排层（移植自 exportService.cjs createExportService.exportWord 2118-2193）。
// 与桌面差异：
//  - 去掉 dialog.showSaveDialog（浏览器用 Content-Disposition 触发下载，无需选保存路径）。
//  - 去掉 fs.writeFileSync（直接把 buffer 经 HTTP 返回）。
//  - 去掉 shell.openPath（浏览器无此能力；下载完成后由用户自行打开）。
//  - executeRequiredOnlineService ping gate 去掉：mermaid.ink 联网失败由 loadImageWithRetry 兜底降级。
//  - developerLogger no-op（不落 JSONL 调试日志）。
import { buildDocxResult } from './docxBuilder';
import type { BuildProgress } from './docxBuilder';
import { sanitizeFilename, type ExportWordPayload } from './format';

export interface ExportWordOptions {
  onProgress?: (progress: BuildProgress) => void;
}

export interface ExportWordResult {
  buffer: Buffer;
  filename: string;
  warnings: string[];
  stats: { leafCount: number; mermaidCount: number };
}

function buildExportFilename(payload: ExportWordPayload): string {
  // 文件名规则：解析到项目名称 → 「{项目名}方案.docx」；
  // 未解析到（为空或仍是编号占位）→ 直接「技术方案.docx」。
  // 占位判断在 sanitize 之前做（sanitize 会改写字符，导致与编号比对失败）。
  const rawName = String(payload.project_name || '').trim();
  const rawCode = String(payload.project_code || '').trim();
  const unresolved = !rawName || (rawCode && rawName === rawCode);
  if (unresolved) {
    return '技术方案.docx';
  }
  return `${sanitizeFilename(rawName)}方案.docx`;
}

export async function exportWordToBuffer(payload: ExportWordPayload, options: ExportWordOptions = {}): Promise<ExportWordResult> {
  const outline = Array.isArray(payload?.outline) ? payload.outline : [];
  if (!outline.length) {
    throw new Error('大纲为空，无法导出 Word 文件。');
  }

  const onProgress = options.onProgress;
  const filename = buildExportFilename(payload);

  const { buffer, warnings, stats } = await buildDocxResult(
    {
      project_name: payload.project_name,
      outline,
      export_format: payload.export_format ?? null,
      base_dir: payload.base_dir || payload.baseDir,
      mermaid_images: payload.mermaid_images,
      subject_replacement_comment_terms: payload.subject_replacement_comment_terms,
    },
    { onProgress, warnings: [] },
  );

  onProgress?.({
    phase: 'completed',
    progress: 100,
    message: 'Word 文件已生成。',
    warnings,
  });

  return { buffer, filename, warnings, stats };
}
