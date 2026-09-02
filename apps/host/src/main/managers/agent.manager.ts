/**
 * AgentManager —— Agent Loop 调度
 *
 * 每轮将「插件注册的工具」动态组装为 LLM tools 参数：
 * - 模型返回 tool_calls → 执行对应插件工具 → 结果回填 → 继续下一轮
 * - 模型返回普通文本 → 作为最终答复（以 delta 事件流式推给前端）
 */
import type { LlmManager, LLMConfig } from './llm.manager';
import type { PluginManager } from './plugin.manager';

export type AgentEvent =
  | { type: 'status'; message: string }
  | { type: 'tool_start'; name: string; args: any }
  | { type: 'tool_result'; name: string; result: any }
  | { type: 'tool_error'; name: string; error: string }
  | { type: 'delta'; delta: string }
  | { type: 'done'; text: string }
  | { type: 'error'; error: string };

export interface AgentRunParams {
  messages: any[];
  config?: Partial<LLMConfig>;
  maxRounds?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class AgentManager {
  constructor(
    private llm: LlmManager,
    private pluginManager: PluginManager
  ) {}

  async run(
    params: AgentRunParams,
    onEvent: (e: AgentEvent) => void
  ): Promise<{ text: string }> {
    const maxRounds = params.maxRounds || 6;
    const tools = this.pluginManager.getRegisteredTools();
    const toolSchemas = tools.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }));

    const messages = [...params.messages];
    const provider = params.config?.provider || this.llm.getConfig()?.provider;

    try {
      for (let round = 0; round < maxRounds; round++) {
        onEvent({ type: 'status', message: `思考中（第 ${round + 1} 轮）…` });

        const res = await this.llm.chatWithTools(
          messages,
          params.config,
          toolSchemas
        );

        if (res.toolCalls.length > 0) {
          // 记录 assistant 的工具调用消息
          messages.push(this.buildAssistantToolMessage(provider, res.text, res.toolCalls));

          for (const call of res.toolCalls) {
            onEvent({ type: 'tool_start', name: call.name, args: call.args });
            const tool = tools.find((t) => t.name === call.name);
            let result: any;
            if (!tool) {
              const errMsg = `工具 "${call.name}" 未注册（可能插件未加载）`;
              onEvent({ type: 'tool_error', name: call.name, error: errMsg });
              result = { error: errMsg };
            } else {
              try {
                result = await tool.execute(call.args);
                onEvent({ type: 'tool_result', name: call.name, result });
              } catch (err: any) {
                const errMsg = err?.message || String(err);
                onEvent({ type: 'tool_error', name: call.name, error: errMsg });
                result = { error: errMsg };
              }
            }
            messages.push(this.buildToolResultMessage(provider, call, result));
          }
          continue;
        }

        // 最终答复：分片推送，模拟打字机效果
        const text = res.text || '';
        for (let i = 0; i < text.length; i += 3) {
          onEvent({ type: 'delta', delta: text.slice(i, i + 3) });
          await sleep(12);
        }
        onEvent({ type: 'done', text });
        return { text };
      }
      throw new Error(`已达到最大工具调用轮数（${maxRounds}），请简化任务后重试`);
    } catch (err: any) {
      const msg = err?.message || String(err);
      onEvent({ type: 'error', error: msg });
      throw err;
    }
  }

  /** 组装 assistant 发起工具调用的消息（云端 / Ollama 协议差异处理） */
  private buildAssistantToolMessage(
    provider: string | undefined,
    text: string | null,
    toolCalls: { id: string; name: string; args: any }[]
  ): any {
    if (provider === 'ollama') {
      // Ollama 期望 assistant 消息携带 tool_calls
      return {
        role: 'assistant',
        content: text || '',
        tool_calls: toolCalls.map((c) => ({
          function: { name: c.name, arguments: c.args },
        })),
      };
    }
    return {
      role: 'assistant',
      content: text || '',
      tool_calls: toolCalls.map((c) => ({
        id: c.id,
        type: 'function',
        function: { name: c.name, arguments: JSON.stringify(c.args) },
      })),
    };
  }

  /** 组装工具执行结果消息 */
  private buildToolResultMessage(
    provider: string | undefined,
    call: { id: string; name: string },
    result: any
  ): any {
    const content = typeof result === 'string' ? result : JSON.stringify(result);
    if (provider === 'ollama') {
      // Ollama 用 role=user 携带工具结果（兼容性最好）
      return {
        role: 'user',
        content: `[工具 ${call.name} 执行结果]\n${content}`,
      };
    }
    return {
      role: 'tool',
      tool_call_id: call.id,
      name: call.name,
      content,
    };
  }
}
