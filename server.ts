import express from "express";
import { createServer as createViteServer } from "vite";
import axios from "axios";
import path from "path";

async function startServer() {
  const app = express();
  const PORT = Number(process.env.PORT) || 3000;

  app.use(express.json());

  // GitHub API Proxy
  app.get("/api/github/*", async (req, res) => {
    try {
      const githubPath = req.params[0];
      const query = new URLSearchParams(req.query as any).toString();
      const url = `https://api.github.com/${githubPath}${query ? `?${query}` : ""}`;
      
      console.log(`Proxying request to: ${url}`);
      
      const githubToken = req.headers['x-github-token'];
      const headers: any = {
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'GitDiff-Analyzer-App'
      };
      
      if (githubToken) {
        headers['Authorization'] = `token ${githubToken}`;
      }
      
      const response = await axios.get(url, { headers });
      
      res.json(response.data);
    } catch (error: any) {
      const errorData = error.response?.data;
      console.error('GitHub Proxy Error:', JSON.stringify(errorData || error.message));
      res.status(error.response?.status || 500).json(errorData || { message: error.message });
    }
  });

  // Proxy for raw diffs (different domain)
  app.get("/api/github-raw", async (req, res) => {
    try {
      const { url } = req.query;
      if (!url || typeof url !== 'string') {
        return res.status(400).json({ message: 'Missing url parameter' });
      }

      const response = await axios.get(url, {
        headers: {
          'User-Agent': 'GitDiff-Analyzer-App'
        }
      });
      res.send(response.data);
    } catch (error: any) {
      res.status(error.response?.status || 500).send(error.message);
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
        } else if (url.includes('api.openai.com') && process.env.OPENAI_API_KEY) {
          headers['Authorization'] = `Bearer ${process.env.OPENAI_API_KEY}`;
        } else if (process.env.OPENAI_API_KEY) {
          // Fallback to OPENAI_API_KEY for other compatible providers if configured
          headers['Authorization'] = `Bearer ${process.env.OPENAI_API_KEY}`;
        }
      }

      const response = await axios.post(url, data, { headers });
      res.json(response.data);
    } catch (error: any) {
      console.error('AI Proxy Error:', error.response?.data || error.message);
      res.status(error.response?.status || 500).json(error.response?.data || { message: error.message });
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
