export enum GitHubErrorType {
  RATE_LIMIT = 'RATE_LIMIT',
  SECONDARY_RATE_LIMIT = 'SECONDARY_RATE_LIMIT',
  DIFF_TOO_LARGE = 'DIFF_TOO_LARGE',
  PERMISSION_ERROR = 'PERMISSION_ERROR',
  NOT_FOUND = 'NOT_FOUND',
  SERVER_ERROR = 'SERVER_ERROR',
  UNKNOWN = 'UNKNOWN'
}

export interface GitHubError {
  status: number;
  message: string;
  type: GitHubErrorType;
  retryAfter?: number;
  rateLimitReset?: number;
  rateLimitRemaining?: number;
}

/**
 * Parses a GitHub API error into a structured object.
 */
export function parseGitHubError(error: any): GitHubError {
  const status = error.response?.status || 0;
  const message = error.response?.data?.message || error.message || 'Unknown GitHub Error';
  const headers = error.response?.headers || {};

  let type = GitHubErrorType.UNKNOWN;

  if (status === 403) {
    if (message.includes('rate limit')) {
      type = GitHubErrorType.RATE_LIMIT;
    } else if (message.includes('secondary rate limit')) {
      type = GitHubErrorType.SECONDARY_RATE_LIMIT;
    } else if (message.includes('too large')) {
      type = GitHubErrorType.DIFF_TOO_LARGE;
    } else {
      type = GitHubErrorType.PERMISSION_ERROR;
    }
  } else if (status === 404) {
    type = GitHubErrorType.NOT_FOUND;
  } else if (status >= 500) {
    type = GitHubErrorType.SERVER_ERROR;
  }

  return {
    status,
    message,
    type,
    retryAfter: headers['retry-after'] ? parseInt(headers['retry-after'], 10) : undefined,
    rateLimitReset: headers['x-ratelimit-reset'] ? parseInt(headers['x-ratelimit-reset'], 10) : undefined,
    rateLimitRemaining: headers['x-ratelimit-remaining'] ? parseInt(headers['x-ratelimit-remaining'], 10) : undefined
  };
}
