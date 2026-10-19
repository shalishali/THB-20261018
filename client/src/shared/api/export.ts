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
  /** 浏览器本地预渲染的 Mermaid 图（PNG data URL），服务端优先使用，避免导出时联网 mermaid.ink */
  mermaid_images?: Array<{ code: string; data_url: string }>;
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

// ── 浏览器本地预渲染 Mermaid ─────────────────────────────────────────────
// 服务端原先逐张请求 mermaid.ink 转图，国内网络下 5 张图要几分钟；这里用浏览器里已有的
// mermaid（与正文预览同一套渲染）先转成 PNG data URL 随请求带上，服务端直接嵌入。
function collectMermaidCodes(outline: unknown): string[] {
  const codes: string[] = [];
  const seen = new Set<string>();
  const visit = (nodes: any[]): void => {
    for (const node of nodes || []) {
      const content = typeof node?.content === 'string' ? node.content : '';
      for (const matched of content.matchAll(/```mermaid\s*\n([\s\S]*?)```/gi)) {
        const code = matched[1].trim();
        if (code && !seen.has(code)) {
          seen.add(code);
          codes.push(code);
        }
      }
      if (Array.isArray(node?.children)) visit(node.children);
    }
  };
  if (Array.isArray(outline)) visit(outline);
  return codes;
}

async function renderMermaidToPngDataUrl(code: string): Promise<string | null> {
  try {
    const { default: mermaid } = await import('mermaid');
    mermaid.initialize({ startOnLoad: false, theme: 'default', securityLevel: 'strict' });
    const { svg } = await mermaid.render(`export-mermaid-${Math.random().toString(36).slice(2)}`, code);
    const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
    const root = doc.documentElement;
    const viewBox = (root.getAttribute('viewBox') || '').split(/[\s,]+/).map(Number);
    const width = Math.max(1, Math.round(viewBox[2] || Number(root.getAttribute('width')) || 800));
    const height = Math.max(1, Math.round(viewBox[3] || Number(root.getAttribute('height')) || 600));
    const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    try {
      const image = await new Promise<HTMLImageElement>((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('SVG 载入失败'));
        img.src = url;
      });
      const canvas = document.createElement('canvas');
      canvas.width = Math.min(2400, width * 2);
      canvas.height = Math.min(2400, height * 2);
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL('image/png');
    } finally {
      URL.revokeObjectURL(url);
    }
  } catch {
    return null;
  }
}

async function prerenderMermaidImages(outline: unknown): Promise<Array<{ code: string; data_url: string }>> {
  const codes = collectMermaidCodes(outline);
  const images: Array<{ code: string; data_url: string }> = [];
  for (const code of codes.slice(0, 20)) {
    const dataUrl = await renderMermaidToPngDataUrl(code);
    if (dataUrl) images.push({ code, data_url: dataUrl });
  }
  return images;
}

export async function exportWord(payload: ExportWordPayload): Promise<ExportWordResult> {
  try {
    // 先在浏览器本地把 Mermaid 转成 PNG（毫秒级），服务端就不再逐张联网转图。
    const mermaidImages = await prerenderMermaidImages(payload.outline);
    const response = await http.post('/export/word', { ...payload, mermaid_images: mermaidImages }, {
      responseType: 'blob',
      // 未预渲染成功时服务端会回落 mermaid.ink，仍给足时间。
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
