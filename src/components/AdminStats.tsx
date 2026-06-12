import React, { useEffect, useState } from 'react';
import axios from 'axios';
import { BarChart3, RefreshCw, Loader2, Package, Activity, ExternalLink } from 'lucide-react';

interface StatsSummary {
  totalAnalyses: number;
  distinctRepos: number;
  topRepos: { repo: string; repoUrl: string; count: number; lastAt: string }[];
  recent: { repo: string; fromVersion: string; toVersion: string; mode: string; at: string }[];
  byMode: { mode: string; count: number }[];
}

const MODE_LABELS: Record<string, string> = {
  changelog: '变更日志',
  full_diff: '完整 Diff',
  segmented_full_diff: '分片 Diff',
  multi_batch_full_diff: '分批 Diff',
  partial_full_diff: '概览',
  batch: '批量'
};

export function AdminStats() {
  const [summary, setSummary] = useState<StatsSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const { data } = await axios.get('/api/stats/summary');
      setSummary(data);
    } catch (e: any) {
      setError(e?.response?.data?.message || e.message || '加载统计失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  return (
    <div className="bg-white rounded-3xl p-8 shadow-sm border border-black/5 mb-12 space-y-8">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-bold flex items-center gap-2">
          <BarChart3 size={20} className="text-violet-500" />
          使用统计
        </h2>
        <button
          onClick={load}
          disabled={loading}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-black/5 text-black/60 rounded-lg text-xs font-bold hover:bg-black/10 transition-all disabled:opacity-40"
        >
          {loading ? <Loader2 className="animate-spin" size={12} /> : <RefreshCw size={12} />}
          刷新
        </button>
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}

      {summary && (
        <>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="bg-violet-50 border border-violet-100 rounded-2xl p-5">
              <div className="flex items-center gap-2 text-violet-600 text-xs font-bold uppercase tracking-wider mb-2">
                <Package size={14} /> 被分析的三方件
              </div>
              <div className="text-3xl font-bold text-violet-900">{summary.distinctRepos}</div>
            </div>
            <div className="bg-emerald-50 border border-emerald-100 rounded-2xl p-5">
              <div className="flex items-center gap-2 text-emerald-600 text-xs font-bold uppercase tracking-wider mb-2">
                <Activity size={14} /> 累计分析次数
              </div>
              <div className="text-3xl font-bold text-emerald-900">{summary.totalAnalyses}</div>
            </div>
            <div className="bg-blue-50 border border-blue-100 rounded-2xl p-5">
              <div className="text-blue-600 text-xs font-bold uppercase tracking-wider mb-2">按模式</div>
              <div className="flex flex-wrap gap-2">
                {summary.byMode.map(m => (
                  <span key={m.mode} className="px-2 py-0.5 bg-white rounded-lg text-[11px] font-medium text-blue-800 border border-blue-100">
                    {MODE_LABELS[m.mode] || m.mode}: {m.count}
                  </span>
                ))}
                {summary.byMode.length === 0 && <span className="text-xs text-blue-400">暂无数据</span>}
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
            <div>
              <h3 className="text-sm font-bold text-black/60 mb-3">三方件排行（按分析次数）</h3>
              <div className="border border-black/5 rounded-2xl overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="bg-black/[0.03] text-[11px] uppercase tracking-wider text-black/40">
                    <tr>
                      <th className="text-left px-4 py-2.5 font-bold">三方件</th>
                      <th className="text-right px-4 py-2.5 font-bold">次数</th>
                      <th className="text-right px-4 py-2.5 font-bold">最近分析</th>
                    </tr>
                  </thead>
                  <tbody>
                    {summary.topRepos.map(r => (
                      <tr key={r.repo} className="border-t border-black/5">
                        <td className="px-4 py-2.5">
                          {r.repoUrl ? (
                            <a href={r.repoUrl} target="_blank" rel="noreferrer" className="font-medium text-blue-600 hover:underline inline-flex items-center gap-1">
                              {r.repo} <ExternalLink size={10} />
                            </a>
                          ) : <span className="font-medium">{r.repo}</span>}
                        </td>
                        <td className="px-4 py-2.5 text-right font-bold">{r.count}</td>
                        <td className="px-4 py-2.5 text-right text-black/40 text-xs">{r.lastAt}</td>
                      </tr>
                    ))}
                    {summary.topRepos.length === 0 && (
                      <tr><td colSpan={3} className="px-4 py-6 text-center text-black/30 text-xs">还没有分析记录，完成一次分析后这里会出现统计</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            <div>
              <h3 className="text-sm font-bold text-black/60 mb-3">最近 20 条分析</h3>
              <div className="border border-black/5 rounded-2xl overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="bg-black/[0.03] text-[11px] uppercase tracking-wider text-black/40">
                    <tr>
                      <th className="text-left px-4 py-2.5 font-bold">三方件</th>
                      <th className="text-left px-4 py-2.5 font-bold">版本范围</th>
                      <th className="text-left px-4 py-2.5 font-bold">模式</th>
                      <th className="text-right px-4 py-2.5 font-bold">时间</th>
                    </tr>
                  </thead>
                  <tbody>
                    {summary.recent.map((r, i) => (
                      <tr key={i} className="border-t border-black/5">
                        <td className="px-4 py-2.5 font-medium">{r.repo}</td>
                        <td className="px-4 py-2.5 text-xs font-mono text-black/50">{r.fromVersion} → {r.toVersion}</td>
                        <td className="px-4 py-2.5 text-xs">{MODE_LABELS[r.mode] || r.mode}</td>
                        <td className="px-4 py-2.5 text-right text-black/40 text-xs">{r.at}</td>
                      </tr>
                    ))}
                    {summary.recent.length === 0 && (
                      <tr><td colSpan={4} className="px-4 py-6 text-center text-black/30 text-xs">暂无记录</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
