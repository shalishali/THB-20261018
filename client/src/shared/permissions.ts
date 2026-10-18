import type { SectionId } from './types/navigation';

// 可授予的功能模块（用户管理矩阵展示用）。user-management 仅管理员可用，不可授予普通用户。
// 与 server/src/auth/permissions.ts ASSIGNABLE_MODULE_IDS 保持同源。
export interface AssignableModule {
  id: SectionId;
  label: string;
}

export const ASSIGNABLE_MODULES: AssignableModule[] = [
  { id: 'template-settings', label: '格式管理' },
  { id: 'bid-check', label: '标书检查' },
  { id: 'docs', label: '使用文档' },
  { id: 'faq', label: '问题FAQ' },
  { id: 'user-management', label: '用户管理' },
];

// 普通用户实际可被授予的模块（排除 user-management）。
export const GRANTABLE_MODULE_IDS: SectionId[] = ['template-settings', 'bid-check', 'docs', 'faq'];

// 默认对所有登录用户开放的模块（不进授予集）。
// 与 server/src/auth/permissions.ts DEFAULT_OPEN_MODULE_IDS 保持同源。
const DEFAULT_OPEN_MODULES: SectionId[] = ['dashboard', 'bid-generation', 'template-settings'];

// 已随 DB-01~04 裁剪下线的模块：模型、服务端路由、菜单入口均已移除。
// 这里显式拒绝（含管理员），确保旧书签/直链落地时被 AppRouter 兜底重定向到仪表盘，而不是白屏。
const RETIRED_SECTIONS: SectionId[] = [
  'knowledge-base',
  'document-knowledge-base',
  'tool-asset-library',
  'company-qualification-library',
  'personnel-qualification-library',
  // 响应偏离表工作台：产品裁剪（product_mvp DB-01/FE-01），页面、API 与服务端路由均已移除。
  'response-deviation-table',
];

// 子路由 → 所属模块映射（用于判定深链/子页面归属）。
const SECTION_TO_MODULE: Partial<Record<SectionId, SectionId>> = {
  // 格式管理
  'my-templates': 'template-settings',
  'new-template': 'template-settings',
  'export-format': 'template-settings',
  // 标书检查
  'duplicate-check': 'bid-check',
  'rejection-check': 'bid-check',
  // 使用文档（faq 顶层 id 经 ASSIGNABLE_MODULES 回退解析，无需在此映射）
  'docs-usage': 'docs',
  'docs-config': 'docs',
};

// 返回 section 所属的可授予模块 id；null 表示默认开放/非模块门禁（如 dashboard/标书生成/settings）。
export function getModuleForSection(section: SectionId): SectionId | null {
  if (SECTION_TO_MODULE[section]) return SECTION_TO_MODULE[section] as SectionId;
  const assignable = ASSIGNABLE_MODULES.find((m) => m.id === section);
  return assignable ? assignable.id : null;
}

// 判定某 section 对给定用户是否可访问。
// admin → 全部；user-management/prompt-management → 仅 admin；默认开放 → 全员；
// 子页面（如"我的模板"）归属默认开放模块时同样全员放行——修复普通用户点"新建模板"被弹回首页的问题；
// 其余需 modules 含所属模块。
export function canAccessSection(
  role: string | undefined,
  modules: string[] | undefined,
  section: SectionId,
): boolean {
  // 已下线模块先拦：否则 getModuleForSection 返回 null 会被当成"非门禁项"放行。
  if (RETIRED_SECTIONS.includes(section)) return false;
  if (role === 'admin') return true;
  if (section === 'user-management') return false;
  if (section === 'prompt-management') return false;
  if (section === 'analytics') return false; // 数据看板仅管理员
  if ((DEFAULT_OPEN_MODULES as string[]).includes(section)) return true;
  const mod = getModuleForSection(section);
  if (mod === null) return true; // settings 等非门禁项默认放行
  if ((DEFAULT_OPEN_MODULES as string[]).includes(mod)) return true; // 归属默认开放模块的子页面
  return Boolean(modules?.includes(mod));
}
