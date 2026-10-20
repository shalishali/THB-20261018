// multipart 上传的两条共享收集路径：
//   - collectParsedImports：每 part 落临时文件 → parseDocument（technical_plan / rejection_check 导入用）。
//   - collectRawUploads   ：仅收字节缓冲，不解析（duplicate_check 选文件 / knowledge_base copy_source 用，
//     调用方自行决定落盘与是否再解析）。单 part 失败不阻断整批（收集到 errors）。
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import type { FastifyRequest } from 'fastify';
import { parseDocument, isLibreOfficeMissingError, LOCAL_SUPPORTED_EXTENSIONS, type ParsedImport } from './parser';

// API-09：上传后缀白名单（与 parseDocument 本地支持的扩展一致），白名单外文件在收集阶段拒绝。
export function isAllowedUploadExtension(ext: string): boolean {
  return (LOCAL_SUPPORTED_EXTENSIONS as readonly string[]).includes(ext);
}

export function extensionWhitelistLabel(): string {
  return LOCAL_SUPPORTED_EXTENSIONS.join(' / ');
}

export interface CollectedImports {
  docs: ParsedImport[];
  errors: string[];
  officeMissing: boolean;
}

export async function collectParsedImports(req: FastifyRequest): Promise<CollectedImports> {
  const docs: ParsedImport[] = [];
  const errors: string[] = [];
  let officeMissing = false;
  for await (const part of req.files()) {
    const fileName = String(part.filename || 'upload');
    const ext = path.extname(fileName).toLowerCase();
    if (!isAllowedUploadExtension(ext)) {
      errors.push(`${fileName}: 不支持的文件类型 ${ext || '(无后缀)'}，支持：${extensionWhitelistLabel()}`);
      // 必须把该 part 读空，否则 multipart 流不会推进，后续文件不处理且请求会一直挂起。
      await part.toBuffer().catch(() => undefined);
      continue;
    }
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yibiao-upload-'));
    const tmpPath = path.join(tmpDir, `upload${ext || ''}`);
    try {
      const buffer = await part.toBuffer();
      await fs.writeFile(tmpPath, buffer);
      const result = await parseDocument(tmpPath);
      docs.push({ fileName, ...result });
    } catch (error) {
      if (isLibreOfficeMissingError(error)) officeMissing = true;
      errors.push(`${fileName}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
  return { docs, errors, officeMissing };
}

export interface RawUpload {
  fileName: string;
  ext: string;
  buffer: Buffer;
}

export interface CollectedRawUploads {
  files: RawUpload[];
  errors: string[];
}

// 仅收集 multipart 字节缓冲（不落临时文件、不解析）。调用方自行持久化或再 parseDocument。
// 内存防护上限：全部 part 会 toBuffer 堆在内存里，不限文件数/总字节时单请求即可 OOM 杀进程
// （单实例部署 = 全站不可用）。20 个文件 × 累计 200MB 对标书查重场景足够宽裕。
const RAW_UPLOAD_MAX_FILES = 20;
const RAW_UPLOAD_MAX_TOTAL_BYTES = 200 * 1024 * 1024;

export async function collectRawUploads(req: FastifyRequest): Promise<CollectedRawUploads> {
  const files: RawUpload[] = [];
  const errors: string[] = [];
  let totalBytes = 0;
  for await (const part of req.files()) {
    if (files.length >= RAW_UPLOAD_MAX_FILES) {
      errors.push(`单次最多上传 ${RAW_UPLOAD_MAX_FILES} 个文件，超出部分已忽略`);
      break;
    }
    const fileName = String(part.filename || 'upload');
    const ext = path.extname(fileName).toLowerCase();
    try {
      const buffer = await part.toBuffer();
      totalBytes += buffer.length;
      if (totalBytes > RAW_UPLOAD_MAX_TOTAL_BYTES) {
        errors.push(`上传总大小超过 ${Math.floor(RAW_UPLOAD_MAX_TOTAL_BYTES / 1024 / 1024)}MB 上限，超出部分已忽略`);
        break;
      }
      files.push({ fileName, ext, buffer });
    } catch (error) {
      errors.push(`${fileName}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { files, errors };
}
