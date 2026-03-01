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

  static async getReleases(owner: string, repo: string): Promise<GitHubRelease[]> {
    const response = await axios.get(`${this.BASE_URL}/repos/${owner}/${repo}/releases`);
    return response.data;
  }

  static async getReleaseByTag(owner: string, repo: string, tag: string): Promise<GitHubRelease> {
    const response = await axios.get(`${this.BASE_URL}/repos/${owner}/${repo}/releases/tags/${tag}`);
    return response.data;
  }

  static async getPullRequest(owner: string, repo: string, prNumber: number): Promise<GitHubPR> {
    const response = await axios.get(`${this.BASE_URL}/repos/${owner}/${repo}/pulls/${prNumber}`);
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
