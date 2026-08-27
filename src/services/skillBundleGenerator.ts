import { ChangeLogAnalysis, ExternalEvidence, FullDiffAnalysis, SkillBundle } from '../types';

const TERM_NOISE = new Set([
  'a', 'an', 'and', 'are', 'as', 'be', 'by', 'for', 'from', 'if', 'in', 'is', 'it', 'of', 'on', 'or', 'the', 'to',
  'this', 'that', 'these', 'those', 'with', 'without',
  'string', 'builder', 'default', 'returns', 'return', 'collection', 'collections', 'object', 'objects',
  'boolean', 'integer', 'long', 'double', 'float', 'void', 'class', 'interface', 'enum', 'public', 'private',
  'protected', 'static', 'final', 'override', 'abstract', 'null', 'true', 'false', 'new', 'get', 'set',
  'http', 'https', 'apache', 'software', 'version', 'added', 'fixed', 'changed', 'removed', 'contributed'
]);

function textOf(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function uniqueClean(values: unknown[], limit = 40): string[] {
  const out: string[] = [];
  for (const raw of values) {
    const value = textOf(raw).trim().replace(/^['"`\s([{]+|['"`\s)\]}.,;:]+$/g, '');
    if (value.length < 3 || value.length > 160) continue;
    const normalized = value.toLowerCase();
    const compact = normalized.replace(/[^a-z0-9_$#.@/-]+/g, '');
    if (!compact || TERM_NOISE.has(compact) || TERM_NOISE.has(normalized)) continue;
    if (/^\d+$/.test(compact)) continue;
    if (!out.some(existing => existing.toLowerCase() === normalized)) out.push(value);
    if (out.length >= limit) break;
  }
  return out;
}

function extractSearchTerms(...inputs: unknown[]): string[] {
  const raw: string[] = [];
  const text = inputs.map(textOf).filter(Boolean).join('\n');

  for (const input of inputs) {
    if (Array.isArray(input)) raw.push(...input.map(textOf));
  }

  const patterns = [
    /`([^`\n]{3,120})`/g,
    /\b[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+(?:#[A-Za-z_$][\w$]*)?(?:\([^)\n]{0,120}\))?/g,
    /\b[A-Z][A-Za-z0-9_$]+(?:#[A-Za-z_$][\w$]*)?(?:\([^)\n]{0,120}\))?/g,
    /\b[A-Za-z0-9_.-]+(?:Config|Options|Builder|Client|Router|Store|Plugin|Factory|Manager|Strategy|Handler|Interceptor|Consumer|Provider|Request|Response|Exception|Timeout|Socket|Connection|Cache|Auth|Scheme)\b/g,
    /\b(?:[a-z][a-z0-9]*[._-]){1,}[a-z][a-z0-9_-]*\b/g
  ];

  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      raw.push(match[1] || match[0]);
    }
  }

  return uniqueClean(raw, 50);
}

function splitSearchVariants(term: string): string[] {
  const variants = [term];
  const member = term.includes('#') ? term.split('#').pop() : '';
  const simple = term
    .replace(/\([^)]*\)/g, '')
    .split(/[.#/@-]/)
    .filter(Boolean)
    .pop();
  if (member) variants.push(member.replace(/\([^)]*\)/g, ''));
  if (simple) variants.push(simple);
  variants.push(term.replace(/[\s.#/@_-]+/g, ''));
  return uniqueClean(variants, 8);
}

function symbolKind(term: string): string {
  if (term.includes('#') || /\w+\([^)]*\)/.test(term)) return 'method';
  if (/[._-](config|option|property|timeout|ttl|limit|size|count|mode|flag)s?$/i.test(term)) return 'config';
  if (term.includes('.') && /[A-Z]/.test(term.split('.').pop() || '')) return 'class';
  if (/Exception$/.test(term)) return 'exception';
  if (/^[A-Z][A-Za-z0-9_$]+$/.test(term)) return 'class';
  return 'keyword';
}

function affectedSymbols(terms: string[]) {
  return terms.slice(0, 20).map(name => ({
    name,
    kind: symbolKind(name),
    search_variants: splitSearchVariants(name)
  }));
}

function inferRiskType(text: string): string {
  const lower = text.toLowerCase();
  if (/remove|delete|renam|signature|public api|interface|method|constructor|field/.test(lower)) return 'api-contract';
  if (/default|behavior|behaviour|timeout|retry|pool|cache|redirect|cookie|auth|tls|ssl|serialization|protocol/.test(lower)) return 'behavior-change';
  if (/config|option|property|setting|environment|yaml|json|xml/.test(lower)) return 'config-contract';
  if (/jdk|java|node|runtime|baseline|minimum/.test(lower)) return 'runtime-baseline';
  if (/dependency|peer|transitive|bom|version constraint/.test(lower)) return 'dependency-constraint';
  if (/exception|throw|error|failed|failure|cannot|invalid|reject/.test(lower)) return 'failure-mode';
  return 'compatibility-risk';
}

function inferSourceFile(sourceSnippet?: string | null): string | null {
  if (!sourceSnippet) return null;
  const patterns = [
    /^diff --git a\/.+ b\/(.+)$/m,
    /^File:\s*(.+)$/m,
    /\b(?:modified|added|removed|renamed)\s+([^\s]+\.[A-Za-z0-9]+)\b/,
    /\b([A-Za-z0-9_./-]+\.(?:java|kt|groovy|js|jsx|ts|tsx|vue|py|go|rs|cs|xml|yaml|yml|json|properties|toml|gradle|pom))\b/
  ];
  for (const pattern of patterns) {
    const match = sourceSnippet.match(pattern);
    if (match?.[1]) return match[1].trim();
  }
  return null;
}

function sourceUrl(repoUrl: string, fromVersion: string, toVersion: string): string {
  const base = repoUrl.replace(/\.git$/, '').replace(/\/$/, '');
  return `${base}/compare/${encodeURIComponent(fromVersion)}...${encodeURIComponent(toVersion)}`;
}

function packageCoordinates(repoUrl: string, repoName: string) {
  return {
    package: repoName,
    repo: repoUrl,
    purl: null,
    coordinates: []
  };
}

function inferEcosystem(...inputs: unknown[]): string {
  const text = inputs.map(textOf).join('\n').toLowerCase();
  if (/pom\.xml|\.java\b|maven|gradle|build\.gradle/.test(text)) return 'maven';
  if (/package\.json|pnpm-lock|yarn\.lock|bun\.lock|\.tsx?\b|\.jsx?\b|\.vue\b|vite|webpack|npm|pnpm|yarn/.test(text)) return 'npm';
  if (/pyproject\.toml|requirements\.txt|poetry\.lock|\.py\b|python|pypi/.test(text)) return 'python';
  if (/go\.mod|\.go\b|golang/.test(text)) return 'go';
  if (/cargo\.toml|cargo\.lock|\.rs\b|rust/.test(text)) return 'rust';
  if (/\.csproj|\.sln|\.cs\b|nuget|dotnet/.test(text)) return 'dotnet';
  if (/composer\.json|composer\.lock|\.php\b/.test(text)) return 'php';
  return 'unknown';
}

function externalEvidenceLines(externalEvidence: ExternalEvidence[] = []): string {
  return externalEvidence.map(item => JSON.stringify(item)).join('\n');
}

function evidenceForRisk(externalEvidence: ExternalEvidence[], riskId: string): ExternalEvidence[] {
  return externalEvidence.filter(item => item.risk_id === riskId);
}

function evidenceSourceSummary(externalEvidence: ExternalEvidence[]) {
  return {
    total: externalEvidence.length,
    github: externalEvidence.filter(e => e.source_type === 'github_issue' || e.source_type === 'github_pr').length,
    stackoverflow: externalEvidence.filter(e => e.source_type === 'stackoverflow').length,
    osv: externalEvidence.filter(e => e.source_type === 'osv').length,
    web_reference: externalEvidence.filter(e => e.reference_only).length,
    official_or_maintainer: externalEvidence.filter(e => ['official', 'maintainer', 'security'].includes(e.trust_level)).length
  };
}

function evidenceSearchTerms(evidence: ExternalEvidence[]): string[] {
  const values: unknown[] = [];
  for (const item of evidence.filter(e => !e.reference_only)) {
    values.push(item.matched_terms, item.extracted_terms);
    values.push(...(item.affected_symbols || []).map(s => s.name));
  }
  return uniqueClean(values, 60);
}

function evidenceFailureSignatures(evidence: ExternalEvidence[]): string[] {
  return uniqueClean(evidence.filter(e => !e.reference_only).flatMap(item => item.failure_signatures || []), 20);
}

function evidenceUrls(evidence: ExternalEvidence[]): string[] {
  return uniqueClean(evidence.map(item => item.source_url), 20);
}

function mergeTerms(...values: unknown[]): string[] {
  const flattened: unknown[] = [];
  for (const value of values) {
    if (Array.isArray(value)) flattened.push(...value);
    else flattened.push(value);
  }
  return uniqueClean(flattened, 80);
}

/**
 * 基于 ChangeLog 分析结果，通过纯代码逻辑构建 Skill Bundle。
 * 不涉及大模型调用，确保导出速度。
 */
export function buildAnalysisBundleFromChangeLog(
  analysis: ChangeLogAnalysis,
  repoUrl: string,
  fromVersion: string,
  toVersion: string,
  projectBackground: string,
  externalEvidence: ExternalEvidence[] = []
): SkillBundle {
  const repoParts = repoUrl.split('/');
  const repoName = repoParts[repoParts.length - 1] || 'unknown-repo';
  const now = new Date().toISOString();

  const rows = analysis.excelRows || [];
  const ecosystem = inferEcosystem(repoUrl, repoName, rows, analysis.items, projectBackground);
  const highRiskCount = rows.filter(r => r.risk === '高').length;
  const mediumRiskCount = rows.filter(r => r.risk === '中').length;
  const lowRiskCount = rows.filter(r => r.risk === '低').length;

  // 1. manifest.json
  const manifest = {
    schema_version: 2,
    bundle_schema_version: 2,
    repo: repoUrl,
    component: repoName,
    ecosystem,
    package_coordinates: packageCoordinates(repoUrl, repoName),
    from_ref: fromVersion,
    to_ref: toVersion,
    analysis_mode: "changelog",
    generated_at: now,
    language: "zh-CN",
    finding_count: rows.length,
    high_risk_count: highRiskCount,
    medium_risk_count: mediumRiskCount,
    low_risk_count: lowRiskCount,
    external_evidence_count: externalEvidence.length,
    external_evidence_sources: evidenceSourceSummary(externalEvidence),
    confidence: "upstream-high / repo-unverified",
    limitations: ["基于 ChangeLog 分析生成，未进行源码级验证"],
    project_background: projectBackground || ""
  };

  // 2. file-risk.json
  const fileRisk = rows.map((row, index) => {
    const id = `chg-${(index + 1).toString().padStart(3, '0')}`;
    const item = analysis.items?.[index];
    const riskEvidence = evidenceForRisk(externalEvidence, id);
    const externalTerms = evidenceSearchTerms(riskEvidence);
    const externalFailures = evidenceFailureSignatures(riskEvidence);
    const affectedApis = extractSearchTerms(
      (item as any)?.affectedApis,
      row.code_discovery,
      row.changepoint,
      row.chinese,
      row.function,
      item?.reason,
      item?.compatibilityAnalysis,
      item?.codeExample
    );
    const localSearchTerms = mergeTerms(extractSearchTerms(
      affectedApis,
      row.code_discovery,
      row.code_fix,
      row.test_suggestion,
      item?.reason,
      item?.compatibilityAnalysis,
      item?.codeExample
    ), externalTerms, externalFailures);
    const riskText = [row.changepoint, row.chinese, row.function, item?.reason, item?.compatibilityAnalysis].join('\n');
    return {
      id,
      version: row.version || toVersion,
      title: row.changepoint,
      title_zh: row.chinese,
      severity: row.risk === '高' ? 'high' : (row.risk === '中' ? 'medium' : 'low'),
      risk_type: inferRiskType(riskText),
      trigger_condition: row.function || item?.compatibilityAnalysis || row.chinese,
      failure_signatures: mergeTerms(extractSearchTerms(row.test_suggestion).slice(0, 10), externalFailures).slice(0, 15),
      affectedApis,
      affected_symbols: affectedSymbols(mergeTerms(affectedApis.length ? affectedApis : localSearchTerms, externalTerms)),
      source_file: null,
      source_url: sourceUrl(repoUrl, fromVersion, toVersion),
      local_search_terms: localSearchTerms,
      external_evidence_urls: evidenceUrls(riskEvidence),
      functional_purpose: row.function,
      triage_advice: row.suggestion ? [row.suggestion] : [],
      test_advice: row.test_suggestion ? [row.test_suggestion] : [],
      code_investigation_guide: uniqueClean([...(row.code_discovery ? [row.code_discovery] : []), ...affectedApis, ...externalTerms], 20),
      code_remediation_guide: row.code_fix ? [row.code_fix] : [],
      confidence: "high"
    };
  });

  // 3. diff-evidence.jsonl
  // 尽量从 items 中提取更详细的证据，如果 items 不足则回退到 rows
  const diffEvidenceLines = (analysis.items || []).map((item, index) => {
    const id = `chg-${(index + 1).toString().padStart(3, '0')}`;
    const row = rows[index];
    const riskEvidence = evidenceForRisk(externalEvidence, id);
    const externalTerms = evidenceSearchTerms(riskEvidence);
    const externalFailures = evidenceFailureSignatures(riskEvidence);
    const affectedApis = extractSearchTerms(
      (item as any).affectedApis,
      row?.code_discovery,
      item.reason,
      item.compatibilityAnalysis,
      item.codeExample
    );
    const localSearchTerms = mergeTerms(extractSearchTerms(
      affectedApis,
      item.reason,
      item.compatibilityAnalysis,
      item.codeExample,
      row?.test_suggestion
    ), externalTerms, externalFailures);
    const evidence = {
      id,
      source_type: "changelog_row",
      upstream_version: toVersion,
      hypothesis: item.reason,
      sample_failure_signatures: mergeTerms(extractSearchTerms(row?.test_suggestion).slice(0, 10), externalFailures).slice(0, 15),
      suspect_apis: mergeTerms(affectedApis, externalTerms).slice(0, 60),
      likely_impact_surfaces: item.compatibilityAnalysis ? [item.compatibilityAnalysis] : [],
      source_file: null,
      source_url: sourceUrl(repoUrl, fromVersion, toVersion),
      local_search_terms: localSearchTerms,
      external_evidence_urls: evidenceUrls(riskEvidence),
      before_after_hint: item.codeExample ? {
        before: item.codeExample.before,
        after: item.codeExample.after
      } : null
    };
    return JSON.stringify(evidence);
  });

  // 如果 items 为空，尝试从 rows 补齐基础证据
  if (diffEvidenceLines.length === 0 && rows.length > 0) {
    rows.forEach((row, index) => {
      const id = `chg-${(index + 1).toString().padStart(3, '0')}`;
      const riskEvidence = evidenceForRisk(externalEvidence, id);
      const externalTerms = evidenceSearchTerms(riskEvidence);
      const externalFailures = evidenceFailureSignatures(riskEvidence);
      const affectedApis = extractSearchTerms(row.code_discovery, row.changepoint, row.chinese, row.function);
      const localSearchTerms = mergeTerms(extractSearchTerms(affectedApis, row.code_fix, row.test_suggestion), externalTerms, externalFailures);
      const evidence = {
        id,
        source_type: "changelog_row",
        upstream_version: toVersion,
        hypothesis: row.chinese,
        sample_failure_signatures: mergeTerms(extractSearchTerms(row.test_suggestion).slice(0, 10), externalFailures).slice(0, 15),
        suspect_apis: mergeTerms(affectedApis, externalTerms).slice(0, 60),
        likely_impact_surfaces: [],
        source_file: null,
        source_url: sourceUrl(repoUrl, fromVersion, toVersion),
        local_search_terms: localSearchTerms,
        external_evidence_urls: evidenceUrls(riskEvidence),
        before_after_hint: null
      };
      diffEvidenceLines.push(JSON.stringify(evidence));
    });
  }

  const diffEvidence = diffEvidenceLines.join('\n');

  // 4. unresolved-questions.json
  const unresolvedQuestions: any[] = [];

  // 5. platform-summary.md
  const platformSummary = `
# 三方件升级风险分析摘要 (${repoName})

## 版本信息
- **起始版本**: ${fromVersion}
- **目标版本**: ${toVersion}
- **仓库地址**: ${repoUrl}

## 风险概览
- **总变更点**: ${manifest.finding_count}
- **高风险**: ${highRiskCount}
- **中风险**: ${mediumRiskCount}
- **低风险**: ${lowRiskCount}

## 核心摘要
${analysis.summary}

## 外部证据增强
- **外部证据条数**: ${externalEvidence.length}
- **高可信来源**: ${evidenceSourceSummary(externalEvidence).official_or_maintainer}

## 项目背景
${projectBackground}

---
*本报告由 Release Review 自动化工具基于 ChangeLog 结果自动转换生成。*
`;

  return {
    manifest,
    fileRisk,
    diffEvidence,
    externalEvidence: externalEvidenceLines(externalEvidence),
    unresolvedQuestions,
    platformSummary
  };
}

/**
 * 基于全量 Diff 分析结果，通过纯代码逻辑构建 Skill Bundle。
 * 以 items 为主轴（diff 模式下 excelRows 可能缺失），并保留
 * sourceSnippet / commitLinks 等源码级证据。
 */
export function buildAnalysisBundleFromFullDiff(
  analysis: FullDiffAnalysis,
  repoUrl: string,
  fromVersion: string,
  toVersion: string,
  projectBackground: string,
  externalEvidence: ExternalEvidence[] = []
): SkillBundle {
  const repoParts = repoUrl.split('/');
  const repoName = repoParts[repoParts.length - 1] || 'unknown-repo';
  const now = new Date().toISOString();

  const items = analysis.items || [];
  const rows = analysis.excelRows || [];
  const ecosystem = inferEcosystem(repoUrl, repoName, items, rows, projectBackground);
  // excelRows 与 items 同序生成时按下标对齐，否则按标题匹配
  const rowForItem = (item: FullDiffAnalysis['items'][number], index: number) => {
    if (rows.length === items.length) return rows[index];
    return rows.find(r => r.changepoint === item.title);
  };

  const highRiskCount = items.filter(i => i.riskLevel === 'High').length;
  const mediumRiskCount = items.filter(i => i.riskLevel === 'Medium').length;
  const lowRiskCount = items.filter(i => i.riskLevel === 'Low').length;

  const analysisMode = analysis.analysisMode || 'full_diff';
  const isDegraded = analysisMode !== 'full_diff';

  const limitations = ["基于上游源码 Diff 分析生成，未在使用方仓库验证"];
  if (isDegraded) {
    limitations.push(`分析模式为 ${analysisMode}，可能未覆盖全部变更文件`);
  }
  if (analysis.fallbackReason) {
    limitations.push(`降级原因：${analysis.fallbackReason}`);
  }
  if (analysis.confidenceNote) {
    limitations.push(`置信度说明：${analysis.confidenceNote}`);
  }

  // 1. manifest.json
  const manifest = {
    schema_version: 2,
    bundle_schema_version: 2,
    repo: repoUrl,
    component: repoName,
    ecosystem,
    package_coordinates: packageCoordinates(repoUrl, repoName),
    from_ref: fromVersion,
    to_ref: toVersion,
    analysis_mode: analysisMode,
    generated_at: now,
    language: "zh-CN",
    finding_count: items.length,
    high_risk_count: highRiskCount,
    medium_risk_count: mediumRiskCount,
    low_risk_count: lowRiskCount,
    overall_risk: analysis.overallRisk,
    external_evidence_count: externalEvidence.length,
    external_evidence_sources: evidenceSourceSummary(externalEvidence),
    confidence: "upstream-diff-verified / repo-unverified",
    limitations,
    project_background: projectBackground || ""
  };

  // 2. file-risk.json
  const fileRisk = items.map((item, index) => {
    const id = `diff-${(index + 1).toString().padStart(3, '0')}`;
    const row = rowForItem(item, index);
    const riskEvidence = evidenceForRisk(externalEvidence, id);
    const externalTerms = evidenceSearchTerms(riskEvidence);
    const externalFailures = evidenceFailureSignatures(riskEvidence);
    const affectedApis = extractSearchTerms(
      item.affectedApis,
      row?.code_discovery,
      item.sourceSnippet,
      item.description,
      item.compatibilityAnalysis,
      item.codeExample
    );
    const localSearchTerms = mergeTerms(extractSearchTerms(
      affectedApis,
      item.sourceSnippet,
      item.description,
      item.compatibilityAnalysis,
      item.codeExample,
      row?.test_suggestion,
      row?.code_fix
    ), externalTerms, externalFailures);
    const sourceFile = inferSourceFile(item.sourceSnippet);
    const riskText = [item.title, item.description, item.compatibilityAnalysis, item.sourceSnippet].join('\n');
    return {
      id,
      version: row?.version || toVersion,
      title: item.title,
      title_zh: row?.chinese || item.description,
      severity: item.riskLevel === 'High' ? 'high' : (item.riskLevel === 'Medium' ? 'medium' : 'low'),
      risk_type: inferRiskType(riskText),
      trigger_condition: item.compatibilityAnalysis || row?.function || item.description,
      failure_signatures: mergeTerms(extractSearchTerms(row?.test_suggestion, item.compatibilityAnalysis).slice(0, 10), externalFailures).slice(0, 15),
      affectedApis,
      affected_symbols: affectedSymbols(mergeTerms(affectedApis.length ? affectedApis : localSearchTerms, externalTerms)),
      source_file: sourceFile,
      source_url: sourceUrl(repoUrl, fromVersion, toVersion),
      local_search_terms: localSearchTerms,
      external_evidence_urls: evidenceUrls(riskEvidence),
      functional_purpose: row?.function || item.compatibilityAnalysis || item.description,
      triage_advice: row?.suggestion ? [row.suggestion] : [],
      test_advice: row?.test_suggestion ? [row.test_suggestion] : [],
      code_investigation_guide: uniqueClean([...(row?.code_discovery ? [row.code_discovery] : []), ...affectedApis, ...externalTerms], 20),
      code_remediation_guide: row?.code_fix ? [row.code_fix] : (item.codeExample?.after ? [item.codeExample.after] : []),
      confidence: isDegraded ? "medium" : "high"
    };
  });

  // 3. diff-evidence.jsonl（与 file-risk.json 共用 id）
  const diffEvidence = items.map((item, index) => {
    const id = `diff-${(index + 1).toString().padStart(3, '0')}`;
    const row = rowForItem(item, index);
    const riskEvidence = evidenceForRisk(externalEvidence, id);
    const externalTerms = evidenceSearchTerms(riskEvidence);
    const externalFailures = evidenceFailureSignatures(riskEvidence);
    const affectedApis = extractSearchTerms(
      item.affectedApis,
      row?.code_discovery,
      item.sourceSnippet,
      item.description,
      item.compatibilityAnalysis,
      item.codeExample
    );
    const localSearchTerms = mergeTerms(extractSearchTerms(
      affectedApis,
      item.sourceSnippet,
      item.description,
      item.compatibilityAnalysis,
      item.codeExample,
      row?.test_suggestion
    ), externalTerms, externalFailures);
    const sourceFile = inferSourceFile(item.sourceSnippet);
    return JSON.stringify({
      id,
      source_type: "full_diff_item",
      upstream_version: toVersion,
      hypothesis: item.description,
      sample_failure_signatures: mergeTerms(extractSearchTerms(row?.test_suggestion, item.compatibilityAnalysis).slice(0, 10), externalFailures).slice(0, 15),
      suspect_apis: mergeTerms(affectedApis, externalTerms).slice(0, 60),
      likely_impact_surfaces: item.compatibilityAnalysis ? [item.compatibilityAnalysis] : [],
      source_snippet: item.sourceSnippet || null,
      source_file: sourceFile,
      source_url: sourceUrl(repoUrl, fromVersion, toVersion),
      local_search_terms: localSearchTerms,
      external_evidence_urls: evidenceUrls(riskEvidence),
      related_commits: (item.commitLinks || []).map(c => c.url),
      before_after_hint: item.codeExample ? {
        before: item.codeExample.before,
        after: item.codeExample.after
      } : null
    });
  }).join('\n');

  // 4. unresolved-questions.json
  const unresolvedQuestions: any[] = [];
  if (isDegraded) {
    unresolvedQuestions.push({
      id: "uq-coverage",
      question: `本次分析模式为 ${analysisMode}，未必覆盖两个版本间的全部变更文件，请人工确认未覆盖部分是否涉及当前仓库使用的 API。`,
      reason: analysis.fallbackReason || analysis.confidenceNote || "分析未达到完整 Diff 覆盖"
    });
  }

  // 5. platform-summary.md
  const platformSummary = `
# 三方件升级风险分析摘要 (${repoName})

## 版本信息
- **起始版本**: ${fromVersion}
- **目标版本**: ${toVersion}
- **仓库地址**: ${repoUrl}
- **分析模式**: 全量 Diff（${analysisMode}）
- **整体风险**: ${analysis.overallRisk === 'High' ? '高' : analysis.overallRisk === 'Medium' ? '中' : '低'}

## 风险概览
- **总变更点**: ${items.length}
- **高风险**: ${highRiskCount}
- **中风险**: ${mediumRiskCount}
- **低风险**: ${lowRiskCount}

## 核心摘要
${analysis.summary}

## 核心建议
${(analysis.recommendations || []).map(r => `- ${r}`).join('\n')}

## 外部证据增强
- **外部证据条数**: ${externalEvidence.length}
- **高可信来源**: ${evidenceSourceSummary(externalEvidence).official_or_maintainer}

## 项目背景
${projectBackground}

---
*本报告由 Release Review 自动化工具基于全量 Diff 结果自动转换生成。*
`;

  return {
    manifest,
    fileRisk,
    diffEvidence,
    externalEvidence: externalEvidenceLines(externalEvidence),
    unresolvedQuestions,
    platformSummary
  };
}
