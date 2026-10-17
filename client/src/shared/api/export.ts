// 导出 Word 的 Web HTTP 层。
// 桌面：IPC export:word → dialog 选路径 → fs.writeFileSync → 返回 {path,...}。
// Web：POST /api/export/word（responseType blob）→ 拿到 docx Blob → 触发浏览器下载。
// 不返回 path（浏览器自管下载）；warnings 留空（图片/Mermaid 失败已在 docx 正文内联占位）。
import { http } from './http';
import { notifyQuotaInsufficient, notifyQuotaRefresh, type QuotaInsufficientDetail } from './quota';

export interface ExportWordPayload {
  requestId?: string;
  project_name?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  outline?: any[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export_format?: any;
  base_dir?: string;
  baseDir?: string;
}

export interface ExportWordResult {
  canceled: boolean;
  message: string;
  warnings: string[];
  path?: string;
}

export interface WordExportProgressEvent {
  requestId?: string;
  phase: 'running' | 'completed' | 'error';
  progress: number;
  message: string;
  warnings?: string[];
}

// 解析 Content-Disposition 里的文件名，优先 RFC 5987 的 filename*=UTF-8''<pct> 形式。
function parseFilenameFromDisposition(disposition: string | undefined): string | null {
  if (!disposition) return null;
  const utf8Match = /filename\*=UTF-8''([^;]+)/i.exec(disposition);
  if (utf8Match?.[1]) {
    try {
      return decodeURIComponent(utf8Match[1].trim());
    } catch {
      /* fall through */
    }
  }
  const plainMatch = /filename="?([^";]+)"?/i.exec(disposition);
  return plainMatch?.[1]?.trim() || null;
}

function triggerBlobDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

// responseType:'blob' 时，错误响应体也是 Blob（服务端 send 的 JSON），需读出再 parse。
// 额度不足（402 QUOTA_INSUFFICIENT）时广播 quota:insufficient，全局充值弹窗自行打开。
async function extractErrorPayload(data: unknown): Promise<{ message: string; quota?: QuotaInsufficientDetail }> {
  let parsed: any = null;
  if (data instanceof Blob) {
    try {
      const text = await data.text();
      try {
        parsed = JSON.parse(text);
      } catch {
        return { message: text };
      }
    } catch {
      return { message: '导出失败' };
    }
  } else if (typeof data === 'string') {
    try {
      parsed = JSON.parse(data);
    } catch {
      return { message: data };
    }
  } else if (data && typeof data === 'object') {
    parsed = data;
  }
  if (parsed && typeof parsed === 'object') {
    if (parsed.code === 'QUOTA_INSUFFICIENT') {
      const quota: QuotaInsufficientDetail = {
        required: Number(parsed.required) || 0,
        balance: Number(parsed.balance) || 0,
        plans: Array.isArray(parsed.plans) ? parsed.plans : undefined,
      };
      notifyQuotaInsufficient(quota);
      return { message: parsed.error || '字数额度不足', quota };
    }
    return { message: String(parsed.error || '导出失败') };
  }
  return { message: '导出失败' };
}

export async function exportWord(payload: ExportWordPayload): Promise<ExportWordResult> {
  try {
    const response = await http.post('/export/word', payload, {
      responseType: 'blob',
      // mermaid.ink 远程转图可能很慢，给 5 分钟。
      timeout: 300000,
    });
    const blob = response.data as Blob;
    const filename = parseFilenameFromDisposition(response.headers['content-disposition'] as string | undefined) || 'export.docx';
    triggerBlobDownload(blob, filename);
    // 扣费成功后广播刷新，顶栏额度立即更新（不等到 60s 的 /me 轮询）。
    notifyQuotaRefresh();
    return {
      canceled: false,
      message: 'Word 已导出，请打开文档核对图片、表格和版式。',
      warnings: [],
    };
  } catch (error) {
    const status = (error as { response?: { status?: number } })?.response?.status;
    const { message } = await extractErrorPayload((error as { response?: { data?: unknown } })?.response?.data);
    if (status === 402) {
      throw new Error(message || '字数额度不足，请充值后重试');
    }
    throw new Error(message);
  }
}

// PDF 导出（API-33）：服务端 Word 构建 + LibreOffice 转换；计费/防重复与 Word 共用同一指纹。
export async function exportPdf(payload: ExportWordPayload): Promise<ExportWordResult> {
  try {
    const response = await http.post('/export/pdf', payload, {
      responseType: 'blob',
      timeout: 300000,
    });
    const blob = response.data as Blob;
    const filename = parseFilenameFromDisposition(response.headers['content-disposition'] as string | undefined) || 'export.pdf';
    triggerBlobDownload(blob, filename);
    notifyQuotaRefresh();
    return {
      canceled: false,
      message: 'PDF 已导出。',
      warnings: [],
    };
  } catch (error) {
    const status = (error as { response?: { status?: number } })?.response?.status;
    const { message } = await extractErrorPayload((error as { response?: { data?: unknown } })?.response?.data);
    if (status === 402) {
      throw new Error(message || '字数额度不足，请充值后重试');
    }
    throw new Error(message);
  }
}
