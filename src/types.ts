export type AIProviderType = 'gemini' | 'openai-compatible';

export interface AIConfig {
  provider: AIProviderType;
  apiKey: string;
  baseUrl?: string;
  model: string;
  useProxy: boolean;
  githubToken?: string;
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
  categories: {
    name: string;
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
  }[];
  overallRisk: 'High' | 'Medium' | 'Low';
  recommendations: string[];
}

export interface AIProvider {
  analyzeChangeLog(changeLog: string, projectBackground: string): Promise<ChangeLogAnalysis>;
  analyzeDiff(diff: string, prTitle: string, projectBackground: string): Promise<DiffAnalysis>;
  analyzeFullDiff(diff: string, projectBackground: string, commits?: any[]): Promise<FullDiffAnalysis>;
}
