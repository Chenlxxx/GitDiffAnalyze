import express from "express";
import { createServer as createViteServer } from "vite";
import axios from "axios";
import path from "path";
import fs from "fs";

// ===== 分析统计（SQLite 持久化，data/stats.db）=====
let statsDb: any = null;
async function getStatsDb() {
  if (statsDb) return statsDb;
  const Database = (await import("better-sqlite3")).default;
  const dataDir = path.join(process.cwd(), "data");
  fs.mkdirSync(dataDir, { recursive: true });
  statsDb = new Database(path.join(dataDir, "stats.db"));
  statsDb.exec(`
    CREATE TABLE IF NOT EXISTS analysis_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      repo TEXT NOT NULL,
      repo_url TEXT,
      from_version TEXT,
      to_version TEXT,
      mode TEXT,
      created_at TEXT DEFAULT (datetime('now', 'localtime'))
    );
    CREATE INDEX IF NOT EXISTS idx_analysis_repo ON analysis_log(repo);
  `);
  return statsDb;
}

// GitHub GET 响应内存缓存：减少重复请求对速率配额的消耗
// （匿名限额 60 次/小时，一轮分析的 tag 探测 + 翻页就可能耗尽）
const githubCache = new Map<string, { status: number; data: any; ts: number }>();
const GITHUB_CACHE_TTL_MS = 10 * 60 * 1000;
const GITHUB_CACHE_MAX_ENTRIES = 300;
const GITHUB_CACHE_MAX_VALUE_SIZE = 5 * 1024 * 1024;

function githubCacheGet(key: string) {
  const hit = githubCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.ts > GITHUB_CACHE_TTL_MS) {
    githubCache.delete(key);
    return null;
  }
  return hit;
}

function githubCacheSet(key: string, status: number, data: any) {
  try {
    const size = typeof data === 'string' ? data.length : JSON.stringify(data).length;
    if (size > GITHUB_CACHE_MAX_VALUE_SIZE) return;
  } catch {
    return;
  }
  if (githubCache.size >= GITHUB_CACHE_MAX_ENTRIES) {
    const oldest = githubCache.keys().next().value;
    if (oldest !== undefined) githubCache.delete(oldest);
  }
  githubCache.set(key, { status, data, ts: Date.now() });
}

function rateLimitResetHint(headers: any): string {
  const reset = headers?.['x-ratelimit-reset'];
  if (!reset) return '';
  const minutes = Math.max(1, Math.ceil((parseInt(reset, 10) * 1000 - Date.now()) / 60000));
  return `配额将在约 ${minutes} 分钟后重置。`;
}

// AI 代理的服务端默认 key 注入：客户端未带鉴权时按目标域名兜底。
// 部署平台（如 Render）可通过 DEFAULT_AI_API_KEY 提供统一默认 Key。
function injectAIKey(url: string, headers: any) {
  // Anthropic 协议用 x-api-key 头（仅当请求本身带了该字段但为空时注入）
  if ('x-api-key' in headers && !String(headers['x-api-key'] || '').trim()) {
    const anthropicKey = process.env.ANTHROPIC_API_KEY || process.env.DEFAULT_AI_API_KEY;
    if (anthropicKey) headers['x-api-key'] = anthropicKey;
    return;
  }

  const authHeader = headers['Authorization'] || headers['authorization'];
  const isAuthEmpty = !authHeader || authHeader === 'Bearer ' || authHeader === 'Bearer';
  if (!isAuthEmpty) return;
  if (url.includes('dashscope.aliyuncs.com') && process.env.QWEN_API_KEY) {
    headers['Authorization'] = `Bearer ${process.env.QWEN_API_KEY}`;
  } else if (url.includes('api.openai.com') && process.env.OPENAI_API_KEY) {
    headers['Authorization'] = `Bearer ${process.env.OPENAI_API_KEY}`;
  } else if (process.env.DEFAULT_AI_API_KEY) {
    headers['Authorization'] = `Bearer ${process.env.DEFAULT_AI_API_KEY}`;
  } else if (process.env.OPENAI_API_KEY) {
    headers['Authorization'] = `Bearer ${process.env.OPENAI_API_KEY}`;
  } else {
    console.warn(`AI Proxy: No API key provided by client and no default key found for ${url}`);
  }
}

// 把可读流收集为字符串（带上限），用于读取上游错误响应体
function streamToString(stream: any, maxBytes = 64 * 1024): Promise<string> {
  return new Promise((resolve) => {
    let out = '';
    let len = 0;
    stream.on('data', (chunk: Buffer) => {
      if (len < maxBytes) { out += chunk.toString('utf8'); len += chunk.length; }
    });
    stream.on('end', () => resolve(out));
    stream.on('error', () => resolve(out));
  });
}

async function startServer() {
  const app = express();
  const PORT = Number(process.env.PORT) || 3000;

  app.use(express.json({ limit: '50mb' }));
  app.use(express.urlencoded({ limit: '50mb', extended: true }));

  // GitHub API Proxy
  app.get("/api/github/*", async (req, res) => {
    let url = "";
    let cacheKey = "";
    try {
      const githubPath = req.params[0] || "";
      const query = new URLSearchParams(req.query as any).toString();
      url = `https://api.github.com/${githubPath}${query ? `?${query}` : ""}`;
      
      console.log(`Proxying request to: ${url}`);
      
      const customAccept = req.headers['accept'];
      const clientAuth = req.headers['authorization'];
      const headers: any = {
        'Accept': customAccept || 'application/vnd.github.v3+json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache'
      };

      // Use token from client if provided, otherwise fallback to environment
      if (clientAuth) {
        headers['Authorization'] = clientAuth;
      } else if (process.env.GITHUB_TOKEN) {
        headers['Authorization'] = `token ${process.env.GITHUB_TOKEN}`;
      }

      // 命中缓存则不消耗 GitHub 配额（缓存按认证身份隔离）
      cacheKey = `${headers['Authorization'] || 'anon'}|${headers['Accept']}|${url}`;
      const cached = githubCacheGet(cacheKey);
      if (cached) {
        console.log(`[cache hit] ${url}`);
        return res.status(cached.status).json(cached.data);
      }

      const response = await axios.get(url, { headers });

      githubCacheSet(cacheKey, 200, response.data);
      res.json(response.data);
    } catch (error: any) {
      const status = error.response?.status;
      const errorData = error.response?.data;

      if (status === 403 && errorData?.message?.includes('rate limit exceeded')) {
        console.warn(`GitHub API Rate Limit Exceeded for ${url || req.originalUrl}`);
        const hasAuth = !!(req.headers['authorization'] || process.env.GITHUB_TOKEN);
        return res.status(403).json({
          message: `GitHub API 速率限制已达到。${rateLimitResetHint(error.response?.headers)}`,
          details: errorData,
          suggestion: hasAuth
            ? '当前 Token 的配额已用尽，请稍后再试或更换 Token。'
            : '匿名访问限额仅 60 次/小时。请点击页面右上角设置图标填入 GitHub Token（无需勾选任何权限，限额提升至 5000 次/小时），或在 .env 中配置 GITHUB_TOKEN。'
        });
      }

      if (status === 404) {
        console.warn(`GitHub Resource Not Found (404): ${url || req.originalUrl}`);
        // 404 同样消耗配额，短期缓存避免 tag 变体探测反复打到上游
        if (cacheKey) githubCacheSet(cacheKey, 404, errorData || { message: 'Not Found' });
      } else {
        console.error('GitHub Proxy Error:', JSON.stringify(errorData || error.message));
      }

      res.status(status || 500).json(errorData || { message: error.message });
    }
  });

  // GitHub POST proxy（仅用于 releases/generate-notes 等只读式 POST，自动从 PR 生成变更日志）
  app.post("/api/github/*", async (req, res) => {
    let url = "";
    try {
      const githubPath = req.params[0] || "";
      url = `https://api.github.com/${githubPath}`;
      const clientAuth = req.headers['authorization'];
      const headers: any = {
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'Mozilla/5.0 (compatible; CompatAnalyzer/1.0)',
        'Content-Type': 'application/json'
      };
      if (clientAuth) headers['Authorization'] = clientAuth;
      else if (process.env.GITHUB_TOKEN) headers['Authorization'] = `token ${process.env.GITHUB_TOKEN}`;

      const response = await axios.post(url, req.body, { headers });
      res.json(response.data);
    } catch (error: any) {
      const status = error.response?.status;
      const errorData = error.response?.data;
      if (status === 403 && errorData?.message?.includes('rate limit exceeded')) {
        return res.status(403).json({
          message: `GitHub API 速率限制已达到。${rateLimitResetHint(error.response?.headers)}`,
          details: errorData
        });
      }
      if (status !== 404 && status !== 422) {
        console.error('GitHub POST Proxy Error:', JSON.stringify(errorData || error.message));
      }
      res.status(status || 500).json(errorData || { message: error.message });
    }
  });

  // Proxy for raw diffs (different domain)
  app.get("/api/github-raw", async (req, res) => {
    try {
      const { url } = req.query;
      if (!url || typeof url !== 'string') {
        return res.status(400).json({ message: 'Missing url parameter' });
      }

      const headers: any = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache',
        'Sec-Ch-Ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
        'Sec-Ch-Ua-Mobile': '?0',
        'Sec-Ch-Ua-Platform': '"Windows"',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-User': '?1',
        'Upgrade-Insecure-Requests': '1'
      };

      // Use token from client if provided, otherwise fallback to environment
      const clientAuth = req.headers['authorization'];
      if (clientAuth && url.includes('github.com')) {
        headers['Authorization'] = clientAuth;
      } else if (process.env.GITHUB_TOKEN && url.includes('api.github.com')) {
        headers['Authorization'] = `token ${process.env.GITHUB_TOKEN}`;
      }

      const response = await axios.get(url, { headers });
      res.send(response.data);
    } catch (error: any) {
      const status = error.response?.status;
      console.error(`GitHub Raw Proxy Error (${status}):`, error.message);

      if (status === 403 || status === 429) {
        return res.status(status).json({
          message: `GitHub 拒绝了 Diff 请求 (${status})，通常是速率限制。${rateLimitResetHint(error.response?.headers)}`,
          suggestion: '请点击页面右上角设置图标填入 GitHub Token（无需勾选任何权限），或稍后再试。'
        });
      }

      res.status(status || 500).json({ message: error.message });
    }
  });

  // ===== 分析统计 =====
  app.post("/api/stats/record", async (req, res) => {
    try {
      const { repo, repoUrl, fromVersion, toVersion, mode } = req.body || {};
      if (!repo || typeof repo !== 'string') {
        return res.status(400).json({ message: 'repo is required' });
      }
      const db = await getStatsDb();
      db.prepare(
        'INSERT INTO analysis_log (repo, repo_url, from_version, to_version, mode) VALUES (?, ?, ?, ?, ?)'
      ).run(String(repo).slice(0, 200), String(repoUrl || '').slice(0, 500),
        String(fromVersion || '').slice(0, 100), String(toVersion || '').slice(0, 100),
        String(mode || '').slice(0, 50));
      res.json({ ok: true });
    } catch (error: any) {
      console.error('Stats record error:', error.message);
      res.status(500).json({ message: error.message });
    }
  });

  app.get("/api/stats/summary", async (_req, res) => {
    try {
      const db = await getStatsDb();
      const totals = db.prepare(
        'SELECT COUNT(*) AS totalAnalyses, COUNT(DISTINCT repo) AS distinctRepos FROM analysis_log'
      ).get();
      const topRepos = db.prepare(`
        SELECT repo, repo_url AS repoUrl, COUNT(*) AS count, MAX(created_at) AS lastAt
        FROM analysis_log GROUP BY repo ORDER BY count DESC, lastAt DESC LIMIT 50
      `).all();
      const recent = db.prepare(`
        SELECT repo, from_version AS fromVersion, to_version AS toVersion, mode, created_at AS at
        FROM analysis_log ORDER BY id DESC LIMIT 20
      `).all();
      const byMode = db.prepare(
        'SELECT mode, COUNT(*) AS count FROM analysis_log GROUP BY mode ORDER BY count DESC'
      ).all();
      res.json({ ...totals, topRepos, recent, byMode });
    } catch (error: any) {
      console.error('Stats summary error:', error.message);
      res.status(500).json({ message: error.message });
    }
  });

  // 服务端默认模型配置（供部署平台预置，前端启动时拉取；Key 永不下发）
  app.get("/api/default-config", (_req, res) => {
    const rawProtocol = (process.env.DEFAULT_AI_PROTOCOL || 'openai').toLowerCase();
    const protocol = ['openai', 'anthropic', 'gemini'].includes(rawProtocol) ? rawProtocol : 'openai';
    const hasKey = !!(
      process.env.DEFAULT_AI_API_KEY ||
      (protocol === 'gemini' && process.env.GEMINI_API_KEY) ||
      (protocol === 'anthropic' && process.env.ANTHROPIC_API_KEY) ||
      (protocol === 'openai' && (process.env.OPENAI_API_KEY || process.env.QWEN_API_KEY))
    );
    res.json({
      hasDefaultProvider: hasKey && !!process.env.DEFAULT_AI_MODEL,
      protocol,
      baseUrl: process.env.DEFAULT_AI_BASE_URL || '',
      model: process.env.DEFAULT_AI_MODEL || '',
      hasGithubToken: !!process.env.GITHUB_TOKEN
    });
  });

  // 模型连通性测试：按协议发一次最小请求，验证 baseUrl / apiKey / model 是否可用。
  // apiKey 为空时回退服务端默认 Key（平台默认供应商的测试场景）。
  app.post("/api/ai/test-connection", async (req, res) => {
    const { protocol, baseUrl, model } = req.body || {};
    let { apiKey } = req.body || {};
    if (!apiKey || !String(apiKey).trim()) {
      apiKey = process.env.DEFAULT_AI_API_KEY
        || (protocol === 'gemini' ? process.env.GEMINI_API_KEY
          : protocol === 'anthropic' ? process.env.ANTHROPIC_API_KEY
          : (process.env.OPENAI_API_KEY || process.env.QWEN_API_KEY))
        || '';
    }
    if (!protocol || !apiKey || !model) {
      return res.status(400).json({ ok: false, message: '缺少必要参数（protocol / apiKey / model），且服务端未配置默认 Key' });
    }
    const started = Date.now();
    try {
      if (protocol === 'openai') {
        const base = (baseUrl || 'https://api.openai.com/v1').replace(/\/$/, '');
        const url = base.endsWith('/chat/completions') ? base : `${base}/chat/completions`;
        await axios.post(url, {
          model,
          messages: [{ role: 'user', content: 'ping' }],
          max_tokens: 1
        }, {
          headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          timeout: 15000
        });
      } else if (protocol === 'anthropic') {
        const base = (baseUrl || 'https://api.anthropic.com').replace(/\/$/, '');
        const url = base.endsWith('/messages') ? base : `${base}/v1/messages`;
        await axios.post(url, {
          model,
          max_tokens: 1,
          messages: [{ role: 'user', content: 'ping' }]
        }, {
          headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
          timeout: 15000
        });
      } else if (protocol === 'gemini') {
        const base = (baseUrl || 'https://generativelanguage.googleapis.com').replace(/\/$/, '');
        const url = `${base}/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
        await axios.post(url, {
          contents: [{ parts: [{ text: 'ping' }] }],
          generationConfig: { maxOutputTokens: 1 }
        }, {
          headers: { 'Content-Type': 'application/json' },
          timeout: 15000
        });
      } else {
        return res.status(400).json({ ok: false, message: `不支持的协议: ${protocol}` });
      }

      res.json({ ok: true, latencyMs: Date.now() - started, message: '连接成功' });
    } catch (error: any) {
      const status = error.response?.status;
      const detail = error.response?.data;
      let message = error.message;
      if (error.code === 'ECONNABORTED') message = '连接超时（15 秒），请检查 Base URL 或网络';
      else if (status === 401 || status === 403) message = 'API Key 无效或无权限';
      else if (status === 404) message = '接口或模型不存在，请检查 Base URL 与模型名称';
      else if (status === 429) message = 'Key 有效，但当前触发限流/配额不足';
      else if (detail?.error?.message) message = detail.error.message;
      else if (detail?.message) message = detail.message;

      // 429 说明鉴权与路由都通了，视为连通
      const reachableButThrottled = status === 429;
      res.status(reachableButThrottled ? 200 : (status || 500)).json({
        ok: reachableButThrottled,
        latencyMs: Date.now() - started,
        message,
        httpStatus: status
      });
    }
  });

  // AI Analysis Proxy (Server-side execution for security and stability)
  app.post("/api/ai/analyze-changelog", async (req, res) => {
    try {
      const { provider, config, changeLog, projectBackground, sourceUrl, type = 'changelog' } = req.body;
      
      // Better key resolution: strictly prefer non-empty client key, then fallback to environment
      let apiKey = (config && config.apiKey && typeof config.apiKey === 'string' && config.apiKey.trim() !== '') ? config.apiKey.trim() : null;
      
      if (!apiKey) {
        if (provider === 'gemini') {
          apiKey = process.env.GEMINI_API_KEY || process.env.DEFAULT_AI_API_KEY || null;
        } else if (provider === 'anthropic') {
          apiKey = process.env.ANTHROPIC_API_KEY || process.env.DEFAULT_AI_API_KEY || null;
        } else {
          apiKey = process.env.OPEN_API_KEY || process.env.OPENAI_API_KEY || process.env.DEFAULT_AI_API_KEY || null;
        }
      }

      // Final sanitization: remove potential quotes if user pasted them
      if (apiKey) {
        apiKey = apiKey.replace(/^["']|["']$/g, '').trim();
      }

      if (!apiKey) {
        console.error(`AI Analysis Error: No API Key found for provider ${provider}.`);
        return res.status(400).json({ message: `API Key for ${provider} is missing. Please provide it in settings.` });
      }

      // Special check for Gemini: users often accidentally paste the whole JSON config
      if (provider === 'gemini' && apiKey.includes('{') && apiKey.includes('}')) {
        return res.status(401).json({ 
          message: "API Key 格式不正确。检测到您可能输入了 JSON 格式的密钥文件内容。Gemini 模式需要填入单一的 API Key 字符串（通常以 AIza 开头，由 Google AI Studio 提供）。" 
        });
      }

      // Diagnostic log (don't log the full key!)
      console.log(`AI Analysis Request: Provider=${provider}, Type=${type}, ContentLength=${changeLog?.length || 0}`);
      if (apiKey) {
        console.log(`Key Info: Length=${apiKey.length}, Preview=${apiKey.substring(0, 6)}...${apiKey.substring(apiKey.length - 4)}`);
      }
      
      // Log beginning of changelog to ensure it's not empty/wrong
      if (changeLog) {
        console.log(`Changelog Preview: ${changeLog.substring(0, 200).replace(/\n/g, ' ')}...`);
      }

      if (provider === 'gemini') {
        const { GoogleGenerativeAI } = await import("@google/generative-ai");
        const genAI = new GoogleGenerativeAI(apiKey);
        
        // Use the user-configured model, falling back to gemini-2.0-flash
        const modelName = (config && typeof config.model === 'string' && config.model.startsWith('gemini')) ? config.model : "gemini-2.0-flash";
        const model = genAI.getGenerativeModel({ 
          model: modelName, 
          generationConfig: {
            maxOutputTokens: 8192,
            temperature: 0.1,
            responseMimeType: "application/json"
          }
        });

        let prompt = "";
        if (type === 'changelog') {
          prompt = `
            你是一个极其严谨的资深软件架构师和安全专家。
            
            任务：深入分析 GitHub Release Log，识别所有对项目产生实质性影响的变更条目。
            
            项目背景：
            ${projectBackground}

            待分析内容 (Release Note): 
            ${changeLog}
            ${sourceUrl ? `提示：内容来源于 ${sourceUrl}` : ''}

            要求：
            1. 必须输出纯 JSON 格式。
            2. 识别并罗列变更日志中的每一个具体条目。不要进行宽泛的概括，要细化到具体的 PR 或 BugFix。
            3. 每一个条目必须包含：标题、PR编号（如有）、变更原因、影响程度评价（High/Medium/Low）、兼容性影响分析。
            4. 如果影响等级为“High”或“Medium”，必须提供具体的代码示例或配置调整展示。
            5. 特别针对 Netty 等项目，请关注 Protocol, SSL, Buffer, EventLoop, Transport 等核心模块。

            输出格式 (JSON):
            {
              "summary": "版本综合摘要（中文，100字左右）",
              "items": [
                {
                  "title": "变更标题",
                  "prNumber": 12345,
                  "reason": "变更的详细背景说明",
                  "impactLevel": "High | Medium | Low",
                  "compatibilityAnalysis": "对现有代码的影响及排查建议",
                  "codeExample": {
                    "before": "旧版本用法",
                    "after": "新版本用法"
                  }
                }
              ],
              "excelRows": [
                {
                  "version": "版本号",
                  "changepoint": "标题",
                  "chinese": "描述",
                  "function": "场景",
                  "suggestion": "排查点",
                  "risk": "高/中/低",
                  "test_suggestion": "测试建议",
                  "code_discovery": "涉及类/关键字",
                  "code_fix": "整改建议",
                  "related_commits": "#12345"
                }
              ]
            }

            注意：严禁遗漏任何条目。如果输入内容为空或无效，请在 summary 中说明。
          `;
        } else {
          // Generic prompt for other analysis types (diff, batch, etc.)
          prompt = changeLog;
        }

        console.log(`[Gemini] Sending request: Type=${type}, ContentLength=${changeLog?.length || 0}`);
        const result = await model.generateContent(prompt);
        const responseText = result.response.text();
        console.log(`[Gemini] Received response text length: ${responseText.length}`);
        res.json({ text: responseText });
      } else {
        res.status(501).json({ message: "Server-side analysis for this provider is not implemented yet." });
      }
    } catch (error: any) {
      console.error("Server-side Analysis Error:", error);
      
      let errorMessage = error.message || "未知错误";
      let statusCode = 500;

      if (errorMessage.includes("API key not valid") || errorMessage.includes("API_KEY_INVALID")) {
        errorMessage = "API Key 无效。对于 Gemini，请确保您使用的是有效的 Google AI Studio Key。";
        statusCode = 401;
      } else if (errorMessage.includes("quota") || errorMessage.includes("429") || errorMessage.includes("RESOURCE_EXHAUSTED")) {
        errorMessage = "API 配额已耗尽或请求过于频繁。请稍后再试。";
        statusCode = 429;
      } else if (errorMessage.includes("safety")) {
        errorMessage = "请求内容被安全过滤器拦截。请尝试调整输入内容。";
        statusCode = 400;
      }

      res.status(statusCode).json({ 
        message: errorMessage,
        rawError: error.message
      });
    }
  });

  // Proxy for external AI APIs
  app.post("/api/ai-proxy", async (req, res) => {
    try {
      const { url, data, headers } = req.body;

      injectAIKey(url, headers);

      const response = await axios.post(url, data, {
        headers,
        timeout: 300000 // 300 seconds timeout for AI generation
      });
      res.json(response.data);
    } catch (error: any) {
      const status = error.response?.status;
      const errorData = error.response?.data;
      const targetUrl = req.body.url;
      
      if (error.code === 'ECONNABORTED' || error.message?.includes('timeout')) {
        console.error(`AI Proxy Timeout for ${targetUrl}`);
        return res.status(504).json({
          message: 'AI 服务响应超时。由于分析内容较多或模型生成较慢，请求已超过 5 分钟限制。',
          details: error.message,
          url: targetUrl
        });
      }

      console.error(`AI Proxy Error (${status}) for ${targetUrl}:`, JSON.stringify(errorData || error.message));
      
      if (status === 401) {
        return res.status(401).json({
          message: '身份验证失败 (401)。请检查您的 API Key 是否正确，或者是否已在服务端配置了默认 Key。',
          details: errorData,
          url: targetUrl
        });
      }

      if (status === 404) {
        return res.status(404).json({
          message: `AI 服务接口未找到 (404)。请检查 Base URL 配置是否正确。当前请求地址: ${targetUrl}`,
          details: errorData,
          url: targetUrl
        });
      }
      
      res.status(status || 500).json(errorData || {
        message: error.message,
        url: targetUrl
      });
    }
  });

  // Streaming proxy: 把上游 AI 的 SSE 流原样透传给浏览器（OpenAI / Anthropic 协议）
  app.post("/api/ai-proxy-stream", async (req, res) => {
    const { url, data, headers } = req.body;
    try {
      injectAIKey(url, headers);

      const upstream = await axios.post(url, { ...data, stream: true }, {
        headers,
        responseType: 'stream',
        timeout: 300000
      });

      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no'); // 禁用反代缓冲，保证逐块下发

      upstream.data.pipe(res);
      upstream.data.on('error', () => res.end());
      // 客户端断开时关闭上游，避免空转
      req.on('close', () => upstream.data.destroy());
    } catch (error: any) {
      const status = error.response?.status || 500;
      let detail = error.message;
      try {
        if (error.response?.data && typeof error.response.data.on === 'function') {
          detail = await streamToString(error.response.data);
        }
      } catch {}
      console.error(`AI Stream Proxy Error (${status}) for ${url}:`, detail);
      if (!res.headersSent) {
        const msg = status === 401
          ? '身份验证失败 (401)。请检查 API Key 是否正确。'
          : status === 404
          ? `AI 服务接口未找到 (404)。请检查 Base URL 配置。当前地址: ${url}`
          : `AI 流式请求失败 (${status})。`;
        res.status(status).json({ message: msg, details: detail, url });
      } else {
        res.end();
      }
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
