// 图形验证码（API-02）：注册/登录防刷。
// 零依赖实现：随机 4 位字符 + 服务端自绘 SVG（噪线/干扰点/逐字符旋转位移），
// 内存 Map 存储（TTL 5 分钟，一次性消费）。多实例/多进程部署时需换共享存储（二期）。
import { randomBytes, randomUUID } from 'node:crypto';

const CAPTCHA_TTL_MS = 5 * 60 * 1000;
const CAPTCHA_MAX_ENTRIES = 2000;
// 去掉易混淆字符（0/O、1/I/l）
const CAPTCHA_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CAPTCHA_LENGTH = 4;
const CHAR_COLORS = ['#1f3a8a', '#0f766e', '#7c2d12', '#4a1d96', '#334155'];

interface CaptchaEntry {
  code: string;
  expiresAt: number;
}

const store = new Map<string, CaptchaEntry>();

function sweepExpired(): void {
  const now = Date.now();
  for (const [id, entry] of store) {
    if (entry.expiresAt <= now) store.delete(id);
  }
}

function randomInt(min: number, max: number): number {
  return min + Math.floor(Math.random() * (max - min + 1));
}

function renderSvg(code: string): string {
  const width = 150;
  const height = 46;
  let texts = '';
  for (let i = 0; i < code.length; i++) {
    const ch = code[i];
    const x = 22 + i * 30 + randomInt(-4, 4);
    const y = 32 + randomInt(-3, 3);
    const rotate = randomInt(-24, 24);
    const fontSize = randomInt(25, 30);
    const fill = CHAR_COLORS[randomInt(0, CHAR_COLORS.length - 1)];
    texts += `<text x="${x}" y="${y}" font-family="'Courier New',monospace" font-size="${fontSize}" font-weight="700" fill="${fill}" transform="rotate(${rotate} ${x} ${y})">${ch}</text>`;
  }
  let lines = '';
  for (let i = 0; i < 4; i++) {
    lines += `<line x1="${randomInt(0, width)}" y1="${randomInt(0, height)}" x2="${randomInt(0, width)}" y2="${randomInt(0, height)}" stroke="${CHAR_COLORS[randomInt(0, CHAR_COLORS.length - 1)]}" stroke-opacity="0.35" stroke-width="1.2"/>`;
  }
  let dots = '';
  for (let i = 0; i < 18; i++) {
    dots += `<circle cx="${randomInt(2, width - 2)}" cy="${randomInt(2, height - 2)}" r="1" fill="#64748b" fill-opacity="0.5"/>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="captcha"><rect width="${width}" height="${height}" rx="8" fill="#f6f8fc"/>${lines}${dots}${texts}</svg>`;
}

export interface CaptchaChallenge {
  captchaId: string;
  svg: string;
}

export function generateCaptcha(): CaptchaChallenge {
  if (store.size > CAPTCHA_MAX_ENTRIES) sweepExpired();
  let code = '';
  const bytes = randomBytes(CAPTCHA_LENGTH);
  for (let i = 0; i < CAPTCHA_LENGTH; i++) {
    code += CAPTCHA_ALPHABET[bytes[i] % CAPTCHA_ALPHABET.length];
  }
  const captchaId = randomUUID();
  store.set(captchaId, { code, expiresAt: Date.now() + CAPTCHA_TTL_MS });
  return { captchaId, svg: renderSvg(code) };
}

// 一次性校验：无论对错都消费掉该 id，防止同一验证码反复试错。
export function verifyCaptcha(captchaId: unknown, captchaCode: unknown): boolean {
  if (typeof captchaId !== 'string' || typeof captchaCode !== 'string') return false;
  const entry = store.get(captchaId);
  store.delete(captchaId);
  if (!entry) return false;
  if (entry.expiresAt <= Date.now()) return false;
  return entry.code === captchaCode.trim().toUpperCase();
}
