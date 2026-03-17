import { GoogleGenAI, Type } from "@google/genai";
import axios from "axios";
import { AIProvider, ChangeLogAnalysis, DiffAnalysis, FullDiffAnalysis, AIConfig } from "../types";

function parseJSON(text: string): any {
  if (!text) return {};
  const cleanText = text.trim();
  try {
    return JSON.parse(cleanText);
  } catch (e) {
    // Try to extract JSON from markdown code blocks
    const jsonMatch = cleanText.match(/```json\s*([\s\S]*?)\s*```/i) || cleanText.match(/```\s*([\s\S]*?)\s*```/i);
    if (jsonMatch && jsonMatch[1]) {
      try {
        return JSON.parse(jsonMatch[1].trim());
      } catch (innerError) {
        console.error("Failed to parse extracted JSON:", innerError);
      }
    }
    
    // Try to find the first '{' and last '}'
    const firstBrace = cleanText.indexOf('{');
    const lastBrace = cleanText.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
      try {
        return JSON.parse(cleanText.substring(firstBrace, lastBrace + 1));
      } catch (innerError) {
        console.error("Failed to parse braced JSON:", innerError);
      }
    }
    
    throw new Error("无法解析 AI 返回的 JSON 数据。");
  }
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
        
        项目背景：${projectBackground}
        
        变更日志：
        ${changeLog}
        
        任务：
        1. 提供该版本的简明摘要（中文）。
        2. **必须识别并罗列变更日志中的每一个条目，严禁遗漏任何一项**。包括所有分类（如 Documentation, Refactor, Fix, Feature 等）下的每一个 PR 或提交。
        3. 对于每一个条目，根据提供的背景评估影响等级（高、中、低）。
        4. 如果影响等级为“高”或“中”，必须提供：
           - \`compatibilityAnalysis\`: 结合项目背景，详细说明该变更可能带来的兼容性风险或破坏性影响。
           - \`codeExample\`: 提供简要的 "before" 和 "after" 代码示例，展示项目代码可能需要如何调整。
        5. 如果影响等级为“低”，请在 \`reason\` 中简要解释原因。
        6. 必须提取每个条目对应的 Pull Request 编号（例如 #123 或 PR #123）。
        
        请务必使用中文回答，确保输出的 items 数组长度与变更日志中的条目总数一致。
      `,
      config: {
        responseMimeType: "application/json",
        maxOutputTokens: 8192,
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
          
          PR 标题：${prTitle}
          项目背景：${projectBackground}
          
          差异内容：
          ${diff.slice(0, 20000)}
        
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
              },
              required: ["before", "after"]
            }
          },
          required: ["riskLevel", "breakingChanges", "compatibilityNotes", "recommendations", "codeExample"]
        }
      }
    }));
    return parseJSON(response.text || '{}');
  } catch (err: any) {
    console.error("Gemini analyzeDiff error:", err);
    if (err.message?.includes("401") || err.status === 401) {
      throw new Error("Gemini API 身份验证失败 (401)。请检查您的 API Key 是否正确。");
    }
    if (err.message?.includes("429") || err.message?.includes("RESOURCE_EXHAUSTED")) {
      throw new Error("Gemini API 配额已耗尽。请稍后再试，或在设置中更换 API Key。");
    }
    if (err.message?.includes("Rpc failed") || err.message?.includes("xhr error")) {
      throw new Error("Gemini API 暂时不可用或差异内容过大导致请求失败，请稍后再试。");
    }
    throw err;
  }
}

  async analyzeFullDiff(diff: string, projectBackground: string, commits?: any[]): Promise<FullDiffAnalysis> {
    try {
      const commitSummary = commits ? commits.slice(0, 50).map(c => `- ${c.sha.substring(0, 7)}: ${c.commit.message}`).join('\n') : '';
      
      const response = await withRetry(() => this.ai.models.generateContent({
        model: "gemini-3.1-pro-preview",
        contents: `
          你是一个资深架构师和安全专家。请分析以下两个版本之间的完整代码差异（Diff），并识别潜在的兼容性风险、破坏性变更和架构影响。
          
          项目背景：${projectBackground}
          
          相关 Commits 摘要：
          ${commitSummary}
          
          差异内容（前 30000 字符）：
          ${diff.slice(0, 30000)}
          
          任务：
          1. 提供变更的整体摘要。
          2. 将变更分类（如：API 变更、依赖更新、核心逻辑修改、安全修复等）。
          3. 识别每个分类下的关键条目，并评估风险等级。
          4. **可信度要求**：对于每一个识别出的条目，必须从提供的 Diff 中摘取**足够长且完整**的原文代码片段（sourceSnippet），通常建议 10-20 行，确保包含上下文。
          5. **关联 Commit**：如果某个条目能对应到上述 Commits 中的某一个或多个，请在 \`commitLinks\` 中列出对应的 SHA。
          6. **深度分析与兼容性指导**：对于“高”和“中”风险项，必须提供：
             - \`compatibilityAnalysis\`: **深度分析**该变更对当前项目背景的具体影响，不要只给一两句话。
             - \`codeExample\`: 提供详细的 "before" 和 "after" 代码示例。**注意**："after" 代码应展示如何修改用户代码以适配新版本，同时尽可能保持逻辑一致性或提供平滑迁移方案。
          7. 给出整体风险评估和建议。
          
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
              categories: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    name: { type: Type.STRING },
                    items: {
                      type: Type.ARRAY,
                      items: {
                        type: Type.OBJECT,
                        properties: {
                          title: { type: Type.STRING },
                          description: { type: Type.STRING },
                          riskLevel: { type: Type.STRING, enum: ["High", "Medium", "Low"] },
                          compatibilityAnalysis: { type: Type.STRING },
                          sourceSnippet: { type: Type.STRING, description: "从 Diff 中摘取的原始代码片段，应包含足够的上下文" },
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
                    }
                  },
                  required: ["name", "items"]
                }
              }
            },
            required: ["summary", "overallRisk", "recommendations", "categories"]
          }
        }
      }));
      return parseJSON(response.text || '{}');
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
        const response = await axios.post('/api/ai-proxy', { url, data, headers });
        return response.data.choices[0].message.content;
      } else {
        // Direct call (Works in static hosting if the AI provider allows CORS)
        const response = await axios.post(url, data, { headers });
        return response.data.choices[0].message.content;
      }
    } catch (error: any) {
      if (error.response?.status === 401) {
        throw new Error(error.response.data?.message || "身份验证失败 (401)。请检查您的 API Key 是否正确。");
      }
      throw error;
    }
  }

  async analyzeChangeLog(changeLog: string, projectBackground: string): Promise<ChangeLogAnalysis> {
    const prompt = `
      分析以下 GitHub 发布变更日志，并识别对具有此背景的项目产生影响的所有条目。
      
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
      
      PR 标题：${prTitle}
      项目背景：${projectBackground}
      
      差异内容：
      ${diff.slice(0, 20000)}
      
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

  async analyzeFullDiff(diff: string, projectBackground: string, commits?: any[]): Promise<FullDiffAnalysis> {
    const commitSummary = commits ? commits.slice(0, 50).map(c => `- ${c.sha.substring(0, 7)}: ${c.commit.message}`).join('\n') : '';
    
    const prompt = `
      你是一个资深架构师和安全专家。请分析以下两个版本之间的完整代码差异（Diff），并识别潜在的兼容性风险、破坏性变更和架构影响。
      
      项目背景：${projectBackground}
      
      相关 Commits 摘要：
      ${commitSummary}
      
      差异内容（前 20000 字符）：
      ${diff.slice(0, 20000)}
      
      任务：
      1. 提供变更的整体摘要。
      2. 将变更分类。
      3. 识别关键条目，评估风险等级。
      4. **可信度要求**：摘取 10-20 行原始代码片段 (sourceSnippet)。
      5. **关联 Commit**：在 \`commitLinks\` 中列出 SHA 和 URL。
      6. **深度分析**：对中高风险项进行深度分析并提供迁移代码示例。
      
      请以 JSON 格式返回，结构如下：
      {
        "summary": "整体摘要",
        "overallRisk": "High/Medium/Low",
        "recommendations": ["建议1", "建议2"],
        "categories": [
          {
            "name": "分类名称",
            "items": [
              {
                "title": "变更标题",
                "description": "变更描述",
                "riskLevel": "High/Medium/Low",
                "sourceSnippet": "从 Diff 中摘取的原始代码片段 (10-20行)",
                "commitLinks": [
                  { "sha": "commit_sha", "url": "commit_url" }
                ],
                "compatibilityAnalysis": "对项目背景的深度兼容性影响分析",
                "codeExample": {
                  "before": "修改前的项目代码示例",
                  "after": "修改后的项目代码示例 (展示如何适配新版本并保持功能兼容)"
                }
              }
            ]
          }
        ]
      }
      
      请务必使用中文回答。
    `;
    const result = await this.callAI(prompt);
    return parseJSON(result);
  }
}

export function getAIProvider(config: AIConfig): AIProvider {
  if (config.provider === 'gemini') {
    return new GeminiProvider(config.apiKey || '');
  }
  return new OpenAICompatibleProvider(config);
}
