import { ModelProtocol } from '../types';

/** 预置模型厂商：参考 Dify 的供应商目录，覆盖国内主流厂商与三大协议 */
export interface ProviderPreset {
  id: string;
  name: string;
  protocol: ModelProtocol;
  defaultBaseUrl: string;
  defaultModel: string;
  /** 常用模型建议列表（可手填覆盖） */
  models: string[];
  /** API Key 申请入口 */
  keyUrl?: string;
  description?: string;
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: 'deepseek',
    name: 'DeepSeek 深度求索',
    protocol: 'openai',
    defaultBaseUrl: 'https://api.deepseek.com/v1',
    defaultModel: 'deepseek-chat',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    keyUrl: 'https://platform.deepseek.com/api_keys'
  },
  {
    id: 'qwen',
    name: '通义千问 (阿里云百炼)',
    protocol: 'openai',
    defaultBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    defaultModel: 'qwen-plus',
    models: ['qwen-plus', 'qwen-max', 'qwen-turbo', 'qwen-long'],
    keyUrl: 'https://bailian.console.aliyun.com/?apiKey=1'
  },
  {
    id: 'moonshot',
    name: 'Kimi (月之暗面)',
    protocol: 'openai',
    defaultBaseUrl: 'https://api.moonshot.cn/v1',
    defaultModel: 'kimi-latest',
    models: ['kimi-latest', 'moonshot-v1-32k', 'moonshot-v1-128k'],
    keyUrl: 'https://platform.moonshot.cn/console/api-keys'
  },
  {
    id: 'zhipu',
    name: '智谱 GLM',
    protocol: 'openai',
    defaultBaseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    defaultModel: 'glm-4-plus',
    models: ['glm-4-plus', 'glm-4-air', 'glm-4-flash'],
    keyUrl: 'https://open.bigmodel.cn/usercenter/apikeys'
  },
  {
    id: 'doubao',
    name: '豆包 (火山方舟)',
    protocol: 'openai',
    defaultBaseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    defaultModel: '',
    models: [],
    keyUrl: 'https://console.volcengine.com/ark',
    description: '模型名填接入点 ID（ep-xxx）或开通的模型名，如 doubao-1-5-pro-32k-250115'
  },
  {
    id: 'minimax',
    name: 'MiniMax',
    protocol: 'openai',
    defaultBaseUrl: 'https://api.minimax.chat/v1',
    defaultModel: 'MiniMax-Text-01',
    models: ['MiniMax-Text-01', 'abab6.5s-chat'],
    keyUrl: 'https://platform.minimaxi.com/user-center/basic-information/interface-key'
  },
  {
    id: 'siliconflow',
    name: '硅基流动 SiliconFlow',
    protocol: 'openai',
    defaultBaseUrl: 'https://api.siliconflow.cn/v1',
    defaultModel: 'deepseek-ai/DeepSeek-V3',
    models: ['deepseek-ai/DeepSeek-V3', 'deepseek-ai/DeepSeek-R1', 'Qwen/Qwen2.5-72B-Instruct'],
    keyUrl: 'https://cloud.siliconflow.cn/account/ak'
  },
  {
    id: 'openai',
    name: 'OpenAI',
    protocol: 'openai',
    defaultBaseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o',
    models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'o3-mini'],
    keyUrl: 'https://platform.openai.com/api-keys'
  },
  {
    id: 'anthropic',
    name: 'Anthropic Claude',
    protocol: 'anthropic',
    defaultBaseUrl: 'https://api.anthropic.com',
    defaultModel: 'claude-sonnet-4-6',
    models: ['claude-sonnet-4-6', 'claude-opus-4-8', 'claude-haiku-4-5-20251001'],
    keyUrl: 'https://console.anthropic.com/settings/keys'
  },
  {
    id: 'gemini',
    name: 'Google Gemini',
    protocol: 'gemini',
    defaultBaseUrl: 'https://generativelanguage.googleapis.com',
    defaultModel: 'gemini-2.0-flash',
    models: ['gemini-2.0-flash', 'gemini-2.5-pro', 'gemini-2.5-flash'],
    keyUrl: 'https://aistudio.google.com/apikey'
  },
  {
    id: 'custom-openai',
    name: '自定义 (OpenAI 兼容)',
    protocol: 'openai',
    defaultBaseUrl: '',
    defaultModel: '',
    models: [],
    description: '任何兼容 /chat/completions 协议的服务（One-API、Ollama、vLLM、第三方中转等）'
  },
  {
    id: 'custom-anthropic',
    name: '自定义 (Anthropic 兼容)',
    protocol: 'anthropic',
    defaultBaseUrl: '',
    defaultModel: '',
    models: [],
    description: '任何兼容 /v1/messages 协议的服务'
  }
];

export function getPreset(presetId: string): ProviderPreset | undefined {
  return PROVIDER_PRESETS.find(p => p.id === presetId);
}
