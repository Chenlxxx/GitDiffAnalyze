import { GoogleGenAI, Type } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || '' });

export interface ChangeLogAnalysis {
  items: {
    title: string;
    prNumber?: number;
    reason: string;
    impactLevel: 'High' | 'Medium' | 'Low';
  }[];
  summary: string;
}

export interface DiffAnalysis {
  riskLevel: 'High' | 'Medium' | 'Low';
  breakingChanges: string[];
  compatibilityNotes: string[];
  recommendations: string[];
  codeExample?: {
    before: string;
    after: string;
  };
}

export class GeminiService {
  static async analyzeChangeLog(
    changeLog: string,
    projectBackground: string
  ): Promise<ChangeLogAnalysis> {
    try {
      const response = await ai.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: `
          分析以下 GitHub 发布变更日志，并识别对具有此背景的项目产生影响的所有条目：
          
          项目背景：${projectBackground}
          
          变更日志：
          ${changeLog}
          
          任务：
          1. 提供该版本的简明摘要（中文）。
          2. **必须识别并罗列变更日志中的每一个条目，严禁遗漏任何一项**。包括所有分类（如 Documentation, Refactor, Fix, Feature 等）下的每一个 PR 或提交。
          3. 对于每一个条目，根据提供的背景评估影响等级（高、中、低）。
          4. 如果影响等级为“低”，请用一句话解释为什么该项对当前项目背景风险较低。
          5. 如果影响等级为“高”或“中”，请详细说明它如何影响项目。
          6. 必须提取每个条目对应的 Pull Request 编号（例如 #123 或 PR #123）。
          
          请务必使用中文回答，确保输出的 items 数组长度与变更日志中的条目总数一致。
        `,
        config: {
          responseMimeType: "application/json",
          maxOutputTokens: 8192,
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              items: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    title: { type: Type.STRING },
                    prNumber: { type: Type.INTEGER, description: "Extract the PR number if available" },
                    reason: { type: Type.STRING, description: "Why this impacts the project or why risk is low" },
                    impactLevel: { type: Type.STRING, enum: ["High", "Medium", "Low"] }
                  },
                  required: ["title", "reason", "impactLevel"]
                }
              },
              summary: { type: Type.STRING }
            },
            required: ["items", "summary"]
          }
        }
      });

      const text = response.text || '{}';
      return JSON.parse(text);
    } catch (error) {
      console.error('Error analyzing change log:', error);
      return {
        items: [],
        summary: "分析变更日志失败。请重试。"
      };
    }
  }

  static async analyzeDiff(
    diff: string,
    prTitle: string,
    projectBackground: string
  ): Promise<DiffAnalysis> {
    try {
      const response = await ai.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: `
          分析以下代码差异以识别兼容性风险和破坏性变更。
          
          PR 标题：${prTitle}
          项目背景：${projectBackground}
          
          差异内容：
          ${diff.slice(0, 30000)}
          
          任务：
          1. 识别任何破坏性变更（API 更改、删除的方法、更改的签名）。
          2. 评估项目背景的风险级别。
          3. 提供具体的迁移或测试建议。
          4. 提供代码示例，展示在项目代码中如何进行变动以保持兼容。
             - "before": 修改前的项目代码示例
             - "after": 修改后的项目代码示例
          
          请务必使用中文回答。
        `,
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              riskLevel: { type: Type.STRING, enum: ["High", "Medium", "Low"] },
              breakingChanges: { type: Type.ARRAY, items: { type: Type.STRING } },
              compatibilityNotes: { type: Type.ARRAY, items: { type: Type.STRING } },
              recommendations: { type: Type.ARRAY, items: { type: Type.STRING } },
              codeExample: {
                type: Type.OBJECT,
                properties: {
                  before: { type: Type.STRING },
                  after: { type: Type.STRING }
                },
                required: ["before", "after"]
              }
            },
            required: ["riskLevel", "breakingChanges", "compatibilityNotes", "recommendations", "codeExample"]
          }
        }
      });

      const text = response.text || '{}';
      return JSON.parse(text);
    } catch (error) {
      console.error('Error analyzing diff:', error);
      return {
        riskLevel: 'Medium',
        breakingChanges: ["分析差异内容失败。"],
        compatibilityNotes: ["发生分析错误。"],
        recommendations: ["请在 GitHub 上手动查看 PR 差异。"]
      };
    }
  }
}
