import { GoogleGenAI, Type } from "@google/genai";
import axios from "axios";
import { AIProvider, ChangeLogAnalysis, DiffAnalysis, FullDiffAnalysis, AIConfig, ExcelAnalysis, BatchAnalysisResult, SkillBundle } from "../types";

// ===== 流式输出总线 =====
// 模块级单监听器：仅在「单路调用」阶段（changelog / 单次 full_diff / 聚合）启用，
// 并行批次不设监听器，避免 4 路 token 交织。callAI 检测到监听器即走流式传输。
export type StreamListener = (info: { delta: string; full: string }) => void;
let activeStreamListener: StreamListener | null = null;
export function setStreamListener(cb: StreamListener | null) { activeStreamListener = cb; }

// 输出被 max_tokens 截断时附加在文本末尾的内部标记，parseJSON 据此给出精确报错
const TRUNCATION_MARKER = '__AI_OUTPUT_TRUNCATED__';

// ===== max_tokens 自动探测 =====
// 各模型最大输出上限差异巨大（DeepSeek 8k / gpt-4o 16k / MiniMax-M3 40k+），
// 且超限请求大多直接报 400。策略：从高档位开始请求，被拒自动降档，
// 探测结果按「接口地址+模型」缓存，后续调用直达正确档位，用户零配置。
const MAX_TOKENS_LADDER = [64000, 32000, 16000, 8192, 4096];
const maxTokensCache = new Map<string, number>();

function maxTokensLadderFor(cacheKey: string, override?: number): number[] {
  if (override) return [override];
  const known = maxTokensCache.get(cacheKey);
  if (known) {
    const idx = MAX_TOKENS_LADDER.indexOf(known);
    if (idx >= 0) return MAX_TOKENS_LADDER.slice(idx);
  }
  return MAX_TOKENS_LADDER;
}

/** 判断错误是否为 max_tokens 超过模型上限（应降档重试） */
function isMaxTokensRejection(err: any): boolean {
  const status = err?.response?.status ?? err?.status;
  if (status !== 400) return false;
  let body = '';
  try { body = JSON.stringify(err?.response?.data ?? err?.message ?? ''); } catch { body = String(err?.message || ''); }
  return /max_?tokens|max_?completion|output.?tokens|too large|maximum|invalid.?parameter/i.test(body);
}

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
  let truncated = false;

  const handlePayload = (payload: string) => {
    if (!payload || payload === '[DONE]') return;
    try {
      const obj = JSON.parse(payload);
      // OpenAI 协议
      if (obj.choices?.[0]?.finish_reason === 'length') truncated = true;
      const oa = obj.choices?.[0]?.delta?.content;
      if (typeof oa === 'string' && oa) { full += oa; onDelta(oa, full); return; }
      // Anthropic 协议
      if (obj.type === 'message_delta' && obj.delta?.stop_reason === 'max_tokens') truncated = true;
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
  return truncated && full ? full + TRUNCATION_MARKER : full;
}

function stripThinking(content: string): string {
  if (content && typeof content === 'string') {
    // 推理模型（MiniMax-M 系列、DeepSeek-R1、QwQ 等）会在正文输出思考块，
    // 其中几乎必然包含花括号，会干扰 JSON 提取，必须先剔除
    let out = content.replace(/<(think|thought|thinking|reasoning)>[\s\S]*?<\/\1>/gi, '');
    // 孤立的闭合标签（流式拼接或开头被截断时出现）：丢弃它之前的全部内容
    out = out.replace(/^[\s\S]*?<\/(think|thought|thinking|reasoning)>/i, '');
    return out.trim();
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
    // affectedApis 规范成字符串数组（模型可能返回字符串或对象数组）
    let affectedApis: string[] | undefined;
    const rawApis = item.affectedApis || item.affected_apis || item.apis;
    if (Array.isArray(rawApis)) {
      affectedApis = rawApis.map((a: any) => toText(a)).filter(Boolean);
    } else if (typeof rawApis === 'string' && rawApis.trim()) {
      affectedApis = rawApis.split(/[,，;；\n]/).map(s => s.trim()).filter(Boolean);
    }
    return {
      ...item,
      title: toText(item.title) || '未知变更',
      description: toText(item.description),
      reason: toText(item.reason),
      compatibilityAnalysis: toText(item.compatibilityAnalysis),
      sourceSnippet: toText(item.sourceSnippet),
      affectedApis,
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
  // 取出截断标记（callAI 在 finish_reason=length 时附加）
  let wasTruncated = false;
  if (text.includes(TRUNCATION_MARKER)) {
    wasTruncated = true;
    text = text.split(TRUNCATION_MARKER).join('');
  }
  // 剔除推理模型的思考块；若剔除后为空，说明思考耗尽了 max_tokens、没输出结果
  const stripped = stripThinking(text.trim());
  if (!stripped) {
    throw new Error('模型只输出了思考过程，没有给出结果（思考耗尽了该模型的输出长度上限）。请缩小分析范围，或换用非推理模型。');
  }
  let cleanText = stripped;
  
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
  if (wasTruncated) {
    throw new Error("模型输出达到了该模型的输出长度上限被截断，JSON 不完整且无法自动修复。请缩小分析范围（如减小版本跨度），或换用输出上限更大的模型。");
  }
  throw new Error("无法解析 AI 返回的 JSON 数据。常见原因：模型未按要求输出 JSON、或输出含异常格式。已尝试自动修复但失败，请重试、缩小分析范围或换用其他模型。");
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
    const headers = { 'x-api-key': this.config.apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' };
    const cacheKey = `${url}|${this.config.model}`;
    const ladder = maxTokensLadderFor(cacheKey, this.config.maxTokens);
    const buildData = (maxTokens: number) => ({
      model: this.config.model,
      max_tokens: maxTokens,
      system: "你是一个极其严谨的资深架构师。请直接输出 JSON 结果。",
      messages: [{ role: 'user', content: prompt }]
    });

    // 有监听器时走流式（Anthropic SSE content_block_delta），失败回退非流式
    if (activeStreamListener) {
      const listener = activeStreamListener;
      try {
        const full = await streamChatCompletion(url, buildData(ladder[0]), headers, this.config.useProxy, (delta, acc) => listener({ delta, full: acc }));
        if (full && full.trim()) {
          maxTokensCache.set(cacheKey, ladder[0]);
          return stripThinking(full);
        }
        console.warn('Streaming returned empty content, falling back to non-streaming.');
      } catch (streamErr) {
        console.warn('Streaming failed, falling back to non-streaming:', streamErr);
      }
    }

    // 非流式：从高档位开始，max_tokens 超限被拒则自动降档重试
    let response: any = null;
    for (let i = 0; i < ladder.length; i++) {
      const data = buildData(ladder[i]);
      try {
        response = await axios.post(this.config.useProxy ? '/api/ai-proxy' : url,
          this.config.useProxy ? { url, data, headers } : data,
          { headers: this.config.useProxy ? {} : headers, timeout: 310000 });
        maxTokensCache.set(cacheKey, ladder[i]);
        break;
      } catch (err: any) {
        if (i < ladder.length - 1 && isMaxTokensRejection(err)) {
          console.warn(`max_tokens=${ladder[i]} rejected by model, retrying with ${ladder[i + 1]}`);
          continue;
        }
        throw err;
      }
    }

    const result = response.data;
    if (Array.isArray(result.content)) {
      const joined = result.content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('');
      return result.stop_reason === 'max_tokens' && joined ? joined + TRUNCATION_MARKER : joined;
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
    const headers = { 'Authorization': `Bearer ${this.config.apiKey}`, 'Content-Type': 'application/json' };
    const cacheKey = `${url}|${this.config.model}`;
    const ladder = maxTokensLadderFor(cacheKey, this.config.maxTokens);
    const buildData = (maxTokens: number) => ({
      model: this.config.model,
      messages: [
        { role: 'system', content: "你是一个极其严谨的资深架构师。请直接输出最终的 JSON 结果。" },
        { role: 'user', content: prompt }
      ],
      response_format: jsonMode ? { type: 'json_object' } : undefined,
      temperature: 0.1,
      max_tokens: maxTokens
    });

    // 有监听器时走流式：实时回调 token，最终仍返回完整文本供 JSON 解析。
    // 流式请求不带 response_format——大量网关不支持 json_object+stream 组合，
    // 会报错或返回空导致静默回退；提示词已强约束 JSON，parseJSON 也能从
    // markdown 代码块中提取。流式失败（含 max_tokens 超限）回退非流式，
    // 由非流式分支完成档位探测，下次流式直接用缓存档位。
    if (activeStreamListener) {
      const listener = activeStreamListener;
      try {
        const { response_format: _omit, ...streamData } = buildData(ladder[0]) as any;
        const full = await streamChatCompletion(url, streamData, headers, this.config.useProxy, (delta, acc) => listener({ delta, full: acc }));
        if (full && full.trim()) {
          maxTokensCache.set(cacheKey, ladder[0]);
          return stripThinking(full);
        }
        console.warn('Streaming returned empty content, falling back to non-streaming.');
      } catch (streamErr) {
        console.warn('Streaming failed, falling back to non-streaming:', streamErr);
      }
    }

    // 非流式：从高档位开始，max_tokens 超限被拒则自动降档重试
    let response: any = null;
    for (let i = 0; i < ladder.length; i++) {
      const data = buildData(ladder[i]);
      try {
        response = await axios.post(this.config.useProxy ? '/api/ai-proxy' : url,
          this.config.useProxy ? { url, data, headers } : data,
          { headers: this.config.useProxy ? {} : headers, timeout: 310000 });
        maxTokensCache.set(cacheKey, ladder[i]);
        break;
      } catch (err: any) {
        if (i < ladder.length - 1 && isMaxTokensRejection(err)) {
          console.warn(`max_tokens=${ladder[i]} rejected by model, retrying with ${ladder[i + 1]}`);
          continue;
        }
        throw err;
      }
    }

    const aiResponse = response.data;
    let content = aiResponse?.choices?.[0]?.message?.content || aiResponse?.choices?.[0]?.text || aiResponse?.text || (typeof aiResponse === 'string' ? aiResponse : null);
    content = stripThinking(content);
    if (content && aiResponse?.choices?.[0]?.finish_reason === 'length') {
      content += TRUNCATION_MARKER;
    }
    return content;
  }

  async analyzeChangeLog(changeLog: string, projectBackground: string, sourceUrl?: string): Promise<ChangeLogAnalysis> {
    const prompt = `你是资深软件架构师。分析以下三方库变更日志，识别对使用方有实质影响的变更条目。

项目背景：${projectBackground}
${sourceUrl ? `内容来源：${sourceUrl}\n` : ''}变更日志：
${changeLog}

输出 JSON（不要输出任何其他内容）：
{
  "summary": "版本综合摘要（中文，100 字内）",
  "items": [{
    "title": "变更标题",
    "prNumber": 12345,
    "reason": "变更说明与背景（中文）",
    "impactLevel": "High | Medium | Low",
    "compatibilityAnalysis": "对使用方的影响与排查建议",
    "codeExample": { "before": "旧用法", "after": "新用法" }
  }]
}
要求：逐条覆盖日志中的具体条目，不要宽泛概括；High/Medium 条目必须给出 codeExample；prNumber 没有就省略；仅基于日志内容，严禁编造。`;
    const result = await this.callAI(prompt);
    return { ...parseJSON(result), sourceUrl };
  }
  async analyzeDiff(diff: string, prTitle: string, projectBackground: string): Promise<DiffAnalysis> {
    const prompt = `你是资深软件架构师。分析以下 PR 代码差异对使用方的兼容性影响。

PR 标题：${prTitle}
项目背景：${projectBackground}
代码差异：
${diff.slice(0, 20000)}

输出 JSON（不要输出任何其他内容）：
{
  "riskLevel": "High | Medium | Low",
  "breakingChanges": ["破坏性变更（中文）"],
  "compatibilityNotes": ["兼容性说明"],
  "recommendations": ["建议"],
  "codeExample": { "before": "旧用法", "after": "新用法" }
}
仅基于差异内容，严禁编造。`;
    const result = await this.callAI(prompt);
    return parseJSON(result);
  }
  async analyzeBatchDiff(diff: string, projectBackground: string, fromVersion: string, toVersion: string, groupName: string, batchIndex: number, totalBatches: number, releaseNotes?: string, commits?: any[]): Promise<BatchAnalysisResult> {
    const prompt = `你是资深软件架构师。分析以下三方库代码变更（${fromVersion} -> ${toVersion}，分组：${groupName}，第 ${batchIndex + 1}/${totalBatches} 批）。

项目背景：${projectBackground}
${releaseNotes ? `发布日志（节选）：\n${releaseNotes.slice(0, 2000)}\n` : ''}
文件级变更证据：
${diff.slice(0, 20000)}

请识别可能影响使用方的 API 变更、行为变更、配置变更与移除项。对每一项尽量写充分、具体，不要只写一句话。输出 JSON：
{
  "summary": "本批次中文小结",
  "items": [{
    "title": "变更点标题",
    "description": "详细变更说明：改了什么、为什么改；点名受影响的类/接口/方法/字段/配置项的具体名称",
    "riskLevel": "High | Medium | Low",
    "affectedApis": ["受影响的公开 API 全名，如 com.foo.Bar#method(类型)"],
    "compatibilityAnalysis": "对使用方的影响：调用方在什么场景会受影响、运行时/编译期如何表现、如何排查",
    "migration": "具体迁移/整改步骤（如有）",
    "sourceSnippet": "关键 diff 片段（保留能说明问题的几行）"
  }],
  "recommendations": ["建议"]
}
只输出 JSON。仅报告证据中真实存在的变更，无实质变更时 items 返回空数组。`;
    const result = await this.callAI(prompt);
    return parseJSON(result);
  }
  async aggregateBatchResults(batchResults: BatchAnalysisResult[], projectBackground: string, fromVersion: string, toVersion: string, releaseNotes?: string): Promise<FullDiffAnalysis> {
    // 压缩批次结果作为聚合输入，整体控制在 ~90k 字符（尽量保留细节）
    const perBatchBudget = Math.max(2500, Math.floor(90000 / Math.max(1, batchResults.length)));
    const evidence = batchResults.map((r, i) => {
      const slim = {
        summary: r.summary,
        recommendations: (r.recommendations || []).slice(0, 10),
        items: (r.items || []).map((it: any) => ({
          title: it.title,
          riskLevel: it.riskLevel,
          description: (it.description || '').slice(0, 900),
          affectedApis: it.affectedApis,
          compatibilityAnalysis: (it.compatibilityAnalysis || '').slice(0, 700),
          migration: (it.migration || '').slice(0, 400),
          sourceSnippet: (it.sourceSnippet || '').slice(0, 500)
        }))
      };
      let text = JSON.stringify(slim);
      if (text.length > perBatchBudget) text = text.slice(0, perBatchBudget) + '…(截断)';
      return `[批次 ${i + 1}]\n${text}`;
    }).join('\n\n');

    const prompt = `你是资深软件架构师。以下是 ${fromVersion} -> ${toVersion} 版本间代码差异的 ${batchResults.length} 个批次分析结果，请汇总为一份**详尽、可执行**的最终升级风险报告。

项目背景：${projectBackground}
${releaseNotes ? `发布日志（节选）：\n${releaseNotes.slice(0, 4000)}\n` : ''}
批次分析结果：
${evidence}

要求：
1. 合并重复或同类变更点，保留并融合各批次中最具体的描述、受影响 API 与证据；按风险从高到低排列。不要为了精简而丢失关键技术细节。
2. 每一项都要写充分：description 说清改了什么、影响什么；compatibilityAnalysis 说清使用方在何种调用场景会受影响、运行时/编译期如何表现、如何排查；High/Medium 项尽量给出 before/after 代码示例。不要用一句话敷衍。
3. 输出 JSON（不要输出 excelRows 等其他字段）：
{
  "summary": "中文总摘要（说明本次升级的整体性质与主要风险，150-300 字）",
  "overallRisk": "High | Medium | Low",
  "recommendations": ["核心建议，按优先级排列"],
  "items": [{
    "title": "变更点标题",
    "description": "详细变更说明，点名受影响的类/接口/方法/配置项具体名称",
    "riskLevel": "High | Medium | Low",
    "affectedApis": ["受影响的公开 API 全名"],
    "compatibilityAnalysis": "对使用方的影响、排查方式与迁移建议",
    "codeExample": { "before": "旧用法", "after": "新用法" },
    "sourceSnippet": "关键 diff 片段"
  }]
}
4. 严禁编造批次结果中不存在的变更；批次标注分析失败的部分不要臆测。只输出 JSON。`;
    const result = await this.callAI(prompt);
    return parseJSON(result);
  }
  async analyzeFullDiff(diff: string, projectBackground: string, fromVersion: string, toVersion: string, releaseNotes?: string, commits?: any[], files?: any[], metadata?: { mode?: string, fallbackReason?: string, confidenceNote?: string }): Promise<FullDiffAnalysis> {
    const prompt = `你是资深软件架构师。分析三方库 ${fromVersion} -> ${toVersion} 的代码差异，评估升级兼容性风险。

项目背景：${projectBackground}
${releaseNotes ? `发布日志（节选）：\n${releaseNotes.slice(0, 3000)}\n` : ''}代码差异：
${diff.slice(0, 50000)}

逐项分析时要写充分、具体，不要一句话敷衍。输出 JSON（不要输出任何其他内容）：
{
  "summary": "中文总摘要（说明升级整体性质与主要风险，150-300 字）",
  "overallRisk": "High | Medium | Low",
  "recommendations": ["核心建议，按优先级排列"],
  "items": [{
    "title": "变更点标题",
    "description": "详细变更说明：改了什么、为什么改；点名受影响的类/接口/方法/字段/配置项具体名称",
    "riskLevel": "High | Medium | Low",
    "affectedApis": ["受影响的公开 API 全名"],
    "compatibilityAnalysis": "对使用方的影响：何种调用场景受影响、运行时/编译期如何表现、如何排查与迁移",
    "codeExample": { "before": "旧用法", "after": "新用法" },
    "sourceSnippet": "关键 diff 片段"
  }]
}
要求：按风险从高到低排列；High/Medium 项尽量给出 before/after 代码示例；仅报告差异中真实存在的变更，严禁编造。`;
    const result = await this.callAI(prompt);
    return parseJSON(result);
  }
}

export function getAIProvider(config: AIConfig): AIProvider {
  if (config.provider === 'gemini') return new GeminiProvider(config);
  if (config.provider === 'anthropic') return new AnthropicProvider(config);
  return new OpenAICompatibleProvider(config);
}
