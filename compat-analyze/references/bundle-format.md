# analysis-bundle 格式（与 release-review skill 兼容）

在 `analysis-bundle/` 目录下生成以下 6 个文件。使用方把整个目录放进 release-review skill 的
`analysis-bundle/` 子目录（与该 skill 的 SKILL.md 同级，例如 Claude Code 的
`.claude/skills/release-review/analysis-bundle/` 或 OpenCode 的
`.opencode/skills/release-review/analysis-bundle/`），即可做第二阶段落地复核。

## 1. manifest.json
```json
{
  "schema_version": 2,
  "bundle_schema_version": 2,
  "repo": "https://github.com/owner/repo",
  "component": "repo",
  "ecosystem": "maven | npm | python | go | rust | unknown",
  "package_coordinates": {
    "package": "repo",
    "repo": "https://github.com/owner/repo",
    "purl": null,
    "coordinates": []
  },
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
  "external_evidence_count": 0,
  "external_evidence_sources": {
    "total": 0,
    "github": 0,
    "stackoverflow": 0,
    "osv": 0,
    "official_or_maintainer": 0
  },
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
  "risk_type": "api-contract | behavior-change | config-contract | runtime-baseline | dependency-constraint | failure-mode | compatibility-risk",
  "trigger_condition": "风险在使用方仓库中成立的触发条件",
  "failure_signatures": ["可能出现的错误、异常、日志、构建失败签名"],
  "affectedApis": ["受影响的 API/配置/符号"],
  "affected_symbols": [
    {
      "name": "org.example.Foo#bar",
      "kind": "method | class | config | exception | keyword",
      "search_variants": ["org.example.Foo#bar", "bar"]
    }
  ],
  "source_file": "上游变更文件路径或 null",
  "source_url": "上游 compare / commit / release URL",
  "local_search_terms": ["本地仓优先搜索词，已过滤 String/Builder/Default/This 等噪声词"],
  "external_evidence_urls": ["公开证据 URL"],
  "functional_purpose": "影响场景",
  "triage_advice": ["排查点"],
  "test_advice": ["测试建议"],
  "code_investigation_guide": ["涉及类/关键字"],
  "code_remediation_guide": ["整改建议"],
  "confidence": "high | medium"
}]
```
二阶段本地脚本会在 `final-report.json` 中为每条 review 追加：
```json
{
  "status": "confirmed | likely | downgraded | rejected | needs-human",
  "auto_fix_eligible": true,
  "reason": "机器复核原因"
}
```
`auto_fix_eligible=true` 表示该项满足自动整改门槛：本地 confirmed，且原始或最终风险为 high。skill 只能对这些项执行代码修改。

## 3. diff-evidence.jsonl
每行一个 JSON 对象，id 与 file-risk.json 对应：
```json
{"id":"diff-001","source_type":"full_diff_item","upstream_version":"toTag","hypothesis":"变更说明","sample_failure_signatures":["错误签名"],"suspect_apis":["类名/方法名/配置项"],"likely_impact_surfaces":["影响面"],"source_snippet":"关键 diff 片段或 null","source_file":"上游变更文件路径或 null","source_url":"上游 compare / commit / release URL","local_search_terms":["本地仓优先搜索词"],"external_evidence_urls":["公开证据 URL"],"related_commits":["commit URL"],"before_after_hint":{"before":"旧用法","after":"新用法"}}
```

## 4. external-evidence.jsonl
每行一个 JSON 对象，id 通过 `risk_id` 关联 file-risk / diff-evidence。该文件来自联网搜索，仅作公开经验佐证和搜索词增强，不替代本地代码验证：
```json
{"risk_id":"diff-001","source_type":"github_issue | github_pr | stackoverflow | osv | web_search","source_url":"https://...","title":"公开证据标题","matched_terms":["命中的搜索词"],"evidence_summary":"简要摘要","signal":"upstream_issue_or_regression | community_runtime_or_migration_question | security_advisory | reference_only_web_result","trust_level":"official | maintainer | community-confirmed | security | registry | weak","confidence":0.76,"score":12,"reference_only":false,"extracted_terms":["从证据中抽取的 API/配置/错误词"],"failure_signatures":["异常或错误签名"],"affected_symbols":[{"name":"FooException","kind":"exception","search_variants":["FooException"]}],"published_at":"ISO8601 或 null"}
```
其中 `reference_only=true` 的 `web_search` 结果只作为前端跳转参考，不进入风险打分和本地搜索词回灌。

## 5. unresolved-questions.json
无法仅凭上游信息确认、需要使用方人工核实的问题数组（可为空数组）。

## 6. platform-summary.md
中文摘要：版本信息、风险计数、核心摘要、核心建议、项目背景。
