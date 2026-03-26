---
name: release-review
description: 使用内置的 analysis-bundle，对当前本地仓库进行三方件升级风险复核，并输出中文 markdown 或 word 报告。适用于仓库内存在 .opencode/skills/release-review/analysis-bundle，且用户希望 claude code 或 opencode 结合真实代码、调用方、配置与测试，对上游 changelog 风险项做二次验证并生成中文汇总报告的场景。
---

当用户要求运行或使用 release-review skill 时，直接执行以下工作流。

## 输入位置
本 skill 自带的分析输入位于：
`.opencode/skills/release-review/analysis-bundle/`

优先读取以下文件：
1. `.opencode/skills/release-review/analysis-bundle/manifest.json`
2. `.opencode/skills/release-review/analysis-bundle/file-risk.json`
3. `.opencode/skills/release-review/analysis-bundle/diff-evidence.jsonl`
4. `.opencode/skills/release-review/analysis-bundle/unresolved-questions.json`
5. `.opencode/skills/release-review/analysis-bundle/platform-summary.md`

## 主要任务
将 bundle 中的每条风险项都视为“待验证假设 + 已有证据”，不要视为最终事实。

读取 bundle 后，必须结合当前仓库执行以下动作：
- 搜索相关三方库、API、调用点、包装层、适配器、配置项与测试代码
- 对每一条高风险或中风险 finding，确认、降级或推翻
- 识别受影响模块、入口点、调用链与可能的运行时故障模式
- 在仓库根目录输出 `final-report.md`

不要停留在对 bundle 的复述。输出必须是**基于当前仓库证据的中文汇总报告**。

## 执行规则
- 全部输出使用中文。
- 优先使用当前仓库中的代码证据，而不是项目背景推测。
- 如果仓库未使用某个被引用的库或 API，要明确说明，并降低该风险项的置信度或级别。
- 必要时引用简短代码片段、文件路径、类名、方法名作为证据。
- 无法仅凭当前仓库证明的内容，放入“待人工确认问题”，不要猜测。
- 除非必须文件缺失，否则不要先请求确认，直接开始分析。
- 对 bundle 中的**所有风险项**做统一汇总，不要只分析第一条。

## 中文报告结构
在仓库根目录生成 `final-report.md`，使用以下结构：

# 三方件升级复核报告

## 一、执行摘要
- 升级范围
- 风险项总数
- 已确认高风险项
- 已降级或不适用项
- 仍待人工确认项
- 最终总体判断

## 二、已确认成立的风险项
对每一项至少包含：
- 风险标题
- 风险等级
- 在当前仓库中成立的原因
- 受影响文件、模块或调用点
- 可能故障模式
- 整改建议

## 三、已降级或不适用的风险项
对每一项至少包含：
- 风险标题
- 上游假设
- 为什么在当前仓库中不成立，或为什么风险降低

## 四、待人工确认问题
列出无法仅凭当前仓库证明的内容。

## 五、受影响模块与调用链汇总
按模块、入口点、调用链或功能域进行归纳。

## 六、建议整改与测试计划
给出优先级清单，优先覆盖高风险项。

## 七、证据附录
列出使用到的 bundle 文件，以及检查过的关键仓库文件路径。

## 可选 Word 导出
如果用户在 markdown 报告生成后还要求 Word 输出，运行：
`python .opencode/skills/release-review/scripts/export_docx.py final-report.md final-report.docx`

参考 `.opencode/skills/release-review/references/example-report.md` 获取风格示例。
