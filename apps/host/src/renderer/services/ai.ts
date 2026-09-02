// AI 服务层（渲染侧）
//
// 微内核架构下，HTTP 调用、模型适配、流式解析、Agent Tool Calling
// 全部由 Host 主进程的 LlmManager / AgentManager 完成；
// 本文件仅保留：配置类型、Prompt 模板、本地文本检索、IPC 调用封装。

export type AIProvider = 'cloud' | 'ollama';

export type AIMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string;
};

export type AIConfig = {
  provider: AIProvider;
  // cloud
  baseUrl: string;
  apiKey: string;
  model: string;
  // ollama
  ollamaBaseUrl: string;
  ollamaModel: string;
  // 参数
  temperature: number;
  maxTokens: number;
};

export const DEFAULT_CONFIG: AIConfig = {
  provider: 'cloud',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  model: 'gpt-4o-mini',
  ollamaBaseUrl: 'http://127.0.0.1:11434',
  ollamaModel: 'qwen2.5:7b',
  temperature: 0.6,
  maxTokens: 4000,
};

function ensureConfig(config: AIConfig) {
  if (config.provider === 'cloud' && !config.apiKey) {
    throw new Error('请先在设置中配置 AI API Key');
  }
}

/**
 * 通用流式对话 —— 经 Host LlmManager 调用云端/Ollama
 */
export async function chat(
  config: AIConfig,
  messages: AIMessage[],
  onStream?: (chunk: string) => void
): Promise<string> {
  ensureConfig(config);
  return window.electronAPI.llm.chatStream(
    { messages: messages as any[], config: config as any },
    onStream
  );
}

export type AgentEvent =
  | { type: 'status'; message: string }
  | { type: 'tool_start'; name: string; args: any }
  | { type: 'tool_result'; name: string; result: any }
  | { type: 'tool_error'; name: string; error: string }
  | { type: 'delta'; delta: string }
  | { type: 'done'; text: string }
  | { type: 'error'; error: string };

/**
 * Agent Loop —— 经 Host AgentManager 执行；
 * 可调用的工具由插件动态注册（如 calculator、sales_summary）。
 */
export async function runAgent(
  config: AIConfig,
  messages: AIMessage[],
  onEvent?: (ev: AgentEvent) => void
): Promise<string> {
  ensureConfig(config);
  const res = await window.electronAPI.agent.run(
    { messages: messages as any[], config: config as any },
    onEvent as any
  );
  if (!res.ok) throw new Error(res.error || 'Agent 执行失败');
  return res.text || '';
}

// =============== 常用 Prompt 模板 ===============
export function buildSummarizePrompt(text: string, lang = '中文') {
  const sys = `你是专业的文档助理。请用${lang}输出用户提供文档的结构化摘要，包含：\n1) 主题概览（2-3句）\n2) 核心要点（5-8条，用Markdown列表）\n3) 结论 / 建议（如有）。\n请仅基于给定内容，不要虚构。`;
  return [
    { role: 'system', content: sys },
    { role: 'user', content: `文档内容如下：\n\n${text.slice(0, 24000)}` },
  ] as AIMessage[];
}

export function buildQAPrompt(context: string, question: string, lang = '中文') {
  const sys = `你是严谨的文档问答助手。请仅使用下方【文档片段】中的信息回答用户问题，用${lang}输出。如果【文档片段】中没有相关信息，明确告知"文档中未提及此信息"，不要编造答案。引用关键部分可以使用引号。

当用户请求数值计算（如加减乘除、统计求和、平均值等）时，必须调用已提供的工具（如 calculator / sales_summary）完成计算，不要凭记忆心算。`;
  return [
    { role: 'system', content: sys },
    {
      role: 'user',
      content: `【文档片段】\n${context.slice(0, 28000)}\n\n【用户问题】${question}`,
    },
  ] as AIMessage[];
}

export function buildRewritePrompt(
  text: string,
  instruction: string,
  lang = '中文'
) {
  const sys = `你是资深写作润色助手。请按用户要求改写下列文本，保持原有格式（如段落、列表）不变，直接输出改写后的${lang}文本，不要输出额外解释。`;
  return [
    { role: 'system', content: sys },
    {
      role: 'user',
      content: `【改写要求】${instruction}\n\n【原始文本】\n${text.slice(0, 20000)}`,
    },
  ] as AIMessage[];
}

export function buildDataAnalyzePrompt(tableMarkdown: string, question: string, lang = '中文') {
  const sys = `你是资深数据分析助手。请基于给出的表格数据（Markdown格式）回答用户问题。
要求：
- 指出涉及的列/字段；
- 给出必要的统计结果（总数、平均、最大最小、Top N等）；
- 数值计算必须调用提供的工具（如 calculator / sales_summary），不要心算；
- 若请求分类汇总或运算，请明确列出过程与结果；
- 用${lang}输出，条理清晰，必要时可输出 Markdown 表格。`;
  return [
    { role: 'system', content: sys },
    { role: 'user', content: `【表格数据】\n${tableMarkdown.slice(0, 30000)}\n\n【问题】${question || '请给出关键指标分析和数据洞察'}` },
  ] as AIMessage[];
}

// ========= 检索：简单词频 + 滑动窗口（无需向量化即可工作） =========
export function retrieveRelevantChunks(
  documentText: string,
  question: string,
  opts: { chunkSize?: number; topK?: number } = {}
) {
  const chunkSize = opts.chunkSize || 1200;
  const topK = opts.topK || 4;
  const overlap = 200;
  const tokens = tokenize(question);
  if (!documentText || !tokens.size) {
    return documentText.slice(0, chunkSize * topK);
  }
  const chunks: { text: string; score: number; start: number }[] = [];
  for (let i = 0; i < documentText.length; i += chunkSize - overlap) {
    const slice = documentText.slice(i, i + chunkSize);
    let score = 0;
    const sliceLower = slice.toLowerCase();
    tokens.forEach((t) => {
      if (!t) return;
      const re = new RegExp(escapeRegExp(t), 'gi');
      const m = sliceLower.match(re);
      if (m) score += m.length;
    });
    score = score / (1 + Math.log(1 + slice.length / 200));
    if (score > 0) chunks.push({ text: slice, score, start: i });
  }
  chunks.sort((a, b) => b.score - a.score);
  const best = chunks.slice(0, topK);
  best.sort((a, b) => a.start - b.start);
  return best.map((c) => c.text).join('\n\n');
}

function tokenize(s: string) {
  const set = new Set<string>();
  const words = s.toLowerCase().match(/[a-z0-9_]{2,}/g) || [];
  words.forEach((w) => set.add(w));
  const zh = s.match(/[\u4e00-\u9fa5]{2,}/g) || [];
  zh.forEach((z) => {
    for (let i = 0; i < z.length - 1; i++) {
      set.add(z.slice(i, i + 2));
    }
  });
  const nums = s.match(/\d{2,}/g) || [];
  nums.forEach((n) => set.add(n));
  return set;
}

function escapeRegExp(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
