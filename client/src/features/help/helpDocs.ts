// 公开帮助中心的文档索引。文件本身放在 client/public/docs，登录前即可阅读。
// 归类只影响导航，不复制正文；新增文档时在 HELP_DOCS 里补一条即可。

export type HelpCategoryId = 'start' | 'features' | 'faq' | 'admin' | 'config';

export interface HelpCategory {
  id: HelpCategoryId;
  label: string;
  description: string;
}

export interface HelpDoc {
  id: string;
  category: HelpCategoryId;
  title: string;
  description: string;
  /** 相对 client/public/docs 的路径，使用中文文件名。 */
  file: string;
}

export const HELP_CATEGORIES: HelpCategory[] = [
  { id: 'start', label: '快速开始', description: '第一次使用，从上传到导出' },
  { id: 'features', label: '功能指南', description: '查重、废标检查与问题反馈' },
  { id: 'faq', label: '常见问题', description: '卡住时先看这里' },
  { id: 'admin', label: '账号与管理', description: '用户、权限与提示词' },
  { id: 'config', label: '配置指南', description: '模型、解析与智能体' },
];

export const HELP_DOCS: HelpDoc[] = [
  {
    id: 'usage-01',
    category: 'start',
    title: '生成技术方案',
    description: '从上传招标文件、解析评分项，到生成目录正文并导出 Word 的完整流程。',
    file: '使用/01-生成技术方案.md',
  },
  {
    id: 'usage-02',
    category: 'start',
    title: '已有方案扩写',
    description: '保留已有方案的结构和内容，在原有骨架上补充厚度。',
    file: '使用/02-已有方案扩写.md',
  },
  {
    id: 'usage-04',
    category: 'features',
    title: '标书查重',
    description: '多份标书之间查重复，提前发现大段雷同，降低撞车风险。',
    file: '使用/04-标书查重.md',
  },
  {
    id: 'usage-05',
    category: 'features',
    title: '废标项检查',
    description: '对照招标文件逐条排查废标红线，交稿前少漏一项。',
    file: '使用/05-废标项检查.md',
  },
  {
    id: 'usage-07',
    category: 'features',
    title: '问题 FAQ 使用教程',
    description: '查看已有问题、提交新问题并上传截图，跟踪管理员的回复。',
    file: '使用/07-问题FAQ.md',
  },
  {
    id: 'usage-06',
    category: 'faq',
    title: '常见问题',
    description: '“下一步”不能点、解析效果不好、生成失败、图片不完整等常见故障。',
    file: '使用/06-常见问题.md',
  },
  {
    id: 'usage-08',
    category: 'admin',
    title: '用户管理',
    description: '自助注册后的角色、模块权限、密码与账号删除。',
    file: '使用/08-用户管理.md',
  },
  {
    id: 'usage-09',
    category: 'admin',
    title: '提示词管理',
    description: '理解内置提示词分组，调整、启用或新建提示词来改变生成效果。',
    file: '使用/09-提示词管理.md',
  },
  {
    id: 'config-01',
    category: 'config',
    title: '配置文本模型（必做）',
    description: '接入文本模型 API，这是解析、生成目录和正文的前置条件。',
    file: '配置/01-配置文本模型.md',
  },
  {
    id: 'config-02',
    category: 'config',
    title: '配置生图模型（可选）',
    description: '需要 AI 配图时，配置生图模型与图片尺寸。',
    file: '配置/02-配置生图模型.md',
  },
  {
    id: 'config-03',
    category: 'config',
    title: '选择文件解析方式',
    description: '按文件类型选择本地解析或 LibreOffice 转换，提升招标文件解析质量。',
    file: '配置/03-选择文件解析方式.md',
  },
  {
    id: 'config-04',
    category: 'config',
    title: '智能体配置',
    description: '配置智能体模型与工具，用于更深入的目录和正文处理。',
    file: '配置/04-智能体配置.md',
  },
];

export function getHelpDoc(id: string | null | undefined): HelpDoc | undefined {
  return HELP_DOCS.find((doc) => doc.id === id);
}

export function getCategory(id: HelpCategoryId): HelpCategory {
  return HELP_CATEGORIES.find((category) => category.id === id) ?? HELP_CATEGORIES[0];
}

/** 中文按字符估算阅读时间；图片多时向上取整，给用户一个大概预期。 */
export function estimateReadMinutes(markdown: string): number {
  const chars = markdown.replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\s+/g, '').length;
  return Math.max(2, Math.ceil(chars / 450));
}
