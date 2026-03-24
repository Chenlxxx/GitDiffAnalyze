
export const MAX_COMMITS_FOR_FULL_DIFF = 100;
export const MAX_FILES_FOR_FULL_DIFF = 300;
export const MAX_PRIORITY_FILES_FOR_SEGMENTED_DIFF = 30;

export type AnalysisMode = 'full_diff' | 'segmented_full_diff' | 'partial_full_diff';

export interface DiffStrategy {
  mode: AnalysisMode;
  reason?: string;
}

export function determineDiffStrategy(commitsCount: number, filesCount: number): DiffStrategy {
  if (commitsCount <= MAX_COMMITS_FOR_FULL_DIFF && filesCount <= MAX_FILES_FOR_FULL_DIFF) {
    return { mode: 'full_diff' };
  }
  
  if (commitsCount > 500 || filesCount > 1000) {
    return { 
      mode: 'partial_full_diff', 
      reason: 'compare_scale_too_large' 
    };
  }

  return { 
    mode: 'segmented_full_diff', 
    reason: 'compare_scale_too_large' 
  };
}
