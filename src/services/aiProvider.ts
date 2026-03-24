import { GoogleGenAI, Type } from "@google/genai";
import axios from "axios";
import { AIProvider, ChangeLogAnalysis, DiffAnalysis, FullDiffAnalysis, AIConfig, ExcelAnalysis, BatchAnalysisResult } from "../types";

function parseJSON(text: string): any {
  if (!text) return {};
  let cleanText = text.trim();
  
  // Helper to try parsing
  const tryParse = (str: string) => {
    try {
      return JSON.parse(str);
    } catch (e) {
      // Try to fix common JSON issues:
      // 1. Remove trailing commas before closing braces/brackets
      let fixed = str.replace(/,\s*([\]}])/g, '$1');
      try {
        return JSON.parse(fixed);
      } catch (e2) {
        return null;
      }
    }
  };

  // 1. Try direct parse
  let result = tryParse(cleanText);
  if (result) return result;

  // 2. Try to extract JSON from markdown code blocks
  const jsonMatch = cleanText.match(/```json\s*([\s\S]*?)\s*```/i) || cleanText.match(/```\s*([\s\S]*?)\s*```/i);
  if (jsonMatch && jsonMatch[1]) {
    result = tryParse(jsonMatch[1].trim());
    if (result) return result;
    console.error("Failed to parse extracted JSON");
  }
  
  // 3. Try to find the first '{' and last '}'
  const firstBrace = cleanText.indexOf('{');
  const lastBrace = cleanText.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    result = tryParse(cleanText.substring(firstBrace, lastBrace + 1));
    if (result) return result;
    console.error("Failed to parse braced JSON");
  }
  
  throw new Error("无法解析 AI 返回的 JSON 数据。这通常是因为返回内容过长导致截断，或者内容中包含特殊字符。请尝试缩小分析范围或稍后再试。");
}

async function withRetry<T>(fn: () => Promise<T>, maxRetries: number = 3, initialDelay: number = 2000): Promise<T> {
  let retries = 0;
  while (true) {
    try {
      return await fn();
    } catch (err: any) {
      const isRateLimit = err.message?.includes("429") || err.status === 429 || err.message?.includes("RESOURCE_EXHAUSTED");
      if (isRateLimit && retries < maxRetries) {
        const delay = initialDelay * Math.pow(2, retries);
        console.warn(`AI Rate limit hit, retrying in ${delay}ms... (Attempt ${retries + 1}/${maxRetries})`);
        await new Promise(resolve => setTimeout(resolve, delay));
        retries++;
        continue;
      }
      throw err;
    }
  }
}

export class GeminiProvider implements AIProvider {
  private ai: GoogleGenAI;

  constructor(apiKey: string) {
    this.ai = new GoogleGenAI({ apiKey });
  }

  async analyzeChangeLog(changeLog: string, projectBackground: string): Promise<ChangeLogAnalysis> {
    try {
      const response = await withRetry(() => this.ai.models.generateContent({
        model: "gemini-3.1-pro-preview",
        contents: `
          分析以下 GitHub 发布变更日志，并识别对具有此背景的项目产生影响的所有条目：
        
        **重要指令：禁止使用任何外部工具、搜索或联网功能。仅基于提供的文本内容进行分析。**

        项目背景：${projectBackground}
        
        变更日志：
        ${changeLog}
        
        任务：
        1. 提供该版本的简明摘要（中文）。
        2. **必须识别并罗列变更日志中的每一个条目，严禁遗漏任何一项**。包括所有分类（如 Documentation, Refactor, Fix, Feature 等）下的每一个 PR 或提交。
        3. 对于每一个条目，根据提供的背景评估影响等级（高、中、低）。
        4. 如果影响等级为“高”或“中”，必须提供：
           - \`compatibilityAnalysis\`: 结合项目背景，详细说明该变更可能带来的兼容性风险或破坏性影响。
           - \`codeExample\`: 提供详细的 "before" 和 "after" 代码示例，展示项目代码可能需要如何调整。
        5. 如果影响等级为“低”，请在 \`reason\` 中简要解释原因。
        6. 必须提取每个条目对应的 Pull Request 编号（例如 #123 或 PR #123）。
        
        请务必使用中文回答，确保输出的 items 数组长度与变更日志中的条目总数一致。
      `,
      config: {
        responseMimeType: "application/json",
        maxOutputTokens: 16384,
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            items: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  title: { type: Type.STRING },
                  prNumber: { type: Type.INTEGER },
                  reason: { type: Type.STRING },
                  impactLevel: { type: Type.STRING, enum: ["High", "Medium", "Low"] },
                  compatibilityAnalysis: { type: Type.STRING },
                  codeExample: {
                    type: Type.OBJECT,
                    properties: {
                      before: { type: Type.STRING },
                      after: { type: Type.STRING }
                    }
                  }
                },
                required: ["title", "reason", "impactLevel"]
              }
            },
            summary: { type: Type.STRING }
          },
          required: ["items", "summary"]
        }
      }
    }));
    return parseJSON(response.text || '{}');
  } catch (err: any) {
    console.error("Gemini analyzeChangeLog error:", err);
    if (err.message?.includes("401") || err.status === 401) {
      throw new Error("Gemini API 身份验证失败 (401)。请检查您的 API Key 是否正确。");
    }
    if (err.message?.includes("429") || err.message?.includes("RESOURCE_EXHAUSTED")) {
      throw new Error("Gemini API 配额已耗尽。请稍后再试，或在设置中更换 API Key。");
    }
    if (err.message?.includes("Rpc failed") || err.message?.includes("xhr error")) {
      throw new Error("Gemini API 暂时不可用或变更日志过大，请稍后再试。");
    }
    throw err;
  }
}

  async analyzeDiff(diff: string, prTitle: string, projectBackground: string): Promise<DiffAnalysis> {
    try {
      const response = await withRetry(() => this.ai.models.generateContent({
        model: "gemini-3.1-pro-preview",
        contents: `
          分析以下代码差异以识别兼容性风险和破坏性变更。
          
          **重要指令：禁止使用任何外部工具、搜索或联网功能。仅基于提供的文本内容进行分析。**

          PR 标题：${prTitle}
          项目背景：${projectBackground}
          
          差异内容：
          ${diff.slice(0, 30000)}
        
        任务：
        1. 识别任何破坏性变更（API 更改、删除的方法、更改的签名）。
        2. 评估项目背景的风险级别。
        3. 提供具体的迁移或测试建议。
        4. 提供代码示例，展示在项目代码中如何进行变动以保持兼容。
           - "before": 修改前的项目代码示例
           - "after": 修改后的项目代码示例
        
        请务必使用中文回答。
      `,
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            riskLevel: { type: Type.STRING, enum: ["High", "Medium", "Low"] },
            breakingChanges: { type: Type.ARRAY, items: { type: Type.STRING } },
            compatibilityNotes: { type: Type.ARRAY, items: { type: Type.STRING } },
            recommendations: { type: Type.ARRAY, items: { type: Type.STRING } },
            codeExample: {
              type: Type.OBJECT,
              properties: {
                before: { type: Type.STRING },
                after: { type: Type.STRING }
              }
            }
          },
          required: ["riskLevel", "breakingChanges", "compatibilityNotes", "recommendations"]
        }
      }
    }));
    return parseJSON(response.text || '{}');
  } catch (err: any) {
    console.error("Gemini analyzeDiff error:", err);
    throw err;
  }
}

  async analyzeBatchDiff(diff: string, projectBackground: string, fromVersion: string, toVersion: string, groupName: string, batchIndex: number, totalBatches: number, releaseNotes?: string, commits?: any[]): Promise<BatchAnalysisResult> {
    try {
      const commitSummary = commits ? commits.slice(0, 50).map(c => `- SHA: ${c.sha}, Message: ${c.commit.message}`).join('\n') : '';
      
      const response = await withRetry(() => this.ai.models.generateContent({
        model: "gemini-3.1-pro-preview",
        contents: `
          你是一个极其严谨的资深架构师。正在进行分批代码差异分析。
          当前分析分组：${groupName} (第 ${batchIndex + 1} 批，共 ${totalBatches} 批)
          版本范围：${fromVersion} -> ${toVersion}
          项目背景：${projectBackground}

          **重要指令：禁止使用任何外部工具、搜索或联网功能。仅基于提供的文本内容进行分析。**

          发布日志 (Release Notes)：
          ${releaseNotes || '未提供'}

          相关 Commits 列表（前 50 个）：
          ${commitSummary}

          差异内容：
          ${diff.slice(0, 30000)}

          任务：
          1. 识别该批次代码变更中的所有潜在兼容性风险。
          2. 对每个风险项提供详细描述、风险等级、兼容性分析和代码示例。
          3. 提供该批次变更的简要总结。

          请务必使用中文回答。
        `,
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              summary: { type: Type.STRING },
              items: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    title: { type: Type.STRING },
                    description: { type: Type.STRING },
                    riskLevel: { type: Type.STRING, enum: ["High", "Medium", "Low"] },
                    compatibilityAnalysis: { type: Type.STRING },
                    sourceSnippet: { type: Type.STRING },
                    codeExample: {
                      type: Type.OBJECT,
                      properties: {
                        before: { type: Type.STRING },
                        after: { type: Type.STRING }
                      }
                    }
                  },
                  required: ["title", "description", "riskLevel"]
                }
              },
              recommendations: { type: Type.ARRAY, items: { type: Type.STRING } }
            },
            required: ["summary", "items", "recommendations"]
          }
        }
      }));
      return parseJSON(response.text || '{}');
    } catch (err: any) {
      console.error("Gemini analyzeBatchDiff error:", err);
      throw err;
    }
  }

  async aggregateBatchResults(batchResults: BatchAnalysisResult[], projectBackground: string, fromVersion: string, toVersion: string, releaseNotes?: string): Promise<FullDiffAnalysis> {
    try {
      const resultsSummary = batchResults.map((r, i) => `Batch ${i + 1} Summary: ${r.summary}\nItems: ${r.items.map(item => `- ${item.title} (${item.riskLevel})`).join(', ')}`).join('\n\n');
      const allItems = batchResults.flatMap(r => r.items);
      
      const response = await withRetry(() => this.ai.models.generateContent({
        model: "gemini-3.1-pro-preview",
        contents: `
          你是一个极其严谨的资深架构师。请汇总多个批次的差异分析结果，生成最终的全量分析报告。
          版本范围：${fromVersion} -> ${toVersion}
          项目背景：${projectBackground}
          发布日志：${releaseNotes || '未提供'}

          **重要指令：禁止使用任何外部工具、搜索或联网功能。仅基于提供的文本内容进行分析。**

          待汇总的批次结果摘要：
          ${resultsSummary}

          全量条目详情（共 ${allItems.length} 条）：
          ${JSON.stringify(allItems.slice(0, 100))} 

          任务：
          1. 汇总所有批次的发现，去除重复项，合并相似项。
          2. 结合发布日志和项目背景，给出整体风险评估和核心建议。
          3. 生成最终的结构化报告，包括 Excel 导出所需的行数据。
          4. 确保 ExcelRows 中的内容详实，特别是 function, suggestion, code_discovery, code_fix 字段。

          请务必使用中文回答。
        `,
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              summary: { type: Type.STRING },
              overallRisk: { type: Type.STRING, enum: ["High", "Medium", "Low"] },
              recommendations: { type: Type.ARRAY, items: { type: Type.STRING } },
              items: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    title: { type: Type.STRING },
                    description: { type: Type.STRING },
                    riskLevel: { type: Type.STRING, enum: ["High", "Medium", "Low"] },
                    compatibilityAnalysis: { type: Type.STRING },
                    sourceSnippet: { type: Type.STRING },
                    codeExample: {
                      type: Type.OBJECT,
                      properties: {
                        before: { type: Type.STRING },
                        after: { type: Type.STRING }
                      }
                    }
                  },
                  required: ["title", "description", "riskLevel"]
                }
              },
              excelRows: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    version: { type: Type.STRING },
                    changepoint: { type: Type.STRING },
                    chinese: { type: Type.STRING },
                    function: { type: Type.STRING },
                    suggestion: { type: Type.STRING },
                    risk: { type: Type.STRING, enum: ["高", "中", "低"] },
                    test_suggestion: { type: Type.STRING },
                    code_discovery: { type: Type.STRING },
                    code_fix: { type: Type.STRING },
                    related_commits: { type: Type.STRING }
                  },
                  required: ["version", "changepoint", "chinese", "function", "suggestion", "risk", "test_suggestion", "code_discovery", "code_fix"]
                }
              }
            },
            required: ["summary", "overallRisk", "recommendations", "items", "excelRows"]
          }
        }
      }));
      const result = parseJSON(response.text || '{}');
      return {
        ...result,
        analysisMode: 'multi_batch_full_diff',
        confidenceNote: '已执行全量索引 + 分组分批深度分析，覆盖率较高。'
      };
    } catch (err: any) {
      console.error("Gemini aggregateBatchResults error:", err);
      throw err;
    }
  }

  async analyzeFullDiff(diff: string, projectBackground: string, fromVersion: string, toVersion: string, releaseNotes?: string, commits?: any[], files?: any[], metadata?: { mode?: string, fallbackReason?: string, confidenceNote?: string }): Promise<FullDiffAnalysis> {
    try {
      // Slice commits to avoid huge payload
      const commitSummary = commits ? commits.slice(0, 100).map(c => `- SHA: ${c.sha}, Message: ${c.commit.message}`).join('\n') : '';
      const fileSummary = files ? files.slice(0, 100).map(f => `- File: ${f.filename}, Status: ${f.status}, Changes: +${f.additions}/-${f.deletions}`).join('\n') : '';
      
      const mode = metadata?.mode || 'full_diff';
      const fallbackReason = metadata?.fallbackReason || '';
      const confidenceNote = metadata?.confidenceNote || '';

      let modeInstruction = '';
      if (mode === 'segmented_full_diff') {
        modeInstruction = `
          **当前分析模式：分片式深度分析 (Segmented Deep Analysis)**
          由于版本差异规模较大，我们优先提取了高优先级关键文件的 Diff 片段进行分析。
          请重点分析 API 表面、配置变更、迁移路径及核心逻辑变化。
        `;
      } else if (mode === 'multi_batch_full_diff') {
        modeInstruction = `
          **当前分析模式：全量分组分批分析 (Multi-Batch Full Analysis)**
          由于版本差异规模较大，我们已将所有变更文件按风险表面分组并分批进行了深度分析。
          当前正在进行最终的汇总评估。
        `;
      } else if (mode === 'partial_full_diff') {
        modeInstruction = `
          **当前分析模式：降级部分分析 (Partial Analysis)**
          由于无法获取完整代码差异（原因：${fallbackReason}），本次分析主要基于 Commit 记录、文件变更列表和发布日志。
          请在输出中明确标注这是“基于有限证据的兼容性评估”，并给出高风险推断及建议人工复核的点。
        `;
      }

      const response = await withRetry(() => this.ai.models.generateContent({
        model: "gemini-3.1-pro-preview",
        contents: `
          分析从 ${fromVersion} 到 ${toVersion} 版本之间的代码差异（Diff），并识别潜在的兼容性风险。
          
          **重要指令：禁止使用任何外部工具、搜索或联网功能。仅基于提供的文本内容进行分析。**

          ${modeInstruction}
          
          **分析输入：**
          1. **代码差异 (Diff)**：最真实的代码变更（当前模式下可能仅包含部分关键片段）。
          2. **Commit 记录**：变更的具体意图。
          3. **发布日志 (Release Notes/Change Log)**：作者提醒的高危变更和功能说明。
          
          项目背景：${projectBackground}
          
          变更文件列表：
          ${fileSummary}
          
          相关 Commits 列表（共 ${commits?.length || 0} 个，展示前 100 个）：
          ${commitSummary}
          
          发布日志 (Release Notes)：
          ${releaseNotes || '未提供'}
          
          差异内容（前 60000 字符）：
          ${diff.slice(0, 60000)}
          
          任务：
          1. 提供变更的整体摘要。
          2. 识别关键变更条目，评估风险等级。
          3. 生成 Excel 结构化数据。
          4. **必须在返回的 JSON 中包含 analysisMode, confidenceNote, fallbackReason 字段。**
          
          请务必使用中文回答。
        `,
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              summary: { type: Type.STRING },
              overallRisk: { type: Type.STRING, enum: ["High", "Medium", "Low"] },
              recommendations: { type: Type.ARRAY, items: { type: Type.STRING } },
              analysisMode: { type: Type.STRING },
              confidenceNote: { type: Type.STRING },
              fallbackReason: { type: Type.STRING },
              items: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    title: { type: Type.STRING },
                    description: { type: Type.STRING },
                    riskLevel: { type: Type.STRING, enum: ["High", "Medium", "Low"] },
                    compatibilityAnalysis: { type: Type.STRING },
                    sourceSnippet: { type: Type.STRING },
                    commitLinks: {
                      type: Type.ARRAY,
                      items: {
                        type: Type.OBJECT,
                        properties: {
                          sha: { type: Type.STRING },
                          url: { type: Type.STRING }
                        }
                      }
                    },
                    codeExample: {
                      type: Type.OBJECT,
                      properties: {
                        before: { type: Type.STRING },
                        after: { type: Type.STRING }
                      }
                    }
                  },
                  required: ["title", "description", "riskLevel"]
                }
              },
              excelRows: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    version: { type: Type.STRING },
                    changepoint: { type: Type.STRING },
                    chinese: { type: Type.STRING },
                    function: { type: Type.STRING },
                    suggestion: { type: Type.STRING },
                    risk: { type: Type.STRING, enum: ["高", "中", "低"] },
                    test_suggestion: { type: Type.STRING },
                    code_discovery: { type: Type.STRING },
                    code_fix: { type: Type.STRING },
                    related_commits: { type: Type.STRING }
                  },
                  required: ["version", "changepoint", "chinese", "function", "suggestion", "risk", "test_suggestion", "code_discovery", "code_fix"]
                }
              }
            },
            required: ["summary", "overallRisk", "recommendations", "items", "excelRows", "analysisMode", "confidenceNote"]
          }
        }
      }));
      const result = parseJSON(response.text || '{}');
      return {
        ...result,
        analysisMode: result.analysisMode || mode,
        confidenceNote: result.confidenceNote || confidenceNote,
        fallbackReason: result.fallbackReason || fallbackReason
      };
    } catch (err: any) {
      console.error("Gemini analyzeFullDiff error:", err);
      if (err.message?.includes("401") || err.status === 401) {
        throw new Error("Gemini API 身份验证失败 (401)。请检查您的 API Key 是否正确。");
      }
      if (err.message?.includes("429") || err.message?.includes("RESOURCE_EXHAUSTED")) {
        throw new Error("Gemini API 配额已耗尽。请稍后再试，或在设置中更换 API Key。");
      }
      throw err;
    }
  }
}

export class OpenAICompatibleProvider implements AIProvider {
  private config: AIConfig;

  constructor(config: AIConfig) {
    this.config = config;
  }

  private async callAI(prompt: string, jsonMode: boolean = true): Promise<string> {
    const url = `${this.config.baseUrl || 'https://api.openai.com/v1'}/chat/completions`;
    const data = {
      model: this.config.model,
      messages: [{ role: 'user', content: prompt }],
      response_format: jsonMode ? { type: 'json_object' } : undefined,
      temperature: 0.1
    };
    const headers = {
      'Authorization': `Bearer ${this.config.apiKey}`,
      'Content-Type': 'application/json'
    };

    try {
      if (this.config.useProxy) {
        // Use the proxy to avoid CORS (Works in full-stack environments like AI Studio)
        const response = await axios.post('/api/ai-proxy', { url, data, headers }, { timeout: 310000 });
        
        if (typeof response.data === 'string' && response.data.includes('<!doctype html>')) {
          console.error("Received HTML instead of JSON from AI proxy:", response.data);
          throw new Error("AI 服务返回了无效的 HTML 响应。这通常是因为请求超时或服务端发生错误。请尝试缩小分析范围或稍后再试。");
        }

        if (!response.data?.choices?.[0]?.message?.content) {
          console.error("Invalid AI response structure:", response.data);
          throw new Error("AI 服务返回了无效的数据结构。请检查模型配置或稍后再试。");
        }
        return response.data.choices[0].message.content;
      } else {
        // Direct call (Works in static hosting if the AI provider allows CORS)
        const response = await axios.post(url, data, { headers, timeout: 310000 });
        
        if (typeof response.data === 'string' && response.data.includes('<!doctype html>')) {
          console.error("Received HTML instead of JSON from AI API:", response.data);
          throw new Error("AI 服务返回了无效的 HTML 响应。请尝试检查 API 地址或稍后再试。");
        }

        if (!response.data?.choices?.[0]?.message?.content) {
          console.error("Invalid AI response structure:", response.data);
          throw new Error("AI 服务返回了无效的数据结构。请检查模型配置或稍后再试。");
        }
        return response.data.choices[0].message.content;
      }
    } catch (error: any) {
      if (error.code === 'ECONNABORTED' || error.message?.includes('timeout')) {
        throw new Error("AI 分析请求超时。由于分析内容较多或模型生成较慢，请求已超过 5 分钟限制。请尝试缩小版本跨度或简化项目背景。");
      }
      if (error.response?.status === 401) {
        throw new Error(error.response.data?.message || "身份验证失败 (401)。请检查您的 API Key 是否正确。");
      }
      if (error.response?.status === 400) {
        const msg = error.response.data?.error?.message || error.response.data?.message || "";
        if (msg.includes("http call")) {
          throw new Error("AI 服务拒绝了请求，因为它尝试使用联网功能（如搜索）但未获授权。已尝试在提示词中禁用此功能，请重试。如果问题持续，请更换模型 or API Key。");
        }
        throw new Error(`AI 服务请求失败 (400): ${msg || "无效的请求参数"}`);
      }
      throw error;
    }
  }

  async analyzeChangeLog(changeLog: string, projectBackground: string): Promise<ChangeLogAnalysis> {
    const prompt = `
      分析以下 GitHub 发布变更日志，并识别对具有此背景的项目产生影响的所有条目。
      
      **重要指令：禁止使用任何外部工具、搜索或联网功能。仅基于提供的文本内容进行分析。**

      项目背景：${projectBackground}
      
      变更日志：
      ${changeLog}
      
      任务：
      1. 提供该版本的简明摘要（中文）。
      2. 识别变更日志中的每一个条目。
      3. 评估影响等级（High, Medium, Low）。
      4. 对于 High/Medium 风险项，提供 \`compatibilityAnalysis\` 和 \`codeExample\` (before/after)。
      5. 提取 PR 编号。
      
      请以 JSON 格式返回，结构如下：
      {
        "items": [
          { 
            "title": "...", 
            "prNumber": 123, 
            "reason": "...", 
            "impactLevel": "High/Medium/Low",
            "compatibilityAnalysis": "...",
            "codeExample": { "before": "...", "after": "..." }
          }
        ],
        "summary": "..."
      }
      
      请务必使用中文回答。
    `;
    const result = await this.callAI(prompt);
    return parseJSON(result);
  }

  async analyzeDiff(diff: string, prTitle: string, projectBackground: string): Promise<DiffAnalysis> {
    const prompt = `
      分析以下代码差异以识别兼容性风险。
      
      **重要指令：禁止使用任何外部工具、搜索或联网功能。仅基于提供的文本内容进行分析。**

      PR 标题：${prTitle}
      项目背景：${projectBackground}
      
      差异内容：
      ${diff.slice(0, 30000)}
      
      请以 JSON 格式返回，结构如下：
      {
        "riskLevel": "High/Medium/Low",
        "breakingChanges": ["..."],
        "compatibilityNotes": ["..."],
        "recommendations": ["..."],
        "codeExample": { "before": "...", "after": "..." }
      }
      
      请务必使用中文回答。
    `;
    const result = await this.callAI(prompt);
    return parseJSON(result);
  }

  async analyzeBatchDiff(diff: string, projectBackground: string, fromVersion: string, toVersion: string, groupName: string, batchIndex: number, totalBatches: number, releaseNotes?: string, commits?: any[]): Promise<BatchAnalysisResult> {
    const commitSummary = commits ? commits.slice(0, 50).map(c => `- SHA: ${c.sha}, Message: ${c.commit.message}`).join('\n') : '';
    
    const prompt = `
      分析以下代码差异以识别兼容性风险。
      当前分析分组：${groupName} (第 ${batchIndex + 1} 批，共 ${totalBatches} 批)
      版本范围：${fromVersion} -> ${toVersion}
      项目背景：${projectBackground}

      发布日志 (Release Notes)：
      ${releaseNotes || '未提供'}

      相关 Commits 列表（前 50 个）：
      ${commitSummary}

      差异内容：
      ${diff.slice(0, 30000)}

      请以 JSON 格式返回，结构如下：
      {
        "summary": "...",
        "items": [
          {
            "title": "...",
            "description": "...",
            "riskLevel": "High/Medium/Low",
            "compatibilityAnalysis": "...",
            "sourceSnippet": "...",
            "codeExample": { "before": "...", "after": "..." }
          }
        ],
        "recommendations": ["..."]
      }
      
      请务必使用中文回答。
    `;
    const result = await this.callAI(prompt);
    return parseJSON(result);
  }

  async aggregateBatchResults(batchResults: BatchAnalysisResult[], projectBackground: string, fromVersion: string, toVersion: string, releaseNotes?: string): Promise<FullDiffAnalysis> {
    const resultsSummary = batchResults.map((r, i) => `Batch ${i + 1} Summary: ${r.summary}\nItems: ${r.items.map(item => `- ${item.title} (${item.riskLevel})`).join(', ')}`).join('\n\n');
    const allItems = batchResults.flatMap(r => r.items);

    const prompt = `
      汇总多个批次的差异分析结果，生成最终的全量分析报告。
      版本范围：${fromVersion} -> ${toVersion}
      项目背景：${projectBackground}
      发布日志：${releaseNotes || '未提供'}

      待汇总的批次结果摘要：
      ${resultsSummary}

      全量条目详情（共 ${allItems.length} 条）：
      ${JSON.stringify(allItems.slice(0, 50))} 

      请以 JSON 格式返回，结构如下：
      {
        "summary": "...",
        "overallRisk": "High/Medium/Low",
        "recommendations": ["..."],
        "items": [...],
        "excelRows": [...]
      }
      
      请务必使用中文回答。
    `;
    const resultStr = await this.callAI(prompt);
    const result = parseJSON(resultStr);
    return {
      ...result,
      analysisMode: 'multi_batch_full_diff',
      confidenceNote: '已执行全量索引 + 分组分批深度分析。'
    };
  }

  async analyzeFullDiff(diff: string, projectBackground: string, fromVersion: string, toVersion: string, releaseNotes?: string, commits?: any[], files?: any[], metadata?: { mode?: string, fallbackReason?: string, confidenceNote?: string }): Promise<FullDiffAnalysis> {
    const commitSummary = commits ? commits.slice(0, 100).map(c => `- SHA: ${c.sha}, Message: ${c.commit.message}`).join('\n') : '';
    const fileSummary = files ? files.slice(0, 100).map(f => `- File: ${f.filename}, Status: ${f.status}`).join('\n') : '';
    
    const mode = metadata?.mode || 'full_diff';
    const fallbackReason = metadata?.fallbackReason || '';
    const confidenceNote = metadata?.confidenceNote || '';

    let modeInstruction = '';
    if (mode === 'segmented_full_diff') {
      modeInstruction = `
        **当前分析模式：分片式深度分析 (Segmented Deep Analysis)**
        由于版本差异规模较大，我们优先提取了高优先级关键文件的 Diff 片段进行分析。
        请重点分析 API 表面、配置变更、迁移路径及核心逻辑变化。
      `;
    } else if (mode === 'multi_batch_full_diff') {
      modeInstruction = `
        **当前分析模式：全量分组分批分析 (Multi-Batch Full Analysis)**
        由于版本差异规模较大，我们已将所有变更文件按风险表面分组并分批进行了深度分析。
        当前正在进行最终的汇总评估。
      `;
    } else if (mode === 'partial_full_diff') {
      modeInstruction = `
        **当前分析模式：降级部分分析 (Partial Analysis)**
        由于无法获取完整代码差异（原因：${fallbackReason}），本次分析主要基于 Commit 记录、文件变更列表和发布日志。
        请在输出中明确标注这是“基于有限证据的兼容性评估”，并给出高风险推断及建议人工复核的点。
      `;
    }

    const prompt = `
      你是一个极其严谨的资深架构师和安全专家。请分析从 ${fromVersion} 到 ${toVersion} 版本之间的代码差异（Diff），并识别潜在的兼容性风险。
      
      **重要指令：禁止使用任何外部工具、搜索或联网功能。仅基于提供的文本内容进行分析。**

      ${modeInstruction}

      **分析输入：**
      1. **代码差异 (Diff)**：最真实的代码变更（当前模式下可能仅包含部分关键片段）。
      2. **Commit 记录**：变更的具体意图。
      3. **发布日志 (Release Notes/Change Log)**：作者提醒的高危变更和功能说明。
      
      **核心原则：**
      1. **代码驱动 + 日志参考**：主要依靠代码 Diff 和 Commit 进行分析，但**必须参考**发布日志中的说明。如果发布日志中提到某个变更是 Breaking Change 或高危变更，即使代码层面看起来变动不大，也应重点分析并提高风险等级。
      2. **语义变更优先**：重点关注“语义变更”（行为变化、逻辑调整、兼容性影响），而非仅关注“API 变更”。
      3. **可溯源性**：在分析结果中，如果某个变更能明确关联到某个 Commit，请务必记录其 SHA。
      4. **业务影响评估**：如果某个修改会影响到业务功能，或者会导致运行期错误，必须显著提高风险等级。
      
      **风险评估原则：**
      - 评估对象是【兼容性风险】：升级后，旧代码 / 旧配置 / 旧默认行为是否可能发生变化或失效。
      - 风险评估以“技术兼容性变化”为核心。
      - 允许结合“该变更对业务能力面的影响范围与关键程度”进行有限度风险调整。
      - 不允许因为业务重要而忽略兼容性事实，也不允许脱离变更内容主观放大。
      
      项目背景：${projectBackground}
      
      变更文件列表：
      ${fileSummary}
      
      相关 Commits 列表：
      ${commitSummary}
      
      发布日志 (Release Notes)：
      ${releaseNotes || '未提供'}
      
      差异内容（前 60000 字符）：
      ${diff.slice(0, 60000)}
      
      任务：
      1. 提供变更的整体摘要。
      2. 识别关键变更条目，评估风险等级。
      3. **深度分析**：对中高风险项进行深度分析并提供迁移代码示例。
      4. **生成 Excel 结构化数据**：同时生成一套符合 Excel 格式的结构化数据行。要求内容详实，严禁简略。
      5. **必须在返回的 JSON 中包含 analysisMode, confidenceNote, fallbackReason 字段。**
      
      **Excel 字段深度要求：**
      - **version**: ${toVersion}
      - **changepoint**: 变更点（英文）
      - **chinese**: 变更点中文描述
      - **function**: 变更点涉及的功能作用说明。**必须结合业务场景**，详细说明该功能的作用以及在哪些具体业务场景下会产生影响。
      - **suggestion**: 排查建议。必须包含**【典型问题场景】**（描述升级后可能出现的具体异常现象）和**【排查步骤】**（详细的排查路径）。
      - **risk**: 高/中/低
      - **test_suggestion**: 测试建议。**请提供尽可能多且详尽的测试建议**，涵盖正常路径、边界情况及异常场景。
      - **code_discovery**: 代码排查指导。必须包含**【调用入口点】**（用户代码中可能调用的受影响 API 或接口）和**【变更源码位置】**（变更涉及的库内部具体类或方法）。
      - **code_fix**: 代码整改指导。必须提供**能够兼容的前后代码修改示例**（Before/After），展示如何调整代码以适配新版本。
      - **related_commits**: 关联的 Commit SHA（如有，多个用逗号分隔）

      请以 JSON 格式返回，结构如下：
      {
        "summary": "整体摘要",
        "overallRisk": "High/Medium/Low",
        "analysisMode": "full_diff/segmented_full_diff/partial_full_diff",
        "confidenceNote": "置信度说明",
        "fallbackReason": "降级原因",
        "recommendations": ["建议1", "建议2"],
        "items": [
          {
            "title": "变更标题",
            "description": "变更描述",
            "riskLevel": "High/Medium/Low",
            "sourceSnippet": "从 Diff 中摘取的原始代码片段",
            "commitLinks": [
              { "sha": "commit_sha", "url": "commit_url" }
            ],
            "compatibilityAnalysis": "深度兼容性影响分析",
            "codeExample": {
              "before": "修改前的项目代码示例",
              "after": "修改后的项目代码示例"
            }
          }
        ],
        "excelRows": [
          {
            "version": "版本号",
            "changepoint": "变更点（英文）",
            "chinese": "变更点中文描述",
            "function": "功能作用说明",
            "suggestion": "排查建议",
            "risk": "高/中/低",
            "test_suggestion": "测试建议",
            "code_discovery": "代码排查指导",
            "code_fix": "代码整改指导",
            "related_commits": "commit1, commit2"
          }
        ]
      }
      
      请务必使用中文回答。
    `;
    const resultStr = await this.callAI(prompt);
    const result = parseJSON(resultStr);
    return {
      ...result,
      analysisMode: result.analysisMode || mode,
      confidenceNote: result.confidenceNote || confidenceNote,
      fallbackReason: result.fallbackReason || fallbackReason
    };
  }
}

export function getAIProvider(config: AIConfig): AIProvider {
  if (config.provider === 'gemini') {
    return new GeminiProvider(config.apiKey || '');
  }
  return new OpenAICompatibleProvider(config);
}
