import { ChangeLogAnalysis, SkillBundle } from '../types';

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
    limitations: ["基于 ChangeLog 分析生成，未进行源码级验证"]
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
