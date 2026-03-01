/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect } from 'react';
import { 
  Github, 
  ArrowRight, 
  Search, 
  AlertTriangle, 
  CheckCircle2, 
  Info, 
  Loader2, 
  ExternalLink,
  ChevronRight,
  History,
  Code2,
  Settings,
  Cpu
} from 'lucide-react';
import { GitHubService, GitHubRelease, GitHubPR } from './services/githubService';
import { getAIProvider } from './services/aiProvider';
import { AIConfig, ChangeLogAnalysis, DiffAnalysis } from './types';
import Markdown from 'react-markdown';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export default function App() {
  const [repoUrl, setRepoUrl] = useState('https://github.com/maxGraph/maxGraph');
  const [fromVersion, setFromVersion] = useState('0.21.0');
  const [toVersion, setToVersion] = useState('0.22.0');
  const [projectBackground, setProjectBackground] = useState('我现在的项目是coze平台再这个平台中可以搭建agent，这个项目用到了maxgraph作为三方件');
  
  // AI Config
  const [aiConfig, setAiConfig] = useState<AIConfig>({
    provider: 'gemini',
    apiKey: '',
    baseUrl: '',
    model: 'gemini-3-flash-preview'
  });
  const [showSettings, setShowSettings] = useState(false);

  const [loading, setLoading] = useState(false);
  const [step, setStep] = useState<'idle' | 'analyzing-changelog' | 'analyzing-diffs'>('idle');
  const [error, setError] = useState<string | null>(null);
  
  const [changeLogAnalysis, setChangeLogAnalysis] = useState<ChangeLogAnalysis | null>(null);
  const [diffAnalyses, setDiffAnalyses] = useState<Record<number, DiffAnalysis>>({});
  const [analyzingPrs, setAnalyzingPrs] = useState<Set<number>>(new Set());

  const handleAnalyze = async () => {
    setLoading(true);
    setError(null);
    setChangeLogAnalysis(null);
    setDiffAnalyses({});
    setStep('analyzing-changelog');

    try {
      const repoInfo = GitHubService.parseRepoUrl(repoUrl);
      if (!repoInfo) throw new Error('Invalid GitHub URL');

      // 1. Fetch Release Info
      let release: GitHubRelease;
      try {
        release = await GitHubService.getReleaseByTag(repoInfo.owner, repoInfo.repo, toVersion.startsWith('v') ? toVersion : `v${toVersion}`);
      } catch (err: any) {
        // Fallback to searching without 'v' prefix
        try {
          release = await GitHubService.getReleaseByTag(repoInfo.owner, repoInfo.repo, toVersion);
        } catch (innerErr: any) {
          const status = innerErr.response?.status;
          if (status === 404) {
            throw new Error(`Release version "${toVersion}" not found in this repository.`);
          } else if (status === 403) {
            throw new Error('GitHub API rate limit exceeded. Please try again later or configure a GitHub token.');
          } else {
            throw new Error(`Failed to fetch release info: ${innerErr.message}`);
          }
        }
      }

      // 2. Analyze Change Log with Selected AI
      const provider = getAIProvider(aiConfig);
      const analysis = await provider.analyzeChangeLog(release.body, projectBackground);
      setChangeLogAnalysis(analysis);
      
    } catch (err: any) {
      console.error(err);
      setError(err.message || '分析过程中发生错误');
    } finally {
      setLoading(false);
    }
  };

  const analyzePR = async (prNumber: number, title: string) => {
    if (analyzingPrs.has(prNumber)) return;
    
    setAnalyzingPrs(prev => new Set(prev).add(prNumber));
    try {
      const repoInfo = GitHubService.parseRepoUrl(repoUrl);
      if (!repoInfo) return;

      const pr = await GitHubService.getPullRequest(repoInfo.owner, repoInfo.repo, prNumber);
      const diff = await GitHubService.getDiff(pr.diff_url);
      
      const provider = getAIProvider(aiConfig);
      const analysis = await provider.analyzeDiff(diff, pr.title, projectBackground);
      setDiffAnalyses(prev => ({ ...prev, [prNumber]: analysis }));
    } catch (err: any) {
      console.error(err);
      // We don't block the whole UI if one PR fails
    } finally {
      setAnalyzingPrs(prev => {
        const next = new Set(prev);
        next.delete(prNumber);
        return next;
      });
    }
  };

  return (
    <div className="min-h-screen bg-[#F5F5F5] text-[#1A1A1A] font-sans selection:bg-emerald-100">
      {/* Header */}
      <header className="bg-white border-b border-black/5 sticky top-0 z-50 backdrop-blur-md bg-white/80">
        <div className="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-black rounded-xl flex items-center justify-center text-white">
              <Github size={24} />
            </div>
            <div>
              <h1 className="font-bold text-lg tracking-tight">GitDiff 变更分析器</h1>
              <p className="text-[10px] uppercase tracking-widest text-black/40 font-semibold">AI 兼容性评估引擎</p>
            </div>
          </div>
          <div className="flex items-center gap-4">
            <button 
              onClick={() => setShowSettings(!showSettings)}
              className={cn(
                "p-2 rounded-xl transition-all",
                showSettings ? "bg-black text-white" : "bg-black/5 text-black/40 hover:bg-black/10"
              )}
            >
              <Settings size={20} />
            </button>
            <div className="hidden md:flex items-center gap-2 px-3 py-1.5 bg-emerald-50 text-emerald-700 rounded-full text-xs font-medium border border-emerald-100">
              <div className="w-1.5 h-1.5 bg-emerald-500 rounded-full animate-pulse" />
              {aiConfig.provider === 'gemini' ? 'Gemini 3.1 Pro' : aiConfig.model} 已就绪
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-6 py-12">
        {/* Settings Panel */}
        {showSettings && (
          <div className="mb-12 bg-white rounded-3xl p-8 shadow-sm border border-black/5 animate-in fade-in slide-in-from-top-4">
            <div className="flex items-center gap-2 mb-6">
              <Cpu size={20} className="text-emerald-500" />
              <h2 className="text-xl font-bold">AI 模型配置</h2>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
              <div className="space-y-2">
                <label className="text-[11px] uppercase tracking-wider font-bold text-black/40">AI 提供商</label>
                <select 
                  value={aiConfig.provider}
                  onChange={(e) => setAiConfig({...aiConfig, provider: e.target.value as any})}
                  className="w-full px-4 py-3 bg-[#F9F9F9] border border-black/5 rounded-xl focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 transition-all text-sm"
                >
                  <option value="gemini">Google Gemini</option>
                  <option value="openai-compatible">OpenAI 兼容 (豆包/Qwen/DeepSeek)</option>
                </select>
              </div>
              <div className="space-y-2">
                <label className="text-[11px] uppercase tracking-wider font-bold text-black/40">API Key</label>
                <input 
                  type="password" 
                  value={aiConfig.apiKey}
                  onChange={(e) => setAiConfig({...aiConfig, apiKey: e.target.value})}
                  className="w-full px-4 py-3 bg-[#F9F9F9] border border-black/5 rounded-xl focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 transition-all text-sm"
                  placeholder={aiConfig.provider === 'gemini' ? '可选 (默认使用系统 Key)' : '请输入 API Key'}
                />
              </div>
              {aiConfig.provider === 'openai-compatible' && (
                <>
                  <div className="space-y-2">
                    <label className="text-[11px] uppercase tracking-wider font-bold text-black/40">Base URL</label>
                    <input 
                      type="text" 
                      value={aiConfig.baseUrl}
                      onChange={(e) => setAiConfig({...aiConfig, baseUrl: e.target.value})}
                      className="w-full px-4 py-3 bg-[#F9F9F9] border border-black/5 rounded-xl focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 transition-all text-sm"
                      placeholder="https://api.openai.com/v1"
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-[11px] uppercase tracking-wider font-bold text-black/40">模型名称</label>
                    <input 
                      type="text" 
                      value={aiConfig.model}
                      onChange={(e) => setAiConfig({...aiConfig, model: e.target.value})}
                      className="w-full px-4 py-3 bg-[#F9F9F9] border border-black/5 rounded-xl focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 transition-all text-sm"
                      placeholder="gpt-4o / qwen-max"
                    />
                  </div>
                </>
              )}
            </div>
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-12">
          
          {/* Left Column: Configuration */}
          <div className="lg:col-span-4 space-y-8">
            <section className="bg-white rounded-3xl p-8 shadow-sm border border-black/5">
              <h2 className="text-xl font-bold mb-6 flex items-center gap-2">
                <Search size={20} className="text-emerald-500" />
                分析配置
              </h2>
              
              <div className="space-y-6">
                <div className="space-y-2">
                  <label className="text-[11px] uppercase tracking-wider font-bold text-black/40">GitHub 仓库地址</label>
                  <div className="relative">
                    <Github className="absolute left-3 top-1/2 -translate-y-1/2 text-black/20" size={18} />
                    <input 
                      type="text" 
                      value={repoUrl}
                      onChange={(e) => setRepoUrl(e.target.value)}
                      className="w-full pl-10 pr-4 py-3 bg-[#F9F9F9] border border-black/5 rounded-xl focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 transition-all text-sm"
                      placeholder="https://github.com/owner/repo"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <label className="text-[11px] uppercase tracking-wider font-bold text-black/40">起始版本 (From)</label>
                    <input 
                      type="text" 
                      value={fromVersion}
                      onChange={(e) => setFromVersion(e.target.value)}
                      className="w-full px-4 py-3 bg-[#F9F9F9] border border-black/5 rounded-xl focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 transition-all text-sm"
                      placeholder="0.21.0"
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-[11px] uppercase tracking-wider font-bold text-black/40">目标版本 (To)</label>
                    <input 
                      type="text" 
                      value={toVersion}
                      onChange={(e) => setToVersion(e.target.value)}
                      className="w-full px-4 py-3 bg-[#F9F9F9] border border-black/5 rounded-xl focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 transition-all text-sm"
                      placeholder="0.22.0"
                    />
                  </div>
                </div>

                <div className="space-y-2">
                  <label className="text-[11px] uppercase tracking-wider font-bold text-black/40">项目背景</label>
                  <textarea 
                    value={projectBackground}
                    onChange={(e) => setProjectBackground(e.target.value)}
                    rows={4}
                    className="w-full px-4 py-3 bg-[#F9F9F9] border border-black/5 rounded-xl focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 transition-all text-sm resize-none"
                    placeholder="描述您是如何使用这个库的..."
                  />
                </div>

                <button 
                  onClick={handleAnalyze}
                  disabled={loading}
                  className="w-full bg-black text-white py-4 rounded-2xl font-bold flex items-center justify-center gap-2 hover:bg-black/90 transition-all disabled:opacity-50 disabled:cursor-not-allowed group"
                >
                  {loading ? (
                    <Loader2 className="animate-spin" size={20} />
                  ) : (
                    <>
                      开始分析
                      <ArrowRight size={20} className="group-hover:translate-x-1 transition-transform" />
                    </>
                  )}
                </button>
              </div>
            </section>

            {error && (
              <div className="bg-red-50 border border-red-100 p-4 rounded-2xl flex gap-3 text-red-700">
                <AlertTriangle className="shrink-0" size={20} />
                <p className="text-sm font-medium">{error}</p>
              </div>
            )}
          </div>

          {/* Right Column: Results */}
          <div className="lg:col-span-8 space-y-8">
            {!changeLogAnalysis && !loading && (
              <div className="h-full min-h-[400px] flex flex-col items-center justify-center text-center space-y-4 bg-white/50 border border-dashed border-black/10 rounded-3xl">
                <div className="w-16 h-16 bg-white rounded-2xl shadow-sm flex items-center justify-center text-black/20">
                  <History size={32} />
                </div>
                <div>
                  <h3 className="text-lg font-bold">暂无分析结果</h3>
                  <p className="text-sm text-black/40 max-w-xs mx-auto">配置您的项目详情并点击“开始分析”以启动 AI 驱动的风险评估。</p>
                </div>
              </div>
            )}

            {loading && step === 'analyzing-changelog' && (
              <div className="space-y-6 animate-pulse">
                <div className="h-48 bg-white rounded-3xl border border-black/5" />
                <div className="h-64 bg-white rounded-3xl border border-black/5" />
              </div>
            )}

            {changeLogAnalysis && (
              <div className="space-y-8">
                {/* Summary Section */}
                <section className="bg-white rounded-3xl p-8 shadow-sm border border-black/5">
                  <div className="flex items-center justify-between mb-6">
                    <h2 className="text-xl font-bold flex items-center gap-2">
                      <Info size={20} className="text-blue-500" />
                      版本发布摘要
                    </h2>
                    <span className="px-3 py-1 bg-blue-50 text-blue-700 rounded-full text-[10px] uppercase tracking-wider font-bold border border-blue-100">
                      {toVersion}
                    </span>
                  </div>
                  <div className="prose prose-sm max-w-none text-black/70">
                    <Markdown>{changeLogAnalysis.summary}</Markdown>
                  </div>
                </section>

                {/* All Changes Section */}
                <section className="space-y-4">
                  <div className="flex items-center justify-between px-2">
                    <h2 className="text-xl font-bold flex items-center gap-2">
                      <History size={20} className="text-amber-500" />
                      变更详情与风险评估
                    </h2>
                    <span className="text-xs font-medium text-black/40 bg-black/5 px-2 py-1 rounded-lg">
                      共 {changeLogAnalysis.items.length} 项变更
                    </span>
                  </div>
                  
                  <div className="grid gap-4">
                    {changeLogAnalysis.items.map((item, idx) => {
                      const repoInfo = GitHubService.parseRepoUrl(repoUrl);
                      const prUrl = item.prNumber && repoInfo 
                        ? `https://github.com/${repoInfo.owner}/${repoInfo.repo}/pull/${item.prNumber}`
                        : null;

                      return (
                        <div key={idx} className="bg-white rounded-2xl border border-black/5 overflow-hidden transition-all hover:shadow-md">
                          <div className="p-6">
                            <div className="flex items-start justify-between gap-4">
                              <div className="space-y-1 flex-1">
                                <div className="flex items-center gap-2 flex-wrap">
                                  <span className={cn(
                                    "px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider",
                                    item.impactLevel === 'High' ? "bg-red-50 text-red-600 border border-red-100" :
                                    item.impactLevel === 'Medium' ? "bg-amber-50 text-amber-600 border border-amber-100" :
                                    "bg-emerald-50 text-emerald-600 border border-emerald-100"
                                  )}>
                                    {item.impactLevel === 'High' ? '高' : item.impactLevel === 'Medium' ? '中' : '低'} 影响
                                  </span>
                                  {item.prNumber && (
                                    <a 
                                      href={prUrl || '#'} 
                                      target="_blank" 
                                      rel="noreferrer"
                                      className="text-xs font-mono text-blue-500 hover:underline flex items-center gap-1"
                                    >
                                      #{item.prNumber}
                                      <ExternalLink size={10} />
                                    </a>
                                  )}
                                </div>
                                <h3 className="font-bold text-lg">{item.title}</h3>
                                <p className="text-sm text-black/60 leading-relaxed">{item.reason}</p>
                              </div>
                              
                              {item.prNumber && (item.impactLevel === 'High' || item.impactLevel === 'Medium') && (
                                <button 
                                  onClick={() => analyzePR(item.prNumber!, item.title)}
                                  disabled={analyzingPrs.has(item.prNumber) || !!diffAnalyses[item.prNumber]}
                                  className={cn(
                                    "shrink-0 px-4 py-2 rounded-xl text-xs font-bold flex items-center gap-2 transition-all",
                                    diffAnalyses[item.prNumber] 
                                      ? "bg-emerald-50 text-emerald-700 border border-emerald-100" 
                                      : "bg-black text-white hover:bg-black/80 disabled:opacity-50"
                                  )}
                                >
                                  {analyzingPrs.has(item.prNumber) ? (
                                    <>
                                      <Loader2 className="animate-spin" size={14} />
                                      正在分析差异...
                                    </>
                                  ) : diffAnalyses[item.prNumber] ? (
                                    <>
                                      <CheckCircle2 size={14} />
                                      分析已就绪
                                    </>
                                  ) : (
                                    <>
                                      <Code2 size={14} />
                                      深度扫描差异
                                    </>
                                  )}
                                </button>
                              )}
                            </div>

                            {/* Diff Analysis Result */}
                            {diffAnalyses[item.prNumber!] && (
                              <div className="mt-6 pt-6 border-t border-black/5 space-y-6 animate-in fade-in slide-in-from-top-2">
                                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                                  <div className="space-y-3">
                                    <h4 className="text-[11px] uppercase tracking-wider font-bold text-black/40 flex items-center gap-1.5">
                                      <AlertTriangle size={12} />
                                      破坏性变更
                                    </h4>
                                    <ul className="space-y-2">
                                      {diffAnalyses[item.prNumber!].breakingChanges.map((change, i) => (
                                        <li key={i} className="text-sm flex gap-2 text-red-700">
                                          <div className="w-1 h-1 rounded-full bg-red-400 mt-2 shrink-0" />
                                          {change}
                                        </li>
                                      ))}
                                      {diffAnalyses[item.prNumber!].breakingChanges.length === 0 && (
                                        <li className="text-sm text-black/30 italic">未识别到破坏性变更。</li>
                                      )}
                                    </ul>
                                  </div>
                                  <div className="space-y-3">
                                    <h4 className="text-[11px] uppercase tracking-wider font-bold text-black/40 flex items-center gap-1.5">
                                      <CheckCircle2 size={12} />
                                      迁移建议
                                    </h4>
                                    <ul className="space-y-2">
                                      {diffAnalyses[item.prNumber!].recommendations.map((rec, i) => (
                                        <li key={i} className="text-sm flex gap-2 text-emerald-700">
                                          <div className="w-1 h-1 rounded-full bg-emerald-400 mt-2 shrink-0" />
                                          {rec}
                                        </li>
                                      ))}
                                    </ul>
                                  </div>
                                </div>

                                {/* Code Examples */}
                                {diffAnalyses[item.prNumber!].codeExample && (
                                  <div className="space-y-4">
                                    <h4 className="text-[11px] uppercase tracking-wider font-bold text-black/40 flex items-center gap-1.5">
                                      <Code2 size={12} />
                                      兼容性代码示例
                                    </h4>
                                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                      <div className="space-y-2">
                                        <div className="text-[10px] font-bold text-black/30 uppercase tracking-widest">修改前 (Before)</div>
                                        <pre className="p-4 bg-red-50/30 border border-red-100/50 rounded-xl text-[12px] font-mono text-red-900 overflow-x-auto">
                                          <code>{diffAnalyses[item.prNumber!].codeExample?.before}</code>
                                        </pre>
                                      </div>
                                      <div className="space-y-2">
                                        <div className="text-[10px] font-bold text-black/30 uppercase tracking-widest">修改后 (After)</div>
                                        <pre className="p-4 bg-emerald-50/30 border border-emerald-100/50 rounded-xl text-[12px] font-mono text-emerald-900 overflow-x-auto">
                                          <code>{diffAnalyses[item.prNumber!].codeExample?.after}</code>
                                        </pre>
                                      </div>
                                    </div>
                                  </div>
                                )}

                                <div className="p-4 bg-blue-50/50 rounded-xl border border-blue-100/50">
                                  <h4 className="text-[11px] uppercase tracking-wider font-bold text-blue-600/60 mb-2">兼容性说明</h4>
                                  <ul className="space-y-1">
                                    {diffAnalyses[item.prNumber!].compatibilityNotes.map((note, i) => (
                                      <li key={i} className="text-xs text-blue-800 flex gap-2">
                                        <span className="text-blue-400">•</span>
                                        {note}
                                      </li>
                                    ))}
                                  </ul>
                                </div>
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </section>
              </div>
            )}
          </div>
        </div>
      </main>

      {/* Footer */}
      <footer className="max-w-7xl mx-auto px-6 py-12 border-t border-black/5">
        <div className="flex flex-col md:flex-row items-center justify-between gap-6">
          <div className="flex items-center gap-2 text-black/40">
            <Github size={18} />
            <span className="text-sm font-medium">GitDiff 变更分析器 v1.0</span>
          </div>
          <div className="flex items-center gap-8">
            <a href="#" className="text-xs font-bold uppercase tracking-widest text-black/40 hover:text-black transition-colors">文档</a>
            <a href="#" className="text-xs font-bold uppercase tracking-widest text-black/40 hover:text-black transition-colors">API 状态</a>
            <a href="#" className="text-xs font-bold uppercase tracking-widest text-black/40 hover:text-black transition-colors">隐私政策</a>
          </div>
        </div>
      </footer>
    </div>
  );
}
