
export interface FileScore {
  filename: string;
  score: number;
  priorityReason: string;
}

const HIGH_PRIORITY_KEYWORDS = [
  'api', 'public', 'export', 'index', 'config', 'settings', 'options',
  'migration', 'migrate', 'deprecate', 'deprecated', 'breaking',
  'interface', 'types', 'schema', 'core', 'entry'
];

const HIGH_PRIORITY_EXTENSIONS = [
  'json', 'xml', 'gradle', 'txt', 'py', 'yml', 'yaml', 'properties', 'ts', 'tsx', 'java', 'go', 'rs'
];

const HIGH_PRIORITY_FILENAMES = [
  'package.json', 'pom.xml', 'build.gradle', 'requirements.txt', 'setup.py',
  'tsconfig.json', 'webpack.config.js', 'CHANGELOG.md', 'RELEASE_NOTES.md'
];

export function scoreFile(filename: string): FileScore {
  let score = 0;
  const reasons: string[] = [];
  const lowerFilename = filename.toLowerCase();

  // Check exact filename matches
  const baseName = filename.split('/').pop() || '';
  if (HIGH_PRIORITY_FILENAMES.includes(baseName)) {
    score += 50;
    reasons.push('Critical configuration or documentation file');
  }

  // Check keywords in path
  for (const keyword of HIGH_PRIORITY_KEYWORDS) {
    if (lowerFilename.includes(keyword)) {
      score += 20;
      reasons.push(`Contains keyword: ${keyword}`);
    }
  }

  // Check path structure
  if (lowerFilename.includes('src/public/') || lowerFilename.includes('src/api/') || lowerFilename.includes('src/types/') || lowerFilename.includes('src/config/')) {
    score += 30;
    reasons.push('Located in a public/API/config directory');
  }

  if (lowerFilename.includes('migration/') || lowerFilename.includes('docs/migration/')) {
    score += 40;
    reasons.push('Migration related file');
  }

  // Check extension
  const ext = filename.split('.').pop()?.toLowerCase();
  if (ext && HIGH_PRIORITY_EXTENSIONS.includes(ext)) {
    score += 5;
    // Don't add to reasons for just extension unless it's very specific
  }

  return {
    filename,
    score,
    priorityReason: reasons.join(', ') || 'Standard file'
  };
}

export function sortFilesByPriority(files: any[]): any[] {
  return [...files]
    .map(f => ({ ...f, _score: scoreFile(f.filename) }))
    .sort((a, b) => b._score.score - a._score.score);
}
