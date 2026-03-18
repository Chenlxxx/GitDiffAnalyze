import { GoogleGenAI, Type } from "@google/genai";
import axios from "axios";
import { AIProvider, ChangeLogAnalysis, DiffAnalysis, FullDiffAnalysis, AIConfig, ExcelAnalysis } from "../types";

function parseJSON(text: string): any {
  if (!text) return {};
  let cleanText = text.trim();
  
  // Helper to try parsing and fixing common issues
  const tryParse = (str: string) => {
    try {
      return JSON.parse(str);
    } catch (e: any) {
      let fixed = str;
      
      // 1. Remove trailing commas before closing braces/brackets
      fixed = fixed.replace(/,\s*([\]}])/g, '$1');
      
      // 2. Handle unescaped newlines in strings
      fixed = fixed.replace(/"([^"]*?)\n([^"]*?)"/g, (match, p1, p2) => {
        return `"${p1}\\n${p2}"`;
      });

      try {
        return JSON.parse(fixed);
      } catch (e2: any) {
        // 3. Handle truncated JSON
        if (e2.message?.includes("Unexpected end of JSON input") || e2.message?.includes("Unterminated string")) {
          let truncated = fixed;
          
          const lastQuote = truncated.lastIndexOf('"');
          const lastOpenBrace = truncated.lastIndexOf('{');
          const lastOpenBracket = truncated.lastIndexOf('[');
          
          if (lastQuote > lastOpenBrace && lastQuote > lastOpenBracket) {
            const quotesAfterLastBrace = truncated.substring(Math.max(lastOpenBrace, lastOpenBracket)).split('"').length - 1;
            if (quotesAfterLastBrace % 2 !== 0) {
              truncated += '"';
            }
          }

          const stack: string[] = [];
          for (let i = 0; i < truncated.length; i++) {
            if (truncated[i] === '{') stack.push('}');
            else if (truncated[i] === '[') stack.push(']');
            else if (truncated[i] === '}') stack.pop();
            else if (truncated[i] === ']') stack.pop();
          }

          while (stack.length > 0) {
            truncated += stack.pop();
          }

          try {
            return JSON.parse(truncated);
          } catch (e3) {
            return null;
          }
        }
        return null;
      }
    }
  };

  let result = tryParse(cleanText);
  if (result) return result;

  const jsonMatch = cleanText.match(/```json\s*([\s\S]*?)\s*```/i) || cleanText.match(/```\s*([\s\S]*?)\s*```/i);
  if (jsonMatch && jsonMatch[1]) {
    result = tryParse(jsonMatch[1].trim());
    if (result) return result;
  }
  
  const firstBrace = cleanText.indexOf('{');
  const lastBrace = cleanText.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    result = tryParse(cleanText.substring(firstBrace, lastBrace + 1));
    if (result) return result;
  }

  if (cleanText.startsWith('{')) {
    result = tryParse(cleanText);
    if (result) return result;
  }
  
  throw new Error("无法解析 AI 返回的 JSON 数据。这通常是因为返回内容过长导致截断，或者内容中包含特殊字符。请尝试缩小分析范围或稍后再试。");
}

async function withRetry<T>(fn: () => Promise<T>, maxRetries: number = 5, initialDelay: number = 3000): Promise<T> {
  let retries = 0;
  while (true) {
    try {
      return await fn();
    } catch (err: any) {
      const isRateLimit = err.message?.includes("429") || err.status === 429 || err.message?.includes("RESOURCE_EXHAUSTED");
      const isStartingServer = err.message?.includes("应用正在启动/重启中") || err.message?.includes("Starting Server");
      
      if ((isRateLimit || isStartingServer) && retries < maxRetries) {
        const delay = initialDelay * Math.pow(2, retries);
        const reason = isRateLimit ? "Rate limit" : "Server starting";
        console.warn(`AI ${reason} hit, retrying in ${delay}ms... (Attempt ${retries + 1}/${maxRetries})`);
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
    throw err;
  }
}

  private async clusterCommitsInBatches(commits: any[]): Promise<string> {
    if (!commits || commits.length === 0) return '';
    
    if (commits.length <= 20) {
      return commits.map(c => `- SHA: ${c.sha}, Message: ${c.commit.message}`).join('\n');
    }

    console.log(`Clustering ${commits.length} commits in batches...`);

    const batchSize = 40;
    const clusters: string[] = [];
    
    for (let i = 0; i < commits.length; i += batchSize) {
      const batch = commits.slice(i, i + batchSize);
      const batchText = batch.map(c => `- SHA: ${c.sha}, Message: ${c.commit.message}`).join('\n');
      
      const response = await withRetry(() => this.ai.models.generateContent({
        model: "gemini-3.1-pro-preview",
        contents: `
          请对以下代码提交（Commits）进行聚类分析。
          
          提交列表：
          ${batchText}
          
          任务：
          1. 识别具有相同目的或涉及相同模块的提交，并将它们聚类。
          2. 对于每个聚类，提供一个简洁的描述（中文），并列出包含的 SHA。
          3. 识别潜在的高风险变更（如 API 变更、核心逻辑修改）。
          4. 过滤掉琐碎的变更（如文档、注释、测试、版本号更新）。
          
          请以结构化的文本形式返回，例如：
          - [模块名/功能名] 描述 (关联 SHA: sha1, sha2...) [风险等级: 高/中/低]
        `,
      }));
      
      clusters.push(response.text || '');
    }
    
    if (clusters.length > 1) {
       const finalResponse = await withRetry(() => this.ai.models.generateContent({
        model: "gemini-3.1-pro-preview",
        contents: `
          请对以下多批次的提交聚类结果进行最终的整合与精简。
          
          聚类结果：
          ${clusters.join('\n\n')}
          
          任务：
          1. 合并重复或高度相关的聚类。
          2. 确保所有重要的变更点都被保留。
          3. 保持描述简洁且专业。
          
          请以结构化的文本形式返回。
        `,
      }));
      return finalResponse.text || clusters.join('\n\n');
    }
    
    return clusters[0];
  }

  private splitDiffByFile(diff: string): { filename: string, content: string }[] {
    const files: { filename: string, content: string }[] = [];
    const lines = diff.split('\n');
    let currentFile: { filename: string, content: string } | null = null;

    for (const line of lines) {
      if (line.startsWith('diff --git')) {
        if (currentFile) files.push(currentFile);
        const match = line.match(/b\/(.*)$/);
        currentFile = { filename: match ? match[1] : 'unknown', content: line + '\n' };
      } else if (currentFile) {
        currentFile.content += line + '\n';
      }
    }
    if (currentFile) files.push(currentFile);
    return files;
  }

  private async analyzeDiffBatch(
    batchDiff: string,
    projectBackground: string,
    toVersion: string,
    commitsSummary: string,
    releaseNotes: string
  ): Promise<{ items: any[], excelRows: any[] }> {
    const response = await withRetry(() => this.ai.models.generateContent({
      model: "gemini-3.1-pro-preview",
      contents: `
        你是一个极其严谨的资深架构师和安全专家。请分析以下代码差异（Diff）片段，并识别潜在的兼容性风险。
        
        **分析输入：**
        1. **代码差异 (Diff)**：当前批次的文件变更。
        2. **Commit 聚类摘要**：整体变更的意图。
        3. **发布日志 (Release Notes)**：高危变更说明。
        
        项目背景：${projectBackground}
        
        差异内容：
        ${batchDiff}
        
        任务：
        1. 识别关键变更条目，评估风险等级。
        2. 对中高风险项进行深度分析并提供迁移代码示例。
        3. 生成符合 Excel 格式的结构化数据行。
        
        请务必使用中文回答。
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
                required: ["title", "description", "riskLevel", "compatibilityAnalysis"]
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
                  risk: { type: Type.STRING },
                  test_suggestion: { type: Type.STRING },
                  code_discovery: { type: Type.STRING },
                  code_fix: { type: Type.STRING },
                  related_commits: { type: Type.STRING }
                }
              }
            }
          },
          required: ["items", "excelRows"]
        }
      }
    }));
    const result = parseJSON(response.text || '{}');
    return {
      items: result.items || [],
      excelRows: result.excelRows || []
    };
  }

  async analyzeFullDiff(diff: string, projectBackground: string, fromVersion: string, toVersion: string, releaseNotes?: string, commits?: any[], files?: any[]): Promise<FullDiffAnalysis> {
    try {
      // 1. Cluster commits
      const enrichedCommitSummary = await this.clusterCommitsInBatches(commits || []);
      
      // 2. Split diff by file
      const diffFiles = this.splitDiffByFile(diff);
      
      const allItems: any[] = [];
      const allExcelRows: any[] = [];
      
      const maxBatchSize = 10000; 
      let currentBatchDiff = '';
      const batches: string[] = [];
      
      for (const file of diffFiles) {
        if (currentBatchDiff.length + file.content.length > maxBatchSize && currentBatchDiff.length > 0) {
          batches.push(currentBatchDiff);
          currentBatchDiff = '';
        }
        currentBatchDiff += file.content;
      }
      if (currentBatchDiff.length > 0) batches.push(currentBatchDiff);

      console.log(`Analyzing diff in ${batches.length} parallel batches...`);

      // 3. Parallelize batch analysis
      const concurrencyLimit = 3;
      for (let i = 0; i < batches.length; i += concurrencyLimit) {
        const currentBatchSlice = batches.slice(i, i + concurrencyLimit);
        const results = await Promise.all(currentBatchSlice.map(batch => 
          this.analyzeDiffBatch(batch, projectBackground, toVersion, enrichedCommitSummary, releaseNotes || '')
        ));
        
        results.forEach(res => {
          allItems.push(...res.items);
          allExcelRows.push(...res.excelRows);
        });
      }

      // 4. Final Summary
      const summaryResponse = await withRetry(() => this.ai.models.generateContent({
        model: "gemini-3.1-pro-preview",
        contents: `
          根据以下已识别的变更点，提供整体的版本升级兼容性分析摘要。
          
          变更点列表：
          ${allItems.map(item => `- ${item.title} (${item.riskLevel})`).join('\n')}
          
          任务：
          1. 提供整体摘要。
          2. 评估整体风险等级。
          3. 提供核心建议。
          
          请务必使用中文回答。
        `,
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              summary: { type: Type.STRING },
              overallRisk: { type: Type.STRING, enum: ["High", "Medium", "Low"] },
              recommendations: { type: Type.ARRAY, items: { type: Type.STRING } }
            },
            required: ["summary", "overallRisk", "recommendations"]
          }
        }
      }));
      
      const summaryData = parseJSON(summaryResponse.text || '{}');
      
      return {
        summary: summaryData.summary || '分析完成',
        overallRisk: summaryData.overallRisk || 'Low',
        recommendations: summaryData.recommendations || [],
        items: allItems,
        excelRows: allExcelRows
      };
    } catch (err: any) {
      console.error("Gemini analyzeFullDiff error:", err);
      throw err;
    }
  }

  async analyzeCommitsOneByOne(projectBackground: string, toVersion: string, commits: any[]): Promise<FullDiffAnalysis> {
    const allItems: any[] = [];
    const allExcelRows: any[] = [];
    
    console.log(`Analyzing ${commits.length} commits one by one...`);
    
    // Process in small parallel batches to avoid overloading
    const concurrencyLimit = 5;
    for (let i = 0; i < commits.length; i += concurrencyLimit) {
      const currentBatch = commits.slice(i, i + concurrencyLimit);
      const results = await Promise.all(currentBatch.map(async (commit) => {
        const prompt = `分析此提交的兼容性风险：\nSHA: ${commit.sha}\nMessage: ${commit.commit.message}`;
        const result = await this.analyzeDiffBatch(prompt, projectBackground, toVersion, commit.commit.message, '');
        return result;
      }));
      
      results.forEach(res => {
        allItems.push(...res.items);
        allExcelRows.push(...res.excelRows);
      });
    }
    
    return {
      summary: '逐个提交分析完成',
      overallRisk: 'Medium',
      recommendations: ['请查看下方详细列表'],
      items: allItems,
      excelRows: allExcelRows
    };
  }

  async smartAnalyzeFullDiff(diff: string, projectBackground: string, fromVersion: string, toVersion: string, releaseNotes: string, commits?: any[]): Promise<FullDiffAnalysis> {
    try {
      // 1. Extract Change Points from Release Notes
      console.log("Extracting Change Points from Release Notes...");
      const changeLogAnalysis = await this.analyzeChangeLog(releaseNotes, projectBackground);
      const items = changeLogAnalysis.items;
      
      const allItems: any[] = [];
      const allExcelRows: any[] = [];
      
      // 2. For each item, find relevant diff hunks
      const diffFiles = this.splitDiffByFile(diff);
      
      console.log(`Smart analyzing ${items.length} change points...`);
      
      const concurrencyLimit = 3;
      for (let i = 0; i < items.length; i += concurrencyLimit) {
        const currentItems = items.slice(i, i + concurrencyLimit);
        const results = await Promise.all(currentItems.map(async (item) => {
          // Find relevant files based on title or keywords
          const keywords = item.title.split(/\s+/).filter(k => k.length > 3);
          const relevantFiles = diffFiles.filter(file => 
            file.filename.toLowerCase().includes(item.title.toLowerCase()) ||
            keywords.some(k => file.filename.toLowerCase().includes(k.toLowerCase())) ||
            keywords.some(k => file.content.toLowerCase().includes(k.toLowerCase()))
          );
          
          if (relevantFiles.length === 0) return null;
          
          const relevantDiff = relevantFiles.map(f => f.content).join('\n').slice(0, 15000);
          
          return await this.analyzeDiffBatch(
            relevantDiff, 
            projectBackground, 
            toVersion, 
            item.title, 
            releaseNotes
          );
        }));
        
        results.forEach(res => {
          if (res) {
            allItems.push(...res.items);
            allExcelRows.push(...res.excelRows);
          }
        });
      }
      
      // 3. Final Summary
      const summaryResponse = await withRetry(() => this.ai.models.generateContent({
        model: "gemini-3.1-pro-preview",
        contents: `
          根据以下已识别的变更点，提供整体的版本升级兼容性分析摘要。
          
          变更点列表：
          ${allItems.map(item => `- ${item.title} (${item.riskLevel})`).join('\n')}
          
          任务：
          1. 提供整体摘要。
          2. 评估整体风险等级。
          3. 提供核心建议。
          
          请务必使用中文回答。
        `,
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              summary: { type: Type.STRING },
              overallRisk: { type: Type.STRING, enum: ["High", "Medium", "Low"] },
              recommendations: { type: Type.ARRAY, items: { type: Type.STRING } }
            },
            required: ["summary", "overallRisk", "recommendations"]
          }
        }
      }));
      
      const summaryData = parseJSON(summaryResponse.text || '{}');
      
      return {
        summary: summaryData.summary || '分析完成',
        overallRisk: summaryData.overallRisk || 'Low',
        recommendations: summaryData.recommendations || [],
        items: allItems,
        excelRows: allExcelRows
      };
    } catch (err: any) {
      console.error("Gemini smartAnalyzeFullDiff error:", err);
      throw err;
    }
  }
}

export class OpenAICompatibleProvider implements AIProvider {
  private config: AIConfig;

  constructor(config: AIConfig) {
    this.config = config;
  }

  private async callAI(prompt: string, jsonMode: boolean = true, maxTokens: number = 4096): Promise<string> {
    const url = `${this.config.baseUrl || 'https://api.openai.com/v1'}/chat/completions`;
    const data = {
      model: this.config.model,
      messages: [{ role: 'user', content: prompt }],
      response_format: jsonMode ? { type: 'json_object' } : undefined,
      temperature: 0.1,
      max_tokens: maxTokens
    };
    const headers = {
      'Authorization': `Bearer ${this.config.apiKey}`,
      'Content-Type': 'application/json'
    };

    try {
      let responseData: any;
      if (this.config.useProxy) {
        const response = await axios.post('/api/ai-proxy', { url, data, headers });
        responseData = response.data;
      } else {
        const response = await axios.post(url, data, { headers });
        responseData = response.data;
      }

      // Detect "Starting Server" HTML response from platform
      if (typeof responseData === 'string' && responseData.includes('<title>Starting Server...</title>')) {
        throw new Error("应用正在启动/重启中，请稍候几秒钟再试。");
      }

      // Try to extract content from various possible structures
      let content = responseData?.choices?.[0]?.message?.content;
      
      // Fallback for some OpenAI-compatible APIs that might use 'text' instead of 'message'
      if (!content && responseData?.choices?.[0]?.text) {
        content = responseData.choices[0].text;
      }
      
      // Fallback for Dashscope/Qwen native format if it somehow leaks through
      if (!content && responseData?.output?.text) {
        content = responseData.output.text;
      }

      if (!content) {
        console.error("Invalid AI response structure:", JSON.stringify(responseData));
        const errorMsg = responseData?.error?.message || responseData?.message || "未知错误";
        throw new Error(`AI 服务返回了无效的数据结构。详情: ${errorMsg}`);
      }

      return content;
    } catch (error: any) {
      if (error.response?.status === 401) {
        throw new Error(error.response.data?.message || "身份验证失败 (401)。请检查您的 API Key 是否正确。");
      }
      if (error.response?.data?.error?.message) {
        throw new Error(`AI 服务错误: ${error.response.data.error.message}`);
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
      
      请以 JSON 格式返回。
    `;
    const result = await withRetry(() => this.callAI(prompt));
    return parseJSON(result);
  }

  async analyzeDiff(diff: string, prTitle: string, projectBackground: string): Promise<DiffAnalysis> {
    const prompt = `
      分析以下代码差异以识别兼容性风险。
      
      PR 标题：${prTitle}
      项目背景：${projectBackground}
      
      差异内容：
      ${diff.slice(0, 20000)}
      
      请以 JSON 格式返回。
    `;
    const result = await withRetry(() => this.callAI(prompt));
    return parseJSON(result);
  }

  private async clusterCommitsInBatches(commits: any[]): Promise<string> {
    if (!commits || commits.length === 0) return '';
    const batchText = commits.slice(0, 50).map(c => `- SHA: ${c.sha}, Message: ${c.commit.message}`).join('\n');
    const prompt = `请对以下代码提交进行聚类分析：\n${batchText}`;
    return await withRetry(() => this.callAI(prompt, false));
  }

  private splitDiffByFile(diff: string): { filename: string, content: string }[] {
    const files: { filename: string, content: string }[] = [];
    const lines = diff.split('\n');
    let currentFile: { filename: string, content: string } | null = null;

    for (const line of lines) {
      if (line.startsWith('diff --git')) {
        if (currentFile) files.push(currentFile);
        const match = line.match(/b\/(.*)$/);
        currentFile = { filename: match ? match[1] : 'unknown', content: line + '\n' };
      } else if (currentFile) {
        currentFile.content += line + '\n';
      }
    }
    if (currentFile) files.push(currentFile);
    return files;
  }

  private async analyzeDiffBatch(
    batchDiff: string,
    projectBackground: string,
    toVersion: string,
    commitsSummary: string,
    releaseNotes: string
  ): Promise<{ items: any[], excelRows: any[] }> {
    const prompt = `
      分析以下代码差异片段并识别兼容性风险。
      
      项目背景：${projectBackground}
      差异内容：
      ${batchDiff}
      
      请以 JSON 格式返回：
      {
        "items": [...],
        "excelRows": [...]
      }
    `;
    const result = await withRetry(() => this.callAI(prompt, true, 4096));
    const parsed = parseJSON(result);
    return {
      items: parsed.items || [],
      excelRows: parsed.excelRows || []
    };
  }

  async analyzeFullDiff(diff: string, projectBackground: string, fromVersion: string, toVersion: string, releaseNotes?: string, commits?: any[], files?: any[]): Promise<FullDiffAnalysis> {
    // 1. Cluster commits
    const enrichedCommitSummary = await this.clusterCommitsInBatches(commits || []);
    
    // 2. Split diff by file
    const diffFiles = this.splitDiffByFile(diff);
    
    const allItems: any[] = [];
    const allExcelRows: any[] = [];
    
    const maxBatchSize = 8000;
    let currentBatchDiff = '';
    const batches: string[] = [];
    
    for (const file of diffFiles) {
      if (currentBatchDiff.length + file.content.length > maxBatchSize && currentBatchDiff.length > 0) {
        batches.push(currentBatchDiff);
        currentBatchDiff = '';
      }
      currentBatchDiff += file.content;
    }
    if (currentBatchDiff.length > 0) batches.push(currentBatchDiff);

    console.log(`Analyzing diff in ${batches.length} parallel batches (OpenAI)...`);

    // 3. Parallelize batch analysis
    const concurrencyLimit = 2;
    for (let i = 0; i < batches.length; i += concurrencyLimit) {
      const currentBatchSlice = batches.slice(i, i + concurrencyLimit);
      const results = await Promise.all(currentBatchSlice.map(batch => 
        this.analyzeDiffBatch(batch, projectBackground, toVersion, enrichedCommitSummary, releaseNotes || '')
      ));
      
      results.forEach(res => {
        allItems.push(...res.items);
        allExcelRows.push(...res.excelRows);
      });
    }

    const summaryPrompt = `根据变更点提供摘要：\n${allItems.map(i => i.title).join('\n')}`;
    const summaryResult = await withRetry(() => this.callAI(summaryPrompt));
    const summaryData = parseJSON(summaryResult);
    
    return {
      summary: summaryData.summary || '分析完成',
      overallRisk: summaryData.overallRisk || 'Low',
      recommendations: summaryData.recommendations || [],
      items: allItems,
      excelRows: allExcelRows
    };
  }

  async analyzeCommitsOneByOne(projectBackground: string, toVersion: string, commits: any[]): Promise<FullDiffAnalysis> {
    const allItems: any[] = [];
    const allExcelRows: any[] = [];
    
    console.log(`Analyzing ${commits.length} commits one by one (OpenAI)...`);
    
    const concurrencyLimit = 3;
    for (let i = 0; i < commits.length; i += concurrencyLimit) {
      const currentBatch = commits.slice(i, i + concurrencyLimit);
      const results = await Promise.all(currentBatch.map(async (commit) => {
        const prompt = `分析此提交的兼容性风险：\nSHA: ${commit.sha}\nMessage: ${commit.commit.message}`;
        const result = await this.analyzeDiffBatch(prompt, projectBackground, toVersion, commit.commit.message, '');
        return result;
      }));
      
      results.forEach(res => {
        allItems.push(...res.items);
        allExcelRows.push(...res.excelRows);
      });
    }
    
    return {
      summary: '逐个提交分析完成',
      overallRisk: 'Medium',
      recommendations: ['请查看下方详细列表'],
      items: allItems,
      excelRows: allExcelRows
    };
  }

  async smartAnalyzeFullDiff(diff: string, projectBackground: string, fromVersion: string, toVersion: string, releaseNotes: string, commits?: any[]): Promise<FullDiffAnalysis> {
    // 1. Extract Change Points from Release Notes
    const changeLogAnalysis = await this.analyzeChangeLog(releaseNotes, projectBackground);
    const items = changeLogAnalysis.items;
    
    const allItems: any[] = [];
    const allExcelRows: any[] = [];
    
    // 2. For each item, find relevant diff hunks
    const diffFiles = this.splitDiffByFile(diff);
    
    console.log(`Smart analyzing ${items.length} change points (OpenAI)...`);
    
    const concurrencyLimit = 2;
    for (let i = 0; i < items.length; i += concurrencyLimit) {
      const currentItems = items.slice(i, i + concurrencyLimit);
      const results = await Promise.all(currentItems.map(async (item) => {
        // Find relevant files based on title or keywords
        const keywords = item.title.split(/\s+/).filter(k => k.length > 3);
        const relevantFiles = diffFiles.filter(file => 
          file.filename.toLowerCase().includes(item.title.toLowerCase()) ||
          keywords.some(k => file.filename.toLowerCase().includes(k.toLowerCase())) ||
          keywords.some(k => file.content.toLowerCase().includes(k.toLowerCase()))
        );
        
        if (relevantFiles.length === 0) return null;
        
        const relevantDiff = relevantFiles.map(f => f.content).join('\n').slice(0, 10000);
        
        return await this.analyzeDiffBatch(
          relevantDiff, 
          projectBackground, 
          toVersion, 
          item.title, 
          releaseNotes
        );
      }));
      
      results.forEach(res => {
        if (res) {
          allItems.push(...res.items);
          allExcelRows.push(...res.excelRows);
        }
      });
    }

    const summaryPrompt = `根据变更点提供摘要：\n${allItems.map(i => i.title).join('\n')}`;
    const summaryResult = await withRetry(() => this.callAI(summaryPrompt));
    const summaryData = parseJSON(summaryResult);
    
    return {
      summary: summaryData.summary || '分析完成',
      overallRisk: summaryData.overallRisk || 'Low',
      recommendations: summaryData.recommendations || [],
      items: allItems,
      excelRows: allExcelRows
    };
  }
}

export function getAIProvider(config: AIConfig): AIProvider {
  if (config.provider === 'gemini') {
    return new GeminiProvider(config.apiKey || '');
  }
  return new OpenAICompatibleProvider(config);
}
