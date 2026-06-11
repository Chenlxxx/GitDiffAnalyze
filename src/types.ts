export type AIProviderType = 'gemini' | 'openai-compatible' | 'anthropic';

export interface AIConfig {
  provider: AIProviderType;
  apiKey: string;
  baseUrl?: string;
  model: string;
  useProxy: boolean;
  /** 单次调用的最大输出 tokens；推理模型（思考占额度）建议 16000+ */
  maxTokens?: number;
}

// ===== 多模型供应商配置（Dify 风格） =====

/** 接口协议：决定请求格式与鉴权方式 */
export type ModelProtocol = 'openai' | 'anthropic' | 'gemini';

/** 用户配置的一个模型供应商实例 */
export interface ModelProviderConfig {
  id: string;
  /** 对应 providerPresets 中的预置厂商，自定义为 custom-openai / custom-anthropic */
  presetId: string;
  displayName: string;
  protocol: ModelProtocol;
  baseUrl: string;
  apiKey: string;
  model: string;
  useProxy: boolean;
  enabled: boolean;
  /** 单次调用的最大输出 tokens（可选，默认 8000；推理模型建议 16000+） */
  maxTokens?: number;
  /** 最近一次连通性测试结果 */
  lastTest?: {
    ok: boolean;
    message: string;
    latencyMs?: number;
    at: string;
  };
}

export interface AppSettings {
  version: 2;
  providers: ModelProviderConfig[];
  activeProviderId: string | null;
  githubToken: string;
  /** 是否启用 AI 流式输出（实时显示模型生成过程），默认开启 */
  streamingEnabled?: boolean;
}

/** ModelProviderConfig -> 旧版 AIConfig，供现有 getAIProvider 路由复用 */
export function toLegacyAIConfig(p: ModelProviderConfig): AIConfig {
  return {
    provider: p.protocol === 'openai' ? 'openai-compatible' : p.protocol,
    apiKey: p.apiKey,
    baseUrl: p.baseUrl || undefined,
    model: p.model,
    useProxy: p.useProxy,
    maxTokens: p.maxTokens
  };
}

export interface ChangeLogAnalysis {
  items: {
    title: string;
    prNumber?: number;
    reason: string;
    impactLevel: 'High' | 'Medium' | 'Low';
    compatibilityAnalysis?: string;
    codeExample?: {
      before: string;
      after: string;
    };
  }[];
  summary: string;
  excelRows?: ExcelAnalysisRow[];
  sourceUrl?: string;
  resolvedTags?: {
    from: string;
    to: string;
  };
}

export interface DiffAnalysis {
  riskLevel: 'High' | 'Medium' | 'Low';
  breakingChanges: string[];
  compatibilityNotes: string[];
  recommendations: string[];
  codeExample?: {
    before: string;
    after: string;
  };
}

export interface FullDiffAnalysis {
  summary: string;
  items: {
    title: string;
    description: string;
    riskLevel: 'High' | 'Medium' | 'Low';
    compatibilityAnalysis?: string;
    sourceSnippet?: string;
    commitLinks?: {
      sha: string;
      url: string;
    }[];
    codeExample?: {
      before: string;
      after: string;
    };
  }[];
  overallRisk: 'High' | 'Medium' | 'Low';
  recommendations: string[];
  excelRows?: ExcelAnalysisRow[];
  analysisMode?: 'full_diff' | 'segmented_full_diff' | 'multi_batch_full_diff' | 'partial_full_diff';
  confidenceNote?: string;
  fallbackReason?: string;
  resolvedTags?: {
    from: string;
    to: string;
  };
  repoUrl?: string;
  fromVersion?: string;
  toVersion?: string;
}

export interface ExcelAnalysisRow {
  version: string;
  changepoint: string;
  chinese: string;
  function: string;
  suggestion: string;
  risk: '高' | '中' | '低';
  test_suggestion: string;
  code_discovery: string;
  code_fix: string;
  related_commits?: string;
}

export interface ExcelAnalysis {
  rows: ExcelAnalysisRow[];
}

export interface BatchAnalysisItem {
  repoUrl: string;
  fromVersion: string;
  toVersion: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  error?: string;
  analysis?: FullDiffAnalysis;
}

export interface BatchAnalysisResult {
  items: FullDiffAnalysis['items'];
  summary: string;
  recommendations: string[];
}

export interface FileEvidence {
  filename: string;
  group: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
  patchAvailable: boolean;
  diffFetchFailed: boolean;
  riskHint: string;
  reviewHint: string;
}

export interface SkillBundle {
  manifest: any;
  fileRisk: any;
  diffEvidence: string;
  unresolvedQuestions: any;
  platformSummary: string;
}

export interface AIProvider {
  analyzeChangeLog(changeLog: string, projectBackground: string, sourceUrl?: string): Promise<ChangeLogAnalysis>;
  analyzeDiff(diff: string, prTitle: string, projectBackground: string): Promise<DiffAnalysis>;
  analyzeFullDiff(diff: string, projectBackground: string, fromVersion: string, toVersion: string, releaseNotes?: string, commits?: any[], files?: any[], metadata?: { mode?: string, fallbackReason?: string, confidenceNote?: string }): Promise<FullDiffAnalysis>;
  analyzeBatchDiff(diff: string, projectBackground: string, fromVersion: string, toVersion: string, groupName: string, batchIndex: number, totalBatches: number, releaseNotes?: string, commits?: any[]): Promise<BatchAnalysisResult>;
  aggregateBatchResults(batchResults: BatchAnalysisResult[], projectBackground: string, fromVersion: string, toVersion: string, releaseNotes?: string): Promise<FullDiffAnalysis>;
}
