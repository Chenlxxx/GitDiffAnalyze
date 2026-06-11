# 大重构计划与进度（2026-06-11）

> 本文件是重构工作的**单一事实来源**。每完成一项就勾选对应条目、追加进度日志并提交。
> 如果你是定时任务拉起的接班会话：从第一个未勾选项继续，不要重做已勾选项。

## 环境与约束

- 工作目录：`D:\Users\lzc\Codefile\DiffAnalyze`，开发环境跑在 Docker：`docker compose up -d`（已设自启，可能已在运行）
- 验证命令：`docker compose exec app npm run lint`（tsc 类型检查）；应用在 http://localhost:3000，代码改动热更新生效，无需重启容器
- git：`origin` = lzcyyds0-afk/GitDiffAnalyze（自己的私有仓库，提交后推这里）；`upstream` = 原作者仓库，**永远不要推**
- 提交规则：按逻辑拆分提交，消息末尾加 `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
- 文本文件含中文，**禁止用 PowerShell 管道改写文件内容**（会 GBK 乱码），一律用 Edit/Write 工具

## T1：模型配置重构（Dify 风格，多厂商）

设计：`ModelProviderConfig[]` 替代单一 `AIConfig`。每个 provider：`{ id, presetId, displayName, protocol: 'openai' | 'anthropic' | 'gemini', baseUrl, apiKey, model, enabled }`。
预置厂商清单（presets，含默认 baseUrl 与常见模型名）：OpenAI、Anthropic、Google Gemini、DeepSeek、通义千问(DashScope)、Moonshot Kimi、智谱 GLM、豆包(火山方舟)、MiniMax、硅基流动 SiliconFlow、自定义(OpenAI 兼容)、自定义(Anthropic 兼容)。

- [x] T1.1 新建 `src/constants/providerPresets.ts`（12 个预置：DeepSeek/通义/Kimi/智谱/豆包/MiniMax/硅基流动/OpenAI/Anthropic/Gemini/自定义×2）+ types.ts 增加 ModelProviderConfig/AppSettings/toLegacyAIConfig
- [x] T1.2 服务端 `/api/ai/test-connection`：三协议最小请求，401/404/429/超时映射为中文提示，429 视为连通；已验证无效 key 返回 401
- [x] T1.3 `src/components/ModelSettings.tsx`：供应商卡片（增删/激活/启用）、测试连接按钮与延迟显示、GitHub Token 区；已替换 App.tsx 旧设置面板
- [x] T1.4 localStorage v2（version/providers/activeProviderId/githubToken），v1 aiConfig 自动迁移为"旧版配置（自动迁移）"条目
- [x] T1.5 分析入口统一走 requireAIConfig()（未配置时给可操作错误）；顺带修复 server.ts Gemini 模型名硬编码、移除源码中硬编码的第三方 API Key（原作者遗留泄漏）
- [x] T1.6 容器内 tsc 通过；连通性端点 curl 验证 OK；已提交

## T2：全量 Diff 提速（目标 20min → <5min）

前提：先读 `src/App.tsx` 的 performFullDiffAnalysis / `src/services/aiProvider.ts` 的 analyzeBatchDiff 确认瓶颈（预判：AI 批次串行 + GitHub 文件 diff 串行拉取）。
原则：**只改调度并发，不缩减喂给模型的内容**，聚合逻辑不变，保证准确性。

- [x] T2.1 瓶颈确认：① AI 批次完全串行（MAX_BATCHES=100，主因）；② getFileDiff 带 path 参数无效，每个缺 patch 文件都重复下载完整 diff；③ aggregateBatchResults 提示词没把批次结果传给模型（准确性 bug）
- [x] T2.2 AI 批次并行化：src/services/diffUtils.ts mapWithConcurrency，并发 AI_BATCH_CONCURRENCY=4（VITE_AI_BATCH_CONCURRENCY 可调），失败重试 1 次，仍失败记入 confidenceNote 不中断整体
- [x] T2.3 GitHub diff：一次 getCompareDiff + splitUnifiedDiffByFile 本地切分代替逐文件全量下载；multi_batch 与 segmented 模式都已替换
- [x] T2.4 进度 UI：batchProgress 状态 + 进度条（x/n 批）
- [x] T2.5 lint 通过；修复 analyzeBatchDiff / aggregateBatchResults 提示词（聚合现在真正携带压缩后的批次结果，~60k 字符预算）；已提交
- [ ] T2.6 （待实测）跑一次真实大版本 diff 记录耗时对比——需要有效模型 Key，留给人工或下个会话

## T3：其余界面/体验优化（自行裁量，小步快跑）

- [x] T3.1 错误提示统一：src/services/errorUtils.ts formatErrorMessage（提取代理错误体的 message+suggestion），错误横幅在涉及配置时显示"打开设置"快捷按钮
- [x] T3.2 分析输入持久化（repoUrl/版本/项目背景 存 localStorage，刷新不丢）
- [x] T3.3 死代码清理：删除 src/utils/ 下三个无引用的重复文件（diffStrategy/filePriority/githubErrorUtils）
- [x] T3.4 README 更新为新模型配置中心的说明

## T4：项目 skill 化（**最后做**，T1-T3 完成并提交后才开始）

把平台的分析能力封装成可在 Claude Code 中运行的 skill：`compat-analyze/SKILL.md` + scripts，输入 repo URL + from/to 版本，复用平台的 GitHub 抓取与分析提示词逻辑（脚本化调用），输出中文报告 + analysis-bundle。

- [x] T4.1 `compat-analyze/` skill：SKILL.md（输入解析→gh api 数据获取→分级分析策略→报告/bundle 输出→可选落地复核）+ references/report-template.md + references/bundle-format.md（与 release-review 互通）
- [x] T4.2 自测：gh api tag 探测与 compare 命令实测可用（httpcomponents-client rel/v5.4.4...rel/v5.5 = 80 commits/262 files）；实测发现 rel/v 前缀变体并回补到 skill 与平台 githubService.getReleaseByTag；README 增加 Skill 形态章节；已提交

## T5：处理过程可视化 + AI 流式输出（追加需求）

- [x] T5.1 紧凑过程面板：每阶段一行原位更新（tag 解析→概览→diff 切分→批次进度→聚合），失败/降级停在对应行；changelog 模式同样覆盖
- [x] T5.2 AI 流式输出：服务端 `/api/ai-proxy-stream` SSE 透传（复用 injectAIKey，兼容 OpenAI/Anthropic SSE）；客户端 aiProvider.ts 模块级 setStreamListener，callAI 检测到监听器走流式 fetch、实时回调、最终仍返回完整文本供 parseJSON；流式失败/空回退非流式
- [x] T5.3 仅单路调用阶段流式（changelog/单次 full_diff/聚合），并行批次保持计数；过程面板加「模型实时输出」预览（80ms 节流，末尾 1500 字）；设置面板加流式开关（streamingEnabled 持久化，默认开）；Gemini 走服务端 SDK 暂不流式（结束时一次性出结果）

## 进度日志（倒序追加）

- 2026-06-11 04:50 T5 完成。流式经端点错误路径冒烟（无效 key 正确 401）；真实 token 流需有效 Key 人工验证。注意：activeStreamListener 是模块级单例，只在 runWithStream 包裹的单路调用挂载，批次并行不挂；Gemini 不流式是已知取舍。
- 2026-06-11 02:40 T4 完成并提交。全部任务收尾：仅剩 T2.6 真实耗时实测需人工跑一次（需有效模型 Key）。

- 2026-06-11 02:25 T3 完成并提交。剩 T2.6（真实耗时实测，需模型 Key）与 T4（skill 化）。

- 2026-06-11 02:10 T2 完成并提交。预期效果：20 个批次场景 串行20×40s≈13min → 4路并行5轮≈3-4min，且省掉 N 次全量 diff 重复下载；聚合准确性同步修复。

- 2026-06-11 01:40 T1 完成并提交。注意：normalizeAIResponse/parseJSON 在 aiProvider.ts 顶部，勿动；OpenAICompatibleProvider.aggregateBatchResults 的 prompt 没把批次结果传给模型（疑似 bug），T2 一并处理。
- 2026-06-11 01:00 计划创建，T1 开始。
