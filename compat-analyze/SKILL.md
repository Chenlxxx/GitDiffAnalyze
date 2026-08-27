---
name: compat-analyze
description: 分析 GitHub 三方库两个版本之间的破坏性变更与兼容性升级风险，输出中文风险报告，并可生成与 release-review 兼容的 analysis-bundle。适用于用户给出"某个库从版本 A 升到版本 B 有什么风险"类问题，或要求对依赖升级做兼容性评估的场景。
---

本 skill 把 CompatAnalyzer 平台的两段式分析流程封装为 agent 工作流：你（agent）自己承担平台中"调用大模型分析"的角色，数据获取用 GitHub API 完成。

## 输入

需要三个必备信息，缺失时一次性向用户问清（不要分多轮）：
1. 仓库地址（如 `https://github.com/apache/httpcomponents-client`）
2. 起始版本（from）与目标版本（to）
3. 可选：项目背景（使用方项目如何使用该库——模块、协议、调用方式）。若当前工作目录本身是使用方仓库，可自行扫描 `pom.xml` / `build.gradle` / `package.json` 等确认依赖与用法，代替询问。

## 第一步：数据获取

优先用 `gh api`（自带认证，不易触发限流）；没有 gh 时用 curl + `$GITHUB_TOKEN`。

1. **解析 tag**：用户输入的版本号未必等于 tag 名。按顺序探测直到命中：原值 → 加 `v` 前缀 → 去 `v` 前缀 → `rel/v{version}`（Apache HttpComponents 风格）→ `{repo}-{version}`（Netty 风格）。验证命令：
   `gh api repos/{owner}/{repo}/git/ref/tags/{tag}`（404 即不存在）。全部不中时列出 `gh api repos/{owner}/{repo}/tags --paginate -q '.[].name'` 模糊匹配。
2. **Release Notes**（按可靠性依次尝试，拿到充分内容即止）：
   a. `gh api repos/{owner}/{repo}/releases/tags/{toTag}` 取 release body；
   b. 为空或过短时，用 GitHub 自动生成变更日志（覆盖面最广，几乎任何有 PR 的仓库都能产出）：
      `gh api --method POST repos/{owner}/{repo}/releases/generate-notes -f tag_name={toTag} -f previous_tag_name={fromTag}` 取返回的 `body`；
   c. 仍不足时找仓库内 CHANGELOG.md / CHANGES / RELEASE_NOTES / HISTORY / NEWS（含 docs/ 目录、多种扩展名）中对应版本的小节；
   d. 都没有则从 commits 合成（取 commit message 首行列表）。
3. **变更概览**：`gh api repos/{owner}/{repo}/compare/{fromTag}...{toTag}` 取 commits 数与 files 列表（注意 files 最多返回 300 个）。
4. **完整 diff**：`gh api repos/{owner}/{repo}/compare/{fromTag}...{toTag} -H "Accept: application/vnd.github.v3.diff"` 一次性取回，落盘为临时文件后按 `diff --git` 切分按需阅读。**不要**逐文件请求 diff——compare API 不支持按 path 过滤。

## 第二步：分级分析策略（对齐平台逻辑）

- **≤50 个文件**：通读完整 diff 逐项分析。
- **50~1000 个文件**：按目录/功能分组，组内按优先级排序（核心源码 > 接口/协议/配置 > 构建脚本 > 测试 > 文档），优先精读高优先级文件的 diff，测试与文档只扫文件名。
- **>1000 个文件或 diff 拉取失败**：降级为基于 commits 列表 + Release Notes 的概览分析，并在报告中明确标注"未做源码级验证"。

风险定级准则：
- **High**：公开 API 删除/签名变更/语义变更、默认行为变化、配置项删除或默认值变化、序列化/协议格式变化、依赖的最低运行环境提升（如 JDK 版本）
- **Medium**：API 标记废弃、新增的严格校验、性能特征明显变化、内部类变更但常被反射/继承使用
- **Low**：新增功能、纯内部重构、文档与测试变更

每个风险项必须附证据（diff 片段、commit、或 Release Note 原文），严禁脱离证据臆测。

## 第三步：输出

在当前目录生成 `compat-report.md`（结构见 `references/report-template.md`），全文中文，风险项按等级降序。

如果用户要求生成 skill 包 / analysis-bundle（供使用方仓库用 release-review 复核与自动整改），按 `references/bundle-format.md` 在 `analysis-bundle/` 目录生成 6 个文件；其中每个风险项标记 `confidence: upstream-high / repo-unverified`，`manifest.json` 写入 `project_background`。第二阶段只允许对本地 confirmed high 项自动修改代码，其余风险只写报告。

## 第四步（可选）：本仓库落地复核

若当前工作目录是该库的使用方仓库，分析完成后主动继续做**多层调用链路追踪**（这相当于平台的 release-review 第二阶段）：

对每条高/中风险项：
1. **定位直接使用点**：搜索对受影响 API（类/接口/方法/字段/配置项名）的直接引用——import、new、方法调用、继承、实现、注解、配置文件中的类名。
2. **向上追踪调用链**：继续追踪谁调用了这些直接使用点——包装类、适配器、门面、工具类、基类，一层层向上直到业务入口（Controller / Service 公开方法 / 定时任务 / 消息消费者 / 对外接口），画出「上游变更 API → 本仓库封装层 → 业务入口」的完整链路。
3. **覆盖间接/隐式使用**：反射、SPI、依赖注入(Spring)、AOP、动态代理、配置驱动实例化、序列化框架——这些纯文本搜索易漏。
4. **识别运行时故障面**：判断编译期暴露还是仅运行时暴露，以及触发场景。

把结论合并进报告的"本仓库命中情况"一节，对每条命中项给出完整调用链与受影响业务入口；未命中项明确降级/排除。

## 注意事项

- GitHub 匿名 API 限额 60 次/小时；探测 tag 的 404 同样计入配额，命中后立即停止探测。
- diff 超过 20 万行时不要全文读入上下文，按文件分块、优先级裁剪。
- 输出里的版本号一律用解析后的真实 tag 名，避免用户输入的别名造成歧义。
