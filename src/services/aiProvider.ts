import { GoogleGenAI, Type } from "@google/genai";
import axios from "axios";
import { AIProvider, ChangeLogAnalysis, DiffAnalysis, FullDiffAnalysis, AIConfig, ExcelAnalysis, BatchAnalysisResult, SkillBundle } from "../types";

// ===== 流式输出总线 =====
// 模块级单监听器：仅在「单路调用」阶段（changelog / 单次 full_diff / 聚合）启用，
// 并行批次不设监听器，避免 4 路 token 交织。callAI 检测到监听器即走流式传输。
export type StreamListener = (info: { delta: string; full: string }) => void;
let activeStreamListener: StreamListener | null = null;
export function setStreamListener(cb: StreamListener | null) { activeStreamListener = cb; }

/**
 * 流式消费 OpenAI / Anthropic 协议的 SSE 响应，累积并实时回调 delta，返回完整文本。
 * useProxy 时打到服务端 /api/ai-proxy-stream 透传端点。
 */
async function streamChatCompletion(
  url: string,
  data: any,
  headers: Record<string, string>,
  useProxy: boolean,
  onDelta: (delta: string, full: string) => void
): Promise<string> {
  const body = { ...data, stream: true };
  const resp = await fetch(useProxy ? '/api/ai-proxy-stream' : url, {
    method: 'POST',
    headers: useProxy ? { 'Content-Type': 'application/json' } : { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(useProxy ? { url, data: body, headers } : body),
  });

  if (!resp.ok || !resp.body) {
    let msg = `流式请求失败 (${resp.status})`;
    try { const j = await resp.json(); msg = j.message || msg; } catch {}
    throw new Error(msg);
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';

  const handlePayload = (payload: string) => {
    if (!payload || payload === '[DONE]') return;
    try {
      const obj = JSON.parse(payload);
      // OpenAI 协议
      const oa = obj.choices?.[0]?.delta?.content;
      if (typeof oa === 'string' && oa) { full += oa; onDelta(oa, full); return; }
      // Anthropic 协议
      if (obj.type === 'content_block_delta' && typeof obj.delta?.text === 'string') {
        full += obj.delta.text; onDelta(obj.delta.text, full); return;
      }
    } catch { /* 忽略非 JSON 的心跳/事件行 */ }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('data:')) handlePayload(trimmed.slice(5).trim());
    }
  }
  if (buffer.trim().startsWith('data:')) handlePayload(buffer.trim().slice(5).trim());
  return full;
}

function stripThinking(content: string): string {
  if (content && typeof content === 'string') {
    return content.replace(/<(thought|thinking)>[\s\S]*?<\/\1>/gi, '').trim();
  }
  return content;
}

function normalizeAIResponse(result: any): any {
  if (!result) return { items: [], recommendations: [], breakingChanges: [], summary: "" };

  // 1. Unwrap common top-level container keys (like "analysis", "data", "result")
  // if the result has only one major key and it's an object.
  const commonContainers = ['analysis', 'data', 'result', 'response', 'report', 'details'];
  for (const container of commonContainers) {
    if (result[container] && typeof result[container] === 'object' && !Array.isArray(result[container])) {
      // Small heuristic: if the container has more than one key, it's likely the real payload
      if (Object.keys(result).length === 1 || (Object.keys(result).length <= 2 && (result.status || result.ok || result.success))) {
        console.log(`Unwrapping top-level container: ${container}`);
        result = { ...result, ...result[container] };
      }
    }
  }

  // If result is an array, wrap it
  if (Array.isArray(result)) {
    result = { items: result };
  }

  if (typeof result !== 'object') return { items: [], recommendations: [], breakingChanges: [], summary: String(result) };

  // 2. Gather items from all possible keys if 'items' is missing or empty
  if (!result.items || !Array.isArray(result.items) || result.items.length === 0) {
    const potentialKeys = [
      'items', 'changes', 'change_log', 'items_list', 'cves_fixed', 'fixed_issues', 
      'features', 'new_features', 'improvements', 'bug_fixes', 'breaking_changes', 
      'breakingChanges', 'analysis', 'results', 'report', 'details', 'points', 'detailed_changes',
      'files_changed', 'modified_files', 'commit_list', 'change_details', 'files'
    ];
    let rawItems: any[] = [];

    // Try known keys
    potentialKeys.forEach(key => {
      if (result[key] && Array.isArray(result[key])) {
        const itemsWithMeta = result[key].map((it: any) => ({ 
          ...it, 
          _sourceKey: key,
          _isCVE: key === 'cves_fixed' || (typeof it === 'object' && (it.id?.startsWith('CVE-') || it.title?.startsWith('CVE-')))
        }));
        rawItems = [...rawItems, ...itemsWithMeta];
      }
    });

    // If still empty, check if 'details' or 'review_findings' is a structured object
    const structuredKeys = ['details', 'review_findings', 'change_details', 'findings'];
    if (rawItems.length === 0) {
      structuredKeys.forEach(key => {
        if (result[key] && typeof result[key] === 'object' && !Array.isArray(result[key])) {
          for (const sectionKey in result[key]) {
            const section = result[key][sectionKey];
            if (typeof section === 'object') {
              rawItems.push({
                title: sectionKey.replace(/_/g, ' ').toUpperCase(),
                description: section.description || section.summary || (section.files ? `Modified files: ${section.files.join(', ')}` : JSON.stringify(section)),
                impactLevel: section.impact_level || section.risk_level || "Medium",
                ...section
              });
            } else if (typeof section === 'string') {
              rawItems.push({ title: sectionKey, description: section });
            }
          }
        }
      });
    }

    // If still empty and we have a change_description, use it as a single item
    if (rawItems.length === 0 && result.change_description) {
      rawItems.push({
        title: "变更详情",
        description: result.change_description,
        impactLevel: result.impact_level || result.risk_level || "Low"
      });
    }

    // Still empty? Look for any array that might contain items
    if (rawItems.length === 0) {
      for (const key in result) {
        if (!potentialKeys.includes(key) && Array.isArray(result[key]) && result[key].length > 0) {
          const first = result[key][0];
          if (typeof first === 'object' && (first.title || first.description || first.name || first.summary || first.content || first.id || first.file || first.change_summary || first.patch || first.diff)) {
            rawItems = result[key];
            break;
          }
        }
      }
    }

    if (rawItems.length > 0) {
      result.items = rawItems.map((item: any) => {
        if (typeof item === 'string') {
          return { 
            title: item, 
            reason: item, 
            description: item,
            impactLevel: "Low", 
            riskLevel: "Low",
            compatibilityAnalysis: "无特殊说明" 
          };
        }

        const title = item.title || item.name || item.id || item.change_summary || item.description || item.file || item.changepoint || item.summary || item.change_type || "未知变更";
        const prNumberRaw = item.prNumber || item.pr_number || item.pull_request || item.issue || item.related_commits || "";
        let prNumber: number | undefined = undefined;
        if (typeof prNumberRaw === 'number') prNumber = prNumberRaw;
        else if (typeof prNumberRaw === 'string') {
          const match = prNumberRaw.match(/(\d+)/);
          if (match) prNumber = parseInt(match[1]);
        }

        let impactLevel: "High" | "Medium" | "Low" = "Low";
        const rawImpact = item.impactLevel || item.riskLevel || item.impact || item.risk || item.severity || item.priority || (item.type === 'fix' ? 'Medium' : 'Low');
        
        if (item._isCVE || rawImpact === 'High' || rawImpact === '高' || rawImpact === 'critical' || rawImpact === 'Critical' || (typeof rawImpact === 'string' && (rawImpact.toUpperCase() === 'HIGH' || rawImpact.toUpperCase() === 'CRITICAL'))) {
          impactLevel = "High";
        } else if (rawImpact === 'Medium' || rawImpact === '中' || (typeof rawImpact === 'string' && (rawImpact.toUpperCase() === 'MEDIUM' || rawImpact.toUpperCase() === 'WARNING'))) {
          impactLevel = "Medium";
        }

        const desc = item.reason || item.description || item.change_summary || item.chinese || item.summary || item.url || item.content || item.title || item.change_description || "";

        return {
          title, 
          prNumber,
          reason: desc,
          description: desc, 
          impactLevel,
          riskLevel: impactLevel,
          compatibilityAnalysis: item.compatibilityAnalysis || item.impact || item.suggestion || item.module || item.function || item.description || "无兼容性影响说明",
          codeExample: item.codeExample || (item.before || item.after ? { before: item.before || "", after: item.after || "" } : undefined),
          sourceSnippet: item.sourceSnippet || item.diff || item.patch || item.patch_diff || "",
          commitLinks: item.commitLinks || (item.pull_request ? [item.pull_request] : (item.commits && Array.isArray(item.commits) ? item.commits : []))
        };
      });
    } else {
      result.items = [];
    }
  } else {
    // If items already exist, ensure they have both field sets
    result.items = result.items.map((item: any) => {
      if (typeof item === 'object') {
        const impact = item.impactLevel || item.riskLevel || (item.risk?.toUpperCase() === 'HIGH' ? 'High' : item.risk?.toUpperCase() === 'MEDIUM' ? 'Medium' : 'Low');
        const desc = item.reason || item.description || item.change_summary || item.summary || "";
        const title = item.title || item.name || item.id || item.change_summary || item.description || item.file || "未知变更";
        return {
          ...item,
          title,
          impactLevel: impact,
          riskLevel: impact,
          reason: desc,
          description: desc
        };
      }
      return item;
    });
  }

  // 3. Handle recommendations, breaking changes and compatibility
  if (!result.recommendations || !Array.isArray(result.recommendations) || result.recommendations.length === 0) {
    if (result.recommendation && typeof result.recommendation === 'string') result.recommendations = [result.recommendation];
    else if (result.suggestions && Array.isArray(result.suggestions)) result.recommendations = result.suggestions;
    else if (result.advices && Array.isArray(result.advices)) result.recommendations = result.advices;
    else if (result.security_impact && typeof result.security_impact === 'object') {
      const impacts: string[] = [];
      if (result.security_impact.direct_vulnerabilities) impacts.push(`Direct vulnerabilities: ${result.security_impact.direct_vulnerabilities}`);
      if (Array.isArray(result.security_impact.indirect_risks)) impacts.push(...result.security_impact.indirect_risks);
      if (impacts.length > 0) result.recommendations = impacts;
    }
  }
  
  if (!result.breakingChanges || !Array.isArray(result.breakingChanges) || result.breakingChanges.length === 0) {
    if (result.breaking_changes && Array.isArray(result.breaking_changes)) result.breakingChanges = result.breaking_changes;
    else if (result.incompatible_changes && Array.isArray(result.incompatible_changes)) result.breakingChanges = result.incompatible_changes;
  }

  if (!result.compatibilityNotes || !Array.isArray(result.compatibilityNotes) || result.compatibilityNotes.length === 0) {
    if (result.compatibility && typeof result.compatibility === 'object') {
      result.compatibilityNotes = Object.entries(result.compatibility)
        .map(([k, v]) => `${k.replace(/_/g, ' ')}: ${v}`);
    } else if (result.compatibility_notes && Array.isArray(result.compatibility_notes)) {
      result.compatibilityNotes = result.compatibility_notes;
    }
  }

  // 4. Ensure summary exists
  if (!result.summary) {
    if (result.release_summary) result.summary = result.release_summary;
    else if (result.overview) result.summary = result.overview;
    else if (result.change_description) result.summary = result.change_description;
    else if (result.release_version || result.version) result.summary = `分析结果 (${result.release_version || result.version})。`;
    else if (result.items?.length > 0) result.summary = `发现了 ${result.items.length} 个主要变更点。`;
    else result.summary = "";
  }

  // 5. Calculate overall risk if missing
  if (!result.overallRisk) {
    const rawOverall = result.overall_risk || result.impact_level || result.risk_level;
    if (rawOverall) {
      result.overallRisk = (typeof rawOverall === 'string' && rawOverall.toUpperCase() === 'HIGH') ? 'High' : 
                           (typeof rawOverall === 'string' && rawOverall.toUpperCase() === 'MEDIUM') ? 'Medium' : 'Low';
    } else {
      const items = result.items || [];
      if (items.some((it: any) => it.riskLevel === 'High' || it.impactLevel === 'High')) {
        result.overallRisk = 'High';
      } else if (items.some((it: any) => it.riskLevel === 'Medium' || it.impactLevel === 'Medium')) {
        result.overallRisk = 'Medium';
      } else {
        result.overallRisk = 'Low';
      }
    }
  }

  // 6. Ensure all collection fields are arrays (prevent .map errors)
  const collectionFields = ['items', 'recommendations', 'breakingChanges', 'compatibilityNotes', 'excelRows', 'commits', 'files'];
  collectionFields.forEach(field => {
    if (!result[field] || !Array.isArray(result[field])) {
      result[field] = [];
    }
  });

  // 7. Sanitize render-facing fields: 模型可能把字符串字段返回成嵌套对象、
  // 把 commitLinks 返回成字符串数组，直接渲染会让 React 整树崩溃（白屏）
  const toText = (v: any): string => {
    if (v == null) return '';
    if (typeof v === 'string') return v;
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    try { return JSON.stringify(v, null, 2); } catch { return String(v); }
  };

  result.summary = toText(result.summary);
  (['recommendations', 'breakingChanges', 'compatibilityNotes'] as const).forEach(field => {
    result[field] = result[field].map((entry: any) => toText(entry)).filter(Boolean);
  });

  result.items = result.items.map((item: any) => {
    if (typeof item !== 'object' || item === null) {
      const text = toText(item);
      return { title: text, description: text, reason: text, impactLevel: 'Low', riskLevel: 'Low', commitLinks: [] };
    }
    let codeExample: { before: string; after: string } | undefined;
    if (item.codeExample) {
      codeExample = typeof item.codeExample === 'string'
        ? { before: '', after: item.codeExample }
        : { before: toText(item.codeExample.before), after: toText(item.codeExample.after) };
      if (!codeExample.before && !codeExample.after) codeExample = undefined;
    }
    const commitLinks = (Array.isArray(item.commitLinks) ? item.commitLinks : []).map((link: any) => {
      if (typeof link === 'string') {
        const sha = (link.match(/[0-9a-f]{7,40}/i) || [''])[0];
        return { sha: sha || link.slice(0, 12), url: /^https?:\/\//.test(link) ? link : '' };
      }
      if (link && typeof link === 'object') {
        return { sha: toText(link.sha || link.id) || 'commit', url: toText(link.url || link.html_url) };
      }
      return null;
    }).filter((l: any) => l && l.url);
    return {
      ...item,
      title: toText(item.title) || '未知变更',
      description: toText(item.description),
      reason: toText(item.reason),
      compatibilityAnalysis: toText(item.compatibilityAnalysis),
      sourceSnippet: toText(item.sourceSnippet),
      codeExample,
      commitLinks
    };
  });

  return result;
}

function parseJSON(text: string): any {
  // 非字符串响应（部分网关把 content 返回成分段数组）先拼接成文本
  if (text && typeof text !== 'string') {
    if (Array.isArray(text)) {
      text = (text as any[]).map(p => typeof p === 'string' ? p : (p?.text ?? '')).join('');
    } else {
      text = String(text);
    }
  }
  // 空响应明确报错，而不是返回缺字段的 {}（曾导致下游读 items.length 崩溃）
  if (!text || !String(text).trim()) {
    throw new Error('模型返回了空响应（可能被限流、输入超长被拒或网关异常），请重试或更换模型。');
  }
  let cleanText = text.trim();
  
  const tryParse = (str: string) => {
    if (!str) return null;
    let target = str.trim();
    try {
      const parsed = JSON.parse(target);
      return normalizeAIResponse(parsed);
    } catch (e) {
      // Basic cleanup: remove trailing commas before closing braces
      let fixed = target.replace(/,\s*([\]}])/g, '$1');
      // Fix control characters
      fixed = fixed.replace(/[\x00-\x1F\x7F-\x9F]/g, (match) => {
        if (match === '\n') return '\\n';
        if (match === '\r') return '\\r';
        if (match === '\t') return '\\t';
        return '';
      });

      try {
        const parsed = JSON.parse(fixed);
        return normalizeAIResponse(parsed);
      } catch (e2) {
        // Attempt to close open strings
        let truncated = fixed;
        const quotes = (truncated.match(/(?<!\\)"/g) || []).length;
        if (quotes % 2 !== 0) truncated += '"';

        // Attempt to balance braces/brackets
        const openBraces = (truncated.match(/{/g) || []).length;
        const closeBraces = (truncated.match(/}/g) || []).length;
        const openBrackets = (truncated.match(/\[/g) || []).length;
        const closeBrackets = (truncated.match(/\]/g) || []).length;
        
        if (openBraces > closeBraces || openBrackets > closeBrackets) {
          // Close in reverse order
          let stack: string[] = [];
          for (let char of truncated) {
            if (char === '{') stack.push('}');
            if (char === '[') stack.push(']');
            if (char === '}' || char === ']') stack.pop();
          }
          while (stack.length > 0) truncated += stack.pop();
          
          try {
            const parsed = JSON.parse(truncated);
            return normalizeAIResponse(parsed);
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
    result = tryParse(cleanText.substring(firstBrace));
    if (result) return result;
  }

  const firstBracket = cleanText.indexOf('[');
  const lastBracket = cleanText.lastIndexOf(']');
  if (firstBracket !== -1 && lastBracket !== -1 && lastBracket > firstBracket) {
    result = tryParse(cleanText.substring(firstBracket, lastBracket + 1));
    if (result) return result;
    result = tryParse(cleanText.substring(firstBracket));
    if (result) return result;
  }
  
  console.error("Failed to parse JSON from AI response. Original text summary:", cleanText.substring(0, 500) + "...");
  throw new Error("无法解析 AI 返回的 JSON 数据。这通常是因为内容过长或包含非法字符。已尝试自动修复但失败，请尝试缩小分析范围。");
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
        await new Promise(resolve => setTimeout(resolve, delay));
        retries++;
        continue;
      }
      throw err;
    }
  }
}

export class GeminiProvider implements AIProvider {
  private config: AIConfig;

  constructor(apiKeyOrConfig: string | AIConfig) {
    if (typeof apiKeyOrConfig === 'string') {
      this.config = { 
        provider: 'gemini', 
        apiKey: apiKeyOrConfig, 
        model: 'gemini-1.5-pro', // Default model
        useProxy: true 
      };
    } else {
      this.config = apiKeyOrConfig;
    }
  }

  private async callProxy(prompt: string, type: string, extra: any = {}): Promise<string> {
    const response = await axios.post("/api/ai/analyze-changelog", {
      provider: 'gemini',
      config: this.config,
      changeLog: prompt,
      projectBackground: extra.projectBackground || '',
      sourceUrl: extra.sourceUrl,
      type
    });
    return response.data.text;
  }

  async analyzeChangeLog(changeLog: string, projectBackground: string, sourceUrl?: string): Promise<ChangeLogAnalysis> {
    const text = await this.callProxy(changeLog, 'changelog', { projectBackground, sourceUrl });
    const result = parseJSON(text);
    return { ...result, sourceUrl };
  }

  async analyzeDiff(diff: string, prTitle: string, projectBackground: string): Promise<DiffAnalysis> {
    const openai = new OpenAICompatibleProvider(this.config);
    (openai as any).callAI = (prompt: string) => this.callProxy(prompt, 'diff', { projectBackground });
    return openai.analyzeDiff(diff, prTitle, projectBackground);
  }

  async analyzeBatchDiff(diff: string, projectBackground: string, fromVersion: string, toVersion: string, groupName: string, batchIndex: number, totalBatches: number, releaseNotes?: string, commits?: any[]): Promise<BatchAnalysisResult> {
    const openai = new OpenAICompatibleProvider(this.config);
    (openai as any).callAI = (prompt: string) => this.callProxy(prompt, 'batch-diff', { projectBackground });
    return openai.analyzeBatchDiff(diff, projectBackground, fromVersion, toVersion, groupName, batchIndex, totalBatches, releaseNotes, commits);
  }

  async aggregateBatchResults(batchResults: BatchAnalysisResult[], projectBackground: string, fromVersion: string, toVersion: string, releaseNotes?: string): Promise<FullDiffAnalysis> {
    const openai = new OpenAICompatibleProvider(this.config);
    (openai as any).callAI = (prompt: string) => this.callProxy(prompt, 'aggregate', { projectBackground });
    return openai.aggregateBatchResults(batchResults, projectBackground, fromVersion, toVersion, releaseNotes);
  }

  async analyzeFullDiff(diff: string, projectBackground: string, fromVersion: string, toVersion: string, releaseNotes?: string, commits?: any[], files?: any[], metadata?: { mode?: string, fallbackReason?: string, confidenceNote?: string }): Promise<FullDiffAnalysis> {
    const openai = new OpenAICompatibleProvider(this.config);
    (openai as any).callAI = (prompt: string) => this.callProxy(prompt, 'full-diff', { projectBackground });
    return openai.analyzeFullDiff(diff, projectBackground, fromVersion, toVersion, releaseNotes, commits, files, metadata);
  }
}

export class AnthropicProvider implements AIProvider {
  private config: AIConfig;
  constructor(config: AIConfig) { this.config = config; }
  
  private async callAI(prompt: string): Promise<string> {
    const baseUrl = (this.config.baseUrl || 'https://api.anthropic.com').replace(/\/$/, '');
    const url = baseUrl.endsWith('/messages') ? baseUrl : `${baseUrl}/v1/messages`;
    const data = {
      model: this.config.model,
      max_tokens: 8192,
      system: "你是一个极其严谨的资深架构师。请直接输出 JSON 结果。",
      messages: [{ role: 'user', content: prompt }]
    };
    const headers = { 'x-api-key': this.config.apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' };

    // 有监听器时走流式（Anthropic SSE content_block_delta），失败回退非流式
    if (activeStreamListener) {
      const listener = activeStreamListener;
      try {
        const full = await streamChatCompletion(url, data, headers, this.config.useProxy, (delta, acc) => listener({ delta, full: acc }));
        if (full && full.trim()) return stripThinking(full);
        console.warn('Streaming returned empty content, falling back to non-streaming.');
      } catch (streamErr) {
        console.warn('Streaming failed, falling back to non-streaming:', streamErr);
      }
    }

    const response = await axios.post(this.config.useProxy ? '/api/ai-proxy' : url,
      this.config.useProxy ? { url, data, headers } : data,
      { headers: this.config.useProxy ? {} : headers, timeout: 310000 });

    const result = response.data;
    if (Array.isArray(result.content)) {
      return result.content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('');
    }
    return result.text || result.message || JSON.stringify(result);
  }

  async analyzeChangeLog(changeLog: string, projectBackground: string, sourceUrl?: string): Promise<ChangeLogAnalysis> {
    const openai = new OpenAICompatibleProvider(this.config);
    (openai as any).callAI = (prompt: string) => this.callAI(prompt);
    return openai.analyzeChangeLog(changeLog, projectBackground, sourceUrl);
  }
  async analyzeDiff(diff: string, prTitle: string, projectBackground: string): Promise<DiffAnalysis> {
    const openai = new OpenAICompatibleProvider(this.config);
    (openai as any).callAI = (prompt: string) => this.callAI(prompt);
    return openai.analyzeDiff(diff, prTitle, projectBackground);
  }
  async analyzeBatchDiff(diff: string, projectBackground: string, fromVersion: string, toVersion: string, groupName: string, batchIndex: number, totalBatches: number, releaseNotes?: string, commits?: any[]): Promise<BatchAnalysisResult> {
    const openai = new OpenAICompatibleProvider(this.config);
    (openai as any).callAI = (prompt: string) => this.callAI(prompt);
    return openai.analyzeBatchDiff(diff, projectBackground, fromVersion, toVersion, groupName, batchIndex, totalBatches, releaseNotes, commits);
  }
  async aggregateBatchResults(batchResults: BatchAnalysisResult[], projectBackground: string, fromVersion: string, toVersion: string, releaseNotes?: string): Promise<FullDiffAnalysis> {
    const openai = new OpenAICompatibleProvider(this.config);
    (openai as any).callAI = (prompt: string) => this.callAI(prompt);
    return openai.aggregateBatchResults(batchResults, projectBackground, fromVersion, toVersion, releaseNotes);
  }
  async analyzeFullDiff(diff: string, projectBackground: string, fromVersion: string, toVersion: string, releaseNotes?: string, commits?: any[], files?: any[], metadata?: { mode?: string, fallbackReason?: string, confidenceNote?: string }): Promise<FullDiffAnalysis> {
    const openai = new OpenAICompatibleProvider(this.config);
    (openai as any).callAI = (prompt: string) => this.callAI(prompt);
    return openai.analyzeFullDiff(diff, projectBackground, fromVersion, toVersion, releaseNotes, commits, files, metadata);
  }
}

export class OpenAICompatibleProvider implements AIProvider {
  private config: AIConfig;
  constructor(config: AIConfig) { this.config = config; }

  private async callAI(prompt: string, jsonMode: boolean = true): Promise<string> {
    const baseUrl = (this.config.baseUrl || 'https://api.openai.com/v1').replace(/\/$/, '');
    const url = baseUrl.endsWith('/chat/completions') ? baseUrl : `${baseUrl}/chat/completions`;
    const data = {
      model: this.config.model,
      messages: [
        { role: 'system', content: "你是一个极其严谨的资深架构师。请直接输出最终的 JSON 结果。" },
        { role: 'user', content: prompt }
      ],
      response_format: jsonMode ? { type: 'json_object' } : undefined,
      temperature: 0.1,
      max_tokens: 8000
    };
    const headers = { 'Authorization': `Bearer ${this.config.apiKey}`, 'Content-Type': 'application/json' };

    // 有监听器时走流式：实时回调 token，最终仍返回完整文本供 JSON 解析。
    // 流式失败或返回空（部分网关不支持 json_object+stream）时回退非流式。
    if (activeStreamListener) {
      const listener = activeStreamListener;
      try {
        const full = await streamChatCompletion(url, data, headers, this.config.useProxy, (delta, acc) => listener({ delta, full: acc }));
        if (full && full.trim()) return stripThinking(full);
        console.warn('Streaming returned empty content, falling back to non-streaming.');
      } catch (streamErr) {
        console.warn('Streaming failed, falling back to non-streaming:', streamErr);
      }
    }

    const response = await axios.post(this.config.useProxy ? '/api/ai-proxy' : url,
      this.config.useProxy ? { url, data, headers } : data,
      { headers: this.config.useProxy ? {} : headers, timeout: 310000 });

    const aiResponse = response.data;
    let content = aiResponse?.choices?.[0]?.message?.content || aiResponse?.choices?.[0]?.text || aiResponse?.text || (typeof aiResponse === 'string' ? aiResponse : null);
    return stripThinking(content);
  }

  async analyzeChangeLog(changeLog: string, projectBackground: string, sourceUrl?: string): Promise<ChangeLogAnalysis> {
    const prompt = `分析以下 GitHub 变更日志。项目背景：${projectBackground}\n${sourceUrl ? `来源：${sourceUrl}\n` : ''}${changeLog}\n请返回 JSON 格式结果。`;
    const result = await this.callAI(prompt);
    return { ...parseJSON(result), sourceUrl };
  }
  async analyzeDiff(diff: string, prTitle: string, projectBackground: string): Promise<DiffAnalysis> {
    const prompt = `分析代码差异。PR：${prTitle}\n背景：${projectBackground}\nDiff：\n${diff.slice(0, 20000)}`;
    const result = await this.callAI(prompt);
    return parseJSON(result);
  }
  async analyzeBatchDiff(diff: string, projectBackground: string, fromVersion: string, toVersion: string, groupName: string, batchIndex: number, totalBatches: number, releaseNotes?: string, commits?: any[]): Promise<BatchAnalysisResult> {
    const prompt = `你是资深软件架构师。分析以下三方库代码变更（${fromVersion} -> ${toVersion}，分组：${groupName}，第 ${batchIndex + 1}/${totalBatches} 批）。

项目背景：${projectBackground}
${releaseNotes ? `发布日志（节选）：\n${releaseNotes.slice(0, 2000)}\n` : ''}
文件级变更证据：
${diff.slice(0, 20000)}

请识别可能影响使用方的 API 变更、行为变更、配置变更与移除项，输出 JSON：
{
  "summary": "本批次中文小结",
  "items": [{
    "title": "变更点标题",
    "description": "变更说明",
    "riskLevel": "High | Medium | Low",
    "compatibilityAnalysis": "对使用方的影响与排查建议",
    "sourceSnippet": "关键 diff 片段（可选）"
  }],
  "recommendations": ["建议"]
}
只输出 JSON。仅报告证据中真实存在的变更，无实质变更时 items 返回空数组。`;
    const result = await this.callAI(prompt);
    return parseJSON(result);
  }
  async aggregateBatchResults(batchResults: BatchAnalysisResult[], projectBackground: string, fromVersion: string, toVersion: string, releaseNotes?: string): Promise<FullDiffAnalysis> {
    // 压缩批次结果作为聚合输入，整体控制在 ~60k 字符
    const perBatchBudget = Math.max(2000, Math.floor(60000 / Math.max(1, batchResults.length)));
    const evidence = batchResults.map((r, i) => {
      const slim = {
        summary: r.summary,
        recommendations: (r.recommendations || []).slice(0, 10),
        items: (r.items || []).map(it => ({
          title: it.title,
          riskLevel: it.riskLevel,
          description: (it.description || '').slice(0, 500),
          compatibilityAnalysis: (it.compatibilityAnalysis || '').slice(0, 400),
          sourceSnippet: (it.sourceSnippet || '').slice(0, 400)
        }))
      };
      let text = JSON.stringify(slim);
      if (text.length > perBatchBudget) text = text.slice(0, perBatchBudget) + '…(截断)';
      return `[批次 ${i + 1}]\n${text}`;
    }).join('\n\n');

    const prompt = `你是资深软件架构师。以下是 ${fromVersion} -> ${toVersion} 版本间代码差异的 ${batchResults.length} 个批次分析结果，请汇总为最终升级风险报告。

项目背景：${projectBackground}
${releaseNotes ? `发布日志（节选）：\n${releaseNotes.slice(0, 4000)}\n` : ''}
批次分析结果：
${evidence}

要求：
1. 合并重复或同类变更点，保留最具体的描述与证据；按风险从高到低排列；items 总数不超过 50 条，低风险项可合并概括。
2. 控制输出长度：description 与 compatibilityAnalysis 各 120 字内，sourceSnippet 只保留最关键的几行（可省略）。
3. 输出 JSON（不要输出 excelRows 等其他字段）：
{
  "summary": "中文总摘要（150 字内）",
  "overallRisk": "High | Medium | Low",
  "recommendations": ["核心建议，不超过 10 条"],
  "items": [{
    "title": "变更点",
    "description": "说明",
    "riskLevel": "High | Medium | Low",
    "compatibilityAnalysis": "影响与排查建议",
    "sourceSnippet": "关键 diff 片段（可选）"
  }]
}
4. 严禁编造批次结果中不存在的变更；批次标注分析失败的部分不要臆测。只输出 JSON。`;
    const result = await this.callAI(prompt);
    return parseJSON(result);
  }
  async analyzeFullDiff(diff: string, projectBackground: string, fromVersion: string, toVersion: string, releaseNotes?: string, commits?: any[], files?: any[], metadata?: { mode?: string, fallbackReason?: string, confidenceNote?: string }): Promise<FullDiffAnalysis> {
    const prompt = `全量分析。版本：${fromVersion}->${toVersion}\n背景：${projectBackground}\nDiff：\n${diff.slice(0, 50000)}`;
    const result = await this.callAI(prompt);
    return parseJSON(result);
  }
}

export function getAIProvider(config: AIConfig): AIProvider {
  if (config.provider === 'gemini') return new GeminiProvider(config);
  if (config.provider === 'anthropic') return new AnthropicProvider(config);
  return new OpenAICompatibleProvider(config);
}
