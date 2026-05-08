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

  static async getReleaseByTag(owner: string, repo: string, tag: string): Promise<GitHubRelease | null> {
    const attempts = [
      tag,                                   // 原始输入的 tag
      tag.startsWith('v') ? tag : `v${tag}`,   // 常见的 v1.0.0 格式
      tag.replace(/^v/, ''),                 // 去掉 v 的纯版本号
      `${repo}-${tag}`,                      // Netty 风格: netty-4.1.133.Final
    ];
    
    // 如果 tag 包含了完整的 netty-4.1.133.Final，我们也尝试提取中间的版本号
    if (tag.includes('-')) {
      const parts = tag.split('-');
      const lastPart = parts[parts.length - 1];
      if (!attempts.includes(lastPart)) attempts.push(lastPart);
    }

    // 唯一化并过滤
    const uniqueTags = [...new Set(attempts)].filter(Boolean);

    for (const t of uniqueTags) {
      try {
        const response = await axios.get(`${this.BASE_URL}/repos/${owner}/${repo}/releases/tags/${t}`);
        if (response.data && response.data.body) {
          return response.data;
        }
      } catch (e: any) {
        if (e.response?.status === 404) continue;
        console.warn(`Failed to fetch release for tag ${t}:`, e.message);
      }
    }

    // 最后的挣扎：列出最近的 releases 并尝试模糊匹配
    try {
      const releases = await this.getReleases(owner, repo);
      const match = releases.find(r => 
        r.tag_name.includes(tag) || tag.includes(r.tag_name)
      );
      if (match) return match;
    } catch (e) {}

    return null;
  }

  static async getTags(owner: string, repo: string, pages: number = 10): Promise<{ name: string }[]> {
    let allTags: { name: string }[] = [];
    for (let i = 1; i <= pages; i++) {
        try {
            const response = await axios.get(`${this.BASE_URL}/repos/${owner}/${repo}/tags?per_page=100&page=${i}`);
            if (response.data && response.data.length > 0) {
                allTags = [...allTags, ...response.data];
            } else {
                break;
            }
        } catch (e) {
            break;
        }
    }
    return allTags;
  }

  static async compareCommits(owner: string, repo: string, base: string, head: string): Promise<{ commits: any[], files: any[], html_url: string }> {
    const response = await axios.get(`${this.BASE_URL}/repos/${owner}/${repo}/compare/${base}...${head}`);
    return response.data;
  }

  static async getCompareDiff(owner: string, repo: string, base: string, head: string): Promise<{ diff: string, error?: any }> {
    // Use GitHub API with diff media type
    try {
      const response = await axios.get(`${this.BASE_URL}/repos/${owner}/${repo}/compare/${base}...${head}`, {
        headers: {
          'Accept': 'application/vnd.github.v3.diff'
        }
      });
      return { diff: response.data };
    } catch (e: any) {
      console.error('Failed to fetch diff from GitHub API:', e.message);
      return { diff: '', error: e };
    }
  }

  static async getFileDiff(owner: string, repo: string, base: string, head: string, path: string): Promise<string> {
    try {
      const response = await axios.get(`${this.BASE_URL}/repos/${owner}/${repo}/compare/${base}...${head}`, {
        headers: {
          'Accept': 'application/vnd.github.v3.diff'
        },
        params: {
          path: path
        }
      });
      return response.data;
    } catch (e: any) {
      console.error(`Failed to fetch diff for file ${path}:`, e.message);
      return '';
    }
  }

  static async getFileContent(owner: string, repo: string, path: string, ref: string): Promise<string> {
    const response = await axios.get(`${this.BASE_URL}/repos/${owner}/${repo}/contents/${path}?ref=${ref}`);
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

  static async getCommitDiff(owner: string, repo: string, sha: string): Promise<string> {
    try {
      const response = await axios.get(`${this.BASE_URL}/repos/${owner}/${repo}/commits/${sha}`, {
        headers: {
          'Accept': 'application/vnd.github.v3.diff'
        }
      });
      return response.data;
    } catch (e: any) {
      console.error(`Failed to fetch diff for commit ${sha}:`, e.message);
      return '';
    }
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
    if (!url) return null;
    
    // Handle standard URLs: https://github.com/owner/repo
    // Handle tree/blob URLs: https://github.com/owner/repo/tree/tag
    const match = url.match(/github\.com\/([^/]+)\/([^/]+)/);
    if (match) {
      const owner = match[1];
      let repo = match[2].replace(/\.git$/, '');
      
      // If the repo part contains more slashes (e.g. repo/tree/tag), 
      // we only want the first part as the repo name
      if (repo.includes('/')) {
        repo = repo.split('/')[0];
      }
      
      return { owner, repo };
    }
    return null;
  }

  /**
   * Extracts a tag/version from a GitHub URL if possible.
   * e.g. https://github.com/owner/repo/tree/rel/v5.4.4 -> rel/v5.4.4
   */
  static parseTagFromUrl(url: string): string {
    if (!url) return '';
    if (!url.includes('github.com')) return url; // Not a URL, return as is

    const treeMatch = url.match(/\/tree\/([^?#]+)/);
    if (treeMatch) return treeMatch[1];

    const blobMatch = url.match(/\/blob\/([^?#]+)/);
    if (blobMatch) return blobMatch[1];

    const releaseMatch = url.match(/\/releases\/tag\/([^?#]+)/);
    if (releaseMatch) return releaseMatch[1];

    return url;
  }
}
