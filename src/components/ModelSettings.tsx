import React, { useState } from 'react';
import axios from 'axios';
import {
  Plus, Trash2, Loader2, CheckCircle2, XCircle, Plug, Github, ExternalLink, Cpu
} from 'lucide-react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { ModelProviderConfig } from '../types';
import { PROVIDER_PRESETS, getPreset, ProviderPreset } from '../constants/providerPresets';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

interface ModelSettingsProps {
  providers: ModelProviderConfig[];
  activeProviderId: string | null;
  onProvidersChange: (providers: ModelProviderConfig[]) => void;
  onActiveChange: (id: string | null) => void;
  githubToken: string;
  onGithubTokenChange: (token: string) => void;
  streamingEnabled: boolean;
  onStreamingChange: (enabled: boolean) => void;
}

const inputCls = "w-full px-4 py-2.5 bg-[#F9F9F9] border border-black/5 rounded-xl focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 transition-all text-sm";
const labelCls = "text-[11px] uppercase tracking-wider font-bold text-black/40";

const PROTOCOL_BADGES: Record<string, string> = {
  openai: 'OpenAI 协议',
  anthropic: 'Anthropic 协议',
  gemini: 'Gemini 协议'
};

export function ModelSettings({
  providers, activeProviderId, onProvidersChange, onActiveChange,
  githubToken, onGithubTokenChange,
  streamingEnabled, onStreamingChange
}: ModelSettingsProps) {
  const [showAddPicker, setShowAddPicker] = useState(providers.length === 0);
  const [testingIds, setTestingIds] = useState<Set<string>>(new Set());

  const updateProvider = (id: string, patch: Partial<ModelProviderConfig>) => {
    onProvidersChange(providers.map(p => p.id === id ? { ...p, ...patch } : p));
  };

  const addFromPreset = (preset: ProviderPreset) => {
    const newProvider: ModelProviderConfig = {
      id: (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : `p-${Date.now()}`,
      presetId: preset.id,
      displayName: preset.name,
      protocol: preset.protocol,
      baseUrl: preset.defaultBaseUrl,
      apiKey: '',
      model: preset.defaultModel,
      useProxy: true,
      enabled: true
    };
    onProvidersChange([...providers, newProvider]);
    if (!activeProviderId) onActiveChange(newProvider.id);
    setShowAddPicker(false);
  };

  const removeProvider = (id: string) => {
    const next = providers.filter(p => p.id !== id);
    onProvidersChange(next);
    if (activeProviderId === id) {
      onActiveChange(next.find(p => p.enabled)?.id || next[0]?.id || null);
    }
  };

  const testConnection = async (p: ModelProviderConfig) => {
    setTestingIds(prev => new Set(prev).add(p.id));
    try {
      const resp = await axios.post('/api/ai/test-connection', {
        protocol: p.protocol,
        baseUrl: p.baseUrl,
        apiKey: p.apiKey,
        model: p.model
      }, { timeout: 20000 });
      updateProvider(p.id, {
        lastTest: {
          ok: !!resp.data.ok,
          message: resp.data.message || '连接成功',
          latencyMs: resp.data.latencyMs,
          at: new Date().toISOString()
        }
      });
    } catch (err: any) {
      updateProvider(p.id, {
        lastTest: {
          ok: false,
          message: err.response?.data?.message || err.message || '连接失败',
          at: new Date().toISOString()
        }
      });
    } finally {
      setTestingIds(prev => {
        const next = new Set(prev);
        next.delete(p.id);
        return next;
      });
    }
  };

  return (
    <div className="mb-12 bg-white rounded-3xl p-8 shadow-sm border border-black/5 animate-in fade-in slide-in-from-top-4 space-y-8">
      {/* 模型供应商 */}
      <section>
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-2">
            <Cpu size={20} className="text-emerald-500" />
            <h2 className="text-xl font-bold">模型供应商</h2>
            <span className="text-xs text-black/30">已配置 {providers.length} 个</span>
          </div>
          <button
            onClick={() => setShowAddPicker(!showAddPicker)}
            className="flex items-center gap-2 px-4 py-2 bg-black text-white rounded-xl text-xs font-bold hover:bg-black/80 transition-all"
          >
            <Plus size={14} />
            添加供应商
          </button>
        </div>

        {/* 预置厂商选择 */}
        {showAddPicker && (
          <div className="mb-6 p-5 bg-[#F9F9F9] rounded-2xl border border-black/5">
            <p className={cn(labelCls, "block mb-3")}>选择厂商</p>
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
              {PROVIDER_PRESETS.map(preset => (
                <button
                  key={preset.id}
                  onClick={() => addFromPreset(preset)}
                  className="p-3 bg-white rounded-xl border border-black/5 text-left hover:border-emerald-500/40 hover:shadow-sm transition-all"
                >
                  <div className="text-sm font-bold">{preset.name}</div>
                  <div className="text-[10px] text-black/40 mt-1">{PROTOCOL_BADGES[preset.protocol]}</div>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* 已配置的供应商卡片 */}
        {providers.length === 0 && !showAddPicker && (
          <p className="text-sm text-black/40">尚未配置任何模型，点击右上角"添加供应商"开始。</p>
        )}
        <div className="space-y-4">
          {providers.map(p => {
            const preset = getPreset(p.presetId);
            const isActive = p.id === activeProviderId;
            const testing = testingIds.has(p.id);
            return (
              <div
                key={p.id}
                className={cn(
                  "p-5 rounded-2xl border transition-all",
                  isActive ? "border-emerald-500/40 bg-emerald-50/30" : "border-black/5 bg-[#FCFCFC]"
                )}
              >
                <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
                  <div className="flex items-center gap-3">
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="radio"
                        name="active-provider"
                        checked={isActive}
                        onChange={() => onActiveChange(p.id)}
                        className="w-4 h-4 text-emerald-500 focus:ring-emerald-500/20"
                      />
                      <span className="font-bold text-sm">{p.displayName}</span>
                    </label>
                    <span className="px-2 py-0.5 bg-black/5 rounded-full text-[10px] font-bold text-black/50">
                      {PROTOCOL_BADGES[p.protocol]}
                    </span>
                    {isActive && (
                      <span className="px-2 py-0.5 bg-emerald-100 text-emerald-700 rounded-full text-[10px] font-bold">
                        当前使用
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    {p.lastTest && (
                      <span className={cn(
                        "flex items-center gap-1 text-[11px] font-medium max-w-[300px] truncate",
                        p.lastTest.ok ? "text-emerald-600" : "text-red-500"
                      )} title={p.lastTest.message}>
                        {p.lastTest.ok ? <CheckCircle2 size={13} /> : <XCircle size={13} />}
                        {p.lastTest.ok
                          ? `连接正常${p.lastTest.latencyMs ? ` (${p.lastTest.latencyMs}ms)` : ''}`
                          : p.lastTest.message}
                      </span>
                    )}
                    <button
                      onClick={() => testConnection(p)}
                      disabled={testing || !p.model || (!p.apiKey && !p.useProxy)}
                      className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-50 text-blue-700 border border-blue-100 rounded-lg text-xs font-bold hover:bg-blue-100 transition-all disabled:opacity-40"
                      title={!p.model ? '请先填写模型名称' : (!p.apiKey && !p.useProxy) ? '请先填写 API Key（或开启代理使用服务端默认 Key）' : '发送一次最小请求验证配置'}
                    >
                      {testing ? <Loader2 className="animate-spin" size={13} /> : <Plug size={13} />}
                      测试连接
                    </button>
                    <button
                      onClick={() => removeProvider(p.id)}
                      className="p-1.5 text-black/30 hover:text-red-500 hover:bg-red-50 rounded-lg transition-all"
                      title="删除此供应商"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                  <div className="space-y-1.5">
                    <label className={labelCls}>API Key</label>
                    <input
                      type="password"
                      value={p.apiKey}
                      onChange={(e) => updateProvider(p.id, { apiKey: e.target.value })}
                      className={inputCls}
                      placeholder="请输入 API Key"
                    />
                    {preset?.keyUrl && (
                      <a
                        href={preset.keyUrl} target="_blank" rel="noreferrer"
                        className="text-[10px] text-blue-500 hover:underline flex items-center gap-1"
                      >
                        获取 API Key <ExternalLink size={9} />
                      </a>
                    )}
                  </div>
                  <div className="space-y-1.5">
                    <label className={labelCls}>Base URL</label>
                    <input
                      type="text"
                      value={p.baseUrl}
                      onChange={(e) => updateProvider(p.id, { baseUrl: e.target.value })}
                      className={inputCls}
                      placeholder={preset?.defaultBaseUrl || 'https://...'}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label className={labelCls}>模型名称</label>
                    <input
                      type="text"
                      value={p.model}
                      onChange={(e) => updateProvider(p.id, { model: e.target.value })}
                      className={inputCls}
                      placeholder="模型 ID"
                      list={`models-${p.id}`}
                    />
                    {preset && preset.models.length > 0 && (
                      <datalist id={`models-${p.id}`}>
                        {preset.models.map(m => <option key={m} value={m} />)}
                      </datalist>
                    )}
                  </div>
                  <div className="space-y-1.5">
                    <label className={labelCls}>最大输出 Tokens</label>
                    <input
                      type="number"
                      min={1000}
                      step={1000}
                      value={p.maxTokens ?? ''}
                      onChange={(e) => updateProvider(p.id, { maxTokens: e.target.value ? Number(e.target.value) : undefined })}
                      className={inputCls}
                      placeholder="默认 8000"
                    />
                    <p className="text-[10px] text-black/30">
                      推理模型（MiniMax-M / DeepSeek-R1 等）思考会占用输出额度，建议 16000 以上。
                    </p>
                  </div>
                </div>
                {preset?.description && (
                  <p className="text-[10px] text-black/30 mt-3">{preset.description}</p>
                )}
              </div>
            );
          })}
        </div>
      </section>

      {/* 平台设置 */}
      <section className="pt-6 border-t border-black/5">
        <div className="flex items-center gap-2 mb-4">
          <Github size={18} className="text-black/60" />
          <h3 className="text-base font-bold">GitHub 访问</h3>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div className="space-y-1.5">
            <label className={labelCls}>GitHub Token</label>
            <input
              type="password"
              value={githubToken}
              onChange={(e) => onGithubTokenChange(e.target.value)}
              className={inputCls}
              placeholder="可选，ghp_ 或 github_pat_ 开头"
            />
            <p className="text-[10px] text-black/30">
              未配置时匿名访问 GitHub（仅 60 次/小时，极易触发 403 限流）。配置后提升至 5000 次/小时，Token 无需勾选任何权限。
            </p>
          </div>
          <div className="space-y-1.5">
            <label className={labelCls}>AI 流式输出</label>
            <button
              type="button"
              onClick={() => onStreamingChange(!streamingEnabled)}
              className={cn(
                "flex items-center justify-between w-full px-4 py-2.5 rounded-xl border transition-all text-sm",
                streamingEnabled
                  ? "bg-emerald-50 border-emerald-200 text-emerald-700"
                  : "bg-[#F9F9F9] border-black/5 text-black/50"
              )}
            >
              <span className="font-medium">{streamingEnabled ? '已开启' : '已关闭'}</span>
              <span className={cn(
                "relative w-9 h-5 rounded-full transition-colors shrink-0",
                streamingEnabled ? "bg-emerald-500" : "bg-black/15"
              )}>
                <span className={cn(
                  "absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform",
                  streamingEnabled && "translate-x-4"
                )} />
              </span>
            </button>
            <p className="text-[10px] text-black/30">
              开启后在「处理过程」面板实时显示模型生成内容（changelog / 单次 diff / 聚合阶段）。并行批次阶段仍按批次计数。不支持流式的网关会自动回退。
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}
