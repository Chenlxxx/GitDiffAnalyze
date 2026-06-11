# analysis-bundle 格式（与 release-review skill 兼容）

在 `analysis-bundle/` 目录下生成以下 5 个文件。使用方把整个目录放进自己仓库的
`.opencode/skills/release-review/analysis-bundle/`，即可用 release-review skill 做第二阶段落地复核。

## 1. manifest.json
```json
{
  "repo": "https://github.com/owner/repo",
  "component": "repo",
  "from_ref": "解析后的真实 fromTag",
  "to_ref": "解析后的真实 toTag",
  "analysis_mode": "full_diff | multi_batch_full_diff | changelog",
  "generated_at": "ISO8601 时间",
  "language": "zh-CN",
  "finding_count": 0,
  "high_risk_count": 0,
  "medium_risk_count": 0,
  "low_risk_count": 0,
  "overall_risk": "High | Medium | Low",
  "confidence": "upstream-high / repo-unverified",
  "limitations": ["分析的已知局限"],
  "project_background": "使用方项目背景原文"
}
```

## 2. file-risk.json
风险项数组，id 形如 `diff-001`（与 diff-evidence.jsonl 对齐）：
```json
[{
  "id": "diff-001",
  "version": "toTag",
  "title": "英文/原文标题",
  "title_zh": "中文描述",
  "severity": "high | medium | low",
  "functional_purpose": "影响场景",
  "triage_advice": ["排查点"],
  "test_advice": ["测试建议"],
  "code_investigation_guide": ["涉及类/关键字"],
  "code_remediation_guide": ["整改建议"],
  "confidence": "high | medium"
}]
```

## 3. diff-evidence.jsonl
每行一个 JSON 对象，id 与 file-risk.json 对应：
```json
{"id":"diff-001","source_type":"full_diff_item","upstream_version":"toTag","hypothesis":"变更说明","sample_failure_signatures":[],"suspect_apis":["类名/方法名"],"likely_impact_surfaces":["影响面"],"source_snippet":"关键 diff 片段或 null","related_commits":["commit URL"],"before_after_hint":{"before":"旧用法","after":"新用法"}}
```

## 4. unresolved-questions.json
无法仅凭上游信息确认、需要使用方人工核实的问题数组（可为空数组）。

## 5. platform-summary.md
中文摘要：版本信息、风险计数、核心摘要、核心建议、项目背景。
