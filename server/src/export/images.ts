// 图片加载（移植自 exportService.cjs 1024-1174）。
// 与桌面差异：
//  - yibiao-asset://generated-images|imported-images → 返回 null（Web 服务端尚无 AI 生成图/导入图产物，P6/P7）。
//  - WebP→PNG 不再走 electron nativeImage；docx 库本身不支持 webp，故 webp 抛错 → 上游降级为占位 warning。
//  - data: / http(s): / file: / 相对路径 全部保留，但 web 端多用户共享服务器，增加三类加固：
//    (1) SSRF：http(s) 仅允许公网地址——字面量 IP 与 DNS 解析结果都做私网/环回/链路本地校验，
//        手动跟随重定向并逐跳复检（防 302 跳内网）；(2) 本地路径/file:// 钳制在 baseDir 内，
//        baseDir 缺省时一律不读本地文件（服务端文件系统对客户端不可枚举）；(3) 下载 20s 超时 + 20MB 上限。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import { imageSize } from 'image-size';

const REMOTE_TIMEOUT_MS = 20_000;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const parts = ip.split('.').map(Number);
    if (parts[0] === 10 || parts[0] === 127 || parts[0] === 0) return true;
    if (parts[0] === 169 && parts[1] === 254) return true; // 链路本地（含云厂商 metadata 169.254.169.254）
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    if (parts[0] === 192 && parts[1] === 168) return true;
    if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return true; // CGNAT
    return false;
  }
  if (isIP(ip) === 6) {
    const lower = ip.toLowerCase();
    if (lower === '::' || lower === '::1') return true;
    if (lower.startsWith('fe80') || lower.startsWith('fc') || lower.startsWith('fd')) return true; // 链路本地 / ULA
    if (lower.startsWith('::ffff:')) return isPrivateAddress(lower.slice('::ffff:'.length)); // IPv4-mapped
    return false;
  }
  return true; // 无法识别的格式按拒绝处理
}

// 校验 http(s) URL 指向公网：字面量 IP 直接判定；域名解析出多个地址时全部必须公网。
async function assertPublicHttpUrl(url: URL): Promise<void> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`不允许的图片协议：${url.protocol}`);
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(hostname)) {
    if (isPrivateAddress(hostname)) throw new Error(`图片地址指向内网，已拒绝：${hostname}`);
    return;
  }
  if (/^(localhost|.*\.local|.*\.internal|.*\.localhost)$/i.test(hostname)) {
    throw new Error(`图片地址指向内网主机名，已拒绝：${hostname}`);
  }
  const resolved = await lookup(hostname, { all: true }).catch(() => {
    throw new Error(`图片域名解析失败：${hostname}`);
  });
  if (resolved.some((address) => isPrivateAddress(address.address))) {
    throw new Error(`图片域名解析到内网地址，已拒绝：${hostname}`);
  }
}

async function fetchRemoteImage(rawUrl: string): Promise<{ buffer: Buffer; type: LoadedImage['type'] }> {
  let current = new URL(rawUrl);
  await assertPublicHttpUrl(current);
  // 手动跟随重定向：每跳重新过 SSRF 校验，防止公网 302 跳内网绕过首跳检查。
  for (let hop = 0; hop < 3; hop += 1) {
    const response = await fetch(current, { redirect: 'manual', signal: AbortSignal.timeout(REMOTE_TIMEOUT_MS) });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      void response.body?.cancel();
      if (!location) throw new Error(`图片下载失败：重定向缺少 Location（${response.status}）`);
      current = new URL(location, current);
      await assertPublicHttpUrl(current);
      continue;
    }
    if (!response.ok) {
      void response.body?.cancel();
      throw new Error(`图片下载失败：${current.href}（HTTP ${response.status}）`);
    }
    const contentLength = Number(response.headers.get('content-length') || 0);
    if (contentLength > MAX_IMAGE_BYTES) {
      void response.body?.cancel();
      throw new Error(`图片超过大小上限（${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)}MB）：${current.href}`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > MAX_IMAGE_BYTES) {
      throw new Error(`图片超过大小上限（${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)}MB）：${current.href}`);
    }
    const type = imageTypeFromMime(response.headers.get('content-type')) || imageTypeFromPath(current.pathname);
    return { buffer, type };
  }
  throw new Error('图片下载重定向次数过多');
}

export interface LoadedImage {
  buffer: Buffer;
  type: 'png' | 'jpg' | 'gif' | 'bmp' | 'webp' | null;
}

export function imageTypeFromMime(mime: string | undefined | null): LoadedImage['type'] {
  if (!mime) return null;
  if (mime.includes('png')) return 'png';
  if (mime.includes('jpeg') || mime.includes('jpg')) return 'jpg';
  if (mime.includes('gif')) return 'gif';
  if (mime.includes('bmp')) return 'bmp';
  if (mime.includes('webp')) return 'webp';
  return null;
}

export function imageTypeFromPath(filePath: string | undefined | null): LoadedImage['type'] {
  const ext = path.extname(filePath || '').toLowerCase().replace('.', '');
  if (ext === 'jpeg') return 'jpg';
  return ['png', 'jpg', 'gif', 'bmp', 'webp'].includes(ext) ? (ext as LoadedImage['type']) : null;
}

export function describeImageSourceForLog(source: string): Record<string, unknown> {
  const value = String(source || '').trim();
  if (!value) return { kind: 'empty' };
  if (/^data:/i.test(value)) return { kind: 'data-url' };
  try {
    const url = new URL(value);
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      return { kind: 'remote', protocol: url.protocol.replace(':', ''), host: url.hostname, extension: path.extname(url.pathname || '').toLowerCase() };
    }
    if (url.protocol === 'file:') {
      return { kind: 'local-file-url', extension: path.extname(url.pathname || '').toLowerCase() };
    }
    return { kind: 'url', protocol: url.protocol.replace(':', '') };
  } catch {
    return { kind: path.isAbsolute(value) ? 'local-path' : 'relative-path', extension: path.extname(value).toLowerCase() };
  }
}

// WebP docx 不支持，也无法在服务端无 sharp 时转码 → 抛错让上游降级占位。
export function normalizeImageForDocx(loaded: LoadedImage): LoadedImage {
  if (!loaded?.buffer || !loaded.type) return loaded;
  if (loaded.type !== 'webp') return loaded;
  throw new Error('WebP 图片暂不支持导出（服务端未启用 sharp 转码）');
}

export async function loadImage(source: string, context: { baseDir?: string; allowedRoots?: string[] } = {}): Promise<LoadedImage | null> {
  const url = String(source || '').trim();
  if (!url) return null;

  const dataUrlMatch = /^data:([^;,]+);base64,(.+)$/i.exec(url);
  if (dataUrlMatch) {
    const buffer = Buffer.from(dataUrlMatch[2], 'base64');
    if (buffer.length > MAX_IMAGE_BYTES) {
      throw new Error(`内嵌图片超过大小上限（${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)}MB）`);
    }
    return { buffer, type: imageTypeFromMime(dataUrlMatch[1]) };
  }

  // yibiao-asset:// — 桌面解析到 generated-images / imported-images 目录；Web 服务端目前无此产物。
  if (/^yibiao-asset:\/\//i.test(url)) {
    return null;
  }

  if (/^https?:\/\//i.test(url)) {
    // SSRF 加固后仍保持"公网图片可引用"的产品能力（mermaid.ink 渲染也走这里）
    return fetchRemoteImage(url);
  }

  // 本地路径 / file://：只在显式提供 baseDir 且解析结果未越出该目录时才读盘。
  // baseDir 由服务端路由固定为项目工作区（routes/export.ts），客户端传入的 base_dir 不再被信任。
  const baseDir = context.baseDir ? path.resolve(context.baseDir) : '';
  if (!baseDir) {
    return null;
  }
  const fileUrlPrefix = 'file://';
  const rawPath = url.startsWith(fileUrlPrefix) ? fileURLToPath(url) : url;
  const resolvedPath = path.isAbsolute(rawPath)
    ? path.resolve(rawPath)
    : path.resolve(baseDir, rawPath);
  const normalize = (value: string): string => (process.platform === 'win32' ? value.toLowerCase() : value);
  const allowedRoots = [baseDir, ...(context.allowedRoots || []).map((root) => path.resolve(root))];
  const insideAllowedRoot = allowedRoots.some((root) => {
    const lhs = normalize(root);
    const rhs = normalize(resolvedPath);
    return rhs === lhs || rhs.startsWith(lhs + path.sep);
  });
  if (!insideAllowedRoot) {
    return null; // 越出工作区/受信缓存目录 → 按无图处理，上游降级为占位提示
  }

  if (!fs.existsSync(resolvedPath)) {
    return null;
  }
  try {
    if (fs.statSync(resolvedPath).size > MAX_IMAGE_BYTES) return null;
  } catch {
    return null;
  }

  return { buffer: fs.readFileSync(resolvedPath), type: imageTypeFromPath(resolvedPath) };
}

const REMOTE_IMAGE_RETRY_ATTEMPTS = 2;
const REMOTE_IMAGE_RETRY_DELAY_MS = 3000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function loadImageWithRetry(
  source: string,
  context: { baseDir?: string; allowedRoots?: string[] } = {},
  options: { retryAttempts?: number; retryDelayMs?: number; onRetry?: (attempt: number, error: unknown) => void } = {},
): Promise<LoadedImage | null> {
  const retryAttempts = Math.max(0, Number(options.retryAttempts ?? REMOTE_IMAGE_RETRY_ATTEMPTS) || 0);
  const retryDelayMs = Math.max(0, Number(options.retryDelayMs ?? REMOTE_IMAGE_RETRY_DELAY_MS) || 0);
  let attempt = 0;
  while (attempt <= retryAttempts) {
    try {
      return await loadImage(source, context);
    } catch (error) {
      if (attempt >= retryAttempts) throw error;
      attempt += 1;
      options.onRetry?.(attempt, error);
      if (retryDelayMs > 0) await delay(retryDelayMs);
    }
  }
  return null;
}

export function measureImage(buffer: Buffer): { width: number; height: number } {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = imageSize(buffer as any) as { width?: number; height?: number };
  return { width: result.width || 0, height: result.height || 0 };
}
