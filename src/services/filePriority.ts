export interface FileChange {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
  patch?: string;
}

export const MAX_PRIORITY_FILES_FOR_SEGMENTED_DIFF = Number(import.meta.env.VITE_MAX_PRIORITY_FILES_FOR_SEGMENTED_DIFF) || 15;

/**
 * Scores a file based on its importance for compatibility analysis.
 */
export function getFilePriorityScore(filename: string): number {
  let score = 0;

  // 1. Keywords in filename or path
  const highPriorityKeywords = [
    'api', 'interface', 'contract', 'model', 'schema', 'types', 'migration',
    'config', 'settings', 'security', 'auth', 'core', 'engine', 'util', 'common'
  ];
  const lowPriorityKeywords = [
    'test', 'spec', 'docs', 'example', 'demo', 'mock', 'stub', 'bench', 'perf'
  ];

  const lowerFilename = filename.toLowerCase();
  
  highPriorityKeywords.forEach(kw => {
    if (lowerFilename.includes(kw)) score += 10;
  });

  lowPriorityKeywords.forEach(kw => {
    if (lowerFilename.includes(kw)) score -= 15;
  });

  // 2. File extension
  const highPriorityExtensions = ['.ts', '.tsx', '.java', '.go', '.py', '.rb', '.cs', '.php', '.js', '.jsx'];
  const lowPriorityExtensions = ['.md', '.txt', '.json', '.yaml', '.yml', '.xml', '.css', '.scss', '.html'];

  highPriorityExtensions.forEach(ext => {
    if (lowerFilename.endsWith(ext)) score += 5;
  });

  lowPriorityExtensions.forEach(ext => {
    if (lowerFilename.endsWith(ext)) {
      // package.json and similar are actually high priority
      if (lowerFilename.includes('package.json') || lowerFilename.includes('pom.xml') || lowerFilename.includes('go.mod')) {
        score += 20;
      } else {
        score -= 5;
      }
    }
  });

  // 3. Path structure
  if (lowerFilename.startsWith('src/')) score += 5;
  if (lowerFilename.includes('/api/')) score += 15;
  if (lowerFilename.includes('/internal/')) score += 5;

  return score;
}

/**
 * Sorts files by their priority score.
 */
export function sortFilesByPriority(files: FileChange[]): FileChange[] {
  return [...files].sort((a, b) => {
    const scoreA = getFilePriorityScore(a.filename);
    const scoreB = getFilePriorityScore(b.filename);
    return scoreB - scoreA;
  });
}
