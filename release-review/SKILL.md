---
name: release-review
description: 读取随本 skill 附带的 analysis-bundle（上游三方件升级风险清单），结合当前代码仓库逐项验证，并追踪受影响 API 在本仓库中的多层调用链路，输出基于真实代码证据的中文升级复核报告。适用于已将本 skill 安装到使用方代码仓库、希望对依赖升级风险做落地复核的场景。
---

当用户要求运行或使用 release-review skill 时，直接执行以下工作流，不要先请求确认（除非必需文件缺失）。

## 输入位置
分析输入位于**本 skill 目录下**的 `analysis-bundle/` 子目录（与本 SKILL.md 同级）。
不要假设任何固定绝对路径——本 skill 可能被安装在 `.claude/skills/release-review/`、`.opencode/skills/release-review/` 或其他框架的 skills 目录下。请基于本 SKILL.md 所在目录定位以下文件（路径相对本 SKILL.md）：

1. `analysis-bundle/manifest.json` — 升级范围、风险计数、project_background、analysis_mode
2. `analysis-bundle/file-risk.json` — 风险项清单（含 affectedApis、排查建议、整改建议）
3. `analysis-bundle/diff-evidence.jsonl` — 每条风险的上游证据（source_snippet、related_commits、suspect_apis）
4. `analysis-bundle/unresolved-questions.json` — 待人工确认问题
5. `analysis-bundle/platform-summary.md` — 平台侧分析摘要

若不确定安装路径，可用 glob 搜索 `**/release-review/analysis-bundle/manifest.json` 定位。
`manifest.json` 的 `analysis_mode` 标识风险来源：`changelog`=上游变更日志，`full_diff` 系列=上游两版本间源码 Diff。`project_background` 是使用方项目背景。

## 核心目标
bundle 里每条风险项都是「上游视角的待验证假设 + 已有证据」，**不是**本仓库的最终结论。
你的任务是把每条假设拿到当前代码仓库验证：它在本仓库**是否真实命中**、命中后**会沿哪条调用链路影响到哪些业务入口**。不要停留在复述 bundle。

## 工作流

### 1. 读取并理解 bundle
读完上述文件，建立风险项清单；对每条记下其受影响 API 符号（affectedApis / suspect_apis）与上游证据（source_snippet）。

### 2. 逐项做多层调用链路追踪（本 skill 的核心价值）
对每条高/中风险项，**不要只搜一层直接调用**，要追踪完整链路：

a. **定位直接使用点**：搜索对受影响 API（类/接口/方法/字段/配置项名）的直接引用——import、new、方法调用、继承、实现、注解、配置文件中的类名。
b. **向上追踪调用链**：找到直接使用点后，继续追踪**谁调用了它们**——包装类(wrapper)、适配器(adapter)、门面(facade)、工具类、基类，一层层向上，直到业务入口（Controller / Service 公开方法 / 定时任务 / 消息消费者 / 对外接口）。画出「上游变更 API → 本仓库封装层 → 业务入口」的完整链路。
c. **覆盖间接/隐式使用**：注意纯文本搜索易漏的命中方式——反射、SPI/ServiceLoader、依赖注入(Spring Bean / @Autowired)、AOP 切面、动态代理、配置驱动实例化、字节码增强、序列化框架。
d. **识别运行时故障面**：判断变更在编译期暴露还是仅运行时暴露（默认行为变化、序列化/协议格式变化等），以及触发的具体场景。
e. **结论**：基于证据把该风险项**确认 / 降级 / 推翻**，给出受影响的具体文件、完整调用链、故障模式。

### 3. 输出报告
在仓库根目录生成 `final-report.md`（结构见下）。全部中文，基于真实代码证据，引用文件路径、类名、方法名、行号。

## 执行规则
- 优先读 manifest 的 `project_background`，但代码证据与背景描述冲突时以代码为准。
- `full_diff` 系列时，`diff-evidence.jsonl` 的 `source_snippet` 与 `related_commits` 是源码级证据，可直接据此定位本仓库调用点。
- 仓库未使用某个被引用 API → 明确说明并降级/排除，不要硬凑。
- 无法仅凭当前仓库证明的内容 → 放入「待人工确认问题」，不要臆测。
- 对 bundle 中**所有**风险项统一处理，不要只分析第一条。

## 中文报告结构
在仓库根目录生成 `final-report.md`：

# 三方件升级复核报告

## 一、执行摘要
升级范围 / 风险项总数 / 已确认高风险项 / 已降级或不适用项 / 待人工确认项 / 最终总体判断

## 二、已确认成立的风险项
对每一项：风险标题 / 风险等级 / 在本仓库成立的原因 / 受影响文件与**完整调用链（上游 API → 封装层 → 业务入口）** / 故障模式（编译期还是运行时、触发场景）/ 整改建议

## 三、已降级或不适用的风险项
对每一项：风险标题 / 上游假设 / 为什么在本仓库不成立或风险降低

## 四、待人工确认问题
列出无法仅凭当前仓库证明的内容。

## 五、受影响模块与调用链汇总
按业务入口与调用链归纳，标出每条链路经过的关键封装层。

## 六、建议整改与测试计划
按优先级排列，优先覆盖高风险项。

## 七、证据附录
列出使用的 bundle 文件，以及检查过的关键仓库文件路径。

## 可选 Word 导出
生成 `final-report.md` 后，如用户要求 Word 输出，运行本 skill 目录下脚本（路径相对本 SKILL.md）：
`python scripts/export_docx.py final-report.md final-report.docx`

参考本 skill 目录下的 `references/example-report.md` 获取风格示例。
