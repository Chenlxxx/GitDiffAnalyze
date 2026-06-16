---
name: compat-analyze
description: 评估 GitHub 三方库从版本 A 升级到版本 B 的破坏性变更与兼容性风险，端到端完成数据获取、分级 Diff 分析、（可选）在使用方代码仓库中追踪受影响 API 的多层调用链路，输出中文风险报告（可选 Word 与 analysis-bundle）。当用户问“某个库从 X 升到 Y 有什么风险/要改什么”、要对依赖升级做兼容性评估、或要在自己的代码仓库里复核某次升级影响时使用。
---

本 skill 是 CompatAnalyzer 平台的完整能力封装：无需启动任何 Web 服务，agent 自己用 GitHub API 取数、用大模型分析、（在使用方仓库中时）结合真实代码做落地复核。

## 何时用哪一段
- **只评估上游库本身**（用户没有给出使用方代码，或只想知道某库 A→B 改了什么）：执行第 1–3 步。
- **评估对“我的项目”的影响**（当前工作目录就是使用该库的代码仓库）：执行第 1–4 步，第 4 步是核心价值。

开始前需要：仓库地址、起始版本(from)、目标版本(to)。缺失时一次性问清。项目背景可选——若当前目录是使用方仓库，直接扫描 `pom.xml` / `build.gradle` / `package.json` / `go.mod` 等确认依赖与用法，不必询问。

## 第 1 步：取数（GitHub）
优先 `gh api`（自带认证、不易限流）；无 gh 时用 `curl -H "Authorization: Bearer $GITHUB_TOKEN"`。
匿名限额仅 60 次/小时且 404 也计数，务必配置 token。

1. **解析 tag**：用户输入的版本号未必等于 tag 名。并行探测候选直到命中：原值、`v{x}`、去 `v`、`rel/v{x}`（Apache 风格）、`{repo}-{x}`（Netty 风格）。验证：`gh api repos/{owner}/{repo}/git/ref/tags/{tag}`（404=不存在）。全落空再 `gh api repos/{owner}/{repo}/tags --paginate -q '.[].name'` 模糊匹配。
2. **变更概览**：`gh api repos/{owner}/{repo}/compare/{from}...{to}` 取 `commits` 数与 `files` 列表（files 最多 300）。据此决定分析策略（见下）。
3. **完整 diff**：`gh api repos/{owner}/{repo}/compare/{from}...{to} -H "Accept: application/vnd.github.v3.diff"` 一次取回，落盘临时文件后按 `diff --git` 切分按需读。**不要**逐文件请求（compare API 不支持 path 过滤，逐文件实为重复下载全量）。
4. **变更日志**（用于补充语义，可与 diff 并行取）：依次尝试直到拿到充分内容——
   a. `gh api repos/{owner}/{repo}/releases/tags/{to}` 的 `body`；
   b. 自动从 PR 生成（覆盖面最广）：`gh api --method POST repos/{owner}/{repo}/releases/generate-notes -f tag_name={to} -f previous_tag_name={from}` 的 `body`；
   c. 仓库内 CHANGELOG / CHANGES / RELEASE_NOTES / HISTORY / NEWS（含 docs/、多扩展名）对应版本小节；
   d. 都没有则从 commit message 首行合成。

## 第 2 步：分级分析策略
详细规则、风险定级准则与质量要求见 `references/analysis-playbook.md`——**开始分析前先读它**。要点：
- ≤50 文件：通读完整 diff 逐项分析。
- 50–1000 文件：按目录/功能分组并按优先级排序（核心源码 > 接口/协议/配置 > 构建 > 测试 > 文档），高优先级精读、低优先级扫文件名。
- >1000 文件或 diff 拉取失败：基于 commits + 变更日志做概览，报告中明确标注“未做源码级验证”。

## 第 3 步：输出上游风险报告
在当前目录生成 `compat-report.md`，结构见 `references/report-template.md`。全文中文，风险项按等级降序，每项附证据（diff 片段 / commit / 变更日志原文），严禁脱离证据臆测。
如用户要 analysis-bundle（供平台的 release-review skill 或他人复核），按 `references/bundle-format.md` 生成 `analysis-bundle/`。

## 第 4 步（可选，核心价值）：使用方仓库落地复核
当前目录是使用该库的代码仓库时，把第 3 步的每条风险项当作“待验证假设”，在真实代码里做**多层调用链路追踪**确认/降级/推翻。完整方法见 `references/call-chain-tracing.md`——**做复核前先读它**。结论合并进报告的「本仓库命中情况」一节，对命中项给出「上游变更 API → 本仓库封装层 → 业务入口」的完整调用链。

## 可选：Word 导出
报告生成后如需 Word：`python scripts/export_docx.py compat-report.md compat-report.docx`（需要 `python-docx`）。

## 注意事项
- 输出里的版本号一律用解析后的真实 tag 名，避免别名歧义。
- diff 超大时不要全文塞进上下文，按文件分块、按优先级裁剪。
- 仓库未使用某个被引用的 API → 明确说明并降级/排除该风险，不要硬凑。
- 无法仅凭证据证明的内容 → 放入「待人工确认问题」，不要猜。
