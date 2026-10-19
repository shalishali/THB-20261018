export interface OutlineItem {
  id: string;
  title: string;
  description: string;
  source_requirement_id?: string;
  source_requirement_title?: string;
  knowledge_item_ids?: string[];
  outlineAttribute?: OutlineRootAttribute;
  contentMode?: OutlineContentMode;
  contentModeNote?: string;
  isMirror?: boolean;
  mirrorSourceText?: string;
  children?: OutlineItem[];
  content?: string;
}

// 目录生成范围：aligned = 完整投标文件（历史模式，暂未开放）；standalone-technical = 技术文件独立成册（仅技术方案）。
export type OutlineMode = 'aligned' | 'standalone-technical';

// 当前 STEP03 只开放「技术文件独立成册」，作为客户端默认值与历史配置的兜底。
export const DEFAULT_OUTLINE_MODE: OutlineMode = 'standalone-technical';
export type OutlineExpansionMode = 'original-only' | 'ai-complement';
export type OutlineRootAttribute = 'general' | 'business' | 'qualification' | 'technical' | 'other';
export type OutlineContentMode = 'ai-generate' | 'template-fill' | 'point-to-point' | 'other';

export interface OutlineWordControlOptions {
  minWordsWan: number;
  maxWordsWan: number;
  wordsPerSectionWan: number;
  forceSectionWords: boolean;
}

export interface OutlineData {
  outline: OutlineItem[];
  project_name?: string;
  project_overview?: string;
  word_control_options?: OutlineWordControlOptions;
  word_control_snapshot?: Record<string, unknown>;
}

export interface TechnicalRequirementGroup {
  requirement_id: string;
  title: string;
  description: string;
  detail_points: string[];
}
