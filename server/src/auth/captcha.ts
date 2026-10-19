// 图形验证码（API-02）：短信发送/密码登录前的人机校验。
// 2026-10-19 加固：改为服务端渲染 PNG 位图。旧实现把验证码字符以明文 <text> 拼进 SVG，
// 脚本正则即可直接读出答案，人机校验形同虚设；位图方案下答案只存在于服务端内存。
// 内存 Map 存储（TTL 5 分钟，一次性消费）。多实例/多进程部署时需换共享存储（二期）。
import { randomBytes, randomUUID } from 'node:crypto';
import { createCanvas } from '@napi-rs/canvas';

const CAPTCHA_TTL_MS = 5 * 60 * 1000;
const CAPTCHA_MAX_ENTRIES = 2000;
// 去掉易混淆字符（0/O、1/I/l）
const CAPTCHA_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CAPTCHA_LENGTH = 4;
const CHAR_COLORS = ['#1f3a8a', '#0f766e', '#7c2d12', '#4a1d96', '#334155'];
const CAPTCHA_WIDTH = 150;
const CAPTCHA_HEIGHT = 46;

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

function pickColor(): string {
  return CHAR_COLORS[randomInt(0, CHAR_COLORS.length - 1)];
}

// 渲染成 PNG：字符画进 canvas 后只留下像素，客户端拿不到可解析的文本。
function renderPng(code: string): Buffer {
  const canvas = createCanvas(CAPTCHA_WIDTH, CAPTCHA_HEIGHT);
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#f6f8fc';
  ctx.fillRect(0, 0, CAPTCHA_WIDTH, CAPTCHA_HEIGHT);

  // 干扰线
  for (let i = 0; i < 4; i++) {
    ctx.globalAlpha = 0.35;
    ctx.strokeStyle = pickColor();
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(randomInt(0, CAPTCHA_WIDTH), randomInt(0, CAPTCHA_HEIGHT));
    ctx.lineTo(randomInt(0, CAPTCHA_WIDTH), randomInt(0, CAPTCHA_HEIGHT));
    ctx.stroke();
  }
  // 干扰点
  ctx.globalAlpha = 0.5;
  ctx.fillStyle = '#64748b';
  for (let i = 0; i < 24; i++) {
    ctx.fillRect(randomInt(2, CAPTCHA_WIDTH - 2), randomInt(2, CAPTCHA_HEIGHT - 2), 1.5, 1.5);
  }
  ctx.globalAlpha = 1;

  // 逐字符旋转、位移、着色
  for (let i = 0; i < code.length; i++) {
    const x = 22 + i * 30 + randomInt(-4, 4);
    const y = 34 + randomInt(-3, 3);
    const rotate = (randomInt(-24, 24) * Math.PI) / 180;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(rotate);
    ctx.font = `700 ${randomInt(25, 30)}px "DejaVu Sans", "Microsoft YaHei", sans-serif`;
    ctx.fillStyle = pickColor();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(code[i], 0, 0);
    ctx.restore();
  }

  return canvas.toBuffer('image/png');
}

export interface CaptchaChallenge {
  captchaId: string;
  /** PNG data URL（image/png;base64,...），前端直接作为 <img src> 使用 */
  image: string;
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
  const png = renderPng(code);
  return { captchaId, image: `data:image/png;base64,${png.toString('base64')}` };
}

/**
 * 仅供同进程单元测试使用：取指定 captchaId 的明文答案。
 * 注意：绝不能在 HTTP 响应里暴露（生产序列化路径不引用本函数）。
 */
export function __getCaptchaAnswerForTest(captchaId: string): string | null {
  const entry = store.get(captchaId);
  if (!entry || entry.expiresAt <= Date.now()) return null;
  return entry.code;
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
