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
import { getAIProvider } from './services/aiProvider';
import { AIConfig, ChangeLogAnalysis, DiffAnalysis, FullDiffAnalysis, BatchAnalysisItem, SkillBundle } from './types';
import { determineDiffStrategy, BATCH_ANALYSIS_FILE_BATCH_SIZE, DiffAnalysisMode, MAX_BATCHES_PER_ANALYSIS } from './services/diffStrategy';
import { sortFilesByPriority, MAX_PRIORITY_FILES_FOR_SEGMENTED_DIFF } from './services/filePriority';
import { groupFiles, getRiskHint, getReviewHint } from './services/fileGrouping';
import { parseGitHubError } from './services/githubErrorUtils';
import { buildAnalysisBundleFromChangeLog } from './services/skillBundleGenerator';
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
  const [repoUrl, setRepoUrl] = useState('https://github.com/apache/httpcomponents-client');
  const [fromVersion, setFromVersion] = useState('v5.4.4');
  const [toVersion, setToVersion] = useState('v5.5');
  const [projectBackground, setProjectBackground] = useState('平台背景：MateInfo Integration Platform 是华为内部面向多租户的统一集成中间件，负责 REST/SOAP/FTP 等协议适配、流量治理、凭证管理、审计日志、监控告警、热部署等。平台模块包括 Shared Utilities、FTP Integration、iFlow Engine、Integration Core、REST API、REST Invoke、Security Services、SOAP Services、SOAP Invoke、Integration Auxiliary。');
  
  // AI Config
  const [aiConfig, setAiConfig] = useState<AIConfig>({
    provider: 'openai-compatible',
    apiKey: '',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-plus',
    useProxy: true
  });
  const [showSettings, setShowSettings] = useState(false);

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

  // Batch Analysis State
  const [batchItems, setBatchItems] = useState<BatchAnalysisItem[]>([]);
  const [batchProcessing, setBatchProcessing] = useState(false);

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
    setStep('analyzing-changelog');

    try {
      const repoInfo = GitHubService.parseRepoUrl(repoUrl);
      if (!repoInfo) throw new Error('Invalid GitHub URL');

      const cleanToVersion = GitHubService.parseTagFromUrl(toVersion);
      const cleanFromVersion = GitHubService.parseTagFromUrl(fromVersion);

      // Helper to find actual tag name from version string
      const findActualTag = async (version: string) => {
        try {
          const tags = await GitHubService.getTags(repoInfo.owner, repoInfo.repo);
          // Try exact match, then v-prefix, then common prefixes like rel/
          const match = tags.find(t => 
            t.name === version || 
            t.name === `v${version}` || 
            t.name === `rel/v${version}` || 
            t.name === `rel/${version}` ||
            t.name.endsWith(`/${version}`) ||
            t.name.endsWith(`/v${version}`) ||
            version.endsWith(`/${t.name}`) ||
            version.endsWith(`/v${t.name}`)
          );
          return match?.name || version;
        } catch (e) {
          return version;
        }
      };

      const actualToTag = await findActualTag(cleanToVersion);
      const actualFromTag = await findActualTag(cleanFromVersion);
      setResolvedTags({ from: actualFromTag, to: actualToTag });

      // Helper to extract relevant section from a cumulative changelog
      const extractVersionSection = (content: string, toV: string, fromV: string) => {
        const cleanTo = toV.replace(/^v/, '').replace(/^rel\//, '');
        const cleanFrom = fromV.replace(/^v/, '').replace(/^rel\//, '');
        
        const getVersionPos = (ver: string) => {
          const escapedVer = ver.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const patterns = [
            new RegExp(`(?:Release|Version|##|#|Tag)\\s*v?${escapedVer}`, 'i'),
            new RegExp(`^v?${escapedVer}\\s*$`, 'im'),
            new RegExp(`^v?${escapedVer}\\s+[-=]+$`, 'im'),
            new RegExp(`\\[${escapedVer}\\]`, 'i'),
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
        if (release) {
          releaseBody = release.body;
          releaseUrl = release.html_url;
        } else {
          throw new Error('Release not found');
        }
      } catch (err: any) {
        // Fallback 1: Try to find a changelog file in the repo (e.g., RELEASE_NOTES.txt)
        try {
          const files = ['RELEASE_NOTES.txt', 'CHANGELOG.md', 'CHANGES.txt', 'RELEASENOTES.md', 'CHANGELOG.txt'];
          let fileContent = '';
          let foundFile = '';
          for (const file of files) {
            try {
              fileContent = await GitHubService.getFileContent(repoInfo.owner, repoInfo.repo, file, actualToTag);
              if (fileContent) {
                foundFile = file;
                console.log(`Found changelog in file: ${file}`);
                break;
              }
            } catch (e) {}
          }
          
          if (fileContent) {
            releaseBody = extractVersionSection(fileContent, toVersion, fromVersion);
            releaseUrl = `https://github.com/${repoInfo.owner}/${repoInfo.repo}/blob/${actualToTag}/${foundFile}`;
          } else {
            throw new Error('No changelog file found');
          }
        } catch (fileErr) {
          // Fallback 2: Try to compare tags if release and files are not found
          try {
            const comparison = await GitHubService.compareCommits(repoInfo.owner, repoInfo.repo, actualFromTag, actualToTag);
            releaseUrl = comparison.html_url;
            // Create a synthetic changelog from commit messages
            releaseBody = "## Synthetic Changelog (Generated from Commits)\n\n" + 
              comparison.commits.map((c: any) => `- ${c.commit.message.split('\n')[0]} (${c.sha.substring(0, 7)})`).join('\n');
            
            console.log("Using synthetic changelog from commits");
          } catch (compareErr: any) {
            // Log available tags to help user debug
            try {
              const tags = await GitHubService.getTags(repoInfo.owner, repoInfo.repo);
              console.log("Available tags in this repository:", tags.map(t => t.name));
            } catch (tagErr) {
              console.error("Failed to fetch tags for debugging:", tagErr);
            }

            const status = err.response?.status || compareErr.response?.status;
            const errorData = compareErr.response?.data || err.response?.data;
            
            if (status === 403 && errorData?.message?.includes('rate limit exceeded')) {
              const suggestion = errorData.suggestion || '请在设置中配置 GitHub Token 以提高限制。';
              throw new Error(`GitHub API 速率限制已达到。${suggestion}`);
            } else if (status === 404) {
              throw new Error(`无法找到版本 "${fromVersion}" 或 "${toVersion}"。这通常是因为：\n1. 版本号输入错误\n2. 该版本在 GitHub 上既不是 Release 也不是 Tag\n3. 仓库地址错误\n\n当前尝试匹配的 Tag 为: ${actualToTag}`);
            } else {
              const errorMsg = errorData?.message || err.message || "未知错误";
              throw new Error(`获取发布信息失败: ${errorMsg}`);
            }
          }
        }
      }

      // 2. Analyze Change Log with Selected AI
      const provider = getAIProvider(aiConfig);
      const analysis = await provider.analyzeChangeLog(releaseBody, projectBackground);
      
      // Sort items by risk level: High > Medium > Low
      const riskOrder: Record<string, number> = { 'High': 0, 'Medium': 1, 'Low': 2 };
      analysis.items.sort((a, b) => riskOrder[a.impactLevel] - riskOrder[b.impactLevel]);
      
      // Fallback for excelRows if AI failed to provide it
      if ((!analysis.excelRows || analysis.excelRows.length === 0) && analysis.items.length > 0) {
        console.warn('AI failed to provide excelRows for changelog, generating from items fallback.');
        analysis.excelRows = analysis.items.map(item => ({
          version: toVersion,
          changepoint: item.title,
          chinese: item.reason,
          function: item.compatibilityAnalysis || item.reason,
          suggestion: item.reason,
          risk: item.impactLevel === 'High' ? '高' : item.impactLevel === 'Medium' ? '中' : '低',
          test_suggestion: item.reason,
          code_discovery: '请参考变更日志',
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
      setError(err.message || '分析过程中发生错误');
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

    const cleanToVersion = GitHubService.parseTagFromUrl(targetToVersion);
    const cleanFromVersion = GitHubService.parseTagFromUrl(targetFromVersion);

    let cachedTags: { name: string }[] | null = null;
    const findActualTag = async (version: string) => {
      try {
        if (!cachedTags) {
          cachedTags = await GitHubService.getTags(repoInfo.owner, repoInfo.repo);
        }
        const match = cachedTags.find(t => 
          t.name === version || 
          t.name === `v${version}` || 
          t.name === `rel/v${version}` || 
          t.name === `rel/${version}` ||
          t.name.endsWith(`/${version}`) ||
          t.name.endsWith(`/v${version}`) ||
          version.endsWith(`/${t.name}`) ||
          version.endsWith(`/v${t.name}`)
        );
        return match?.name || version;
      } catch (e) {
        return version;
      }
    };

    const actualToTag = await findActualTag(cleanToVersion);
    const actualFromTag = await findActualTag(cleanFromVersion);

    // 1. Fetch commit data first to determine strategy
    // Only compareCommits failure is allowed to throw
    const commitData = await GitHubService.compareCommits(repoInfo.owner, repoInfo.repo, actualFromTag, actualToTag);
    const strategy = determineDiffStrategy(commitData.commits.length, commitData.files.length);

    let diff = '';
    let metadata: { mode: DiffAnalysisMode, fallbackReason?: string, confidenceNote?: string } = {
      mode: strategy.mode,
      confidenceNote: strategy.confidenceNote
    };

    // 2. Fetch diff based on strategy
    try {
      if (strategy.mode === 'full_diff') {
        const diffResult = await GitHubService.getCompareDiff(repoInfo.owner, repoInfo.repo, actualFromTag, actualToTag);
        if (diffResult.error) {
          const parsedError = parseGitHubError(diffResult.error);
          console.warn('Full diff failed, falling back to multi-batch analysis:', parsedError.message);
          strategy.mode = 'multi_batch_full_diff';
          metadata.mode = 'multi_batch_full_diff';
          metadata.fallbackReason = `获取完整差异失败: ${parsedError.message}`;
          metadata.confidenceNote = '由于无法获取完整差异，已降级为分组分批分析。';
        } else {
          diff = diffResult.diff;
        }
      }

      const provider = getAIProvider(aiConfig);

      if (strategy.mode === 'multi_batch_full_diff') {
        // 3. Multi-batch analysis logic
        const groups = groupFiles(commitData.files);
        const batchResults: any[] = [];

        // Fetch release notes early for context
        let releaseNotes = '';
        try {
          const releaseData = await GitHubService.getReleaseByTag(repoInfo.owner, repoInfo.repo, actualToTag);
          releaseNotes = releaseData?.body || '';
        } catch (e) {
          console.warn('Failed to fetch release notes:', e);
        }

        for (const group of groups) {
          const sortedFiles = sortFilesByPriority(group.files);
          const batches = [];
          for (let i = 0; i < sortedFiles.length; i += BATCH_ANALYSIS_FILE_BATCH_SIZE) {
            batches.push(sortedFiles.slice(i, i + BATCH_ANALYSIS_FILE_BATCH_SIZE));
          }

          for (let i = 0; i < batches.length; i++) {
            if (batchResults.length >= MAX_BATCHES_PER_ANALYSIS) {
              console.warn(`Reached MAX_BATCHES_PER_ANALYSIS (${MAX_BATCHES_PER_ANALYSIS}), skipping remaining batches.`);
              break;
            }
            const batchFiles = batches[i];
            
            // Create structured evidence for each file in the batch
            const batchEvidence: FileEvidence[] = await Promise.all(batchFiles.map(async (file) => {
              let patch = file.patch;
              let diffFetchFailed = false;
              
              if (!patch) {
                try {
                  patch = await GitHubService.getFileDiff(repoInfo.owner, repoInfo.repo, actualFromTag, actualToTag, file.filename);
                } catch (e) {
                  console.warn(`Failed to fetch diff for ${file.filename}:`, e);
                  diffFetchFailed = true;
                }
              }

              return {
                filename: file.filename,
                group: group.name,
                status: file.status,
                additions: file.additions,
                deletions: file.deletions,
                patch: patch || undefined,
                patchAvailable: !!patch,
                diffFetchFailed,
                riskHint: getRiskHint(group.name),
                reviewHint: getReviewHint(group.name)
              };
            }));

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

            const batchResult = await provider.analyzeBatchDiff(
              evidenceString,
              background,
              targetFromVersion,
              targetToVersion,
              group.name,
              i,
              batches.length,
              releaseNotes,
              commitData.commits
            );
            batchResults.push(batchResult);
          }
        }

        // 4. Aggregate results
        const finalAnalysis = await provider.aggregateBatchResults(
          batchResults,
          background,
          targetFromVersion,
          targetToVersion,
          releaseNotes
        );

        // Ensure all required fields are present
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
        const diffs = await Promise.all(priorityFiles.map(async (file) => {
          if (file.patch) {
            return `File: ${file.filename}\n${file.patch}`;
          }
          try {
            const fileDiff = await GitHubService.getFileDiff(repoInfo.owner, repoInfo.repo, actualFromTag, actualToTag, file.filename);
            return `File: ${file.filename}\n${fileDiff}`;
          } catch (e) {
            return `File: ${file.filename}\n(Failed to fetch diff)`;
          }
        }));
        diff = diffs.join('\n\n');
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

      const analysis = await provider.analyzeFullDiff(
        diff, 
        background, 
        targetFromVersion, 
        targetToVersion, 
        releaseNotes, 
        commitData.commits, 
        commitData.files,
        metadata
      );
      
      const riskOrder: Record<string, number> = { 'High': 0, 'Medium': 1, 'Low': 2 };
      analysis.items.sort((a, b) => riskOrder[a.riskLevel] - riskOrder[b.riskLevel]);
      
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

      const provider = getAIProvider(aiConfig);
      const analysis = await provider.analyzeFullDiff(
        diff, 
        background, 
        targetFromVersion, 
        targetToVersion, 
        '', 
        commitData.commits, 
        commitData.files,
        metadata
      );
      
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
    setDiffAnalyses({});
    setStep('analyzing-full-diff');

    try {
      const analysis = await performFullDiffAnalysis(repoUrl, fromVersion, toVersion, projectBackground);
      
      if (analysis.resolvedTags) {
        setResolvedTags(analysis.resolvedTags);
      }

      setFullDiffAnalysis(analysis);
    } catch (err: any) {
      console.error(err);
      setError(err.message || '深度分析过程中发生错误');
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
              <div className="space-y-2 flex flex-col justify-end pb-1">
                <label className="flex items-center gap-2 cursor-pointer group">
                  <input 
                    type="checkbox" 
                    checked={aiConfig.useProxy}
                    onChange={(e) => setAiConfig({...aiConfig, useProxy: e.target.checked})}
                    className="w-5 h-5 rounded-lg border-black/10 text-emerald-500 focus:ring-emerald-500/20 transition-all"
                  />
                  <span className="text-sm font-bold text-black/60 group-hover:text-black transition-colors">使用代理模式</span>
                </label>
                <p className="text-[10px] text-black/30 mt-1">在静态托管环境（如 Cloudflare Pages）下建议关闭此项。</p>
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
                <p className="text-sm font-medium">{error}</p>
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
                      onClick={() => item.status === 'completed' && item.analysis && setFullDiffAnalysis(item.analysis)}
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

            {analysisMode !== 'batch' && !changeLogAnalysis && !fullDiffAnalysis && !loading && (
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
                                  href={link.url}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="inline-flex items-center gap-1 px-2 py-1 bg-gray-100 hover:bg-gray-200 border border-black/5 rounded text-[10px] font-mono text-black/60 transition-colors"
                                >
                                  <GitCommit size={10} />
                                  {link.sha.substring(0, 7)}
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
