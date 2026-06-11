import { BatchAnalysisResult, FullDiffAnalysis } from '../types';

/**
 * AI 聚合失败时的本地兜底合并：按标题去重、保留更高风险/更详尽的条目、
 * 派生整体风险。保住已完成批次的全部成果，避免整体降级为概览分析。
 */
export function mergeBatchResultsLocally(
  batchResults: BatchAnalysisResult[],
  fromVersion: string,
  toVersion: string
): FullDiffAnalysis {
  const severityRank = (lv?: string) => lv === 'High' ? 2 : lv === 'Medium' ? 1 : 0;
  const items: FullDiffAnalysis['items'] = [];
  const indexByTitle = new Map<string, number>();

  for (const batch of batchResults) {
    for (const item of (batch.items || [])) {
      if (!item || !item.title) continue;
      const key = String(item.title).trim().toLowerCase();
      const existingIdx = indexByTitle.get(key);
      if (existingIdx === undefined) {
        indexByTitle.set(key, items.length);
        items.push({ ...item });
      } else {
        const existing = items[existingIdx];
        const moreSevere = severityRank(item.riskLevel) > severityRank(existing.riskLevel);
        const moreDetailed = severityRank(item.riskLevel) === severityRank(existing.riskLevel)
          && (item.description || '').length > (existing.description || '').length;
        if (moreSevere || moreDetailed) {
          items[existingIdx] = { ...existing, ...item };
        }
      }
    }
  }
  items.sort((a, b) => severityRank(b.riskLevel) - severityRank(a.riskLevel));

  const recommendations = [...new Set(batchResults.flatMap(b => b.recommendations || []))].slice(0, 12);
  const high = items.filter(i => i.riskLevel === 'High').length;
  const medium = items.filter(i => i.riskLevel === 'Medium').length;
  const overallRisk: FullDiffAnalysis['overallRisk'] = high > 0 ? 'High' : medium > 0 ? 'Medium' : 'Low';

  return {
    summary: `${fromVersion} -> ${toVersion} 共识别 ${items.length} 个变更点：高风险 ${high} 个、中风险 ${medium} 个、低风险 ${items.length - high - medium} 个。本结果由各批次分析直接合并生成（AI 聚合阶段失败的本地兜底），未经模型二次去重润色，可能存在少量重复条目。`,
    items,
    overallRisk,
    recommendations,
    excelRows: []
  };
}

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
