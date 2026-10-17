// M1 加固：AI 供应商密钥静态加密（at-rest）。
// AppConfig.data 是单个 JSON 列，此前 api_key/mineru_token 全明文落库——拖库/备份泄露即丢全部密钥。
// 这里用 AES-256-GCM 对密钥字段做透明加解密：
//   - 写库前 sealSecretsInConfig：非空且未加密的密钥 → `enc:v1:<iv>.<tag>.<ct>`（base64url）；
//   - 读库后 openSecretsInConfig：带前缀的字段解密回明文（进程内缓存仍是明文，供调用方使用）；
//   - 存量明文数据兼容：无前缀直接透传，下次保存时自动补加密；
//   - 未配置 CONFIG_ENCRYPTION_KEY 时降级为明文（打一次告警），行为与旧版一致。
// 密钥派生：对 env 口径做 sha256 得 32 字节 key。轮换密钥 = 换 env + 重新保存一次配置。
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const PREFIX = 'enc:v1:';

let cachedKey: Buffer | null | undefined;

function getKey(): Buffer | null {
  if (cachedKey !== undefined) return cachedKey;
  const raw = process.env.CONFIG_ENCRYPTION_KEY?.trim() || '';
  cachedKey = raw ? createHash('sha256').update(raw).digest() : null;
  if (!cachedKey) {
    console.warn('[config] CONFIG_ENCRYPTION_KEY 未设置：AI 密钥将以明文落库。生产部署建议设置（任意长随机字符串），见 .env.example');
  }
  return cachedKey;
}

export function encryptSecret(plain: string): string {
  const key = getKey();
  if (!key || !plain || plain.startsWith(PREFIX)) return plain;
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString('base64url')}.${tag.toString('base64url')}.${ct.toString('base64url')}`;
}

export function decryptSecret(value: string): string {
  if (!value || !value.startsWith(PREFIX)) return value;
  const key = getKey();
  if (!key) {
    console.error('[config] 检测到已加密的密钥但未设置 CONFIG_ENCRYPTION_KEY，无法解密——请核对部署环境变量');
    return '';
  }
  try {
    const [ivB64, tagB64, ctB64] = value.slice(PREFIX.length).split('.');
    if (!ivB64 || !tagB64 || !ctB64) throw new Error('malformed ciphertext');
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64url')), decipher.final()]).toString('utf8');
  } catch (error) {
    // 密钥不匹配或密文损坏：宁可置空也不把坏数据当 key 用（调用方会收到"未配置"语义）
    console.error('[config] 密钥字段解密失败（CONFIG_ENCRYPTION_KEY 与写入时不一致？）：', error instanceof Error ? error.message : error);
    return '';
  }
}

// 与 redactSecrets 同一套字段清单：所有会被下发/使用的密钥位置（含多 Key 池数组）。
function walkSecrets(config: any, transform: (value: string) => string): void {
  if (!config || typeof config !== 'object') return;
  const apply = (obj: any, key: string): void => {
    if (typeof obj[key] === 'string' && obj[key]) obj[key] = transform(obj[key]);
  };
  for (const group of ['text_model_profiles', 'image_model_profiles']) {
    const profiles = config[group];
    if (profiles && typeof profiles === 'object') {
      for (const provider of Object.keys(profiles)) {
        const profile = profiles[provider];
        if (profile && typeof profile === 'object') {
          apply(profile, 'api_key');
          if (Array.isArray(profile.api_keys)) {
            profile.api_keys = profile.api_keys.map((item: unknown) => (typeof item === 'string' && item ? transform(item) : item));
          }
        }
      }
    }
  }
  if (config.image_model && typeof config.image_model === 'object') apply(config.image_model, 'api_key');
  if (config.file_parser && typeof config.file_parser === 'object') apply(config.file_parser, 'mineru_token');
  apply(config, 'api_key');
}

// 深拷贝 + 密钥加密，用于写库前的最后一步。
export function sealSecretsInConfig<T>(config: T): T {
  const sealed = JSON.parse(JSON.stringify(config));
  walkSecrets(sealed, encryptSecret);
  return sealed;
}

// 深拷贝 + 密钥解密，用于读库后的第一步（进程内缓存保持明文）。
export function openSecretsInConfig<T>(config: T): T {
  const opened = JSON.parse(JSON.stringify(config));
  walkSecrets(opened, (value) => (value.startsWith(PREFIX) ? decryptSecret(value) : value));
  return opened;
}
