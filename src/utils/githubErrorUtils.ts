
export enum GitHubErrorType {
  RATE_LIMIT = 'rate_limit',
  SECONDARY_RATE_LIMIT = 'secondary_rate_limit',
  DIFF_TOO_LARGE = 'diff_too_large',
  TIMEOUT = 'timeout',
  PERMISSION_ERROR = 'permission_error',
  UNKNOWN_403 = 'unknown_403',
  UNKNOWN = 'unknown'
}

export interface GitHubError {
  status: number;
  message: string;
  type: GitHubErrorType;
  retryAfter?: number;
  rateLimitReset?: number;
  rateLimitRemaining?: number;
}

export function parseGitHubError(error: any): GitHubError {
  const status = error.response?.status;
  const data = error.response?.data;
  const message = data?.message || error.message || 'Unknown error';
  
  let type = GitHubErrorType.UNKNOWN;
  
  if (status === 403) {
    if (message.includes('rate limit exceeded')) {
      type = GitHubErrorType.RATE_LIMIT;
    } else if (message.includes('secondary rate limit')) {
      type = GitHubErrorType.SECONDARY_RATE_LIMIT;
    } else {
      type = GitHubErrorType.UNKNOWN_403;
    }
  } else if (status === 422) {
    if (message.includes('too large')) {
      type = GitHubErrorType.DIFF_TOO_LARGE;
    }
  } else if (status === 401) {
    type = GitHubErrorType.PERMISSION_ERROR;
  } else if (error.code === 'ECONNABORTED' || message.includes('timeout')) {
    type = GitHubErrorType.TIMEOUT;
  }

  const headers = error.response?.headers || {};
  
  return {
    status: status || 500,
    message,
    type,
    retryAfter: headers['retry-after'] ? parseInt(headers['retry-after']) : undefined,
    rateLimitReset: headers['x-ratelimit-reset'] ? parseInt(headers['x-ratelimit-reset']) : undefined,
    rateLimitRemaining: headers['x-ratelimit-remaining'] ? parseInt(headers['x-ratelimit-remaining']) : undefined,
  };
}
