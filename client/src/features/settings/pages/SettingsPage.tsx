import { useEffect, useRef, useState } from 'react';
import { FloatingToolbar, InputWithAction, useToast } from '../../../shared/ui';
import type { FloatingToolbarGroup } from '../../../shared/ui';
import { http } from '../../../shared/api/http';
import { useSystemSettings, useSaveSystemSettings } from '../../../shared/api/system-settings';
import { aiApi } from '../../../shared/api/ai';
import { useAuth } from '../../../shared/api/auth';
import { useAgentStatus, useRunAgentSelfCheck, useRestartAgent, agentPhaseMeta, agentStepStatusMeta, type AgentSelfCheckReport } from '../../../shared/api/agent';
import logoUrl from '../../../../assets/icon_256.png';
import type { AgentModeScenariosConfig, AiRequestMode, ClientConfig, ConfiguredTextModelProvider, FileParserProvider, ImageModelConfig, ImageModelProfiles, ImageModelProvider, ImageModelSize, ImageModelStatus, TextModelConfig, TextModelProfiles, TextModelProvider, UpdateChannel } from '../../../shared/types';
import type { SettingsPageState } from '../types';
import { AiDiagnosticsPanel } from '../components/AiDiagnosticsPanel';
import { AiUsagePanel } from '../components/AiUsagePanel';

type SettingsTab = 'basic' | 'general' | 'text-model' | 'image-model' | 'file-parser' | 'agent' | 'pricing' | 'ai-usage' | 'ai-diagnostics';
type AgentSelfCheckUiStatus = 'untested' | 'checking' | 'normal' | 'busy' | 'error';

const settingsTabs: Array<{ id: SettingsTab; label: string }> = [
  { id: 'basic', label: '基本设置' },
  { id: 'general', label: '通用' },
  { id: 'text-model', label: '文本模型' },
  { id: 'image-model', label: '生图模型' },
  { id: 'file-parser', label: '文件解析' },
  { id: 'agent', label: '智能体配置' },
  { id: 'pricing', label: '定价与额度' },
  { id: 'ai-usage', label: 'AI 调用统计' },
  { id: 'ai-diagnostics', label: 'AI 任务诊断' },
];

const agentSelfCheckStatusMeta: Record<AgentSelfCheckUiStatus, { label: string; description: string }> = {
  untested: { label: '未检测', description: '点击自检后，会验证 OpenCode Server、AI proxy、已集成命令工具、当前文本模型和智能体输出链路。' },
  checking: { label: '检测中', description: '正在清理上一轮自检日志，并校验工具环境与极简智能体任务。' },
  normal: { label: '正常', description: '智能体链路和关键集成工具已通过自检，可以用于目录修复等 Agent 能力。' },
  busy: { label: '忙碌', description: 'Agent 正在处理其他任务，本次自检已跳过；这不是 OpenCode 故障。' },
  error: { label: '异常', description: '智能体链路自检失败，请查看下方错误详情。' },
};

const updateChannelOptions: Array<{ value: UpdateChannel; label: string; description: string }> = [
  { value: 'github', label: 'GitHub', description: '使用 GitHub Release 检查和下载更新' },
  { value: 'cloudflare', label: 'Cloudflare', description: '使用 Cloudflare R2 镜像检查和下载更新' },
];

const defaultAgentModeScenarios: AgentModeScenariosConfig = {
  existing_plan_expansion_original_outline_extraction: true,
};

function normalizeUpdateChannel(value?: string): UpdateChannel {
  return value === 'cloudflare' ? 'cloudflare' : 'github';
}

function normalizeAgentModeScenarios(value?: Partial<AgentModeScenariosConfig>): AgentModeScenariosConfig {
  return {
    existing_plan_expansion_original_outline_extraction: value?.existing_plan_expansion_original_outline_extraction === undefined
      ? defaultAgentModeScenarios.existing_plan_expansion_original_outline_extraction
      : Boolean(value.existing_plan_expansion_original_outline_extraction),
  };
}

const textModelProviders: Array<{ value: TextModelProvider; label: string }> = [
  { value: 'jinlong', label: '金龙中转站【推荐】' },
  { value: 'volcengine', label: '火山方舟' },
  { value: 'deepseek', label: 'DeepSeek' },
  { value: 'agnes', label: 'Agnes AI' },
  { value: 'custom', label: '自定义' },
];

const aiRequestModeOptions: Array<{ value: AiRequestMode; label: string }> = [
  { value: 'normal', label: '普通请求' },
  { value: 'stream', label: '流式请求' },
];

const DEFAULT_TEXT_CONTEXT_LENGTH_LIMIT = 400000;
const DEFAULT_TEXT_CONCURRENCY_LIMIT = 10;
const DEFAULT_TEXT_REQUEST_QUEUE_LIMIT = 24;

const textProviderDefaults: Record<ConfiguredTextModelProvider, TextModelConfig> = {
  jinlong: { api_key: '', base_url: 'https://jlaudeapi.com/v1', model_name: 'gpt-3.5-turbo', context_length_limit: DEFAULT_TEXT_CONTEXT_LENGTH_LIMIT, concurrency_limit: DEFAULT_TEXT_CONCURRENCY_LIMIT, request_mode: 'stream' },
  volcengine: { api_key: '', base_url: 'https://ark.cn-beijing.volces.com/api/v3', model_name: '', context_length_limit: DEFAULT_TEXT_CONTEXT_LENGTH_LIMIT, concurrency_limit: DEFAULT_TEXT_CONCURRENCY_LIMIT, request_mode: 'stream' },
  deepseek: { api_key: '', base_url: 'https://api.deepseek.com', model_name: '', context_length_limit: DEFAULT_TEXT_CONTEXT_LENGTH_LIMIT, concurrency_limit: DEFAULT_TEXT_CONCURRENCY_LIMIT, request_mode: 'stream' },
  longcat: { api_key: '', base_url: 'https://api.longcat.chat/openai/v1', model_name: '', context_length_limit: DEFAULT_TEXT_CONTEXT_LENGTH_LIMIT, concurrency_limit: DEFAULT_TEXT_CONCURRENCY_LIMIT, request_mode: 'stream' },
  agnes: { api_key: '', base_url: 'https://apihub.agnes-ai.com/v1', model_name: '', context_length_limit: DEFAULT_TEXT_CONTEXT_LENGTH_LIMIT, concurrency_limit: DEFAULT_TEXT_CONCURRENCY_LIMIT, request_mode: 'stream' },
  custom: { api_key: '', base_url: '', model_name: '', context_length_limit: DEFAULT_TEXT_CONTEXT_LENGTH_LIMIT, concurrency_limit: DEFAULT_TEXT_CONCURRENCY_LIMIT, request_mode: 'stream' },
};

const textProviderApiKeyUrls: Partial<Record<ConfiguredTextModelProvider, string>> = {
  jinlong: 'https://s.markup.com.cn/jl',
  volcengine: 'https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey',
  deepseek: 'https://platform.deepseek.com/api_keys',
  agnes: 'https://platform.agnes-ai.com/settings/apiKeys',
};

// ===== 多平台配置 =====
// api_keys 行格式：`key`（主平台加号账号）或 `key|Base URL|模型名`（其他平台，模型名可省略）。
// 结构化编辑器把带 | 的行按 Base URL 分组渲染成平台卡片；保存时序列化回行格式（后端 Key 池按行解析）。
interface PoolPlatform {
  provider: ConfiguredTextModelProvider;
  base_url: string;
  model_name: string;
  keys: string[];
}

function guessExtraProvider(base_url: string): TextModelProvider {
  const url = base_url.toLowerCase();
  const match = textModelProviders.find(
    ({ value }) => value !== 'custom' && textProviderDefaults[value].base_url && url.startsWith(textProviderDefaults[value].base_url.toLowerCase()),
  );
  return match?.value ?? 'custom';
}

function parseExtraPlatforms(apiKeys: string[]): PoolPlatform[] {
  const map = new Map<string, PoolPlatform>();
  for (const line of apiKeys) {
    if (!line.includes('|')) continue;
    const [key = '', base_url = '', model_name = ''] = line.split('|').map((part) => part.trim());
    if (!key || !base_url) continue;
    const provider = guessExtraProvider(base_url);
    if (!map.has(base_url)) {
      map.set(base_url, {
        provider,
        base_url,
        model_name: model_name || textProviderDefaults[provider].model_name,
        keys: [],
      });
    }
    map.get(base_url)!.keys.push(key);
  }
  return [...map.values()];
}

function serializeExtraPlatforms(platforms: PoolPlatform[]): string[] {
  const lines: string[] = [];
  for (const platform of platforms) {
    const base_url = platform.base_url.trim();
    const model = platform.model_name.trim();
    for (const key of platform.keys) {
      const trimmed = key.trim();
      if (!trimmed) continue;
      lines.push(base_url ? (model ? `${trimmed}|${base_url}|${model}` : `${trimmed}|${base_url}`) : trimmed);
    }
  }
  return lines;
}

function createDefaultTextModelProfiles(): TextModelProfiles {
  return textModelProviders.reduce((profiles, provider) => ({
    ...profiles,
    [provider.value]: { ...textProviderDefaults[provider.value] },
  }), {} as TextModelProfiles);
}

function normalizeAiRequestMode(value?: AiRequestMode): AiRequestMode {
  return value === 'normal' ? 'normal' : 'stream';
}

function normalizeTextContextLengthLimit(value?: number | string): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : DEFAULT_TEXT_CONTEXT_LENGTH_LIMIT;
}

function normalizeTextConcurrencyLimit(value?: number | string): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : DEFAULT_TEXT_CONCURRENCY_LIMIT;
}

function parseTextContextLengthInput(value: string): number | '' {
  if (value === '') return '';
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(1, Math.floor(number)) : '';
}

function parseTextConcurrencyLimitInput(value: string): number | '' {
  if (value === '') return '';
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(1, Math.round(number)) : '';
}

function normalizeTextRequestQueueLimit(value?: number | string): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : DEFAULT_TEXT_REQUEST_QUEUE_LIMIT;
}

function parseTextRequestQueueLimitInput(value: string): number | '' {
  if (value === '') return '';
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(1, Math.round(number)) : '';
}

function normalizeTextModelProfile(provider: ConfiguredTextModelProvider, profile?: Partial<TextModelConfig>): TextModelConfig {
  const defaults = textProviderDefaults[provider];
  const baseUrl = provider === 'custom' ? profile?.base_url ?? defaults.base_url : defaults.base_url;
  return {
    api_key: profile?.api_key ?? defaults.api_key,
    api_keys: Array.isArray(profile?.api_keys) ? profile.api_keys : [],
    base_url: baseUrl,
    model_name: profile?.model_name ?? defaults.model_name,
    context_length_limit: normalizeTextContextLengthLimit(profile?.context_length_limit ?? defaults.context_length_limit),
    concurrency_limit: normalizeTextConcurrencyLimit(profile?.concurrency_limit ?? defaults.concurrency_limit),
    request_mode: normalizeAiRequestMode(profile?.request_mode ?? defaults.request_mode),
  };
}

function normalizeTextModelProfiles(
  profiles?: Partial<Record<ConfiguredTextModelProvider, TextModelConfig>>,
  activeProvider?: ConfiguredTextModelProvider,
): TextModelProfiles {
  const nextProfiles = textModelProviders.reduce((normalizedProfiles, provider) => ({
    ...normalizedProfiles,
    [provider.value]: normalizeTextModelProfile(provider.value, profiles?.[provider.value]),
  }), {} as TextModelProfiles);

  if (activeProvider === 'longcat' || profiles?.longcat) {
    nextProfiles.longcat = normalizeTextModelProfile('longcat', profiles?.longcat);
  }

  return nextProfiles;
}

function textProfileFromState(textModel: SettingsPageState['textModel']): TextModelConfig {
  return {
    api_key: textModel.api_key,
    api_keys: Array.isArray(textModel.api_keys) ? textModel.api_keys : [],
    base_url: textModel.provider === 'custom' ? textModel.base_url : textProviderDefaults[textModel.provider].base_url,
    model_name: textModel.model_name,
    context_length_limit: normalizeTextContextLengthLimit(textModel.context_length_limit),
    concurrency_limit: normalizeTextConcurrencyLimit(textModel.concurrency_limit),
    request_mode: textModel.request_mode,
  };
}

const imageProviders: Array<{ value: ImageModelProvider; label: string }> = [
  { value: 'jinlong', label: '金龙中转站【推荐】' },
  { value: 'volcengine', label: '火山方舟' },
  { value: 'google-ai-studio', label: 'Google AI Studio' },
  { value: 'agnes', label: 'Agnes AI' },
  { value: 'custom', label: '自定义 OpenAI-like' },
];

const DEFAULT_IMAGE_CONCURRENCY_LIMIT = 2;

const openAICompatibleImageSizeOptions: Array<{ value: ImageModelSize; label: string }> = [
  { value: 'auto', label: '自动' },
  { value: '1024x1024', label: '1024×1024（1K 方图）' },
  { value: '1536x1024', label: '1536×1024（1K 横图）' },
  { value: '1024x1536', label: '1024×1536（1K 竖图）' },
  { value: '2048x2048', label: '2048×2048（2K 方图）' },
  { value: '2048x1152', label: '2048×1152（2K 横图）' },
  { value: '3840x2160', label: '3840×2160（4K 横图）' },
  { value: '2160x3840', label: '2160×3840（4K 竖图）' },
];

const googleImageSizeOptions: Array<{ value: ImageModelSize; label: string }> = [
  { value: '512', label: '512' },
  { value: '1K', label: '1K' },
  { value: '2K', label: '2K' },
  { value: '4K', label: '4K' },
];

function getImageSizeOptions(provider: ImageModelProvider) {
  return provider === 'google-ai-studio' ? googleImageSizeOptions : openAICompatibleImageSizeOptions;
}

function normalizeImageSize(provider: ImageModelProvider, value?: string): ImageModelSize {
  const options = getImageSizeOptions(provider);
  const candidate = String(value || '').trim() as ImageModelSize;
  return options.some((option) => option.value === candidate)
    ? candidate
    : provider === 'google-ai-studio' ? '1K' : '1024x1024';
}

const imageProviderDefaults: ImageModelProfiles = {
  jinlong: {
    provider: 'jinlong',
    base_url: 'https://img-api.jlaudeapi.com/v1',
    api_key: '',
    model_name: 'gpt-image-2',
    image_size: '1024x1024',
    request_mode: 'normal',
    concurrency_limit: DEFAULT_IMAGE_CONCURRENCY_LIMIT,
    status: 'untested',
    tested_at: '',
    last_error: '',
  },
  volcengine: {
    provider: 'volcengine',
    base_url: 'https://ark.cn-beijing.volces.com/api/v3',
    api_key: '',
    model_name: '',
    image_size: '1024x1024',
    request_mode: 'stream',
    concurrency_limit: DEFAULT_IMAGE_CONCURRENCY_LIMIT,
    status: 'untested',
    tested_at: '',
    last_error: '',
  },
  'google-ai-studio': {
    provider: 'google-ai-studio',
    base_url: 'https://generativelanguage.googleapis.com/v1beta',
    api_key: '',
    model_name: 'gemini-3.1-flash-image-preview',
    image_size: '1K',
    request_mode: 'stream',
    concurrency_limit: DEFAULT_IMAGE_CONCURRENCY_LIMIT,
    status: 'untested',
    tested_at: '',
    last_error: '',
  },
  agnes: {
    provider: 'agnes',
    base_url: 'https://apihub.agnes-ai.com/v1',
    api_key: '',
    model_name: '',
    image_size: '1024x1024',
    request_mode: 'stream',
    concurrency_limit: DEFAULT_IMAGE_CONCURRENCY_LIMIT,
    status: 'untested',
    tested_at: '',
    last_error: '',
  },
  custom: {
    provider: 'custom',
    base_url: '',
    api_key: '',
    model_name: '',
    image_size: '1024x1024',
    request_mode: 'stream',
    concurrency_limit: DEFAULT_IMAGE_CONCURRENCY_LIMIT,
    status: 'untested',
    tested_at: '',
    last_error: '',
  },
};

const imageProviderApiKeyUrls: Record<ImageModelProvider, string> = {
  jinlong: 'https://s.markup.com.cn/jl',
  volcengine: 'https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey',
  'google-ai-studio': 'https://aistudio.google.com/api-keys',
  agnes: 'https://platform.agnes-ai.com/settings/apiKeys',
  custom: '',
};

const imageProviderLabels: Record<ImageModelProvider, string> = {
  jinlong: '金龙中转站',
  volcengine: '火山方舟',
  'google-ai-studio': 'Google AI Studio',
  agnes: 'Agnes AI',
  custom: '自定义生图服务',
};

function getImageBaseUrlDescription(provider: ImageModelProvider) {
  if (provider === 'jinlong') return '金龙中转站 OpenAI 兼容接口地址';
  if (provider === 'volcengine') return '火山方舟 OpenAI 兼容接口地址';
  if (provider === 'agnes') return 'Agnes AI OpenAI 兼容接口地址';
  if (provider === 'custom') return '填写兼容 OpenAI /images/generations 的接口地址';
  return 'Google Gemini API REST 地址';
}

function getImageApiKeyDescription(provider: ImageModelProvider) {
  if (provider === 'jinlong') return '用于调用金龙中转站图片生成 API';
  if (provider === 'volcengine') return '用于调用火山方舟图片生成 API';
  if (provider === 'agnes') return '用于调用 Agnes AI 图片生成 API';
  if (provider === 'custom') return '用于调用自定义 OpenAI-like 生图接口';
  return '用于调用 Google AI Studio Gemini API';
}

function getImageModelDescription(provider: ImageModelProvider) {
  if (provider === 'jinlong') return '填写金龙中转站已开通的生图模型名称';
  if (provider === 'volcengine') return '填写火山方舟控制台中已开通的模型或推理接入点 ID';
  if (provider === 'agnes') return '填写 Agnes AI 已开通的生图模型名称';
  if (provider === 'custom') return '填写自定义接口支持的生图模型名称';
  return '选择或填写支持图片生成的 Gemini 模型';
}

function getImageModelPlaceholder(provider: ImageModelProvider) {
  if (provider === 'jinlong') return '请输入已开通的生图模型名称';
  if (provider === 'volcengine') return '请输入已开通的模型或推理接入点 ID';
  if (provider === 'agnes') return '请输入 Agnes AI 生图模型名称';
  if (provider === 'custom') return '请输入 OpenAI-like 生图模型名称';
  return 'gemini-3.1-flash-image-preview';
}

function createDefaultImageModelProfiles(): ImageModelProfiles {
  return imageProviders.reduce((profiles, provider) => ({
    ...profiles,
    [provider.value]: { ...imageProviderDefaults[provider.value] },
  }), {} as ImageModelProfiles);
}

function normalizeImageModelProfile(provider: ImageModelProvider, profile?: Partial<ImageModelConfig>): ImageModelConfig {
  const defaults = imageProviderDefaults[provider];
  const useProviderDefaultImageModel = provider === 'jinlong' && !String(profile?.model_name ?? '').trim();
  return {
    provider,
    base_url: provider === 'custom' ? profile?.base_url ?? defaults.base_url : defaults.base_url,
    api_key: profile?.api_key ?? defaults.api_key,
    model_name: useProviderDefaultImageModel ? defaults.model_name : profile?.model_name ?? defaults.model_name,
    image_size: normalizeImageSize(provider, useProviderDefaultImageModel ? defaults.image_size : profile?.image_size ?? defaults.image_size),
    request_mode: normalizeAiRequestMode(useProviderDefaultImageModel ? defaults.request_mode : profile?.request_mode ?? defaults.request_mode),
    concurrency_limit: normalizeImageConcurrencyLimit(profile?.concurrency_limit ?? defaults.concurrency_limit),
    status: useProviderDefaultImageModel ? defaults.status : profile?.status ?? defaults.status,
    tested_at: useProviderDefaultImageModel ? defaults.tested_at : profile?.tested_at ?? defaults.tested_at,
    last_error: useProviderDefaultImageModel ? defaults.last_error : profile?.last_error ?? defaults.last_error,
  };
}

function normalizeImageConcurrencyLimit(value?: number | string): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : DEFAULT_IMAGE_CONCURRENCY_LIMIT;
}

function parseImageConcurrencyLimitInput(value: string): number | '' {
  if (value === '') return '';
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(1, Math.round(number)) : '';
}

function normalizeImageModelProfiles(profiles?: Partial<ImageModelProfiles>): ImageModelProfiles {
  return imageProviders.reduce((nextProfiles, provider) => ({
    ...nextProfiles,
    [provider.value]: normalizeImageModelProfile(provider.value, profiles?.[provider.value]),
  }), {} as ImageModelProfiles);
}

function imageProfileFromState(imageModel: SettingsPageState['imageModel']): ImageModelConfig {
  return {
    provider: imageModel.provider,
    base_url: imageModel.provider === 'custom' ? imageModel.base_url || '' : imageProviderDefaults[imageModel.provider].base_url,
    api_key: imageModel.api_key,
    model_name: imageModel.model_name,
    image_size: normalizeImageSize(imageModel.provider, imageModel.image_size),
    request_mode: imageModel.request_mode,
    concurrency_limit: normalizeImageConcurrencyLimit(imageModel.concurrency_limit),
    status: imageModel.status || 'untested',
    tested_at: imageModel.tested_at || '',
    last_error: imageModel.last_error || '',
  };
}

const imageStatusMeta: Record<ImageModelStatus, { label: string; description: string }> = {
  untested: {
    label: '未测试',
    description: '请点击测试确认当前生图模型可用，正文生成时只有可用状态才会自动配图。',
  },
  available: {
    label: '可用',
    description: '当前生图模型已通过测试，正文生成时会按内容需要自动配图。',
  },
  unavailable: {
    label: '不可用',
    description: '当前生图模型测试失败，正文生成会跳过配图。',
  },
};

function resetImageModelStatus(imageModel: SettingsPageState['imageModel']): SettingsPageState['imageModel'] {
  return {
    ...imageModel,
    status: 'untested',
    tested_at: '',
    last_error: '',
  };
}

function formatImageTestTime(value?: string) {
  if (!value) {
    return '';
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '';
  }

  return date.toLocaleString('zh-CN', { hour12: false });
}

const fileParserProviders: Array<{ value: FileParserProvider; label: string }> = [
  { value: 'local', label: '本地解析' },
  { value: 'mineru-accurate-api', label: 'MinerU-精准解析 API' },
  { value: 'mineru-agent-api', label: 'MinerU-Agent 轻量解析 API' },
];

const parserOptions = [
  {
    title: '本地解析',
    badge: '推荐默认',
    tone: 'primary',
    summary: '覆盖大多数 Word、Excel 和带文字层 PDF，速度快、无调用限制。',
    items: [
      ['Token', '无需'],
      ['解析速度', '快'],
      ['支持格式', 'pdf、docx、doc、wps、md、xls、xlsx'],
      ['大小/页数', '无限制'],
      ['解析质量', '高'],
      ['扫描件', '不支持'],
    ],
  },
  {
    title: 'MinerU 精准解析 API',
    badge: '扫描件兜底',
    tone: 'accent',
    summary: '解析质量高，适合本地解析失败或扫描件质量要求高的文档。',
    items: [
      ['Token', '需要'],
      ['解析速度', '慢'],
      ['支持格式', 'pdf、doc、docx、ppt、pptx、图片、html；xls/xlsx 自动本地解析'],
      ['大小/页数', '≤ 200MB / ≤ 200 页'],
      ['解析质量', '高'],
      ['扫描件', '支持'],
    ],
  },
  {
    title: 'MinerU-Agent 轻量解析 API',
    badge: '轻量备用',
    tone: 'muted',
    summary: '无需 Token 但存在 IP 限频，适合轻量文档的备用解析。',
    items: [
      ['Token', '无需（IP 限频）'],
      ['解析速度', '中等'],
      ['支持格式', 'pdf、doc、docx、ppt、pptx、图片；xls/xlsx 自动本地解析'],
      ['大小/页数', '≤ 10MB / ≤ 20 页'],
      ['解析质量', '中'],
      ['扫描件', '质量差'],
    ],
  },
];

const initialState: SettingsPageState = {
  textModel: {
    provider: 'jinlong',
    ...textProviderDefaults.jinlong,
  },
  textModelProfiles: createDefaultTextModelProfiles(),
  imageModel: {
    ...imageProviderDefaults.jinlong,
  },
  imageModelProfiles: createDefaultImageModelProfiles(),
  fileParser: {
    provider: 'local',
    mineru_token: '',
  },
  agentModeScenarios: { ...defaultAgentModeScenarios },
  general: {
    developer_mode: false,
    developer_token_stats_auto_open: false,
    update_channel: 'github',
    gpu_hardware_acceleration_enabled: true,
    gpu_hardware_acceleration_configured: true,
    text_request_queue_limit: DEFAULT_TEXT_REQUEST_QUEUE_LIMIT,
  },
};

interface SettingsPageProps {
  onDeveloperModeChange?: (developerMode: boolean) => void;
}

function SettingsPage({ onDeveloperModeChange }: SettingsPageProps) {
  const [state, setState] = useState<SettingsPageState>(initialState);
  const [activeTab, setActiveTab] = useState<SettingsTab>('basic');
  const [savedConfig, setSavedConfig] = useState<ClientConfig | null>(null);
  const [textModels, setTextModels] = useState<string[]>([]);
  const [imageModels, setImageModels] = useState<string[]>([]);
  const [loadingModels, setLoadingModels] = useState<'text' | 'image' | null>(null);
  const [testingTextModel, setTestingTextModel] = useState(false);
  const [testingImageModel, setTestingImageModel] = useState(false);
  const [imageTestPreview, setImageTestPreview] = useState<{ src: string; title: string } | null>(null);
  const [selfCheckReport, setSelfCheckReport] = useState<AgentSelfCheckReport | null>(null);
  const [poolTesting, setPoolTesting] = useState(false);
  // 定价与额度（仅管理员）：充值套餐 + 注册赠送额度，动态调整后用户端实时跟随
  const [pricingDraft, setPricingDraft] = useState<{ signupGrantChars: number; plans: Array<{ key: string; label: string; chars: number; amountCents: number }> } | null>(null);
  const [pricingLoading, setPricingLoading] = useState(false);
  const [pricingSaving, setPricingSaving] = useState(false);
  // ===== API 池：统一平台卡片（首卡为主用平台，写入主配置字段；其余平台进 api_keys 行）=====
  const [poolPlatforms, setPoolPlatforms] = useState<PoolPlatform[]>([]);
  const poolPlatformsDirty = useRef(false);
  const [cardModels, setCardModels] = useState<Record<number, string[]>>({});
  const [cardLoading, setCardLoading] = useState<Record<number, boolean>>({});
  useEffect(() => {
    if (poolPlatformsDirty.current) return;
    const primary = {
      provider: state.textModel.provider,
      base_url: state.textModel.base_url,
      model_name: state.textModel.model_name,
      keys: [state.textModel.api_key, ...(state.textModel.api_keys || []).filter((line) => !line.includes('|'))].filter(Boolean),
    };
    setPoolPlatforms([primary, ...parseExtraPlatforms(state.textModel.api_keys || [])]);
  }, [state.textModel]);
  const [poolTestResults, setPoolTestResults] = useState<Array<{
    key_masked: string;
    base_url: string;
    model_name: string;
    ok: boolean;
    latency_ms: number;
    models_count: number;
    model_found: boolean | null;
    message: string;
  }> | null>(null);
  const { showToast } = useToast();
  const { user } = useAuth();
  // 基本设置（系统名称/Logo）仅管理员：普通用户误入（默认 tab 即 basic）时回落到通用 tab，
  // 否则能编辑表单却在保存时吃 403（保存走 PUT /system-settings，服务端仅管理员）。
  useEffect(() => {
    if (activeTab === 'basic' && user && user.role !== 'admin') {
      setActiveTab('general');
    }
  }, [activeTab, user]);
  const isAdmin = user?.role === 'admin';

  // 智能体运维：sidecar 状态轮询（仅 agent tab 激活时）+ 自检/重启 mutation。
  // 桌面 bridge 的 window.yibiao.agent.* 在 Web 是 no-op，这里直连 server routes/agent.ts。
  const agentStatusQuery = useAgentStatus(activeTab === 'agent');
  const selfCheckMutation = useRunAgentSelfCheck();
  const restartMutation = useRestartAgent();

  // 基本设置（系统名称 + Logo）：独立于模型配置 state，走 system-settings 接口。
  const { data: systemSettings } = useSystemSettings();
  const saveSystemSettingsMutation = useSaveSystemSettings();
  const [draftSystemName, setDraftSystemName] = useState('');
  const [draftLogoDataUrl, setDraftLogoDataUrl] = useState<string | null>(null);
  const [draftPromoCopy, setDraftPromoCopy] = useState('');
  const [basicDirty, setBasicDirty] = useState(false);
  const logoInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    void loadTextConfig();
  }, []);

  // 基本设置：服务端配置首次载入（或保存后刷新）时，同步到本地草稿。
  useEffect(() => {
    if (systemSettings) {
      setDraftSystemName(systemSettings.systemName);
      setDraftLogoDataUrl(systemSettings.logoDataUrl);
      setDraftPromoCopy(systemSettings.invitePromoCopy || '');
      setBasicDirty(false);
    }
  }, [systemSettings]);

  const handleLogoFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      showToast('请选择图片文件', 'error');
      return;
    }
    // 限制 1MB：data URL 直接入库 + 每次接口带回，过大会撑大 app_config 与请求体。
    if (file.size > 1024 * 1024) {
      showToast('Logo 图片不能超过 1MB', 'error');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      setDraftLogoDataUrl(typeof reader.result === 'string' ? reader.result : null);
      setBasicDirty(true);
    };
    reader.onerror = () => showToast('读取图片失败', 'error');
    reader.readAsDataURL(file);
    // 清空 value 允许重复选同一文件再次触发 change。
    e.target.value = '';
  };

  const handleClearLogo = () => {
    setDraftLogoDataUrl(null);
    setBasicDirty(true);
  };

  const handleSaveBasic = async () => {
    const trimmed = draftSystemName.trim();
    if (!trimmed) {
      showToast('系统名称不能为空', 'error');
      return;
    }
    try {
      await saveSystemSettingsMutation.mutateAsync({ systemName: trimmed, logoDataUrl: draftLogoDataUrl, invitePromoCopy: draftPromoCopy.trim() });
      showToast('基本设置已保存', 'success');
      setBasicDirty(false);
    } catch (err) {
      const e = err as { response?: { data?: { message?: string } } };
      showToast(e.response?.data?.message || '保存失败', 'error');
    }
  };

  const loadTextConfig = async () => {
    try {
      const config = await window.yibiao?.config.load();
      if (!config) {
        return;
      }

      const textModelProfiles = normalizeTextModelProfiles(config.text_model_profiles, config.text_model_provider);
      const activeTextProfile = normalizeTextModelProfile(config.text_model_provider, textModelProfiles[config.text_model_provider]);
      const imageModelProfiles = normalizeImageModelProfiles(config.image_model_profiles);
      const activeImageProfile = normalizeImageModelProfile(config.image_model.provider, config.image_model);
      imageModelProfiles[activeImageProfile.provider] = activeImageProfile;

      setState((prev) => ({
        ...prev,
        textModel: {
          provider: config.text_model_provider,
          ...activeTextProfile,
        },
        textModelProfiles,
        imageModel: activeImageProfile,
        imageModelProfiles,
        fileParser: {
          provider: config.file_parser.provider,
          mineru_token: config.file_parser.mineru_token || '',
        },
        agentModeScenarios: normalizeAgentModeScenarios(config.agent_mode_scenarios),
        general: {
          developer_mode: Boolean(config.developer_mode),
          developer_token_stats_auto_open: Boolean(config.developer_token_stats_auto_open),
          update_channel: normalizeUpdateChannel(config.update_channel),
          gpu_hardware_acceleration_enabled: Boolean(config.gpu_hardware_acceleration_enabled),
          gpu_hardware_acceleration_configured: Boolean(config.gpu_hardware_acceleration_configured),
          text_request_queue_limit: normalizeTextRequestQueueLimit(config.text_request_queue_limit),
        },
      }));
      setSavedConfig(config);
      onDeveloperModeChange?.(Boolean(config.developer_mode));
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : '加载客户端配置失败';
      showToast(errorMessage, 'error');
    }
  };

  const getCurrentTextModelProfiles = (): TextModelProfiles => ({
    ...state.textModelProfiles,
    [state.textModel.provider]: textProfileFromState(state.textModel),
  });

  const getCurrentImageModelProfiles = (): ImageModelProfiles => ({
    ...state.imageModelProfiles,
    [state.imageModel.provider]: imageProfileFromState(state.imageModel),
  });

  const createClientConfig = (): ClientConfig => {
    const textModelProfiles = getCurrentTextModelProfiles();
    const activeTextProfile = textModelProfiles[state.textModel.provider]
      || normalizeTextModelProfile(state.textModel.provider);
    const imageModelProfiles = getCurrentImageModelProfiles();
    const activeImageProfile = imageModelProfiles[state.imageModel.provider];

    return {
      text_model_provider: state.textModel.provider,
      text_model_profiles: textModelProfiles,
      api_key: activeTextProfile.api_key,
      base_url: activeTextProfile.base_url,
      model_name: activeTextProfile.model_name,
      context_length_limit: activeTextProfile.context_length_limit,
      concurrency_limit: activeTextProfile.concurrency_limit,
      request_mode: activeTextProfile.request_mode,
      image_model: activeImageProfile,
      image_model_profiles: imageModelProfiles,
      file_parser: {
        provider: state.fileParser.provider,
        mineru_token: state.fileParser.mineru_token || '',
      },
      agent_mode_scenarios: state.agentModeScenarios,
      update_channel: state.general.update_channel,
      gpu_hardware_acceleration_enabled: state.general.gpu_hardware_acceleration_enabled,
      gpu_hardware_acceleration_configured: state.general.gpu_hardware_acceleration_configured,
      developer_mode: state.general.developer_mode,
      developer_token_stats_auto_open: state.general.developer_token_stats_auto_open,
      text_request_queue_limit: normalizeTextRequestQueueLimit(state.general.text_request_queue_limit),
    };
  };

  const updateImageModelConfig = (partial: Partial<Omit<SettingsPageState['imageModel'], 'provider'>>, options: { clearModels?: boolean } = {}) => {
    if (options.clearModels) {
      setImageModels([]);
    }

    setState((prev) => ({
      ...prev,
      ...(() => {
        const imageModel = resetImageModelStatus({ ...prev.imageModel, ...partial });
        return {
          imageModel,
          imageModelProfiles: {
            ...prev.imageModelProfiles,
            [prev.imageModel.provider]: imageProfileFromState(imageModel),
          },
        };
      })(),
    }));
  };

  const updateImageModelProvider = (provider: ImageModelProvider) => {
    setImageModels([]);
    setImageTestPreview(null);
    setState((prev) => ({
      ...prev,
      imageModelProfiles: {
        ...prev.imageModelProfiles,
        [prev.imageModel.provider]: imageProfileFromState(prev.imageModel),
      },
      imageModel: normalizeImageModelProfile(provider, prev.imageModelProfiles[provider]),
    }));
  };

  // 按角色选择保存通道：管理员→平台配置（PUT /config，落 api_key/base_url/并发/全局队列上限等
  // 平台级字段）；普通用户→个人偏好白名单（PUT /config/user，仅 provider 选择等）。这是
  // text_request_queue_limit 等平台字段能真正落库 + 热生效的唯一路径（getLiveTextRequestQueueLimit
  // 读 appConfigCache，只有 saveAppConfig 会刷新它）。
  const persistConfig = (config: ClientConfig) => {
    const bridge = window.yibiao?.config;
    const saveFn = isAdmin ? bridge?.savePlatform : bridge?.save;
    return saveFn ? saveFn(config) : Promise.resolve(undefined);
  };

  const saveClientConfig = async (config: ClientConfig) => {
    try {
      const result = await persistConfig(config);
      showToast(result?.success ? '配置已保存' : result?.message || '配置保存失败', result?.success ? 'success' : 'error');
      if (result?.success) {
        setSavedConfig(config);
        onDeveloperModeChange?.(Boolean(config.developer_mode));
      }
      return Boolean(result?.success);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : '配置保存失败';
      showToast(errorMessage, 'error');
      return false;
    }
  };

  const saveTextConfig = async () => {
    await saveClientConfig(createClientConfig());
  };

  const updateDeveloperMode = (developerMode: boolean) => {
    setState((prev) => ({
      ...prev,
      general: { ...prev.general, developer_mode: developerMode },
    }));
    onDeveloperModeChange?.(developerMode);
  };

  const updateDeveloperTokenStatsAutoOpen = (autoOpen: boolean) => {
    setState((prev) => ({
      ...prev,
      general: { ...prev.general, developer_token_stats_auto_open: autoOpen },
    }));
  };

  const updateUpdateChannel = (updateChannel: UpdateChannel) => {
    setState((prev) => ({
      ...prev,
      general: { ...prev.general, update_channel: updateChannel },
    }));
  };

  const updateGpuHardwareAcceleration = (enabled: boolean) => {
    setState((prev) => ({
      ...prev,
      general: {
        ...prev.general,
        gpu_hardware_acceleration_enabled: enabled,
        gpu_hardware_acceleration_configured: true,
      },
    }));
  };

  const updateAgentModeScenario = (key: keyof AgentModeScenariosConfig, enabled: boolean) => {
    setState((prev) => ({
      ...prev,
      agentModeScenarios: {
        ...prev.agentModeScenarios,
        [key]: enabled,
      },
    }));
  };

  const updateTextModelProvider = (provider: TextModelProvider) => {
    setTextModels([]);
    setState((prev) => ({
      ...prev,
      textModelProfiles: {
        ...prev.textModelProfiles,
        [prev.textModel.provider]: textProfileFromState(prev.textModel),
      },
      textModel: {
        provider,
        ...normalizeTextModelProfile(provider, prev.textModelProfiles[provider]),
      },
    }));
  };

  const updateTextModelConfig = (partial: Partial<Omit<SettingsPageState['textModel'], 'provider'>>, options: { clearModels?: boolean } = {}) => {
    if (options.clearModels) {
      setTextModels([]);
    }

    setState((prev) => ({
      ...prev,
      ...(() => {
        const textModel = { ...prev.textModel, ...partial };
        return {
          textModel,
          textModelProfiles: {
            ...prev.textModelProfiles,
            [prev.textModel.provider]: textProfileFromState(textModel),
          },
        };
      })(),
    }));
  };

  const openTextProviderApiKeyPage = async () => {
    const url = textProviderApiKeyUrls[state.textModel.provider];
    if (!url) {
      showToast('自定义服务商没有预置 API Key 获取页面', 'info');
      return;
    }

    try {
      const result = await window.yibiao?.openExternal(url);
      if (result && !result.success) {
        showToast(result.message || '打开 API Key 获取页面失败', 'error');
      }
    } catch (error) {
      showToast(error instanceof Error ? error.message : '打开 API Key 获取页面失败', 'error');
    }
  };

  const openImageProviderApiKeyPage = async () => {
    const url = imageProviderApiKeyUrls[state.imageModel.provider];
    if (!url) {
      showToast('自定义生图服务没有预置 API Key 获取页面', 'info');
      return;
    }

    try {
      const result = await window.yibiao?.openExternal(url);
      if (result && !result.success) {
        showToast(result.message || '打开生图服务 API Key 获取页面失败', 'error');
      }
    } catch (error) {
      showToast(error instanceof Error ? error.message : '打开生图服务 API Key 获取页面失败', 'error');
    }
  };

  const writePoolBack = (next: PoolPlatform[]): void => {
    poolPlatformsDirty.current = true;
    setPoolPlatforms(next);
    // 首卡为主用平台：写入主配置字段（provider/base_url/model_name/主 Key）；
    // 其余平台与主平台加号账号序列化为 api_keys 行（后端 Key 池按行解析轮询）。
    const primary = next[0];
    const primaryProvider = primary?.provider ?? state.textModel.provider;
    setState((prev) => ({
      ...prev,
      textModel: {
        ...prev.textModel,
        provider: primaryProvider,
        base_url: primary?.base_url ?? '',
        model_name: primary?.model_name ?? '',
        api_key: primary?.keys[0] ?? '',
        api_keys: [
          ...(primary ? primary.keys.slice(1).filter(Boolean) : []),
          ...serializeExtraPlatforms(next.slice(1)),
        ],
      },
    }));
  };
  const updatePoolPlatform = (index: number, patch: Partial<PoolPlatform>): void => {
    writePoolBack(poolPlatforms.map((platform, i) => (i === index ? { ...platform, ...patch } : platform)));
  };
  const applyPoolProvider = (index: number, provider: TextModelProvider): void => {
    const defaults = textProviderDefaults[provider];
    updatePoolPlatform(index, {
      provider,
      base_url: provider === 'custom' ? '' : defaults.base_url,
      model_name: defaults.model_name,
    });
  };
  const addPoolPlatform = (): void => {
    writePoolBack([...poolPlatforms, { provider: 'custom', base_url: '', model_name: '', keys: [''] }]);
  };
  const removePoolPlatform = (index: number): void => {
    if (poolPlatforms.length <= 1) {
      showToast('至少保留一个平台条目（池不能为空）', 'info');
      return;
    }
    writePoolBack(poolPlatforms.filter((_, i) => i !== index));
  };
  const fetchCardModels = async (index: number): Promise<void> => {
    const entry = poolPlatforms[index];
    if (!entry || cardLoading[index]) return;
    const apiKey = entry.keys.find((key) => key.trim());
    if (!apiKey) {
      showToast('请先填写该平台至少一个 API Key', 'info');
      return;
    }
    setCardLoading((prev) => ({ ...prev, [index]: true }));
    try {
      const result = await aiApi.listModels({ base_url: entry.base_url, api_key: apiKey });
      const models = Array.isArray(result.models) ? result.models : [];
      setCardModels((prev) => ({ ...prev, [index]: models }));
      if (models.length === 0) showToast(result.message || '未获取到模型列表，请手动填写模型名', 'info');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '获取模型失败', 'error');
    } finally {
      setCardLoading((prev) => ({ ...prev, [index]: false }));
    }
  };

  // 定价与额度（仅管理员）：充值套餐 + 注册赠送额度，动态调整后用户端充值弹窗实时跟随
  const loadPricing = async () => {
    setPricingLoading(true);
    try {
      const { data } = await http.get<{ signupGrantChars: number; plans: Array<{ key: string; label: string; chars: number; amountCents: number }> }>('/quota/pricing');
      setPricingDraft({ signupGrantChars: data.signupGrantChars, plans: data.plans });
    } catch (error) {
      showToast(error instanceof Error ? error.message : '读取计费配置失败', 'error');
    } finally {
      setPricingLoading(false);
    }
  };

  const savePricing = async () => {
    if (!pricingDraft || pricingSaving) return;
    setPricingSaving(true);
    try {
      await http.put('/quota/pricing', { signupGrantChars: pricingDraft.signupGrantChars, plans: pricingDraft.plans });
      showToast('定价与额度已保存，用户端实时生效', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '保存失败', 'error');
    } finally {
      setPricingSaving(false);
    }
  };

  const updatePricingPlan = (index: number, patch: Partial<{ label: string; chars: number; amountCents: number }>): void => {
    setPricingDraft((prev) => (prev ? { ...prev, plans: prev.plans.map((plan, i) => (i === index ? { ...plan, ...patch } : plan)) } : prev));
  };
  const addPricingPlan = (): void => {
    setPricingDraft((prev) => (prev ? { ...prev, plans: [...prev.plans, { key: `plan-${Date.now().toString(36)}`, label: '', chars: 100000, amountCents: 290 }] } : prev));
  };
  const removePricingPlan = (index: number): void => {
    setPricingDraft((prev) => (prev ? { ...prev, plans: prev.plans.filter((_, i) => i !== index) } : prev));
  };

  useEffect(() => {
      {activeTab === 'pricing' && isAdmin && (
        <section className="settings-page-section">
          <div className="settings-section-title">
            <span />
            <strong>定价与额度</strong>
          </div>
          <div className="settings-pricing">
            <div className="settings-pricing-grant">
              <span className="settings-pricing-grant-label">注册赠送字数</span>
              <input
                type="number"
                min={0}
                step={10000}
                value={pricingDraft?.signupGrantChars ?? 0}
                onChange={(event) => setPricingDraft((prev) => (prev ? { ...prev, signupGrantChars: Math.max(0, Math.floor(Number(event.target.value) || 0)) } : prev))}
              />
              <span className="settings-pricing-hint">新账号初始额度</span>
            </div>
            <div className="settings-pricing-grid">
              {(pricingDraft?.plans ?? []).map((plan, index) => (
                <div className="settings-pricing-card" key={plan.key || `new-${index}`}>
                  <div className="settings-pricing-card-head">
                    <input
                      className="settings-pricing-name"
                      type="text"
                      value={plan.label}
                      placeholder="套餐名称"
                      onChange={(event) => updatePricingPlan(index, { label: event.target.value })}
                    />
                    <button type="button" className="text-button" onClick={() => removePricingPlan(index)}>移除</button>
                  </div>
                  <label className="settings-pricing-field">
                    <span>字数</span>
                    <input
                      type="number"
                      min={1000}
                      step={10000}
                      value={plan.chars}
                      onChange={(event) => updatePricingPlan(index, { chars: Math.max(1000, Math.floor(Number(event.target.value) || 1000)) })}
                    />
                  </label>
                  <label className="settings-pricing-field">
                    <span>价格（元）</span>
                    <input
                      type="number"
                      min={0}
                      step={0.1}
                      value={plan.amountCents / 100}
                      onChange={(event) => updatePricingPlan(index, { amountCents: Math.max(0, Math.round((Number(event.target.value) || 0) * 100)) })}
                    />
                  </label>
                </div>
              ))}
              <button type="button" className="settings-pricing-add" onClick={addPricingPlan}>＋ 添加套餐</button>
            </div>
            <div className="settings-pricing-actions">
              <button type="button" className="primary-action" disabled={pricingSaving || !pricingDraft} onClick={() => void savePricing()}>
                {pricingSaving ? '保存中…' : '保存定价与额度'}
              </button>
              <span className="settings-pricing-hint">保存后用户端充值弹窗实时跟随；配图等生成行为不在计费范围。</span>
            </div>
          </div>
        </section>
      )}
      {activeTab === 'ai-usage' && <AiUsagePanel />}'


      {activeTab === 'ai-diagnostics' && user?.role === 'admin' && <AiDiagnosticsPanel />}

      </div>
      <FloatingToolbar groups={settingsToolbarGroups} label="设置保存工具条" />
    </div>
  );
}

export default SettingsPage;
