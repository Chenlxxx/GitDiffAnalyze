/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export const SKILL_MD = `---
name: release-review
description: 使用内置的 analysis-bundle，对当前本地仓库进行三方件升级风险复核，并输出中文 markdown 或 word 报告。适用于仓库内存在 .opencode/skills/release-review/analysis-bundle，且用户希望 claude code 或 opencode 结合真实代码、调用方、配置与测试，对上游 changelog 风险项做二次验证并生成中文汇总报告的场景。
---

当用户要求运行或使用 release-review skill 时，直接执行以下工作流。

## 输入位置
本 skill 自带的分析输入位于：
\`.opencode/skills/release-review/analysis-bundle/\`

优先读取以下文件：
1. \`.opencode/skills/release-review/analysis-bundle/manifest.json\`
2. \`.opencode/skills/release-review/analysis-bundle/file-risk.json\`
3. \`.opencode/skills/release-review/analysis-bundle/diff-evidence.jsonl\`
4. \`.opencode/skills/release-review/analysis-bundle/unresolved-questions.json\`
5. \`.opencode/skills/release-review/analysis-bundle/platform-summary.md\`

## 主要任务
将 bundle 中的每条风险项都视为“待验证假设 + 已有证据”，不要视为最终事实。

读取 bundle 后，必须结合当前仓库执行以下动作：
- 搜索相关三方库、API、调用点、包装层、适配器、配置项与测试代码
- 对每一条高风险或中风险 finding，确认、降级或推翻
- 识别受影响模块、入口点、调用链与可能的运行时故障模式
- 在仓库根目录输出 \`final-report.md\`

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
在仓库根目录生成 \`final-report.md\`，使用以下结构：

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
\`python .opencode/skills/release-review/scripts/export_docx.py final-report.md final-report.docx\`

参考 \`.opencode/skills/release-review/references/example-report.md\` 获取风格示例。
`;

export const OPENAI_YAML = `interface:
  display_name: Release Review
  short_description: 基于内置风险包对当前仓库做中文升级复核
`;

export const EXAMPLE_REPORT_MD = `# 三方件升级复核报告

## 一、执行摘要
本报告对内置 analysis-bundle 中的三条 HttpClient 5.5 风险项进行了仓库级复核。复核目标不是重复上游 changelog 结论，而是确认这些结论在当前仓库中是否真实命中，以及命中后会影响哪些调用链与业务流程。

## 二、已确认成立的风险项
### 1. 自动重定向策略收紧
- 风险等级：高
- 成立原因：在当前仓库中发现默认自动重定向的 HttpClient 构造方式，并在请求发送前手动设置了 Authorization 头。
- 受影响位置：\`src/auth/OAuthClient.java\`、\`src/gateway/TokenRelay.java\`
- 故障模式：遇到 302 时可能不再自动跳转，而是抛出 Redirect rejected 或 ClientProtocolException。
- 整改建议：关闭自动重定向，改为显式处理 3xx，并避免跨跳转传递敏感头。

## 三、已降级或不适用的风险项
### 1. 某风险项名称
- 上游假设：……
- 复核结论：当前仓库未发现对应 API 使用点，因此暂不构成直接风险。

## 四、待人工确认问题
- 是否存在运行时动态注入的认证拦截器，未在代码仓中体现。
- 是否有外部网关层对缓存头或重定向做二次改写。

## 五、受影响模块与调用链汇总
- OAuth 登录链路
- SSO 单点登录重定向链路
- 多租户缓存调用链

## 六、建议整改与测试计划
1. 优先修复高风险认证与缓存隔离问题。
2. 增加针对 Digest、缓存共享与 302 重定向的回归测试。
3. 对关键集成链路补充端到端验证。

## 七、证据附录
- 使用的 bundle：\`manifest.json\`、\`file-risk.json\`、\`diff-evidence.jsonl\`、\`platform-summary.md\`
- 检查过的仓库文件：按实际扫描结果填写
`;

export const USAGE_MD = `# 项目内安装与使用

## 安装
将本压缩包解压到仓库根目录，最终路径应为：

\`.opencode/skills/release-review/\`

## 运行
在 Claude Code / OpenCode 中打开当前仓库后，可直接输入：

\`请使用 release-review skill，读取 .opencode/skills/release-review/analysis-bundle，对当前仓库进行复核，并在仓库根目录生成中文 final-report.md。\`

更强一些的指令是：

\`请立即使用 release-review skill。读取 .opencode/skills/release-review/analysis-bundle 中的全部风险项，结合当前仓库逐项验证，并输出中文 final-report.md。除非缺少必要文件，否则不要先问我是否继续。\`

## 可选 Word 导出
生成 \`final-report.md\` 后，可继续要求：

\`再导出 final-report.docx。\`
`;

export const EXPORT_DOCX_PY = `#!/usr/bin/env python3
import sys
from pathlib import Path
from docx import Document
from docx.oxml.ns import qn

def md_to_docx(md_path: str, docx_path: str):
    md = Path(md_path).read_text(encoding="utf-8")
    doc = Document()
    style = doc.styles["Normal"]
    style.font.name = "SimSun"
    style._element.rPr.rFonts.set(qn("w:eastAsia"), "SimSun")

    for raw in md.splitlines():
        line = raw.rstrip()
        if not line:
            doc.add_paragraph("")
            continue
        if line.startswith("# "):
            p = doc.add_paragraph()
            r = p.add_run(line[2:])
            r.bold = True
        elif line.startswith("## "):
            p = doc.add_paragraph()
            r = p.add_run(line[3:])
            r.bold = True
        elif line.startswith("### "):
            p = doc.add_paragraph()
            r = p.add_run(line[4:])
            r.bold = True
        elif line.startswith("- "):
            p = doc.add_paragraph(style=None)
            p.style = doc.styles["List Bullet"]
            r = p.add_run(line[2:])
        else:
            p = doc.add_paragraph()
            r = p.add_run(line)
        r.font.name = "SimSun"
        r._element.rPr.rFonts.set(qn("w:eastAsia"), "SimSun")

    doc.save(docx_path)

if __name__ == "__main__":
    if len(sys.argv) != 3:
        print("Usage: export_docx.py <input.md> <output.docx>")
        sys.exit(1)
    md_to_docx(sys.argv[1], sys.argv[2])
`;
