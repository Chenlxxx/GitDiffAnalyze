export type DiffAnalysisMode = 'full_diff' | 'segmented_full_diff' | 'partial_full_diff';

export interface DiffStrategy {
  mode: DiffAnalysisMode;
  confidenceNote: string;
}

// Thresholds for determining analysis strategy
export const MAX_COMMITS_FOR_FULL_DIFF = Number(import.meta.env.VITE_MAX_COMMITS_FOR_FULL_DIFF) || 100;
export const MAX_FILES_FOR_FULL_DIFF = Number(import.meta.env.VITE_MAX_FILES_FOR_FULL_DIFF) || 50;

/**
 * Determines the best analysis strategy based on the scale of changes.
 */
export function determineDiffStrategy(commitCount: number, fileCount: number): DiffStrategy {
  if (commitCount <= MAX_COMMITS_FOR_FULL_DIFF && fileCount <= MAX_FILES_FOR_FULL_DIFF) {
    return {
      mode: 'full_diff',
      confidenceNote: '版本差异规模适中，已执行完整代码差异分析。'
    };
  }

  if (fileCount <= 300) {
    return {
      mode: 'segmented_full_diff',
      confidenceNote: '版本差异规模较大，已执行关键文件分片深度分析。'
    };
  }

  return {
    mode: 'partial_full_diff',
    confidenceNote: '版本差异规模巨大，已降级为基于 Commit 记录和发布日志的概览分析。'
  };
}
