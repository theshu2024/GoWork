/**
 * LlmManager —— 宿主大模型调度器
 *
 * - 统一封装云端 OpenAI 兼容接口 与 本地 Ollama
 * - 支持非流式 chat / 流式 chatStream（SSE / NDJSON）
 * - 支持 Tool Calling（chatWithTools），供 AgentManager 使用
 * - 配置可由渲染层传入，也可持久化到 userData 供插件 context.llm 使用
 */
import fs from 'fs';

export interface LLMConfig {
  provider: 'cloud' | 'ollama';
  baseUrl: string;
  apiKey: string;
  model: string;
  ollamaBaseUrl: string;
  ollamaModel: string;
  temperature: number;
  maxTokens: number;
}

export interface NormalizedToolCall {
  id: string;
  name: string;
  args: any;
}

export interface ChatWithToolsResult {
  text: string | null;
  toolCalls: NormalizedToolCall[];
}

function safeJsonParse(s: string): any {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}

export class LlmManager {
  private cachedConfig: LLMConfig | null = null;

  constructor(private configFilePath?: string) {}

  // ---------- 配置持久化 ----------
  setConfig(config: LLMConfig): void {
    this.cachedConfig = config;
    if (this.configFilePath) {
      try {
        fs.writeFileSync(this.configFilePath, JSON.stringify(config, null, 2), 'utf-8');
      } catch (err) {
        console.error('[LlmManager] 配置持久化失败:', err);
      }
    }
  }

  getConfig(): LLMConfig | null {
    if (this.cachedConfig) return this.cachedConfig;
    if (this.configFilePath && fs.existsSync(this.configFilePath)) {
      try {
        this.cachedConfig = JSON.parse(
          fs.readFileSync(this.configFilePath, 'utf-8')
        );
      } catch {}
    }
    return this.cachedConfig;
  }

  private resolveConfig(config?: Partial<LLMConfig>): LLMConfig {
    const merged = { ...(this.getConfig() || {}), ...(config || {}) } as LLMConfig;
    if (!merged.provider) throw new Error('LLM 未配置：请先在设置中选择模型提供方');
    if (merged.provider === 'cloud' && !merged.apiKey) {
      throw new Error('请先在设置中配置云端 API Key');
    }
    return merged;
  }

  // ---------- 非流式 ----------
  async chat(messages: any[], config?: Partial<LLMConfig>): Promise<{ text: string }> {
    const cfg = this.resolveConfig(config);
    if (cfg.provider === 'ollama') {
      const data = await this.ollamaRequest(cfg, messages, false, undefined);
      return { text: data?.message?.content || '' };
    }
    const data = await this.cloudRequest(cfg, messages, false, undefined);
    return { text: data?.choices?.[0]?.message?.content || '' };
  }

  // ---------- 流式 ----------
  async chatStream(
    messages: any[],
    config?: Partial<LLMConfig>,
    onDelta?: (delta: string) => void
  ): Promise<string> {
    const cfg = this.resolveConfig(config);
    let full = '';
    if (cfg.provider === 'ollama') {
      await this.ollamaRequest(cfg, messages, true, (line) => {
        const obj = safeJsonParse(line);
        const ch = obj?.message?.content || '';
        if (ch) {
          full += ch;
          onDelta?.(ch);
        }
      });
    } else {
      await this.cloudRequest(cfg, messages, true, (line) => {
        if (!line.startsWith('data:')) return;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') return;
        const obj = safeJsonParse(payload);
        const ch = obj?.choices?.[0]?.delta?.content || '';
        if (ch) {
          full += ch;
          onDelta?.(ch);
        }
      });
    }
    return full;
  }

  // ---------- Tool Calling（非流式，供 Agent Loop） ----------
  async chatWithTools(
    messages: any[],
    config: Partial<LLMConfig> | undefined,
    tools: { name: string; description: string; parameters: Record<string, any> }[]
  ): Promise<ChatWithToolsResult> {
    const cfg = this.resolveConfig(config);
    const toolSchemas =
      tools.length > 0
        ? tools.map((t) => ({
            type: 'function',
            function: { name: t.name, description: t.description, parameters: t.parameters },
          }))
        : undefined;

    if (cfg.provider === 'ollama') {
      const data = await this.ollamaRequest(cfg, messages, false, undefined, toolSchemas);
      const msg = data?.message || {};
      const rawCalls: any[] = msg.tool_calls || [];
      return {
        text: msg.content || null,
        toolCalls: rawCalls.map((tc, i) => ({
          id: `call_ollama_${Date.now()}_${i}`,
          name: tc?.function?.name,
          args:
            typeof tc?.function?.arguments === 'string'
              ? safeJsonParse(tc.function.arguments)
              : tc?.function?.arguments || {},
        })),
      };
    }

    const data = await this.cloudRequest(cfg, messages, false, undefined, toolSchemas);
    const msg = data?.choices?.[0]?.message || {};
    const rawCalls: any[] = msg.tool_calls || [];
    return {
      text: msg.content || null,
      toolCalls: rawCalls.map((tc) => ({
        id: tc.id,
        name: tc?.function?.name,
        args: safeJsonParse(tc?.function?.arguments || '{}'),
      })),
    };
  }

  // ---------- HTTP 实现 ----------
  private async cloudRequest(
    cfg: LLMConfig,
    messages: any[],
    stream: boolean,
    onLine?: (line: string) => void,
    tools?: any[]
  ): Promise<any> {
    const url = `${cfg.baseUrl.replace(/\/$/, '')}/chat/completions`;
    const body: Record<string, any> = {
      model: cfg.model,
      messages,
      temperature: cfg.temperature,
      max_tokens: cfg.maxTokens,
    };
    if (tools) body.tools = tools;
    if (stream) body.stream = true;

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`云端模型请求失败 [${res.status}]: ${errText.slice(0, 500)}`);
    }

    if (!stream) return res.json();
    await this.consumeSSE(res, onLine!);
    return null;
  }

  private async ollamaRequest(
    cfg: LLMConfig,
    messages: any[],
    stream: boolean,
    onLine?: (line: string) => void,
    tools?: any[]
  ): Promise<any> {
    const url = `${cfg.ollamaBaseUrl.replace(/\/$/, '')}/api/chat`;
    const body: Record<string, any> = {
      model: cfg.ollamaModel,
      messages,
      stream,
      options: {
        temperature: cfg.temperature,
        num_predict: cfg.maxTokens,
      },
    };
    if (tools) body.tools = tools;

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Ollama 请求失败 [${res.status}]: ${errText.slice(0, 500)}`);
    }

    if (!stream) return res.json();
    await this.consumeSSE(res, onLine!);
    return null;
  }

  /** 读取流式响应体，按行回调（SSE data: 行 或 NDJSON 均兼容） */
  private async consumeSSE(
    res: Response,
    onLine: (line: string) => void
  ): Promise<void> {
    const reader = res.body?.getReader();
    if (!reader) throw new Error('响应体不可读');
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (line) onLine(line);
      }
    }
    if (buffer.trim()) onLine(buffer.trim());
  }
}
