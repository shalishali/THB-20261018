// 配置持久化：AppConfig（平台级，含真实 AI key，管理员维护）+ UserConfig（个人偏好）。
// GET 合并两者并归一化；非管理员下发时脱敏 key；保存时空 key 不覆盖现有 key。
import type { PrismaClient } from '@prisma/client';
import { normalizeConfig, withAnalyticsIdentity, defaultConfig } from './normalize';
import { sealSecretsInConfig, openSecretsInConfig } from './secretBox';
import { pickRotatedApiKey } from '../ai/keyPool';

// 进程内缓存 AppConfig（避免每次 GET 都查库；save 时失效）。多实例部署需改 Redis，本期单实例够用。
let appConfigCache: any = null;

// Agent sidecar 配置版本号：saveAppConfig 检测到 context_length_limit 变更时自增。
// runtimeService.handleConfigChanged 比对前后版本号决定是否重启 sidecar（key/model 由 proxy 每请求直读免重启）。
let agentConfigVersion = 0;

export function getAgentConfigVersion(): number {
  return agentConfigVersion;
}

function clone(value: any): any {
  return JSON.parse(JSON.stringify(value));
}

function redactSecrets(config: any): any {
  const redacted = clone(config);
  if (redacted.text_model_profiles) {
    for (const provider of Object.keys(redacted.text_model_profiles)) {
      if (redacted.text_model_profiles[provider]) {
        redacted.text_model_profiles[provider].api_key = '';
        redacted.text_model_profiles[provider].api_keys = [];
      }
    }
  }
  if (redacted.image_model_profiles) {
    for (const provider of Object.keys(redacted.image_model_profiles)) {
      if (redacted.image_model_profiles[provider]) {
        redacted.image_model_profiles[provider].api_key = '';
        // 与 secretBox 的加密清单保持一致：生图 Key 池也要脱敏（旧数据/脚本可能写入）。
        redacted.image_model_profiles[provider].api_keys = [];
      }
    }
  }
  if (redacted.image_model) redacted.image_model.api_key = '';
  if (redacted.file_parser) redacted.file_parser.mineru_token = '';
  redacted.api_key = '';
  return redacted;
}

async function readAppConfigRaw(prisma: PrismaClient): Promise<any> {
  if (appConfigCache) return appConfigCache;
  const row = await (prisma as any).appConfig.upsert({
    where: { id: 1 },
    update: {},
    create: { id: 1, data: withAnalyticsIdentity(normalizeConfig(defaultConfig)) as any },
  });
  // M1：库中密钥字段为密文（enc:v1:…），读出即解密——进程内缓存保持明文供调用方使用。
  // 存量明文行无前缀透传，兼容旧数据；下次保存时会自动补加密。
  appConfigCache = openSecretsInConfig(row.data as any);
  return appConfigCache;
}

// 启动时预暖 appConfigCache（agent sidecar boot 需要 getLiveAgentAiConfig 立即可用，
// 否则冷启动时 cache 仍为 null → loadConfig() 返 null → sidecar 启动被误判为"配置缺失"）。
export async function primeAppConfigCache(prisma: PrismaClient): Promise<void> {
  await readAppConfigRaw(prisma);
}

async function readUserConfigRaw(prisma: PrismaClient, userId: number): Promise<any> {
  const row = await (prisma as any).userConfig.upsert({
    where: { userId },
    update: {},
    create: { userId, data: {} as any },
  });
  return (row.data as any) || {};
}

// 合并平台默认 + 个人覆盖，再走 normalizeConfig 派生扁平字段。保留真实 key（脱敏由调用方决定）。
export async function buildMerged(prisma: PrismaClient, userId: number): Promise<any> {
  const appRaw = await readAppConfigRaw(prisma);
  const userRaw = await readUserConfigRaw(prisma, userId);
  const mergedRaw: any = { ...appRaw, ...userRaw };

  // 个人偏好只允许改「选哪个服务商」，绝不允许把平台 profile 覆盖成残缺对象：
  // 只写 { provider } 时，用平台该服务商的完整 profile 补齐 key/base_url/model，
  // 否则 normalizeConfig 会用残缺 image_model 覆盖 image_model_profiles[active]，
  // 导致 api_key='' → 自动配图直接失败（2026-10-19 修复）。
  const chosenImageProvider = userRaw?.image_model?.provider;
  if (chosenImageProvider) {
    const baseProfile = appRaw?.image_model_profiles?.[chosenImageProvider]
      || (appRaw?.image_model?.provider === chosenImageProvider ? appRaw.image_model : null);
    mergedRaw.image_model = { ...(baseProfile || {}), provider: chosenImageProvider, ...(baseProfile ? {} : userRaw.image_model) };
    if (baseProfile) {
      mergedRaw.image_model_profiles = {
        ...(appRaw.image_model_profiles || {}),
        [chosenImageProvider]: { ...baseProfile, ...(appRaw.image_model_profiles?.[chosenImageProvider] || {}) },
      };
    }
  }

  // 文本服务商同理：切换 provider 时用该 provider 的平台 profile 补齐扁平字段，
  // 避免把旧 provider 的 api_key/model_name 配到新 base_url 上（会 401）。
  const chosenTextProvider = userRaw?.text_model_provider;
  const platformTextProfile = chosenTextProvider ? appRaw?.text_model_profiles?.[chosenTextProvider] : null;
  if (chosenTextProvider && platformTextProfile) {
    mergedRaw.text_model_profiles = {
      ...(appRaw.text_model_profiles || {}),
      [chosenTextProvider]: { ...platformTextProfile, ...(appRaw.text_model_profiles?.[chosenTextProvider] || {}) },
    };
    mergedRaw.api_key = platformTextProfile.api_key;
    mergedRaw.base_url = platformTextProfile.base_url;
    mergedRaw.model_name = platformTextProfile.model_name;
    mergedRaw.context_length_limit = platformTextProfile.context_length_limit;
    mergedRaw.concurrency_limit = platformTextProfile.concurrency_limit;
    mergedRaw.request_mode = platformTextProfile.request_mode;
  }

  return normalizeConfig(mergedRaw);
}

// 管理员保存：深合并 profile/scenario，incoming 空 key 时保留现有 key（配合下发脱敏）。
export async function saveAppConfig(prisma: PrismaClient, incoming: any): Promise<{ success: boolean; message: string; config: any }> {
  const currentNorm = normalizeConfig(await readAppConfigRaw(prisma));
  const src = incoming && typeof incoming === 'object' ? incoming : {};

  const mergedTextProfiles: any = { ...(currentNorm.text_model_profiles || {}) };
  if (src.text_model_profiles && typeof src.text_model_profiles === 'object') {
    for (const provider of Object.keys(src.text_model_profiles)) {
      const cur = currentNorm.text_model_profiles?.[provider] || {};
      const inc = src.text_model_profiles[provider] || {};
      mergedTextProfiles[provider] = {
        ...cur,
        ...inc,
        api_key: inc.api_key ? inc.api_key : cur.api_key,
        // Key 池：前端显式传数组（可为空 = 清空池子）；未传保持现有池子
        api_keys: Array.isArray(inc.api_keys) ? inc.api_keys : (Array.isArray(cur.api_keys) ? cur.api_keys : []),
      };
    }
  }

  const mergedImageProfiles: any = { ...(currentNorm.image_model_profiles || {}) };
  if (src.image_model_profiles && typeof src.image_model_profiles === 'object') {
    for (const provider of Object.keys(src.image_model_profiles)) {
      const cur = currentNorm.image_model_profiles?.[provider] || {};
      const inc = src.image_model_profiles[provider] || {};
      mergedImageProfiles[provider] = {
        ...cur,
        ...inc,
        api_key: inc.api_key ? inc.api_key : cur.api_key,
        api_keys: Array.isArray(inc.api_keys) ? inc.api_keys : (Array.isArray(cur.api_keys) ? cur.api_keys : []),
      };
    }
  }

  // 活动投影（扁平 text 字段 / image_model）必须与合并后的 profiles 一致，
  // 否则 normalizeConfig 会从陈旧的扁平字段反推 active profile 从而覆盖 profile 里的 key。
  const activeTextProvider = src.text_model_provider || currentNorm.text_model_provider;
  const activeTextProfile = mergedTextProfiles[activeTextProvider] || currentNorm.text_model_profiles?.[activeTextProvider] || {};
  const activeImageProvider = src.image_model?.provider || currentNorm.image_model?.provider;
  const activeImageProfile = mergedImageProfiles[activeImageProvider] || currentNorm.image_model_profiles?.[activeImageProvider] || {};

  const file_parser = {
    provider: src.file_parser?.provider ?? currentNorm.file_parser?.provider,
    mineru_token: src.file_parser?.mineru_token ? src.file_parser.mineru_token : currentNorm.file_parser?.mineru_token,
  };

  const merged = {
    ...currentNorm,
    ...src,
    text_model_profiles: mergedTextProfiles,
    image_model_profiles: mergedImageProfiles,
    image_model: activeImageProfile,
    api_key: activeTextProfile.api_key,
    base_url: activeTextProfile.base_url,
    model_name: activeTextProfile.model_name,
    context_length_limit: activeTextProfile.context_length_limit,
    concurrency_limit: activeTextProfile.concurrency_limit,
    request_mode: activeTextProfile.request_mode,
    file_parser,
    agent_mode_scenarios: { ...(currentNorm.agent_mode_scenarios || {}), ...(src.agent_mode_scenarios || {}) },
    analytics_client_id: src.analytics_client_id || currentNorm.analytics_client_id,
    analytics_created_at: src.analytics_created_at || currentNorm.analytics_created_at,
  };

  const nextConfig = withAnalyticsIdentity(normalizeConfig(merged));
  // context_length_limit 变更需要重启 opencode sidecar（写入 opencode.json 的 limit.context）。
  // key/model/base_url 不触发版本号——AI proxy 每请求 live 直读，无需重启。
  if (Number(normalizeConfig(currentNorm).context_length_limit) !== Number(nextConfig.context_length_limit)) {
    agentConfigVersion += 1;
  }
  // M1：写库前把密钥字段封为密文；进程内缓存保持明文（nextConfig 原样），供 AI 调用直读。
  await (prisma as any).appConfig.update({ where: { id: 1 }, data: { data: sealSecretsInConfig(nextConfig) as any } });
  appConfigCache = nextConfig;
  return { success: true, message: '配置已保存', config: nextConfig };
}

// 个人偏好白名单：只允许偏好类字段，绝不写 key/profile 的密钥。
const USER_FIELD_WHITELIST = [
  'text_model_provider',
  'image_model',
  'export_format',
  'agent_mode_scenarios',
  'developer_mode',
  'developer_token_stats_auto_open',
  'file_parser',
];

export async function saveUserConfig(prisma: PrismaClient, userId: number, incoming: any): Promise<{ success: boolean; message: string; config: any }> {
  const src = incoming && typeof incoming === 'object' ? incoming : {};
  const patch: any = {};
  for (const key of USER_FIELD_WHITELIST) {
    if (Object.prototype.hasOwnProperty.call(src, key)) {
      if (key === 'image_model' && src.image_model) {
        // 个人只能选 image provider，不携带 key
        patch.image_model = { provider: src.image_model.provider };
      } else if (key === 'file_parser' && src.file_parser) {
        patch.file_parser = { provider: src.file_parser.provider };
      } else {
        patch[key] = src[key];
      }
    }
  }
  const current = await readUserConfigRaw(prisma, userId);
  const nextData = {
    ...current,
    ...patch,
    agent_mode_scenarios: { ...(current.agent_mode_scenarios || {}), ...(patch.agent_mode_scenarios || {}) },
  };
  await (prisma as any).userConfig.update({ where: { userId }, data: { data: nextData as any } });
  const merged = await buildMerged(prisma, userId);
  // 写接口同样必须脱敏：否则任意登录用户 PUT 一次空 body 就能拿到平台全部明文密钥。
  return { success: true, message: '个人偏好已保存', config: redactSecrets(merged) };
}

export { redactSecrets };

// 进程级文本请求队列上限（AI_TEXT_QUEUE_LIMIT）的实时读取：供 ai/service.ts 的 textRequestQueue
// 在每次 dequeue 时 live 取值，从而「设置页改完即热生效」而无需重启。appConfigCache 在每次
// saveAppConfig 后被刷新为归一化后的配置，故 text_request_queue_limit 始终是最新值。
// 兜底链：appConfigCache → AI_TEXT_QUEUE_LIMIT env → 24（与 normalize.ts 默认一致）。
export function getLiveTextRequestQueueLimit(): number {
  const cached = Number(appConfigCache?.text_request_queue_limit);
  if (Number.isFinite(cached) && cached > 0) return Math.round(cached);
  const env = Number(process.env.AI_TEXT_QUEUE_LIMIT);
  if (Number.isFinite(env) && env > 0) return Math.round(env);
  return 24;
}

// Agent AI proxy 每请求 live 读取的平台文本模型配置（api_key/model_name/base_url 等）。
// 复用平台统一 key——proxy HTTP 调用独立于 aiService.chat（需 SSE 字节级透传 + usage 捕获），
// 但配置来源与 aiService 同源（appConfigCache 经 normalizeConfig 派生扁平字段）。
// 冷启动时 appConfigCache 可能是未归一化的 raw——这里每次归一化兜底，保证扁平字段可用。
export interface AgentAiConfig {
  api_key: string;
  model_name: string;
  base_url: string;
  text_model_provider: string;
  context_length_limit: number;
  concurrency_limit: number;
  request_mode: string;
  developer_mode: boolean;
}

export function getLiveAgentAiConfig(): AgentAiConfig | null {
  if (!appConfigCache) return null;
  const normalized = normalizeConfig(appConfigCache);
  // Key 池轮询：agent proxy 每请求 live 直读本配置，多 key/多平台时逐请求轮换
  // （条目可自带 Base URL / 模型名，agent 请求随之指向对应平台）
  const pooled = pickRotatedApiKey(normalized);
  return {
    api_key: pooled?.key || '',
    model_name: pooled?.model_name || normalized.model_name || '',
    base_url: pooled?.base_url || normalized.base_url || '',
    text_model_provider: normalized.text_model_provider || '',
    context_length_limit: Number(normalized.context_length_limit || 0),
    concurrency_limit: Number(normalized.concurrency_limit || 0),
    request_mode: normalized.request_mode || '',
    developer_mode: Boolean(normalized.developer_mode),
  };
}

export interface SystemSettings {
  systemName: string;
  logoDataUrl: string | null;
  /** 邀请推广文案（管理员可编辑；支持 {inviteCode}/{inviteUrl} 占位符） */
  invitePromoCopy: string;
  /** 邀请推广海报（管理员上传的 data URL；为空则邀请页不展示海报） */
  invitePosterDataUrl: string | null;
}

// 基本设置（系统名称 + Logo + 邀请推广文案）：从 AppConfig.data 读写。相关字段已纳入
// normalizeConfig，故普通 saveAppConfig 不会覆盖它们；这里单独读写并刷新 appConfigCache。
export async function getSystemSettings(prisma: PrismaClient): Promise<SystemSettings> {
  const raw = await readAppConfigRaw(prisma);
  const normalized = normalizeConfig(raw);
  return {
    systemName: normalized.system_name,
    logoDataUrl: normalized.logo_data_url ?? null,
    invitePromoCopy: normalized.invite_promo_copy || '',
    invitePosterDataUrl: normalized.invite_poster_data_url ?? null,
  };
}

export async function saveSystemSettings(
  prisma: PrismaClient,
  incoming: { systemName?: string; logoDataUrl?: string | null; invitePromoCopy?: string; invitePosterDataUrl?: string | null },
): Promise<SystemSettings> {
  const raw = await readAppConfigRaw(prisma);
  const patch: any = { ...raw };
  if (typeof incoming.systemName === 'string') {
    patch.system_name = incoming.systemName.trim();
  }
  if (incoming.logoDataUrl !== undefined) {
    patch.logo_data_url = incoming.logoDataUrl;
  }
  if (typeof incoming.invitePromoCopy === 'string') {
    patch.invite_promo_copy = incoming.invitePromoCopy.slice(0, 2000);
  }
  if (incoming.invitePosterDataUrl !== undefined) {
    patch.invite_poster_data_url = incoming.invitePosterDataUrl;
  }
  const nextConfig = normalizeConfig(patch);
  // M1：与 saveAppConfig 同规——写库封密文，缓存保持明文。
  await (prisma as any).appConfig.update({ where: { id: 1 }, data: { data: sealSecretsInConfig(nextConfig) as any } });
  appConfigCache = nextConfig;
  return {
    systemName: nextConfig.system_name,
    logoDataUrl: nextConfig.logo_data_url ?? null,
    invitePromoCopy: nextConfig.invite_promo_copy || '',
    invitePosterDataUrl: nextConfig.invite_poster_data_url ?? null,
  };
}
