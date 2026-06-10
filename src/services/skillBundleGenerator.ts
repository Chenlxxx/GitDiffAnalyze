import { ChangeLogAnalysis, FullDiffAnalysis, SkillBundle } from '../types';

/**
 * 基于 ChangeLog 分析结果，通过纯代码逻辑构建 Skill Bundle。
 * 不涉及大模型调用，确保导出速度。
 */
export function buildAnalysisBundleFromChangeLog(
  analysis: ChangeLogAnalysis,
  repoUrl: string,
  fromVersion: string,
  toVersion: string,
  projectBackground: string
): SkillBundle {
  const repoParts = repoUrl.split('/');
  const repoName = repoParts[repoParts.length - 1] || 'unknown-repo';
  const now = new Date().toISOString();

  const rows = analysis.excelRows || [];
  const highRiskCount = rows.filter(r => r.risk === '高').length;
  const mediumRiskCount = rows.filter(r => r.risk === '中').length;
  const lowRiskCount = rows.filter(r => r.risk === '低').length;

  // 1. manifest.json
  const manifest = {
    repo: repoUrl,
    component: repoName,
    from_ref: fromVersion,
    to_ref: toVersion,
    analysis_mode: "changelog",
    generated_at: now,
    language: "zh-CN",
    finding_count: rows.length,
    high_risk_count: highRiskCount,
    medium_risk_count: mediumRiskCount,
    low_risk_count: lowRiskCount,
    confidence: "upstream-high / repo-unverified",
    limitations: ["基于 ChangeLog 分析生成，未进行源码级验证"],
    project_background: projectBackground || ""
  };

  // 2. file-risk.json
  const fileRisk = rows.map((row, index) => {
    const id = `chg-${(index + 1).toString().padStart(3, '0')}`;
    return {
      id,
      version: row.version || toVersion,
      title: row.changepoint,
      title_zh: row.chinese,
      severity: row.risk === '高' ? 'high' : (row.risk === '中' ? 'medium' : 'low'),
      functional_purpose: row.function,
      triage_advice: row.suggestion ? [row.suggestion] : [],
      test_advice: row.test_suggestion ? [row.test_suggestion] : [],
      code_investigation_guide: row.code_discovery ? [row.code_discovery] : [],
      code_remediation_guide: row.code_fix ? [row.code_fix] : [],
      confidence: "high"
    };
  });

  // 3. diff-evidence.jsonl
  // 尽量从 items 中提取更详细的证据，如果 items 不足则回退到 rows
  const diffEvidenceLines = (analysis.items || []).map((item, index) => {
    const id = `chg-${(index + 1).toString().padStart(3, '0')}`;
    const evidence = {
      id,
      source_type: "changelog_row",
      upstream_version: toVersion,
      hypothesis: item.reason,
      sample_failure_signatures: [],
      suspect_apis: [],
      likely_impact_surfaces: item.compatibilityAnalysis ? [item.compatibilityAnalysis] : [],
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
      const evidence = {
        id,
        source_type: "changelog_row",
        upstream_version: toVersion,
        hypothesis: row.chinese,
        sample_failure_signatures: [],
        suspect_apis: [],
        likely_impact_surfaces: [],
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

## 项目背景
${projectBackground}

---
*本报告由 Release Review 自动化工具基于 ChangeLog 结果自动转换生成。*
`;

  return {
    manifest,
    fileRisk,
    diffEvidence,
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
  projectBackground: string
): SkillBundle {
  const repoParts = repoUrl.split('/');
  const repoName = repoParts[repoParts.length - 1] || 'unknown-repo';
  const now = new Date().toISOString();

  const items = analysis.items || [];
  const rows = analysis.excelRows || [];
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
    repo: repoUrl,
    component: repoName,
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
    confidence: "upstream-diff-verified / repo-unverified",
    limitations,
    project_background: projectBackground || ""
  };

  // 2. file-risk.json
  const fileRisk = items.map((item, index) => {
    const id = `diff-${(index + 1).toString().padStart(3, '0')}`;
    const row = rowForItem(item, index);
    return {
      id,
      version: row?.version || toVersion,
      title: item.title,
      title_zh: row?.chinese || item.description,
      severity: item.riskLevel === 'High' ? 'high' : (item.riskLevel === 'Medium' ? 'medium' : 'low'),
      functional_purpose: row?.function || item.compatibilityAnalysis || item.description,
      triage_advice: row?.suggestion ? [row.suggestion] : [],
      test_advice: row?.test_suggestion ? [row.test_suggestion] : [],
      code_investigation_guide: row?.code_discovery ? [row.code_discovery] : [],
      code_remediation_guide: row?.code_fix ? [row.code_fix] : (item.codeExample?.after ? [item.codeExample.after] : []),
      confidence: isDegraded ? "medium" : "high"
    };
  });

  // 3. diff-evidence.jsonl（与 file-risk.json 共用 id）
  const diffEvidence = items.map((item, index) => {
    const id = `diff-${(index + 1).toString().padStart(3, '0')}`;
    return JSON.stringify({
      id,
      source_type: "full_diff_item",
      upstream_version: toVersion,
      hypothesis: item.description,
      sample_failure_signatures: [],
      suspect_apis: [],
      likely_impact_surfaces: item.compatibilityAnalysis ? [item.compatibilityAnalysis] : [],
      source_snippet: item.sourceSnippet || null,
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

## 项目背景
${projectBackground}

---
*本报告由 Release Review 自动化工具基于全量 Diff 结果自动转换生成。*
`;

  return {
    manifest,
    fileRisk,
    diffEvidence,
    unresolvedQuestions,
    platformSummary
  };
}
