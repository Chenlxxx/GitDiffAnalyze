/**
 * 把 axios / 服务端代理返回的错误统一为可读的中文消息。
 * 服务端代理的错误体形如 { message, suggestion?, details? }。
 */
export function formatErrorMessage(err: any, fallback: string): string {
  const data = err?.response?.data;
  if (data) {
    const msg = typeof data === 'string' ? data : (data.message || data.error?.message);
    if (msg) {
      const suggestion = (typeof data === 'object' && data.suggestion) ? ` ${data.suggestion}` : '';
      return `${msg}${suggestion}`;
    }
  }
  return err?.message || fallback;
}
