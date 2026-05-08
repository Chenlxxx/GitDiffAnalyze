import express from "express";
import { createServer as createViteServer } from "vite";
import axios from "axios";
import path from "path";

async function startServer() {
  const app = express();
  const PORT = Number(process.env.PORT) || 3000;

  app.use(express.json({ limit: '50mb' }));
  app.use(express.urlencoded({ limit: '50mb', extended: true }));

  // GitHub API Proxy
  app.get("/api/github/*", async (req, res) => {
    let url = "";
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
      
      const response = await axios.get(url, { headers });
      
      res.json(response.data);
    } catch (error: any) {
      const status = error.response?.status;
      const errorData = error.response?.data;
      
      if (status === 403 && errorData?.message?.includes('rate limit exceeded')) {
        console.warn(`GitHub API Rate Limit Exceeded for ${url || req.originalUrl}`);
        return res.status(403).json({
          message: 'GitHub API 速率限制已达到。',
          details: errorData,
          suggestion: 'GitHub 限制了未授权的 API 请求。请稍后再试，或在平台环境变量中配置 GITHUB_TOKEN。'
        });
      }

      if (status === 404) {
        console.warn(`GitHub Resource Not Found (404): ${url || req.originalUrl}`);
      } else {
        console.error('GitHub Proxy Error:', JSON.stringify(errorData || error.message));
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

      // Use token from environment if available
      if (process.env.GITHUB_TOKEN && url.includes('api.github.com')) {
        headers['Authorization'] = `token ${process.env.GITHUB_TOKEN}`;
      }

      const response = await axios.get(url, { headers });
      res.send(response.data);
    } catch (error: any) {
      const status = error.response?.status;
      console.error(`GitHub Raw Proxy Error (${status}):`, error.message);
      res.status(status || 500).send(error.message);
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
          apiKey = process.env.GEMINI_API_KEY || null;
        } else if (provider === 'anthropic') {
          apiKey = process.env.ANTHROPIC_API_KEY || null;
        } else {
          apiKey = process.env.OPEN_API_KEY || process.env.OPENAI_API_KEY || null;
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
        
        // Use gemini-2.0-flash for best performance/speed balance
        const modelName = "gemini-2.0-flash"; 
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
      
      // Inject default API keys if missing or empty
      const authHeader = headers['Authorization'] || headers['authorization'];
      const isAuthEmpty = !authHeader || authHeader === 'Bearer ' || authHeader === 'Bearer';
      
      if (isAuthEmpty) {
        if (url.includes('dashscope.aliyuncs.com') && process.env.QWEN_API_KEY) {
          headers['Authorization'] = `Bearer ${process.env.QWEN_API_KEY}`;
          console.log('Injected QWEN_API_KEY from environment');
        } else if (url.includes('api.openai.com') && process.env.OPENAI_API_KEY) {
          headers['Authorization'] = `Bearer ${process.env.OPENAI_API_KEY}`;
          console.log('Injected OPENAI_API_KEY from environment');
        } else if (process.env.OPENAI_API_KEY) {
          headers['Authorization'] = `Bearer ${process.env.OPENAI_API_KEY}`;
          console.log('Injected fallback OPENAI_API_KEY from environment');
        } else {
          console.warn(`AI Proxy: No API key provided by client and no default key found in environment for ${url}`);
        }
      }

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
