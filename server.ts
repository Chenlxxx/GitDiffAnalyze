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
      
      if (error.code === 'ECONNABORTED' || error.message?.includes('timeout')) {
        console.error(`AI Proxy Timeout for ${req.body.url}`);
        return res.status(504).json({
          message: 'AI 服务响应超时。由于分析内容较多或模型生成较慢，请求已超过 5 分钟限制。',
          details: error.message
        });
      }

      console.error(`AI Proxy Error (${status}):`, JSON.stringify(errorData || error.message));
      
      if (status === 401) {
        return res.status(401).json({
          message: '身份验证失败 (401)。请检查您的 API Key 是否正确，或者是否已在服务端配置了默认 Key。',
          details: errorData
        });
      }
      
      res.status(status || 500).json(errorData || { message: error.message });
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
