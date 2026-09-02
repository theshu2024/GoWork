/**
 * Preload 桥接：以安全、类型化的方式向渲染层暴露宿主能力
 */
import { contextBridge, ipcRenderer } from 'electron';

export type ParsedDocument = {
  id: string;
  path: string;
  name: string;
  size?: number;
  ext: string;
  mtime?: string;
  content?: string;
  sheets?: { name: string; data: any[][] }[];
  slides?: { index: number; text: string }[];
  meta?: Record<string, any>;
  error?: string;
};

function uid() {
  return 'req_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
}

const api = {
  // ---------- 文档 ----------
  openDocument: () =>
    ipcRenderer.invoke('dialog:openDocument') as Promise<{
      canceled: boolean;
      files: ParsedDocument[];
    }>,
  writeDocument: (opts: {
    sourcePath: string;
    saveAs?: boolean;
    outputFormat?: string;
    data: any;
  }) =>
    ipcRenderer.invoke('document:write', opts) as Promise<{
      canceled: boolean;
      savedPath?: string;
      error?: string;
    }>,

  // ---------- LLM ----------
  llm: {
    chat: (messages: any[], config?: any) =>
      ipcRenderer.invoke('llm:chat', { messages, config }) as Promise<{
        ok: boolean;
        text?: string;
        error?: string;
      }>,
    /** 流式对话：onDelta 收到增量文本，Promise resolve 完整文本 */
    chatStream: (
      payload: { messages: any[]; config?: any },
      onDelta?: (delta: string) => void
    ): Promise<string> => {
      const requestId = uid();
      return new Promise((resolve, reject) => {
        const handler = (_e: unknown, p: any) => {
          if (p.requestId !== requestId) return;
          if (p.delta) onDelta?.(p.delta);
          if (p.done) {
            cleanup();
            resolve(p.fullText || '');
          }
          if (p.error) {
            cleanup();
            reject(new Error(p.error));
          }
        };
        const cleanup = () => ipcRenderer.removeListener('llm:stream', handler);
        ipcRenderer.on('llm:stream', handler);
        ipcRenderer
          .invoke('llm:chatStream', {
            requestId,
            messages: payload.messages,
            config: payload.config,
          })
          .catch((err) => {
            cleanup();
            reject(err);
          });
      });
    },
    saveConfig: (config: any) =>
      ipcRenderer.invoke('llm:saveConfig', { config }) as Promise<{ ok: boolean; error?: string }>,
    getConfig: () =>
      ipcRenderer.invoke('llm:getConfig') as Promise<{ ok: boolean; config?: any }>,
  },

  // ---------- Agent（Tool Calling Loop） ----------
  agent: {
    run: (
      payload: { messages: any[]; config?: any; maxRounds?: number },
      onEvent?: (ev: any) => void
    ): Promise<{ ok: boolean; text?: string; error?: string }> => {
      const requestId = uid();
      return new Promise((resolve, reject) => {
        const handler = (_e: unknown, p: any) => {
          if (p.requestId !== requestId) return;
          // 剥离 requestId 后投递给业务回调
          const { requestId: _r, ...ev } = p;
          onEvent?.(ev);
          if (ev.type === 'done') {
            cleanup();
            resolve({ ok: true, text: ev.text });
          }
          if (ev.type === 'error') {
            cleanup();
            resolve({ ok: false, error: ev.error });
          }
        };
        const cleanup = () => ipcRenderer.removeListener('agent:event', handler);
        ipcRenderer.on('agent:event', handler);
        ipcRenderer
          .invoke('agent:run', { requestId, ...payload })
          .then((r: any) => {
            if (r && r.ok === false) {
              cleanup();
              resolve(r);
            }
          })
          .catch((err) => {
            cleanup();
            reject(err);
          });
      });
    },
  },

  // ---------- 插件 ----------
  plugins: {
    list: () =>
      ipcRenderer.invoke('plugins:list') as Promise<{
        ok: boolean;
        plugins: {
          name: string;
          version: string;
          displayName: string;
          description: string;
          capabilities: string[];
        }[];
      }>,
  },

  // ---------- 通用 ----------
  fetch: (params: {
    url: string;
    method: string;
    headers?: Record<string, string>;
    body?: string;
  }) =>
    ipcRenderer.invoke('http:fetch', params) as Promise<{
      ok: boolean;
      status?: number;
      body?: string;
      error?: string;
    }>,
  getPath: (name: string) =>
    ipcRenderer.invoke('app:getPath', name) as Promise<string>,
};

contextBridge.exposeInMainWorld('electronAPI', api);

export type ElectronAPI = typeof api;
