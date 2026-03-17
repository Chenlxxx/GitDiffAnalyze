import axios from 'axios';

export interface GitHubRelease {
  tag_name: string;
  name: string;
  body: string;
  published_at: string;
  html_url: string;
}

export interface GitHubPR {
  number: number;
  title: string;
  body: string;
  html_url: string;
  diff_url: string;
}

export class GitHubService {
  private static BASE_URL = '/api/github';

  static async getReleases(owner: string, repo: string, token?: string): Promise<GitHubRelease[]> {
    const response = await axios.get(`${this.BASE_URL}/repos/${owner}/${repo}/releases`, {
      headers: token ? { 'X-GitHub-Token': token } : {}
    });
    return response.data;
  }

  static async getReleaseByTag(owner: string, repo: string, tag: string, token?: string): Promise<GitHubRelease> {
    const response = await axios.get(`${this.BASE_URL}/repos/${owner}/${repo}/releases/tags/${tag}`, {
      headers: token ? { 'X-GitHub-Token': token } : {}
    });
    return response.data;
  }

  static async getTags(owner: string, repo: string, token?: string): Promise<{ name: string }[]> {
    const response = await axios.get(`${this.BASE_URL}/repos/${owner}/${repo}/tags`, {
      headers: token ? { 'X-GitHub-Token': token } : {}
    });
    return response.data;
  }

  static async compareCommits(owner: string, repo: string, base: string, head: string, token?: string): Promise<{ commits: any[], html_url: string }> {
    const response = await axios.get(`${this.BASE_URL}/repos/${owner}/${repo}/compare/${base}...${head}`, {
      headers: token ? { 'X-GitHub-Token': token } : {}
    });
    return response.data;
  }

  static async getCompareDiff(owner: string, repo: string, base: string, head: string, token?: string): Promise<string> {
    const response = await axios.get(`${this.BASE_URL}/repos/${owner}/${repo}/compare/${base}...${head}`, {
      headers: {
        ...(token ? { 'X-GitHub-Token': token } : {}),
        'Accept': 'application/vnd.github.v3.diff'
      }
    });
    return response.data;
  }

  static async getFileContent(owner: string, repo: string, path: string, ref: string, token?: string): Promise<string> {
    const response = await axios.get(`${this.BASE_URL}/repos/${owner}/${repo}/contents/${path}?ref=${ref}`, {
      headers: token ? { 'X-GitHub-Token': token } : {}
    });
    if (response.data.encoding === 'base64') {
      const binaryString = atob(response.data.content.replace(/\n/g, ''));
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }
      return new TextDecoder().decode(bytes);
    }
    return response.data;
  }

  static async getPullRequest(owner: string, repo: string, prNumber: number, token?: string): Promise<GitHubPR> {
    const response = await axios.get(`${this.BASE_URL}/repos/${owner}/${repo}/pulls/${prNumber}`, {
      headers: token ? { 'X-GitHub-Token': token } : {}
    });
    return {
      number: response.data.number,
      title: response.data.title,
      body: response.data.body,
      html_url: response.data.html_url,
      diff_url: response.data.diff_url,
    };
  }

  static async getDiff(diffUrl: string): Promise<string> {
    const response = await axios.get(`/api/github-raw?url=${encodeURIComponent(diffUrl)}`);
    return response.data;
  }

  static parseRepoUrl(url: string): { owner: string; repo: string } | null {
    const match = url.match(/github\.com\/([^/]+)\/([^/]+)/);
    if (match) {
      return { owner: match[1], repo: match[2].replace(/\.git$/, '') };
    }
    return null;
  }
}
