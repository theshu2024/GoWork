/**
 * 统一 IPC 通信层
 *
 * 渲染层（React）所有能力都通过这里访问宿主内核：
 * - dialog:openDocument  文档导入（解析器由 PluginManager 动态提供）
 * - document:write       文档写回（写回器由插件注册）
 * - llm:*                大模型调用（云端 / Ollama，流式经 webContents 推送）
 * - agent:run            Agent Loop（工具由插件动态注册）
 * - plugins:list         已加载插件清单
 * - http:fetch           通用 HTTP（用于设置页连通性检测）
 */
import { ipcMain, dialog, app } from 'electron';
import fs from 'fs';
import path from 'path';
import type { PluginManager } from '../managers/plugin.manager';
import type { LlmManager } from '../managers/llm.manager';
import type { AgentManager, AgentEvent } from '../managers/agent.manager';

interface IpcDeps {
  pluginManager: PluginManager;
  llmManager: LlmManager;
  agentManager: AgentManager;
}

export function registerIpc(deps: IpcDeps): void {
  const { pluginManager, llmManager, agentManager } = deps;

  // ============ 文档导入（解析走插件） ============
  ipcMain.handle('dialog:openDocument', async () => {
    const result = await dialog.showOpenDialog({
      title: '选择办公文档',
      properties: ['openFile', 'multiSelections'],
      filters: [
        {
          name: 'Office 文档',
          extensions: ['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'pdf'],
        },
        { name: 'Word', extensions: ['doc', 'docx'] },
        { name: 'Excel', extensions: ['xls', 'xlsx'] },
        { name: 'PowerPoint', extensions: ['ppt', 'pptx'] },
        { name: 'PDF', extensions: ['pdf'] },
        { name: '所有文件', extensions: ['*'] },
      ],
    });

    if (result.canceled) return { canceled: true, files: [] };

    const files = [];
    for (const filePath of result.filePaths) {
      const ext = path.extname(filePath).toLowerCase();
      const base = {
        id: Buffer.from(filePath).toString('base64'),
        path: filePath,
        name: path.basename(filePath),
        ext: ext.slice(1),
      };

      try {
        const stats = fs.statSync(filePath);
        const parser = pluginManager.getParser(ext);
        if (!parser) {
          files.push({
            ...base,
            size: stats.size,
            error: `暂不支持 .${base.ext} 文件：未安装对应解析插件`,
          });
          continue;
        }
        const parsed = await pluginManager.parse(filePath);
        files.push({
          ...base,
          size: stats.size,
          mtime: stats.mtime.toISOString(),
          content: parsed.text,
          sheets: parsed.sheets,
          slides: parsed.slides,
          meta: parsed.meta,
        });
      } catch (err) {
        console.error('解析文件失败:', filePath, err);
        files.push({
          ...base,
          error: '解析失败: ' + (err as Error).message,
        });
      }
    }

    return { canceled: false, files };
  });

  // ============ 文档写回（写回器走插件） ============
  ipcMain.handle(
    'document:write',
    async (
      _e,
      opts: {
        sourcePath: string;
        saveAs?: boolean;
        outputFormat?: string;
        data: any;
      }
    ) => {
      let targetPath = opts.sourcePath;
      const format = (
        opts.outputFormat || path.extname(opts.sourcePath).slice(1)
      ).toLowerCase();

      if (opts.saveAs) {
        const defaultName =
          path.basename(opts.sourcePath, path.extname(opts.sourcePath)) +
          '_AI修改.' +
          format;
        const res = await dialog.showSaveDialog({
          title: '保存为',
          defaultPath: defaultName,
        });
        if (res.canceled || !res.filePath) return { canceled: true };
        targetPath = res.filePath;
      }

      try {
        const writer = pluginManager.getWriter(format);
        if (!writer) {
          return {
            canceled: false,
            error: `不支持写回 .${format} 文件：未安装对应插件`,
          };
        }
        const buffer = await writer(opts.data);
        fs.writeFileSync(targetPath, buffer);
        return { canceled: false, savedPath: targetPath };
      } catch (err) {
        return { canceled: false, error: (err as Error).message };
      }
    }
  );

  // ============ LLM 非流式 ============
  ipcMain.handle('llm:chat', async (_e, payload: { messages: any[]; config?: any }) => {
    try {
      const result = await llmManager.chat(payload.messages, payload.config);
      return { ok: true, text: result.text };
    } catch (err: any) {
      return { ok: false, error: err.message };
    }
  });

  // ============ LLM 流式（delta 通过 llm:stream 事件推送） ============
  ipcMain.handle(
    'llm:chatStream',
    async (event, payload: { requestId: string; messages: any[]; config?: any }) => {
      const send = (patch: Record<string, any>) =>
        event.sender.send('llm:stream', { requestId: payload.requestId, ...patch });
      try {
        const text = await llmManager.chatStream(
          payload.messages,
          payload.config,
          (delta) => send({ delta })
        );
        send({ done: true, fullText: text });
        return { ok: true, text };
      } catch (err: any) {
        send({ error: err.message });
        return { ok: false, error: err.message };
      }
    }
  );

  // ============ LLM 配置持久化 ============
  ipcMain.handle('llm:saveConfig', (_e, payload: { config: any }) => {
    try {
      llmManager.setConfig(payload.config);
      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('llm:getConfig', async () => {
    return { ok: true, config: llmManager.getConfig() };
  });

  // ============ Agent Loop（工具动态来自插件） ============
  ipcMain.handle(
    'agent:run',
    async (
      event,
      payload: { requestId: string; messages: any[]; config?: any; maxRounds?: number }
    ) => {
      const send = (ev: AgentEvent) =>
        event.sender.send('agent:event', { requestId: payload.requestId, ...ev });
      try {
        const result = await agentManager.run(
          {
            messages: payload.messages,
            config: payload.config,
            maxRounds: payload.maxRounds,
          },
          send
        );
        return { ok: true, text: result.text };
      } catch (err: any) {
        send({ type: 'error', error: err.message });
        return { ok: false, error: err.message };
      }
    }
  );

  // ============ 插件清单 ============
  ipcMain.handle('plugins:list', async () => {
    return { ok: true, plugins: pluginManager.listManifests() };
  });

  // ============ 通用 HTTP（设置页连通性检测等） ============
  ipcMain.handle(
    'http:fetch',
    async (
      _e,
      params: { url: string; method: string; headers?: Record<string, string>; body?: string }
    ) => {
      try {
        const res = await fetch(params.url, {
          method: params.method || 'GET',
          headers: params.headers || {},
          body: params.body ? params.body : undefined,
        });
        const text = await res.text();
        return {
          ok: true,
          status: res.status,
          statusText: res.statusText,
          body: text,
        };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    }
  );

  ipcMain.handle('app:getPath', async (_e, name: any) => {
    return app.getPath(name as any);
  });
}
