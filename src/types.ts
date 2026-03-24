export type AIProviderType = 'gemini' | 'openai-compatible';

export interface AIConfig {
  provider: AIProviderType;
  apiKey: string;
  baseUrl?: string;
  model: string;
  useProxy: boolean;
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

export interface AIProvider {
  analyzeChangeLog(changeLog: string, projectBackground: string): Promise<ChangeLogAnalysis>;
  analyzeDiff(diff: string, prTitle: string, projectBackground: string): Promise<DiffAnalysis>;
  analyzeFullDiff(diff: string, projectBackground: string, fromVersion: string, toVersion: string, releaseNotes?: string, commits?: any[], files?: any[], metadata?: { mode?: string, fallbackReason?: string, confidenceNote?: string }): Promise<FullDiffAnalysis>;
  analyzeBatchDiff(diff: string, projectBackground: string, fromVersion: string, toVersion: string, groupName: string, batchIndex: number, totalBatches: number): Promise<BatchAnalysisResult>;
  aggregateBatchResults(batchResults: BatchAnalysisResult[], projectBackground: string, fromVersion: string, toVersion: string, releaseNotes?: string): Promise<FullDiffAnalysis>;
}
