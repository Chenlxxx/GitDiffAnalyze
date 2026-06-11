/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useMemo } from 'react';
import { 
  Github, 
  ArrowRight, 
  Search, 
  AlertTriangle, 
  CheckCircle2, 
  Info, 
  Loader2, 
  ExternalLink,
  GitCommit,
  ChevronRight,
  History,
  Code2,
  Settings,
  Cpu,
  Download,
  FileUp,
  FileArchive,
  FileSpreadsheet,
  Trash2
} from 'lucide-react';
import * as ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { GitHubService, GitHubRelease, GitHubPR } from './services/githubService';
import { getAIProvider, setStreamListener } from './services/aiProvider';
import { AIConfig, ChangeLogAnalysis, DiffAnalysis, FullDiffAnalysis, BatchAnalysisItem, BatchAnalysisResult, SkillBundle, AppSettings, ModelProtocol, ModelProviderConfig, toLegacyAIConfig } from './types';
import { ModelSettings } from './components/ModelSettings';
import { mapWithConcurrency, splitUnifiedDiffByFile, mergeBatchResultsLocally } from './services/diffUtils';
import { determineDiffStrategy, BATCH_ANALYSIS_FILE_BATCH_SIZE, DiffAnalysisMode, MAX_BATCHES_PER_ANALYSIS, AI_BATCH_CONCURRENCY } from './services/diffStrategy';
import { sortFilesByPriority, MAX_PRIORITY_FILES_FOR_SEGMENTED_DIFF } from './services/filePriority';
import { groupFiles, getRiskHint, getReviewHint } from './services/fileGrouping';
import { parseGitHubError } from './services/githubErrorUtils';
import { formatErrorMessage } from './services/errorUtils';
import { buildAnalysisBundleFromChangeLog, buildAnalysisBundleFromFullDiff } from './services/skillBundleGenerator';
import { FileEvidence } from './types';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { 
  SKILL_MD, 
  OPENAI_YAML, 
  EXAMPLE_REPORT_MD, 
  USAGE_MD, 
  EXPORT_DOCX_PY 
} from './constants/skillStaticFiles';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export default function App() {
  // 分析输入持久化：刷新页面后保留上次的仓库与版本
  const INPUT_STORAGE_KEY = 'diffanalyze-last-input';
  const lastInput = useMemo(() => {
    try {
      return JSON.parse(localStorage.getItem(INPUT_STORAGE_KEY) || '{}');
    } catch {
      return {};
    }
  }, []);
  const [repoUrl, setRepoUrl] = useState(lastInput.repoUrl || 'https://github.com/apache/httpcomponents-client');
  const [fromVersion, setFromVersion] = useState(lastInput.fromVersion || 'v5.4.4');
  const [toVersion, setToVersion] = useState(lastInput.toVersion || 'v5.5');
  const [projectBackground, setProjectBackground] = useState(lastInput.projectBackground || '平台背景：MateInfo Integration Platform 是华为内部面向多租户的统一集成中间件，负责 REST/SOAP/FTP 等协议适配、流量治理、凭证管理、审计日志、监控告警、热部署等。平台模块包括 Shared Utilities、FTP Integration、iFlow Engine、Integration Core、REST API、REST Invoke、Security Services、SOAP Services、SOAP Invoke、Integration Auxiliary。');

  useEffect(() => {
    try {
      localStorage.setItem(INPUT_STORAGE_KEY, JSON.stringify({ repoUrl, fromVersion, toVersion, projectBackground }));
    } catch {}
  }, [repoUrl, fromVersion, toVersion, projectBackground]);
  
  // 模型供应商配置（v2：多供应商 + GitHub Token，持久化在 localStorage）
  const SETTINGS_STORAGE_KEY = 'diffanalyze-settings';
  const loadSettings = (): AppSettings => {
    const empty: AppSettings = { version: 2, providers: [], activeProviderId: null, githubToken: '' };
    try {
      const raw = JSON.parse(localStorage.getItem(SETTINGS_STORAGE_KEY) || '{}');
      if (raw.version === 2 && Array.isArray(raw.providers)) {
        return { ...empty, ...raw };
      }
      // v1 -> v2 迁移：旧版单一 aiConfig 转为一个供应商条目
      if (raw.aiConfig && raw.aiConfig.apiKey) {
        const legacy = raw.aiConfig;
        const protocol: ModelProtocol = legacy.provider === 'openai-compatible' ? 'openai' : legacy.provider;
        const migrated: ModelProviderConfig = {
          id: 'migrated-v1',
          presetId: protocol === 'gemini' ? 'gemini' : (protocol === 'anthropic' ? 'custom-anthropic' : 'custom-openai'),
          displayName: '旧版配置（自动迁移）',
          protocol,
          baseUrl: legacy.baseUrl || '',
          apiKey: legacy.apiKey || '',
          model: legacy.model || '',
          useProxy: legacy.useProxy !== false,
          enabled: true
        };
        return { version: 2, providers: [migrated], activeProviderId: migrated.id, githubToken: raw.githubToken || '' };
      }
      return { ...empty, githubToken: raw.githubToken || '' };
    } catch {
      return empty;
    }
  };
  const initialSettings = useMemo(loadSettings, []);
  const [providers, setProviders] = useState<ModelProviderConfig[]>(initialSettings.providers);
  const [activeProviderId, setActiveProviderId] = useState<string | null>(initialSettings.activeProviderId);
  const [githubToken, setGithubToken] = useState<string>(initialSettings.githubToken);
  const [streamingEnabled, setStreamingEnabled] = useState<boolean>(initialSettings.streamingEnabled !== false);
  const [showSettings, setShowSettings] = useState(false);

  useEffect(() => {
    GitHubService.setToken(githubToken);
    try {
      localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ version: 2, providers, activeProviderId, githubToken, streamingEnabled }));
    } catch {}
  }, [providers, activeProviderId, githubToken, streamingEnabled]);

  // AI 流式输出实时预览（仅单路调用阶段：changelog / 单次 full_diff / 聚合）
  const [streamPreview, setStreamPreview] = useState('');
  /** 在 fn 执行期间挂载流监听器，把模型实时输出喂给预览区；结束后必定清理 */
  const runWithStream = async <T,>(fn: () => Promise<T>, stage?: { id: string; label: string }): Promise<T> => {
    if (!streamingEnabled) return fn();
    setStreamPreview('');
    let lastPaint = 0;
    setStreamListener(({ full }) => {
      const now = Date.now();
      // 节流：快速 token 流下最多约每 80ms 刷新一次，避免高频重渲染卡顿
      if (now - lastPaint < 80) return;
      lastPaint = now;
      setStreamPreview(full.length > 1500 ? '…' + full.slice(-1500) : full);
      // 同步把生成字数打到对应阶段的日志行，流式是否在工作一目了然
      if (stage) logStep(stage.id, `${stage.label}（已生成 ${full.length} 字）`, 'running');
    });
    try {
      return await fn();
    } finally {
      setStreamListener(null);
    }
  };

  const activeProvider = providers.find(p => p.id === activeProviderId) || null;
  /** 所有分析入口统一取当前激活的供应商；未配置时抛出可操作的错误提示 */
  const requireAIConfig = (): AIConfig => {
    if (!activeProvider) throw new Error('尚未配置 AI 模型。请点击右上角设置图标，添加模型供应商并填写 API Key。');
    if (!activeProvider.apiKey) throw new Error(`模型「${activeProvider.displayName}」未填写 API Key，请在设置中补全。`);
    return toLegacyAIConfig(activeProvider);
  };

  const [loading, setLoading] = useState(false);
  const [excelLoading, setExcelLoading] = useState(false);
  const [skillLoading, setSkillLoading] = useState(false);
  const [analysisMode, setAnalysisMode] = useState<'changelog' | 'full-diff' | 'batch'>('changelog');
  const [step, setStep] = useState<'idle' | 'analyzing-changelog' | 'analyzing-diffs' | 'analyzing-full-diff' | 'batch-processing'>('idle');
  const [error, setError] = useState<string | null>(null);
  
  const [changeLogAnalysis, setChangeLogAnalysis] = useState<ChangeLogAnalysis | null>(null);
  const [preparedSkillBundle, setPreparedSkillBundle] = useState<SkillBundle | null>(null);
  const [fullDiffAnalysis, setFullDiffAnalysis] = useState<FullDiffAnalysis | null>(null);
  const [resolvedTags, setResolvedTags] = useState<{ from: string; to: string }>({ from: '', to: '' });
  const [diffAnalyses, setDiffAnalyses] = useState<Record<number, DiffAnalysis>>({});
  const [analyzingPrs, setAnalyzingPrs] = useState<Set<number>>(new Set());
  const [batchProgress, setBatchProgress] = useState<{ total: number; completed: number } | null>(null);
  // 处理过程可视化：每个阶段一行，按 id 原位更新避免刷屏
  const [progressLog, setProgressLog] = useState<{ id: string; text: string; status: 'running' | 'done' | 'error' }[]>([]);
  const logStep = (id: string, text: string, status: 'running' | 'done' | 'error') => {
    setProgressLog(prev => {
      const idx = prev.findIndex(e => e.id === id);
      if (idx === -1) return [...prev, { id, text, status }];
      const copy = [...prev];
      copy[idx] = { id, text, status };
      return copy;
    });
  };

  // Batch Analysis State
  const [batchItems, setBatchItems] = useState<BatchAnalysisItem[]>([]);
  const [batchProcessing, setBatchProcessing] = useState(false);

  const resolveActualTags = async (repoInfo: { owner: string; repo: string }, fromV: string, toV: string) => {
    const cleanTo = GitHubService.parseTagFromUrl(toV);
    const cleanFrom = GitHubService.parseTagFromUrl(fromV);
    const tags = await GitHubService.getTags(repoInfo.owner, repoInfo.repo);

    const findMatch = (version: string) => {
      const v = version.trim().toLowerCase();
      // If the version already looks like a full tag name in our list, use it directly
      const directMatch = tags.find(t => t.name.toLowerCase() === v);
      if (directMatch) return directMatch;

      return tags.find(t => {
        const tn = t.name.toLowerCase();
        return tn === v || 
               tn === `v${v}` || 
               tn === `rel/v${v}` || 
               tn === `rel/${v}` ||
               tn === `${repoInfo.repo.toLowerCase()}-${v}` ||
               (tn.startsWith(`${repoInfo.repo.toLowerCase()}-`) && tn.endsWith(`-${v}`)) ||
               tn.endsWith(`/${v}`) ||
               tn.endsWith(`/v${v}`) ||
               tn.endsWith(`-${v}`) ||
               tn.endsWith(`-v${v}`) ||
               v.endsWith(`/${tn}`) ||
               v.endsWith(`/v${tn}`);
      });
    };

    const toMatch = findMatch(cleanTo);
    const fromMatch = findMatch(cleanFrom);

    let actualToTag = toMatch?.name || cleanTo;
    let actualFromTag = fromMatch?.name || cleanFrom;
    const availableTags = tags.map(t => t.name);

    // SPECIAL CASE: If start and end versions are the same, 
    // auto-detect the previous tag to provide a meaningful delta
    if (actualToTag === actualFromTag) {
      console.log(`Same version detected (${actualToTag}). Attempting to find previous tag...`);
      const targetTag = toMatch || findMatch(actualToTag);
      if (targetTag) {
        const toIndex = tags.findIndex(t => t.name === targetTag.name);
        if (toIndex !== -1 && toIndex < tags.length - 1) {
          const previousTag = tags[toIndex + 1].name;
          console.log(`Auto-falling back to previous tag: ${previousTag}`);
          actualFromTag = previousTag;
        }
      }
    }

    return { actualFromTag, actualToTag, fromMatched: !!fromMatch, toMatched: !!toMatch, availableTags };
  };

  /** 版本 Tag 未找到时的可操作报错：指明缺哪个版本，并列出仓库真实存在的部分 Tag */
  const buildTagNotFoundError = (
    availableTags: string[], fromMatched: boolean, toMatched: boolean,
    aFrom: string, aTo: string, inputFrom: string, inputTo: string
  ) => {
    const missing = [
      !fromMatched ? `起始版本「${inputFrom}」` : null,
      !toMatched ? `目标版本「${inputTo}」` : null
    ].filter(Boolean).join(' 和 ') || `版本 ${aFrom} 或 ${aTo}`;
    const sample = availableTags.slice(0, 15).join('、');
    return new Error(
      `在仓库中找不到${missing}对应的 Tag（当前解析为 ${aFrom} → ${aTo}）。\n` +
      (availableTags.length
        ? `该仓库存在的部分 Tag：${sample}${availableTags.length > 15 ? ' …' : ''}\n请从中挑选正确的版本号后重试。`
        : `未能获取该仓库的 Tag 列表，请确认仓库地址正确，或在设置中配置 GitHub Token 后重试。`)
    );
  };

  const handleAnalyze = async () => {
    if (analysisMode === 'full-diff') {
      return handleFullDiffAnalyze();
    }

    setLoading(true);
    setError(null);
    setChangeLogAnalysis(null);
    setPreparedSkillBundle(null);
    setFullDiffAnalysis(null);
    setDiffAnalyses({});
    setProgressLog([]);
    setStreamPreview('');
    setStep('analyzing-changelog');
    logStep('release', '获取 Release Notes / Changelog…', 'running');

    try {
      const repoInfo = GitHubService.parseRepoUrl(repoUrl);
      if (!repoInfo) throw new Error('Invalid GitHub URL');

      const { actualFromTag, actualToTag, fromMatched, toMatched, availableTags } = await resolveActualTags(repoInfo, fromVersion, toVersion);

      if (actualToTag === actualFromTag) {
        throw new Error(`起始版本与终止版本相同 (${actualToTag})，且无法自动识别上一个正式版本。请手动输入不同的起始版本（例如前一个版本号）。`);
      }

      setResolvedTags({ from: actualFromTag, to: actualToTag });

      // Helper to extract relevant section from a cumulative changelog
      const extractVersionSection = (content: string, toV: string, fromV: string) => {
        // Strip common prefixes to get the raw version number
        const getPureVersion = (v: string) => {
          return v.replace(/^(?:netty|rel|v|release|version)[-/]/i, '')
                  .replace(/^(?:netty|rel|v|release|version)\s*/i, '')
                  .replace(/^v/, '');
        };

        const cleanTo = getPureVersion(toV);
        const cleanFrom = getPureVersion(fromV);
        
        const getVersionPos = (ver: string) => {
          const escapedVer = ver.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const patterns = [
            new RegExp(`(?:Release|Version|##|#|Tag|Netty)\\s*v?${escapedVer}`, 'i'),
            new RegExp(`^v?${escapedVer}\\s*$`, 'im'),
            new RegExp(`^v?${escapedVer}\\s+[-=]+$`, 'im'),
            new RegExp(`\\[${escapedVer}\\]`, 'i'),
            new RegExp(`(?:^|[^0-9.])${escapedVer}(?:[^0-9.]|$)`, 'im'),
          ];
          
          for (const p of patterns) {
            const match = content.match(p);
            if (match) return match.index;
          }
          return -1;
        };

        const toPos = getVersionPos(cleanTo);
        if (toPos === -1) return content;

        // Try to find where the next version (or the fromVersion) starts
        let endPos = -1;
        const fromPos = getVersionPos(cleanFrom);
        
        if (fromPos !== -1 && fromPos > toPos) {
          endPos = fromPos;
        } else {
          // If fromVersion not found, look for ANY other version header after toPos
          const nextVersionMatch = content.substring(toPos + 10).match(/(?:Release|Version|##|#)\s*v?\d+\.\d+/i);
          if (nextVersionMatch && nextVersionMatch.index) {
            endPos = toPos + 10 + nextVersionMatch.index;
          }
        }

        if (endPos !== -1) {
          return content.substring(toPos, endPos);
        }
        
        return content.substring(toPos, toPos + 15000); // Default chunk
      };

      // 1. Fetch Release Info or Fallback to Files/Commits
      let releaseBody = '';
      let releaseUrl = '';
      
      try {
        // Try GitHub Release first
        const release = await GitHubService.getReleaseByTag(repoInfo.owner, repoInfo.repo, actualToTag);
        if (release && release.body && release.body.trim().length > 300) {
          releaseBody = release.body;
          releaseUrl = release.html_url;
        } else {
          // If release body is very short or missing, it might just be a placeholder.
          // We save what we have as a fallback but continue to look for better content.
          if (release) {
            releaseBody = release.body;
            releaseUrl = release.html_url;
          }
          throw new Error('Release body too short or release not found, trying files');
        }
      } catch (err: any) {
        // Fallback 1: Try to find a changelog file in the repo (e.g., RELEASE_NOTES.txt)
        try {
          const files = ['RELEASE_NOTES.txt', 'CHANGELOG.md', 'CHANGES.txt', 'RELEASENOTES.md', 'CHANGELOG.txt', 'notes/RELEASE_NOTES.txt'];
          let fileContent = '';
          let foundFile = '';
          for (const file of files) {
            try {
              fileContent = await GitHubService.getFileContent(repoInfo.owner, repoInfo.repo, file, actualToTag);
              if (fileContent && fileContent.length > 500) {
                foundFile = file;
                console.log(`Found substantial changelog in file: ${file}`);
                break;
              }
            } catch (e) {}
          }
          
          if (fileContent && fileContent.length > (releaseBody?.length || 0)) {
            const section = extractVersionSection(fileContent, toVersion, fromVersion);
            if (section && section.length > 100) {
              releaseBody = section;
              releaseUrl = `https://github.com/${repoInfo.owner}/${repoInfo.repo}/blob/${actualToTag}/${foundFile}`;
            }
          }
          
          if (!releaseBody || releaseBody.length < 100) {
            throw new Error('No substantial changelog file found');
          }
        } catch (fileErr) {
          // Fallback 2: Try to compare tags if release and files are not found or too small
          if (!releaseBody || releaseBody.length < 200) {
            try {
              console.log("No good changelog found in releases or files, trying synthetic changelog from commits...");
              const comparison = await GitHubService.compareCommits(repoInfo.owner, repoInfo.repo, actualFromTag, actualToTag);
              releaseUrl = comparison.html_url;
              // Create a synthetic changelog from commit messages
              const syntheticLog = "## Synthetic Changelog (Generated from Commits)\n\n" + 
                comparison.commits.map((c: any) => `- ${c.commit.message.split('\n')[0]} (${c.sha.substring(0, 7)})`).join('\n');
              
              if (syntheticLog.length > (releaseBody?.length || 0)) {
                releaseBody = syntheticLog;
              }
            } catch (compareErr: any) {
            if (availableTags.length) console.log("Available tags in this repository:", availableTags);

            const status = err.response?.status || compareErr.response?.status;
            const errorData = compareErr.response?.data || err.response?.data;
            
            if (status === 403 && (errorData?.message?.includes('rate limit') || errorData?.message?.includes('速率限制'))) {
              const suggestion = errorData.suggestion || '请点击右上角设置图标，配置 GitHub Token（无需勾选任何权限）以将限额从 60 次/小时提升至 5000 次/小时。';
              throw new Error(`GitHub API 速率限制已达到。${suggestion}`);
            } else if (status === 404) {
              throw buildTagNotFoundError(availableTags, fromMatched, toMatched, actualFromTag, actualToTag, fromVersion, toVersion);
            } else {
              const errorMsg = errorData?.message || err.message || "未知错误";
              throw new Error(`获取发布信息失败: ${errorMsg}`);
            }
          }
        }
      }
    }

      // 2. Analyze Change Log with Selected AI
      const provider = getAIProvider(requireAIConfig());
      
      if (!releaseBody || releaseBody.trim().length === 0) {
        throw new Error(`未能找到从 ${actualFromTag} 到 ${actualToTag} 的 Release Note 内容。该项目可能没有在 GitHub Releases 中维护详细日志。建议尝试使用【全量比较 (Diff) 模式】进行分析，它会直接分析代码提交差异。`);
      }

      // Safety truncation to prevent payload issues (manifesting as 400/401/413)
      const MAX_CHANGELOG_LENGTH = 25000;
      if (releaseBody.length > MAX_CHANGELOG_LENGTH) {
        console.warn(`Changelog content too long (${releaseBody.length}), truncating.`);
        releaseBody = releaseBody.substring(0, MAX_CHANGELOG_LENGTH) + "\n\n... (为了保证分析效率，内容已部分截断，请结合原始 Release Note 查看)";
      }

      logStep('release', `变更日志已获取（${Math.max(1, Math.round(releaseBody.length / 1024))} KB）`, 'done');
      logStep('ai', 'AI 分析变更日志中…', 'running');
      const analysis = await runWithStream(
        () => provider.analyzeChangeLog(releaseBody, projectBackground, releaseUrl),
        { id: 'ai', label: 'AI 分析变更日志中' }
      );
      logStep('ai', 'AI 分析完成', 'done');
      console.log('AI Analysis complete. Raw items count:', analysis.items?.length || 0);
      
      // Store resolved tags in analysis for completeness
      analysis.resolvedTags = { from: actualFromTag, to: actualToTag };
      analysis.sourceUrl = releaseUrl;
      
      // Ensure items is an array
      if (!analysis.items) analysis.items = [];
      
      // If AI provided excelRows but no items, generate items from excelRows
      if (analysis.items.length === 0 && analysis.excelRows && analysis.excelRows.length > 0) {
        console.warn('AI provided excelRows but no items, generating items from excelRows.');
        analysis.items = analysis.excelRows.map(row => ({
          title: row.changepoint || row.chinese || '未知变更',
          reason: row.chinese || row.function || '',
          impactLevel: row.risk === '高' ? 'High' : row.risk === '中' ? 'Medium' : 'Low',
          compatibilityAnalysis: row.suggestion || row.function || '',
          prNumber: row.related_commits ? parseInt(row.related_commits.replace('#', '')) || undefined : undefined
        }));
      }
      
      // Sort items by risk level: High > Medium > Low
      const riskOrder: Record<string, number> = { 'High': 0, 'Medium': 1, 'Low': 2 };
      analysis.items.sort((a, b) => {
        const orderA = riskOrder[a.impactLevel] ?? 99;
        const orderB = riskOrder[b.impactLevel] ?? 99;
        return orderA - orderB;
      });
      
      // Sync excelRows from items to ensure consistency
      if (!analysis.excelRows || analysis.excelRows.length === 0) {
        console.log('Generating excelRows from items.');
        analysis.excelRows = analysis.items.map(item => ({
          version: toVersion,
          changepoint: item.title,
          chinese: item.reason,
          function: item.compatibilityAnalysis || item.reason,
          suggestion: item.reason,
          risk: item.impactLevel === 'High' ? '高' : item.impactLevel === 'Medium' ? '中' : '低',
          test_suggestion: item.reason,
          code_discovery: '根据变更日志分析',
          code_fix: item.codeExample?.after || '请参考变更日志',
          related_commits: item.prNumber ? `#${item.prNumber}` : ''
        }));
      }

      setChangeLogAnalysis(analysis);

      // 预先准备好 Skill Bundle，避免下载时再次调用 AI
      try {
        const bundle = buildAnalysisBundleFromChangeLog(
          analysis,
          repoUrl,
          fromVersion,
          toVersion,
          projectBackground
        );
        setPreparedSkillBundle(bundle);
      } catch (bundleErr) {
        console.error('Failed to prepare skill bundle:', bundleErr);
      }
      
    } catch (err: any) {
      console.error(err);
      setError(formatErrorMessage(err, '分析过程中发生错误'));
    } finally {
      setLoading(false);
    }
  };

  const performFullDiffAnalysis = async (
    targetRepoUrl: string, 
    targetFromVersion: string, 
    targetToVersion: string,
    background: string
  ): Promise<FullDiffAnalysis> => {
    const repoInfo = GitHubService.parseRepoUrl(targetRepoUrl);
    if (!repoInfo) throw new Error('Invalid GitHub URL');

    setProgressLog([]);
    setStreamPreview('');
    logStep('tags', `解析版本 tag（${targetFromVersion} → ${targetToVersion}）…`, 'running');
    const { actualFromTag, actualToTag, fromMatched, toMatched, availableTags } = await resolveActualTags(repoInfo, targetFromVersion, targetToVersion);
    logStep('tags', `版本解析完成：${actualFromTag} → ${actualToTag}`, 'done');

    if (actualToTag === actualFromTag) {
      throw new Error(`起始版本与终止版本相同 (${actualToTag})，且无法自动识别上一个正式版本。请手动输入不同的起始版本（例如前一个版本号）。`);
    }

    // 1. Fetch commit data first to determine strategy
    // Only compareCommits failure is allowed to throw
    logStep('overview', '获取变更概览（commits / 文件列表）…', 'running');
    let commitData: { commits: any[]; files: any[]; html_url: string };
    try {
      commitData = await GitHubService.compareCommits(repoInfo.owner, repoInfo.repo, actualFromTag, actualToTag);
    } catch (cmpErr: any) {
      if (cmpErr.response?.status === 404) {
        logStep('overview', '变更概览获取失败：版本 Tag 未找到', 'error');
        throw buildTagNotFoundError(availableTags, fromMatched, toMatched, actualFromTag, actualToTag, targetFromVersion, targetToVersion);
      }
      throw cmpErr;
    }
    const strategy = determineDiffStrategy(commitData.commits.length, commitData.files.length);
    const strategyLabel = strategy.mode === 'full_diff' ? '完整 diff 分析'
      : strategy.mode === 'multi_batch_full_diff' ? '分组分批分析'
      : '概览分析';
    logStep('overview', `变更概览：${commitData.commits.length} 个 commit / ${commitData.files.length} 个文件 · 策略：${strategyLabel}`, 'done');

    let diff = '';
    let metadata: { mode: DiffAnalysisMode, fallbackReason?: string, confidenceNote?: string } = {
      mode: strategy.mode,
      confidenceNote: strategy.confidenceNote
    };

    // 2. Fetch diff based on strategy
    try {
      if (strategy.mode === 'full_diff') {
        logStep('diff', '拉取完整 diff…', 'running');
        const diffResult = await GitHubService.getCompareDiff(repoInfo.owner, repoInfo.repo, actualFromTag, actualToTag);
        if (diffResult.error) {
          const parsedError = parseGitHubError(diffResult.error);
          console.warn('Full diff failed, falling back to multi-batch analysis:', parsedError.message);
          logStep('diff', `完整 diff 获取失败，降级为分批分析：${parsedError.message}`, 'error');
          strategy.mode = 'multi_batch_full_diff';
          metadata.mode = 'multi_batch_full_diff';
          metadata.fallbackReason = `获取完整差异失败: ${parsedError.message}`;
          metadata.confidenceNote = '由于无法获取完整差异，已降级为分组分批分析。';
        } else {
          diff = diffResult.diff;
          logStep('diff', `完整 diff 已获取（${Math.max(1, Math.round((diff?.length || 0) / 1024))} KB）`, 'done');
        }
      }

      const provider = getAIProvider(requireAIConfig());

      if (strategy.mode === 'multi_batch_full_diff') {
        // 3. Multi-batch analysis logic
        const groups = groupFiles(commitData.files);

        // Fetch release notes early for context
        let releaseNotes = '';
        try {
          const releaseData = await GitHubService.getReleaseByTag(repoInfo.owner, repoInfo.repo, actualToTag);
          releaseNotes = releaseData?.body || '';
        } catch (e) {
          console.warn('Failed to fetch release notes:', e);
        }
        logStep('notes', releaseNotes ? 'Release Notes 已获取' : '未找到 Release Notes（不影响分析）', 'done');

        // 一次性获取完整 compare diff 并按文件本地切分。
        // GitHub compare API 不支持按 path 过滤，旧实现对每个缺 patch 的
        // 文件单独请求时实际都在重复下载完整 diff，是耗时大头之一。
        let patchMap = new Map<string, string>();
        if (diff) {
          patchMap = splitUnifiedDiffByFile(diff);
        } else {
          try {
            logStep('patchmap', '拉取完整 diff 并按文件切分…', 'running');
            const wholeDiff = await GitHubService.getCompareDiff(repoInfo.owner, repoInfo.repo, actualFromTag, actualToTag);
            if (!wholeDiff.error && wholeDiff.diff) {
              patchMap = splitUnifiedDiffByFile(wholeDiff.diff);
            }
          } catch (e) {
            console.warn('Failed to fetch whole diff for patch map, relying on inline patches:', e);
          }
          logStep('patchmap', patchMap.size > 0
            ? `diff 切分完成：${patchMap.size} 个文件补丁`
            : '完整 diff 不可用，仅使用 API 内联补丁', patchMap.size > 0 ? 'done' : 'error');
        }

        // 先展开全部批次任务，再受限并行执行（旧实现为完全串行，
        // 几十个批次 × 每次 30-90 秒即 20 分钟耗时的主因）
        interface BatchJob { groupName: string; files: any[]; indexInGroup: number; batchesInGroup: number; }
        const jobs: BatchJob[] = [];
        for (const group of groups) {
          const sortedFiles = sortFilesByPriority(group.files);
          for (let i = 0; i < sortedFiles.length; i += BATCH_ANALYSIS_FILE_BATCH_SIZE) {
            jobs.push({
              groupName: group.name,
              files: sortedFiles.slice(i, i + BATCH_ANALYSIS_FILE_BATCH_SIZE),
              indexInGroup: Math.floor(i / BATCH_ANALYSIS_FILE_BATCH_SIZE),
              batchesInGroup: Math.ceil(sortedFiles.length / BATCH_ANALYSIS_FILE_BATCH_SIZE)
            });
          }
        }
        if (jobs.length > MAX_BATCHES_PER_ANALYSIS) {
          console.warn(`Batch count ${jobs.length} exceeds MAX_BATCHES_PER_ANALYSIS (${MAX_BATCHES_PER_ANALYSIS}), truncating.`);
          jobs.length = MAX_BATCHES_PER_ANALYSIS;
        }

        setBatchProgress({ total: jobs.length, completed: 0 });
        logStep('batch', `批次分析：0/${jobs.length}（并行 ${AI_BATCH_CONCURRENCY} 路）`, 'running');
        const failedBatches: string[] = [];
        let completedBatchCount = 0;

        const batchResults: BatchAnalysisResult[] = await mapWithConcurrency(jobs, AI_BATCH_CONCURRENCY, async (job) => {
          const batchEvidence: FileEvidence[] = job.files.map((file) => {
            const patch = file.patch || patchMap.get(file.filename);
            return {
              filename: file.filename,
              group: job.groupName,
              status: file.status,
              additions: file.additions,
              deletions: file.deletions,
              patch: patch || undefined,
              patchAvailable: !!patch,
              diffFetchFailed: !patch,
              riskHint: getRiskHint(job.groupName),
              reviewHint: getReviewHint(job.groupName)
            };
          });

          // Format evidence as a structured string for the AI
          const evidenceString = batchEvidence.map(ev => {
            let str = `[File Evidence]\n`;
            str += `Path: ${ev.filename}\n`;
            str += `Group: ${ev.group}\n`;
            str += `Status: ${ev.status}\n`;
            str += `Changes: +${ev.additions}/-${ev.deletions}\n`;
            str += `Risk Hint: ${ev.riskHint}\n`;
            str += `Review Hint: ${ev.reviewHint}\n`;
            str += `Patch Available: ${ev.patchAvailable ? 'YES' : 'NO'}\n`;
            if (ev.diffFetchFailed) {
              str += `!!! DIFF_FETCH_FAILED: YES (Please analyze based on metadata and commit context)\n`;
            }
            if (ev.patchAvailable && ev.patch) {
              str += `Patch Content:\n${ev.patch}\n`;
            }
            return str;
          }).join('\n---\n\n');

          const run = () => provider.analyzeBatchDiff(
            evidenceString,
            background,
            targetFromVersion,
            targetToVersion,
            job.groupName,
            job.indexInGroup,
            job.batchesInGroup,
            releaseNotes,
            commitData.commits
          );

          let result: BatchAnalysisResult;
          try {
            result = await run();
          } catch (firstErr) {
            console.warn(`Batch ${job.groupName}#${job.indexInGroup + 1} failed, retrying once:`, firstErr);
            try {
              result = await run();
            } catch (secondErr: any) {
              failedBatches.push(`${job.groupName} 第 ${job.indexInGroup + 1} 批`);
              result = {
                items: [],
                summary: `批次分析失败（${job.groupName} 第 ${job.indexInGroup + 1} 批）：${secondErr?.message || secondErr}`,
                recommendations: []
              };
            }
          }
          setBatchProgress(prev => prev ? { ...prev, completed: prev.completed + 1 } : prev);
          completedBatchCount++;
          logStep('batch', `批次分析：${completedBatchCount}/${jobs.length}（并行 ${AI_BATCH_CONCURRENCY} 路）`, 'running');
          return result;
        });

        logStep('batch', `批次分析完成：${jobs.length} 批${failedBatches.length > 0 ? `，其中 ${failedBatches.length} 批失败` : ''}`, failedBatches.length > 0 ? 'error' : 'done');

        if (failedBatches.length > 0) {
          metadata.confidenceNote = `${metadata.confidenceNote || strategy.confidenceNote} 注意：${failedBatches.length} 个批次重试后仍失败（${failedBatches.join('、')}），对应文件未纳入分析。`;
        }

        // 4. Aggregate results（AI 聚合失败时本地合并兜底，绝不丢弃批次成果）
        logStep('aggregate', 'AI 聚合汇总中…', 'running');
        let finalAnalysis: FullDiffAnalysis;
        try {
          finalAnalysis = await runWithStream(() => provider.aggregateBatchResults(
            batchResults,
            background,
            targetFromVersion,
            targetToVersion,
            releaseNotes
          ), { id: 'aggregate', label: 'AI 聚合汇总中' });
          logStep('aggregate', 'AI 聚合完成', 'done');
        } catch (aggErr: any) {
          console.error('AI aggregation failed, falling back to local merge:', aggErr);
          finalAnalysis = mergeBatchResultsLocally(batchResults, targetFromVersion, targetToVersion);
          metadata.confidenceNote = `${metadata.confidenceNote || strategy.confidenceNote} 注意：AI 聚合阶段失败（${aggErr?.message || aggErr}），结果由各批次直接合并生成。`;
          logStep('aggregate', 'AI 聚合失败，已用本地合并兜底（批次成果未丢失）', 'error');
        }

        // Ensure all required fields are present
        if (!Array.isArray(finalAnalysis.items)) finalAnalysis.items = [];
        if (!Array.isArray(finalAnalysis.recommendations)) finalAnalysis.recommendations = [];
        finalAnalysis.analysisMode = 'multi_batch_full_diff';
        finalAnalysis.confidenceNote = metadata.confidenceNote || strategy.confidenceNote;
        finalAnalysis.fallbackReason = metadata.fallbackReason;
        finalAnalysis.resolvedTags = { from: actualFromTag, to: actualToTag };
        finalAnalysis.repoUrl = targetRepoUrl;
        finalAnalysis.fromVersion = targetFromVersion;
        finalAnalysis.toVersion = targetToVersion;

        // Fallback for excelRows if AI failed to provide it
        if ((!finalAnalysis.excelRows || finalAnalysis.excelRows.length === 0) && finalAnalysis.items.length > 0) {
          console.warn('AI failed to provide excelRows, generating from items fallback.');
          finalAnalysis.excelRows = finalAnalysis.items.map(item => ({
            version: targetToVersion,
            changepoint: item.title,
            chinese: item.description,
            function: item.compatibilityAnalysis || item.description,
            suggestion: item.description,
            risk: item.riskLevel === 'High' ? '高' : item.riskLevel === 'Medium' ? '中' : '低',
            test_suggestion: item.description,
            code_discovery: item.sourceSnippet || '请参考代码变更',
            code_fix: item.codeExample?.after || '请参考代码变更',
            related_commits: ''
          }));
        }

        return finalAnalysis;
      } else if (strategy.mode === 'segmented_full_diff') {
        const priorityFiles = sortFilesByPriority(commitData.files).slice(0, MAX_PRIORITY_FILES_FOR_SEGMENTED_DIFF);
        // 一次性拉取完整 diff 后本地切分（compare API 不支持按 path 过滤）
        let segPatchMap = new Map<string, string>();
        try {
          const segDiff = await GitHubService.getCompareDiff(repoInfo.owner, repoInfo.repo, actualFromTag, actualToTag);
          if (!segDiff.error && segDiff.diff) segPatchMap = splitUnifiedDiffByFile(segDiff.diff);
        } catch (e) {
          console.warn('Failed to fetch diff for segmented analysis:', e);
        }
        diff = priorityFiles.map(file => {
          const patch = file.patch || segPatchMap.get(file.filename);
          return `File: ${file.filename}\n${patch || '(Failed to fetch diff)'}`;
        }).join('\n\n');
      } else if (strategy.mode === 'partial_full_diff') {
        // partial_full_diff - use available patches
        const priorityFiles = sortFilesByPriority(commitData.files).slice(0, 5);
        const patches = priorityFiles
          .filter(f => f.patch)
          .map(f => `File: ${f.filename}\n${f.patch}`)
          .join('\n\n');
        
        diff = patches || '由于版本差异过大，未提取具体代码差异。请参考 Commit 记录和发布日志进行分析。';
      }

      // 5. Fetch release notes for non-batch modes
      let releaseNotes = '';
      try {
        const releaseData = await GitHubService.getReleaseByTag(repoInfo.owner, repoInfo.repo, actualToTag);
        releaseNotes = releaseData?.body || '';
      } catch (e) {
        console.warn('Failed to fetch release notes:', e);
      }
      logStep('notes', releaseNotes ? 'Release Notes 已获取' : '未找到 Release Notes（不影响分析）', 'done');

      logStep('ai', 'AI 深度分析中…', 'running');
      const analysis = await runWithStream(() => provider.analyzeFullDiff(
        diff,
        background,
        targetFromVersion,
        targetToVersion,
        releaseNotes,
        commitData.commits,
        commitData.files,
        metadata
      ), { id: 'ai', label: 'AI 深度分析中' });
      logStep('ai', 'AI 深度分析完成', 'done');

      // Ensure items is an array before sorting
      if (!Array.isArray(analysis.items)) analysis.items = [];
      if (!Array.isArray(analysis.recommendations)) analysis.recommendations = [];
      
      const riskOrder: Record<string, number> = { 'High': 0, 'Medium': 1, 'Low': 2 };
      analysis.items.sort((a, b) => {
        const orderA = riskOrder[a.riskLevel] ?? 99;
        const orderB = riskOrder[b.riskLevel] ?? 99;
        return orderA - orderB;
      });
      
      // Ensure all required fields are present in the final result
      analysis.analysisMode = metadata.mode;
      analysis.confidenceNote = metadata.confidenceNote;
      analysis.fallbackReason = metadata.fallbackReason;
      analysis.resolvedTags = { from: actualFromTag, to: actualToTag };
      analysis.repoUrl = targetRepoUrl;
      analysis.fromVersion = targetFromVersion;
      analysis.toVersion = targetToVersion;
      
      // Fallback for excelRows if AI failed to provide it
      if ((!analysis.excelRows || analysis.excelRows.length === 0) && analysis.items.length > 0) {
        console.warn('AI failed to provide excelRows, generating from items fallback.');
        analysis.excelRows = analysis.items.map(item => ({
          version: targetToVersion,
          changepoint: item.title,
          chinese: item.description,
          function: item.compatibilityAnalysis || item.description,
          suggestion: item.description,
          risk: item.riskLevel === 'High' ? '高' : item.riskLevel === 'Medium' ? '中' : '低',
          test_suggestion: item.description,
          code_discovery: item.sourceSnippet || '请参考代码变更',
          code_fix: item.codeExample?.after || '请参考代码变更',
          related_commits: ''
        }));
      }

      return analysis;
    } catch (err) {
      console.error('Error during diff extraction, falling back to partial analysis:', err);
      metadata.mode = 'partial_full_diff';
      metadata.fallbackReason = `差异提取过程中发生异常: ${err instanceof Error ? err.message : String(err)}`;
      metadata.confidenceNote = '由于差异提取失败，已降级为基于元数据的概览分析。';
      
      // Try to get some patches even in error case
      const priorityFiles = sortFilesByPriority(commitData.files).slice(0, 5);
      const patches = priorityFiles
        .filter(f => f.patch)
        .map(f => `File: ${f.filename}\n${f.patch}`)
        .join('\n\n');
      diff = patches || '由于差异提取失败，已降级为基于元数据的概览分析。';

      const provider = getAIProvider(requireAIConfig());
      const analysis = await runWithStream(() => provider.analyzeFullDiff(
        diff,
        background,
        targetFromVersion,
        targetToVersion,
        '',
        commitData.commits,
        commitData.files,
        metadata
      ), { id: 'ai', label: 'AI 概览分析中' });
      logStep('ai', 'AI 概览分析完成（降级模式）', 'done');

      analysis.analysisMode = metadata.mode;
      analysis.confidenceNote = metadata.confidenceNote;
      analysis.fallbackReason = metadata.fallbackReason;
      analysis.resolvedTags = { from: actualFromTag, to: actualToTag };
      analysis.repoUrl = targetRepoUrl;
      analysis.fromVersion = targetFromVersion;
      analysis.toVersion = targetToVersion;
      
      // Fallback for excelRows if AI failed to provide it
      if ((!analysis.excelRows || analysis.excelRows.length === 0) && analysis.items.length > 0) {
        console.warn('AI failed to provide excelRows, generating from items fallback.');
        analysis.excelRows = analysis.items.map(item => ({
          version: targetToVersion,
          changepoint: item.title,
          chinese: item.description,
          function: item.compatibilityAnalysis || item.description,
          suggestion: item.description,
          risk: item.riskLevel === 'High' ? '高' : item.riskLevel === 'Medium' ? '中' : '低',
          test_suggestion: item.description,
          code_discovery: item.sourceSnippet || '请参考代码变更',
          code_fix: item.codeExample?.after || '请参考代码变更',
          related_commits: ''
        }));
      }

      return analysis;
    }
  };

  const handleFullDiffAnalyze = async () => {
    setLoading(true);
    setError(null);
    setChangeLogAnalysis(null);
    setFullDiffAnalysis(null);
    setPreparedSkillBundle(null);
    setDiffAnalyses({});
    setBatchProgress(null);
    setStep('analyzing-full-diff');

    try {
      const analysis = await performFullDiffAnalysis(repoUrl, fromVersion, toVersion, projectBackground);

      if (analysis.resolvedTags) {
        setResolvedTags(analysis.resolvedTags);
      }

      setFullDiffAnalysis(analysis);

      // 预先准备好 Skill Bundle，避免下载时再次调用 AI
      try {
        const bundle = buildAnalysisBundleFromFullDiff(
          analysis,
          repoUrl,
          fromVersion,
          toVersion,
          projectBackground
        );
        setPreparedSkillBundle(bundle);
      } catch (bundleErr) {
        console.error('Failed to prepare skill bundle:', bundleErr);
      }
    } catch (err: any) {
      console.error(err);
      setError(formatErrorMessage(err, '深度分析过程中发生错误'));
    } finally {
      setLoading(false);
    }
  };

  const handleDownloadChangeLogExcel = async () => {
    if (!changeLogAnalysis) return;
    setLoading(true);
    try {
      const buffer = await generateExcelBuffer(changeLogAnalysis as any, repoUrl, fromVersion, toVersion);
      const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const repoInfo = GitHubService.parseRepoUrl(repoUrl);
      const repoName = repoInfo ? repoInfo.repo : 'repo';
      a.download = `${repoName}_${fromVersion}_to_${toVersion}_changelog_analysis.xlsx`;
      a.click();
      window.URL.revokeObjectURL(url);
    } catch (err: any) {
      console.error(err);
      setError(err.message || '生成 Excel 失败');
    } finally {
      setLoading(false);
    }
  };

  const handleDownloadSkill = async () => {
    if (!preparedSkillBundle) {
      setError('Skill Bundle 尚未准备好，请先完成分析。');
      return;
    }
    setSkillLoading(true);
    try {
      const bundle = preparedSkillBundle;
      const zip = new JSZip();
      
      // Static files
      zip.file('SKILL.md', SKILL_MD);
      zip.file('agents/openai.yaml', OPENAI_YAML);
      zip.file('references/example-report.md', EXAMPLE_REPORT_MD);
      zip.file('references/usage.md', USAGE_MD);
      zip.file('scripts/export_docx.py', EXPORT_DOCX_PY);

      // Dynamic bundle files
      zip.file('analysis-bundle/manifest.json', JSON.stringify(bundle.manifest, null, 2));
      zip.file('analysis-bundle/file-risk.json', JSON.stringify(bundle.fileRisk, null, 2));
      zip.file('analysis-bundle/diff-evidence.jsonl', bundle.diffEvidence);
      zip.file('analysis-bundle/unresolved-questions.json', JSON.stringify(bundle.unresolvedQuestions, null, 2));
      zip.file('analysis-bundle/platform-summary.md', bundle.platformSummary);

      const content = await zip.generateAsync({ type: 'blob' });
      const url = window.URL.createObjectURL(content);
      const a = document.createElement('a');
      a.href = url;
      const repoInfo = GitHubService.parseRepoUrl(repoUrl);
      const repoName = repoInfo ? repoInfo.repo : 'repo';
      a.download = `${repoName}_release_review_skill.zip`;
      a.click();
      window.URL.revokeObjectURL(url);
    } catch (err: any) {
      console.error(err);
      setError(err.message || '生成 Skill 失败');
    } finally {
      setSkillLoading(false);
    }
  };

  const generateExcelBuffer = async (analysis: FullDiffAnalysis | ChangeLogAnalysis, targetRepoUrl: string, targetFromVersion: string, targetToVersion: string) => {
    if (!analysis.excelRows || analysis.excelRows.length === 0) {
      throw new Error('分析数据为空，无法生成 Excel。');
    }

    const repoInfo = GitHubService.parseRepoUrl(targetRepoUrl);
    const repoName = repoInfo ? repoInfo.repo : '项目';
    const reportTitle = `${repoName} ${targetFromVersion} → ${targetToVersion} 升级变更分析报告`;

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Analysis Report');

    // 1. Add Title Row
    const titleRow = worksheet.addRow(['', reportTitle]);
    titleRow.height = 30;
    const titleCell = titleRow.getCell(2);
    titleCell.font = { size: 18, bold: true, color: { argb: 'FF000000' } };
    titleCell.alignment = { vertical: 'middle', horizontal: 'left' };
    worksheet.mergeCells(`B1:K1`);

    worksheet.addRow([]);

    // 2. Define headers
    const headers = [
      '版本号', '变更点（英文）', '变更点中文描述', '功能作用说明', 
      '排查建议', '风险等级', '测试建议', '代码排查指导', 
      '代码整改指导', '关联 Commit'
    ];
    const headerRow = worksheet.addRow(['', ...headers]);
    headerRow.height = 35;
    
    const thinBorder: Partial<ExcelJS.Borders> = {
      top: { style: 'thin', color: { argb: 'FFCCCCCC' } },
      left: { style: 'thin', color: { argb: 'FFCCCCCC' } },
      bottom: { style: 'thin', color: { argb: 'FFCCCCCC' } },
      right: { style: 'thin', color: { argb: 'FFCCCCCC' } }
    };

    headerRow.eachCell((cell, colNumber) => {
      if (colNumber === 1) return;
      cell.font = { size: 11, bold: true, color: { argb: 'FFFFFFFF' } };
      cell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FF333333' }
      };
      cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
      cell.border = thinBorder;
    });

    worksheet.getColumn(1).width = 2;
    worksheet.getColumn(2).width = 10;
    worksheet.getColumn(3).width = 50;
    worksheet.getColumn(4).width = 30;
    worksheet.getColumn(5).width = 50;
    worksheet.getColumn(6).width = 50;
    worksheet.getColumn(7).width = 10;
    worksheet.getColumn(8).width = 40;
    worksheet.getColumn(9).width = 60;
    worksheet.getColumn(10).width = 60;
    worksheet.getColumn(11).width = 40;

    // 3. Add Data Rows
    analysis.excelRows.forEach((data, index) => {
      const row = worksheet.addRow([
        index + 1,
        data.version,
        data.changepoint,
        data.chinese,
        data.function,
        data.suggestion,
        data.risk,
        data.test_suggestion,
        data.code_discovery,
        data.code_fix,
        data.related_commits || ''
      ]);
      row.height = 200;

      row.eachCell((cell, colNumber) => {
        if (colNumber === 1) return;
        cell.font = { size: 10 };
        cell.alignment = { vertical: 'top', horizontal: 'left', wrapText: true };
        cell.border = thinBorder;
        
        if (colNumber === 7) {
          const value = cell.value?.toString() || '';
          if (value.includes('高')) {
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFCCCC' } };
          } else if (value.includes('中')) {
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFFCC' } };
          } else {
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFCCFFCC' } };
          }
          cell.alignment = { vertical: 'middle', horizontal: 'center' };
        }
      });
    });

    worksheet.autoFilter = { from: 'B3', to: 'K3' };
    worksheet.views = [{ state: 'frozen', xSplit: 0, ySplit: 3 }];

    return await workbook.xlsx.writeBuffer();
  };

  const handleDownloadExcel = async () => {
    if (!fullDiffAnalysis?.excelRows || fullDiffAnalysis.excelRows.length === 0) {
      setError('请先进行“全量 Diff 深度分析”，分析完成后即可直接下载 Excel 报告。');
      return;
    }

    setExcelLoading(true);
    setError(null);
    try {
      const buffer = await generateExcelBuffer(fullDiffAnalysis, repoUrl, fromVersion, toVersion);
      const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      const url = window.URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `Analysis_Report_${fromVersion}_to_${toVersion}.xlsx`;
      anchor.click();
      window.URL.revokeObjectURL(url);
    } catch (err: any) {
      console.error('Excel generation error:', err);
      setError('生成 Excel 报告失败: ' + err.message);
    } finally {
      setExcelLoading(false);
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
      
      const provider = getAIProvider(requireAIConfig());
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

  const handleBatchDeepScan = async () => {
    if (!changeLogAnalysis) return;
    
    const targetItems = changeLogAnalysis.items.filter(item => 
      (item.impactLevel === 'High' || item.impactLevel === 'Medium') && 
      item.prNumber && 
      !diffAnalyses[item.prNumber] &&
      !analyzingPrs.has(item.prNumber)
    );

    if (targetItems.length === 0) return;

    // Trigger all scans in parallel
    await Promise.all(targetItems.map(item => analyzePR(item.prNumber!, item.title)));
  };

  const handleExcelUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    try {
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(await file.arrayBuffer());
      const worksheet = workbook.worksheets[0];
      
      const newItems: BatchAnalysisItem[] = [];
      worksheet.eachRow((row, rowNumber) => {
        if (rowNumber === 1) return; // Skip header
        
        const repoUrl = row.getCell(1).text?.trim();
        const fromVersion = row.getCell(2).text?.trim();
        const toVersion = row.getCell(3).text?.trim();
        
        if (repoUrl && fromVersion && toVersion) {
          newItems.push({
            repoUrl,
            fromVersion,
            toVersion,
            status: 'pending'
          });
        }
      });
      
      setBatchItems(prev => [...prev, ...newItems]);
      e.target.value = ''; // Reset input
    } catch (err: any) {
      console.error('Excel upload error:', err);
      setError('解析 Excel 失败，请确保格式正确（三列：仓库地址、起始版本、目标版本）。');
    }
  };

  const handleBatchAnalyze = async () => {
    if (batchItems.length === 0 || batchProcessing) return;
    
    setBatchProcessing(true);
    setError(null);
    setStep('batch-processing');

    const items = [...batchItems];
    
    for (let i = 0; i < items.length; i++) {
      if (items[i].status === 'completed') continue;
      
      items[i] = { ...items[i], status: 'processing' };
      setBatchItems([...items]);
      
      try {
        const analysis = await performFullDiffAnalysis(
          items[i].repoUrl, 
          items[i].fromVersion, 
          items[i].toVersion, 
          projectBackground
        );
        items[i] = { ...items[i], status: 'completed', analysis };
      } catch (err: any) {
        console.error(`Error processing ${items[i].repoUrl}:`, err);
        items[i] = { ...items[i], status: 'failed', error: err.message || '分析失败' };
      }
      
      setBatchItems([...items]);
      // Small delay between items to avoid hitting rate limits too hard
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    setBatchProcessing(false);
    setStep('idle');
  };

  const handleDownloadBatchZip = async () => {
    const completedItems = batchItems.filter(item => item.status === 'completed' && item.analysis);
    if (completedItems.length === 0) {
      setError('没有已完成的分析结果可供下载。');
      return;
    }

    setExcelLoading(true);
    try {
      const zip = new JSZip();
      
      for (const item of completedItems) {
        const repoInfo = GitHubService.parseRepoUrl(item.repoUrl);
        const repoName = repoInfo ? repoInfo.repo : 'repo';
        const fileName = `${repoName}_${item.fromVersion}_to_${item.toVersion}.xlsx`;
        
        const buffer = await generateExcelBuffer(item.analysis!, item.repoUrl, item.fromVersion, item.toVersion);
        zip.file(fileName, buffer);
      }
      
      const content = await zip.generateAsync({ type: 'blob' });
      const url = window.URL.createObjectURL(content);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `Batch_Analysis_Reports_${new Date().toISOString().split('T')[0]}.zip`;
      anchor.click();
      window.URL.revokeObjectURL(url);
    } catch (err: any) {
      console.error('ZIP generation error:', err);
      setError('生成 ZIP 压缩包失败: ' + err.message);
    } finally {
      setExcelLoading(false);
    }
  };

  const removeBatchItem = (index: number) => {
    setBatchItems(prev => prev.filter((_, i) => i !== index));
  };

  const clearBatchItems = () => {
    if (batchProcessing) return;
    setBatchItems([]);
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
              <h1 className="font-bold text-lg tracking-tight">CompatAnalyzer</h1>
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
            <div className={cn(
              "hidden md:flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-medium border",
              activeProvider ? "bg-emerald-50 text-emerald-700 border-emerald-100" : "bg-amber-50 text-amber-700 border-amber-100"
            )}>
              <div className={cn("w-1.5 h-1.5 rounded-full animate-pulse", activeProvider ? "bg-emerald-500" : "bg-amber-500")} />
              {activeProvider ? `${activeProvider.displayName} · ${activeProvider.model} 已就绪` : '未配置模型，请打开设置'}
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-6 py-12">
        {/* Settings Panel */}
        {showSettings && (
          <ModelSettings
            providers={providers}
            activeProviderId={activeProviderId}
            onProvidersChange={setProviders}
            onActiveChange={setActiveProviderId}
            githubToken={githubToken}
            onGithubTokenChange={setGithubToken}
            streamingEnabled={streamingEnabled}
            onStreamingChange={setStreamingEnabled}
          />
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
                  <label className="text-[11px] uppercase tracking-wider font-bold text-black/40">分析模式</label>
                  <div className="flex p-1 bg-[#F9F9F9] border border-black/5 rounded-xl">
                    <button 
                      onClick={() => setAnalysisMode('changelog')}
                      className={cn(
                        "flex-1 py-2 text-[10px] font-bold rounded-lg transition-all",
                        analysisMode === 'changelog' ? "bg-white shadow-sm text-black" : "text-black/40 hover:text-black/60"
                      )}
                    >
                      变更日志模式
                    </button>
                    <button 
                      onClick={() => setAnalysisMode('full-diff')}
                      className={cn(
                        "flex-1 py-2 text-[10px] font-bold rounded-lg transition-all",
                        analysisMode === 'full-diff' ? "bg-white shadow-sm text-black" : "text-black/40 hover:text-black/60"
                      )}
                    >
                      全量 Diff 模式
                    </button>
                    <button 
                      onClick={() => setAnalysisMode('batch')}
                      className={cn(
                        "flex-1 py-2 text-[10px] font-bold rounded-lg transition-all",
                        analysisMode === 'batch' ? "bg-white shadow-sm text-black" : "text-black/40 hover:text-black/60"
                      )}
                    >
                      批量分析模式
                    </button>
                  </div>
                  <p className="text-[10px] text-black/30 px-1">
                    {analysisMode === 'changelog' 
                      ? "基于 Release Notes 或 Commit 记录进行初步评估。" 
                      : analysisMode === 'full-diff'
                      ? "直接获取两个版本间的完整代码差异进行深度扫描。"
                      : "上传 Excel 列表，批量执行全量 Diff 深度分析。"}
                  </p>
                </div>

                {analysisMode !== 'batch' ? (
                  <>
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
                  </>
                ) : (
                  <div className="space-y-4">
                    <div className="p-6 border-2 border-dashed border-black/10 rounded-2xl flex flex-col items-center justify-center gap-3 bg-[#F9F9F9] hover:bg-black/[0.02] transition-colors relative group">
                      <FileUp size={32} className="text-black/20 group-hover:text-emerald-500 transition-colors" />
                      <div className="text-center">
                        <p className="text-sm font-bold">上传分析列表</p>
                        <p className="text-[10px] text-black/40 mt-1">支持 .xlsx 格式，需包含：仓库地址、起始版本、目标版本</p>
                      </div>
                      <input 
                        type="file" 
                        accept=".xlsx"
                        onChange={handleExcelUpload}
                        className="absolute inset-0 opacity-0 cursor-pointer"
                      />
                    </div>
                    
                    {batchItems.length > 0 && (
                      <div className="flex items-center justify-between px-1">
                        <span className="text-[10px] font-bold text-black/40 uppercase tracking-wider">已加载 {batchItems.length} 个项目</span>
                        <button 
                          onClick={clearBatchItems}
                          className="text-[10px] font-bold text-red-500 uppercase tracking-wider hover:underline"
                        >
                          清空列表
                        </button>
                      </div>
                    )}
                  </div>
                )}

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
                  onClick={analysisMode === 'batch' ? handleBatchAnalyze : handleAnalyze}
                  disabled={loading || batchProcessing || (analysisMode === 'batch' && batchItems.length === 0)}
                  className="w-full bg-black text-white py-4 rounded-2xl font-bold flex items-center justify-center gap-2 hover:bg-black/90 transition-all disabled:opacity-50 disabled:cursor-not-allowed group"
                >
                  {loading || batchProcessing ? (
                    <Loader2 className="animate-spin" size={20} />
                  ) : (
                    <>
                      {analysisMode === 'batch' ? '开始批量分析' : '开始分析'}
                      <ArrowRight size={20} className="group-hover:translate-x-1 transition-transform" />
                    </>
                  )}
                </button>
              </div>
            </section>

            {error && (
              <div className="bg-red-50 border border-red-100 p-4 rounded-2xl flex gap-3 text-red-700">
                <AlertTriangle className="shrink-0" size={20} />
                <div className="space-y-2 flex-1">
                  <p className="text-sm font-medium whitespace-pre-wrap">{error}</p>
                  {/(设置|Token|Key|配置)/.test(error) && (
                    <button
                      onClick={() => { setShowSettings(true); window.scrollTo({ top: 0, behavior: 'smooth' }); }}
                      className="text-xs font-bold text-red-700 underline hover:no-underline"
                    >
                      打开设置
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Right Column: Results */}
          <div className="lg:col-span-8 space-y-8">
            {analysisMode === 'batch' && batchItems.length > 0 && (
              <section className="bg-white rounded-3xl p-8 shadow-sm border border-black/5">
                <div className="flex items-center justify-between mb-6">
                  <h2 className="text-xl font-bold flex items-center gap-2">
                    <History size={20} className="text-emerald-500" />
                    批量分析队列 ({batchItems.filter(i => i.status === 'completed').length}/{batchItems.length})
                  </h2>
                  {batchItems.some(i => i.status === 'completed') && (
                    <button 
                      onClick={handleDownloadBatchZip}
                      className="flex items-center gap-2 px-4 py-2 bg-emerald-500 text-white rounded-xl text-xs font-bold hover:bg-emerald-600 transition-all shadow-sm"
                    >
                      <FileArchive size={14} />
                      下载汇总 ZIP
                    </button>
                  )}
                </div>

                <div className="space-y-3">
                  {batchItems.map((item, idx) => (
                    <div 
                      key={idx} 
                      onClick={() => {
                        if (item.status !== 'completed' || !item.analysis) return;
                        setFullDiffAnalysis(item.analysis);
                        // 切换批量结果时同步重建 Skill Bundle，避免下载到上一个项目的内容
                        try {
                          setPreparedSkillBundle(buildAnalysisBundleFromFullDiff(
                            item.analysis,
                            item.repoUrl,
                            item.fromVersion,
                            item.toVersion,
                            projectBackground
                          ));
                        } catch (bundleErr) {
                          console.error('Failed to prepare skill bundle:', bundleErr);
                          setPreparedSkillBundle(null);
                        }
                      }}
                      className={cn(
                        "flex items-center justify-between p-4 bg-[#F9F9F9] rounded-xl border border-black/5 transition-all",
                        item.status === 'completed' && item.analysis ? "cursor-pointer hover:bg-black/[0.02] hover:border-emerald-500/30" : ""
                      )}
                    >
                      <div className="flex flex-col gap-1">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-bold truncate max-w-[200px]">{item.repoUrl.split('/').pop()}</span>
                          <span className="text-[10px] text-black/40 font-mono">{item.fromVersion} → {item.toVersion}</span>
                        </div>
                        {item.error && <p className="text-[10px] text-red-500 font-medium">{item.error}</p>}
                      </div>
                      <div className="flex items-center gap-3">
                        {item.status === 'processing' && <Loader2 className="animate-spin text-emerald-500" size={16} />}
                        {item.status === 'completed' && <CheckCircle2 className="text-emerald-500" size={16} />}
                        {item.status === 'failed' && <AlertTriangle className="text-red-500" size={16} />}
                        <span className={cn(
                          "text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded",
                          item.status === 'pending' ? "bg-black/5 text-black/40" :
                          item.status === 'processing' ? "bg-emerald-50 text-emerald-600" :
                          item.status === 'completed' ? "bg-emerald-500 text-white" :
                          "bg-red-50 text-red-600"
                        )}>
                          {item.status === 'pending' ? '等待中' : 
                           item.status === 'processing' ? '分析中' : 
                           item.status === 'completed' ? '查看结果' : '失败'}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {analysisMode === 'batch' && batchItems.length === 0 && !loading && (
              <div className="h-full min-h-[400px] flex flex-col items-center justify-center text-center space-y-4 bg-white/50 border border-dashed border-black/10 rounded-3xl">
                <div className="w-16 h-16 bg-white rounded-2xl shadow-sm flex items-center justify-center text-black/20">
                  <FileSpreadsheet size={32} />
                </div>
                <div>
                  <h3 className="text-lg font-bold">批量分析队列为空</h3>
                  <p className="text-sm text-black/40 max-w-xs mx-auto">请在左侧上传包含待分析项目列表的 Excel 文件以开始批量处理。</p>
                </div>
              </div>
            )}

            {analysisMode !== 'batch' && !changeLogAnalysis && !fullDiffAnalysis && !loading && progressLog.length === 0 && (
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

            {progressLog.length > 0 && !fullDiffAnalysis && !changeLogAnalysis && (
              <div className="bg-white rounded-2xl p-4 border border-black/5 shadow-sm">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs font-bold text-black/60 flex items-center gap-2">
                    {loading ? <Loader2 className="animate-spin" size={12} /> : <Info size={12} />}
                    处理过程
                  </span>
                  {batchProgress && batchProgress.total > 0 && (
                    <span className="text-[10px] font-medium text-black/40">
                      {batchProgress.completed}/{batchProgress.total} 批 · 并行 {AI_BATCH_CONCURRENCY} 路
                    </span>
                  )}
                </div>
                {loading && batchProgress && batchProgress.total > 0 && (
                  <div className="h-1.5 bg-black/5 rounded-full overflow-hidden mb-2">
                    <div
                      className="h-full bg-emerald-500 rounded-full transition-all duration-500"
                      style={{ width: `${Math.round((batchProgress.completed / Math.max(1, batchProgress.total)) * 100)}%` }}
                    />
                  </div>
                )}
                <div className="max-h-36 overflow-y-auto space-y-1.5 pr-1">
                  {progressLog.map(e => (
                    <div key={e.id} className="flex items-start gap-2 text-[11px] leading-relaxed">
                      {e.status === 'running' ? (
                        <Loader2 className="animate-spin shrink-0 mt-0.5 text-blue-500" size={11} />
                      ) : e.status === 'error' ? (
                        <AlertTriangle className="shrink-0 mt-0.5 text-amber-500" size={11} />
                      ) : (
                        <CheckCircle2 className="shrink-0 mt-0.5 text-emerald-500" size={11} />
                      )}
                      <span className={cn('text-black/60', e.status === 'error' && 'text-amber-700')}>{e.text}</span>
                    </div>
                  ))}
                </div>
                {loading && streamPreview && (
                  <div className="mt-2 pt-2 border-t border-black/5">
                    <div className="flex items-center gap-1.5 text-[10px] text-black/30 mb-1">
                      <Cpu size={10} className="text-blue-400" />
                      模型实时输出
                    </div>
                    <pre className="text-[10px] leading-relaxed text-black/45 whitespace-pre-wrap break-all max-h-24 overflow-y-auto font-mono bg-black/[0.02] rounded-lg p-2">{streamPreview}</pre>
                  </div>
                )}
              </div>
            )}

            {loading && (step === 'analyzing-changelog' || step === 'analyzing-full-diff') && (
              <div className="space-y-6 animate-pulse">
                <div className="h-48 bg-white rounded-3xl border border-black/5" />
                <div className="h-64 bg-white rounded-3xl border border-black/5" />
              </div>
            )}

            {fullDiffAnalysis && (
              <div className="space-y-8">
                {/* Full Diff Summary Section */}
                <section className="bg-white rounded-3xl p-8 shadow-sm border border-black/5">
                  <div className="flex items-center justify-between mb-6">
                    <h2 className="text-xl font-bold flex items-center gap-2">
                      <Info size={20} className="text-blue-500" />
                      全量 Diff 深度分析摘要
                    </h2>
                    <div className="flex items-center gap-4">
                      <button
                        onClick={handleDownloadExcel}
                        disabled={excelLoading}
                        className="flex items-center gap-2 px-4 py-2 bg-emerald-50 text-emerald-700 border border-emerald-100 rounded-xl text-xs font-bold hover:bg-emerald-100 transition-all disabled:opacity-50"
                      >
                        {excelLoading ? <Loader2 className="animate-spin" size={14} /> : <Download size={14} />}
                        下载 Excel 报告
                      </button>
                      {preparedSkillBundle && (
                        <button
                          onClick={handleDownloadSkill}
                          disabled={skillLoading}
                          className="flex items-center gap-2 px-4 py-2 bg-blue-50 text-blue-700 border border-blue-100 rounded-xl text-xs font-bold hover:bg-blue-100 transition-all disabled:opacity-50"
                        >
                          {skillLoading ? <Loader2 className="animate-spin" size={14} /> : <FileArchive size={14} />}
                          下载 Skill
                        </button>
                      )}
                      <div className="flex items-center gap-2">
                        <span className={cn(
                          "px-3 py-1 rounded-full text-[10px] uppercase tracking-wider font-bold border",
                          fullDiffAnalysis.overallRisk === 'High' ? "bg-red-50 text-red-700 border-red-100" :
                          fullDiffAnalysis.overallRisk === 'Medium' ? "bg-amber-50 text-amber-700 border-amber-100" :
                          "bg-emerald-50 text-emerald-700 border-emerald-100"
                        )}>
                          整体风险: {fullDiffAnalysis.overallRisk === 'High' ? '高' : fullDiffAnalysis.overallRisk === 'Medium' ? '中' : '低'}
                        </span>
                        {fullDiffAnalysis.analysisMode && (
                          <span className="px-3 py-1 rounded-full text-[10px] uppercase tracking-wider font-bold border bg-blue-50 text-blue-700 border-blue-100 flex items-center gap-1">
                            <Cpu size={10} />
                            模式: {
                              fullDiffAnalysis.analysisMode === 'full_diff' ? '完整分析' :
                              fullDiffAnalysis.analysisMode === 'segmented_full_diff' ? '分片分析' :
                              '降级分析'
                            }
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                  <div className="prose prose-sm max-w-none text-black/70 whitespace-pre-wrap mb-4">
                    {fullDiffAnalysis.summary}
                  </div>
                  
                  {(fullDiffAnalysis.confidenceNote || fullDiffAnalysis.fallbackReason) && (
                    <div className="mt-4 p-4 bg-amber-50/50 border border-amber-100 rounded-2xl space-y-2">
                      {fullDiffAnalysis.confidenceNote && (
                        <div className="flex gap-2 text-xs text-amber-800">
                          <Info size={14} className="shrink-0 mt-0.5" />
                          <span><strong>置信度说明：</strong>{fullDiffAnalysis.confidenceNote}</span>
                        </div>
                      )}
                      {fullDiffAnalysis.fallbackReason && (
                        <div className="flex gap-2 text-xs text-amber-800">
                          <AlertTriangle size={14} className="shrink-0 mt-0.5" />
                          <span><strong>降级原因：</strong>{fullDiffAnalysis.fallbackReason}</span>
                        </div>
                      )}
                    </div>
                  )}
                </section>

                {/* Recommendations Section */}
                <section className="bg-white rounded-3xl p-8 shadow-sm border border-black/5">
                  <h3 className="text-lg font-bold mb-4 flex items-center gap-2">
                    <CheckCircle2 size={18} className="text-emerald-500" />
                    核心建议
                  </h3>
                  <ul className="space-y-3">
                    {fullDiffAnalysis.recommendations.map((rec, i) => (
                      <li key={i} className="text-sm text-black/70 flex gap-3">
                        <div className="w-1.5 h-1.5 rounded-full bg-emerald-400 mt-2 shrink-0" />
                        {rec}
                      </li>
                    ))}
                  </ul>
                </section>

                {/* Detailed Items Section */}
                <section className="space-y-6">
                  <div className="flex items-center justify-between px-2">
                    <h2 className="text-xl font-bold">变更详情 (按风险等级排序)</h2>
                    <a 
                      href={`${fullDiffAnalysis.repoUrl || repoUrl}/compare/${fullDiffAnalysis.resolvedTags?.from || resolvedTags.from || fromVersion}...${fullDiffAnalysis.resolvedTags?.to || resolvedTags.to || toVersion}`}
                      target="_blank"
                      rel="noreferrer"
                      className="text-xs font-bold text-blue-500 hover:underline flex items-center gap-1"
                    >
                      查看 GitHub 原始对比
                      <ExternalLink size={12} />
                    </a>
                  </div>

                  <div className="grid gap-4">
                    {fullDiffAnalysis.items.map((item, i) => (
                      <div key={i} className="bg-white rounded-2xl border border-black/5 shadow-sm transition-all hover:shadow-md overflow-hidden">
                        <div className="p-6">
                          <div className="flex items-start justify-between gap-4 mb-3">
                            <h4 className="font-bold text-lg">{item.title}</h4>
                            <span className={cn(
                              "px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider",
                              item.riskLevel === 'High' ? "bg-red-50 text-red-600 border border-red-100" :
                              item.riskLevel === 'Medium' ? "bg-amber-50 text-amber-600 border border-amber-100" :
                              "bg-emerald-50 text-emerald-700 border border-emerald-100"
                            )}>
                              {item.riskLevel === 'High' ? '高' : item.riskLevel === 'Medium' ? '中' : '低'} 风险
                            </span>
                          </div>
                          <p className="text-sm text-black/60 mb-4 leading-relaxed whitespace-pre-wrap">
                            {item.description}
                          </p>
                          
                          {/* Commit Links */}
                          {item.commitLinks && item.commitLinks.length > 0 && (
                            <div className="mb-4 flex flex-wrap gap-2">
                              {item.commitLinks.map((link, lIdx) => (
                                <a
                                  key={lIdx}
                                  href={link?.url || '#'}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="inline-flex items-center gap-1 px-2 py-1 bg-gray-100 hover:bg-gray-200 border border-black/5 rounded text-[10px] font-mono text-black/60 transition-colors"
                                >
                                  <GitCommit size={10} />
                                  {String(link?.sha || 'commit').substring(0, 7)}
                                </a>
                              ))}
                            </div>
                          )}

                          {/* Source Snippet for Credibility */}
                          {item.sourceSnippet && (
                            <div className="mb-4 space-y-2">
                              <div className="text-[10px] font-bold text-black/30 uppercase tracking-widest flex items-center gap-1.5">
                                <Code2 size={12} />
                                原始代码片段 (Diff 原文)
                              </div>
                              <pre className="p-4 bg-gray-50 border border-black/5 rounded-xl text-[11px] font-mono text-black/70 overflow-x-auto whitespace-pre-wrap break-all">
                                <code>{item.sourceSnippet}</code>
                              </pre>
                            </div>
                          )}

                          {/* Compatibility Analysis & Code Examples */}
                          {(item.riskLevel === 'High' || item.riskLevel === 'Medium') && (
                            <div className="space-y-4 mt-4 pt-4 border-t border-black/5">
                              {item.compatibilityAnalysis && (
                                <div className="p-4 bg-amber-50/30 rounded-xl border border-amber-100/50">
                                  <div className="text-[10px] font-bold text-amber-700 uppercase tracking-wider mb-1 flex items-center gap-1.5">
                                    <AlertTriangle size={12} />
                                    兼容性影响分析
                                  </div>
                                  <p className="text-sm text-amber-900/80 leading-relaxed whitespace-pre-wrap">
                                    {item.compatibilityAnalysis}
                                  </p>
                                </div>
                              )}

                              {item.codeExample && (
                                <div className="space-y-3">
                                  <div className="text-[10px] font-bold text-black/30 uppercase tracking-widest">迁移指导代码示例</div>
                                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                    <div className="space-y-1">
                                      <div className="text-[9px] font-bold text-red-600/50 uppercase tracking-widest">修改前 (Before)</div>
                                      <pre className="p-3 bg-red-50/20 border border-red-100/30 rounded-lg text-[11px] font-mono text-red-900/80 overflow-x-auto whitespace-pre-wrap break-all">
                                        <code>{item.codeExample.before}</code>
                                      </pre>
                                    </div>
                                    <div className="space-y-1">
                                      <div className="text-[9px] font-bold text-emerald-600/50 uppercase tracking-widest">修改后 (After)</div>
                                      <pre className="p-3 bg-emerald-50/20 border border-emerald-100/30 rounded-lg text-[11px] font-mono text-emerald-900/80 overflow-x-auto whitespace-pre-wrap break-all">
                                        <code>{item.codeExample.after}</code>
                                      </pre>
                                    </div>
                                  </div>
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </section>
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
                  <div className="prose prose-sm max-w-none text-black/70 whitespace-pre-wrap">
                    {changeLogAnalysis.summary}
                  </div>
                  {changeLogAnalysis.sourceUrl && (
                    <div className="mt-4 pt-4 border-t border-black/5">
                      <a 
                        href={changeLogAnalysis.sourceUrl} 
                        target="_blank" 
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-2 text-xs text-blue-600 hover:text-blue-800 font-medium group"
                      >
                        <ExternalLink size={14} className="group-hover:translate-x-0.5 group-hover:-translate-y-0.5 transition-transform" />
                        查看原始变更日志 (证据链)
                      </a>
                    </div>
                  )}
                </section>

                {/* All Changes Section */}
                <section className="space-y-4">
                  <div className="flex items-center justify-between px-2">
                    <div className="flex items-center gap-4">
                      <h2 className="text-xl font-bold flex items-center gap-2">
                        <History size={20} className="text-amber-500" />
                        变更详情与风险评估
                      </h2>
                      {changeLogAnalysis.items.some(item => (item.impactLevel === 'High' || item.impactLevel === 'Medium') && item.prNumber && !diffAnalyses[item.prNumber]) && (
                        <button 
                          onClick={handleBatchDeepScan}
                          disabled={analyzingPrs.size > 0}
                          className="flex items-center gap-2 px-4 py-1.5 bg-black text-white rounded-full text-xs font-bold hover:bg-black/80 transition-all disabled:opacity-50 disabled:cursor-not-allowed shadow-sm hover:shadow-md active:scale-95"
                        >
                          {analyzingPrs.size > 0 ? (
                            <Loader2 className="animate-spin" size={14} />
                          ) : (
                            <Cpu size={14} />
                          )}
                          一键深度扫描 (中/高风险)
                        </button>
                      )}
                    </div>
                    <div className="flex items-center gap-3">
                      {changeLogAnalysis.excelRows && changeLogAnalysis.excelRows.length > 0 && (
                        <div className="flex items-center gap-2">
                          <button
                            onClick={handleDownloadChangeLogExcel}
                            className="flex items-center gap-2 px-4 py-1.5 bg-emerald-600 text-white rounded-full text-xs font-bold hover:bg-emerald-700 transition-all shadow-sm hover:shadow-md active:scale-95"
                          >
                            <Download size={14} />
                            下载 Excel 报告
                          </button>
                          <button
                            onClick={handleDownloadSkill}
                            disabled={skillLoading}
                            className="flex items-center gap-2 px-4 py-1.5 bg-blue-600 text-white rounded-full text-xs font-bold hover:bg-blue-700 transition-all shadow-sm hover:shadow-md active:scale-95 disabled:opacity-50"
                          >
                            {skillLoading ? <Loader2 className="animate-spin" size={14} /> : <FileArchive size={14} />}
                            下载 Skill
                          </button>
                        </div>
                      )}
                      <span className="text-xs font-medium text-black/40 bg-black/5 px-2 py-1 rounded-lg">
                        共 {changeLogAnalysis.items.length} 项变更
                      </span>
                    </div>
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
                                
                                {/* AI-based compatibility analysis from changelog (fallback when no diff is available) */}
                                {!diffAnalyses[item.prNumber || -1] && (item.impactLevel === 'High' || item.impactLevel === 'Medium') && item.compatibilityAnalysis && (
                                  <div className="mt-4 p-4 bg-amber-50/30 rounded-xl border border-amber-100/50 space-y-3">
                                    <div className="flex items-center gap-2 text-amber-700 font-bold text-xs uppercase tracking-wider">
                                      <AlertTriangle size={14} />
                                      AI 兼容性预判 (基于变更日志)
                                    </div>
                                    <p className="text-sm text-amber-900/80 leading-relaxed">{item.compatibilityAnalysis}</p>
                                    
                                    {item.codeExample && (
                                      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-2">
                                        <div className="space-y-1">
                                          <div className="text-[9px] font-bold text-amber-600/50 uppercase tracking-widest">Before</div>
                                          <pre className="p-3 bg-white/50 border border-amber-100/30 rounded-lg text-[11px] font-mono text-amber-900/70 overflow-x-auto">
                                            <code>{item.codeExample.before}</code>
                                          </pre>
                                        </div>
                                        <div className="space-y-1">
                                          <div className="text-[9px] font-bold text-amber-600/50 uppercase tracking-widest">After</div>
                                          <pre className="p-3 bg-white/50 border border-amber-100/30 rounded-lg text-[11px] font-mono text-amber-900/70 overflow-x-auto">
                                            <code>{item.codeExample.after}</code>
                                          </pre>
                                        </div>
                                      </div>
                                    )}
                                  </div>
                                )}
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
            <span className="text-sm font-medium">CompatAnalyzer v1.0</span>
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
