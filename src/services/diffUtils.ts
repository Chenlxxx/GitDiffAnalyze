/** 受限并发执行任务列表，保持结果与输入同序 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));
  const workers = Array.from({ length: workerCount }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) break;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * 将统一 diff 文本按文件切分为 filename -> patch 映射。
 * GitHub compare API 不支持按 path 过滤，单独请求某个文件的 diff
 * 实际会返回完整 diff；正确做法是整体拉取一次后在本地切分。
 */
export function splitUnifiedDiffByFile(diffText: string): Map<string, string> {
  const map = new Map<string, string>();
  if (!diffText || typeof diffText !== 'string') return map;
  const parts = diffText.split(/^diff --git /m);
  for (const part of parts) {
    if (!part.trim()) continue;
    const newlineIdx = part.indexOf('\n');
    const headerLine = newlineIdx === -1 ? part : part.slice(0, newlineIdx);
    // header 形如: a/path b/path（路径含空格时带引号）
    const quoted = headerLine.match(/"b\/(.+)"\s*$/);
    const plain = headerLine.match(/\sb\/(.+)$/);
    const filename = quoted ? quoted[1] : (plain ? plain[1] : '');
    if (!filename) continue;
    map.set(filename, 'diff --git ' + part.trimEnd());
  }
  return map;
}
