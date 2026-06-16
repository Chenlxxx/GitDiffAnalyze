# CompatAnalyzer

CompatAnalyzer 是一款基于 AI 的 GitHub 库变更分析工具，旨在帮助开发者在升级依赖库时，快速评估新版本带来的兼容性风险和破坏性变更。

## 核心功能

- **变更日志分析**：自动抓取 GitHub Release Notes 或 CHANGELOG 文件，识别受影响的条目并评估风险。
- **全量 Diff 深度扫描**：直接对比两个版本间的代码差异，精准识别 API 变更、逻辑调整等潜在风险。
- **批量分析模式**：支持通过 Excel 上传多个项目，一键执行批量深度扫描。
- **结构化报告导出**：分析完成后，可导出详尽的 Excel 报告，包含变更描述、排查建议、测试建议及代码整改指导。
- **多模型支持**：兼容 Gemini、Qwen (通义千问)、DeepSeek 等主流 AI 模型。

## 使用指南

### 1. 配置 AI 模型
点击页面右上角的 **设置** 图标，打开模型供应商配置中心（Dify 风格）：
- **添加供应商**：从预置厂商中选择——DeepSeek、通义千问、Kimi、智谱 GLM、豆包（火山方舟）、MiniMax、硅基流动、OpenAI、Anthropic、Google Gemini，或选择"自定义"接入任何 OpenAI / Anthropic 兼容协议的服务（One-API、Ollama、vLLM、第三方中转等）。
- **填写凭证**：每个供应商独立配置 API Key、Base URL 与模型名称（预置厂商已带默认值，卡片上有获取 Key 的直达链接）。
- **测试连接**：点击卡片上的"测试连接"按钮发送一次最小请求，验证配置是否可用并显示延迟。
- **切换模型**：可同时保存多个供应商，单选激活当前使用的那个；配置持久化在浏览器本地。

### 2. 开始分析
1. **输入仓库地址**：填写 GitHub 仓库的完整 URL（例如 `https://github.com/apache/httpcomponents-client`）。
2. **选择版本范围**：填写起始版本（From）和目标版本（To）。
3. **填写项目背景**：描述您的项目是如何使用该库的，这有助于 AI 提供更精准的兼容性建议。
4. **选择模式**：
   - **变更日志模式**：快速预览。
   - **全量 Diff 模式**：深度分析。
5. **点击“开始分析”**。

### 3. 查看与导出结果
- 分析完成后，页面将展示风险摘要、核心建议及详细的变更条目。
- 对于全量 Diff 模式，您可以点击 **“下载 Excel 报告”** 获取可供团队共享的详细文档。

## 部署到 Render

仓库自带 [render.yaml](render.yaml) 蓝图：Render 控制台 → New → Blueprint → 关联本仓库即可。也可手动创建 Web Service：

- **Build Command**: `npm ci && npm run build`
- **Start Command**: `npm start`
- **环境变量**：

| 变量 | 说明 | 示例 |
|---|---|---|
| `NODE_ENV` | 必须设为 `production` | `production` |
| `DEFAULT_AI_API_KEY` | 默认模型 API Key（仅存服务端，不下发浏览器） | `sk-xxx` |
| `DEFAULT_AI_MODEL` | 默认模型名称 | `qwen-plus` |
| `DEFAULT_AI_BASE_URL` | 默认 Base URL（OpenAI 官方可留空） | `https://dashscope.aliyuncs.com/compatible-mode/v1` |
| `DEFAULT_AI_PROTOCOL` | 接口协议 `openai` / `anthropic` / `gemini` | `openai` |
| `GITHUB_TOKEN` | 默认 GitHub Token（无需权限，限额 60→5000/小时） | `ghp_xxx` |

配置齐 `DEFAULT_AI_API_KEY` + `DEFAULT_AI_MODEL` 后，访客打开页面会自动出现已激活的「平台默认（服务端配置）」供应商，无需自行填写 Key 即可分析；访客也仍可在设置中添加自己的 Key 覆盖默认。

## Skill 形态（无需启动平台）

整个平台的分析能力被封装成了一个**端到端、自包含**的 skill —— [`compat-analyze/`](compat-analyze/)。在 Claude Code / OpenCode 等任意支持 skill 的框架中，不启动 Web 服务即可完成全流程。

### 安装
把 `compat-analyze/` 整个目录拷贝到你的 agent 的 skills 目录下：
- Claude Code：`.claude/skills/compat-analyze/`
- OpenCode：`.opencode/skills/compat-analyze/`
- 其他框架：放到该框架识别 skill 的目录即可。

skill 内全部使用相对路径，不依赖任何固定绝对路径。

### 使用
- **只评估上游库**：在任意目录对 agent 说「分析 \<repo\> 从 \<vA\> 升到 \<vB\> 有什么兼容性风险」。agent 会取数 → 分级 Diff 分析 → 产出 `compat-report.md`（可选 `analysis-bundle/` 与 Word）。
- **评估对你项目的影响**：在你的代码仓库目录里运行同一 skill，它会在上游分析后继续做**多层调用链路追踪**（上游变更 API → 你仓库的封装层 → 业务入口），把命中情况写进报告。

结构：精简的 `SKILL.md` 编排 + 按需加载的 `references/`（分级策略与定级准则、调用链追踪方法、报告模板、bundle 格式）+ `scripts/export_docx.py`（Word 导出）。

> 另有轻量的 [`release-review/`](release-review/) skill，专门用于消费 **Web 平台「下载 Skill」按钮导出的 analysis-bundle**——平台在线分析后，把 bundle 带到使用方仓库做第二阶段复核。它与 compat-analyze 的 bundle 格式互通。

## 注意事项

- 本工具仅基于提供的文本内容（Diff、Commits、Release Notes）进行静态分析，不执行实际代码。
- 建议在分析大型仓库时，尽量缩小版本跨度，以获得更详细的分析结果。
- 如果遇到 GitHub API 速率限制（403），请在页面右上角设置中配置 GitHub Token（无需勾选任何权限，限额从 60 次/小时提升至 5000 次/小时），或在 `.env` 中配置 `GITHUB_TOKEN` 后重启服务。
