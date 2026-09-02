/**
 * PluginManager —— Host 微内核的核心组件
 *
 * 职责：
 * 1. 扫描内置插件目录（resources/plugins / 仓库 plugins/）与用户插件目录（userData/plugins）
 * 2. 读取插件 package.json 并校验 pluginConfig 元数据
 * 3. 动态 import() 载入插件入口，实例化并调用 onActivate(hostContext)
 * 4. 集中管理插件注册的文件解析器、文档写回器、Agent 工具
 */
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import type {
  AgentToolDefinition,
  DocumentWriter,
  FileParser,
  FileParseResult,
  HostContext,
  IDesktopPlugin,
  PluginManifest,
} from '../../types/plugin.sdk';

interface LoadedPlugin {
  instance: IDesktopPlugin;
  manifest: PluginManifest;
  dir: string;
}

/** LLM 能力的最小结构（由 LlmManager 注入，避免与 electron 耦合以便单测） */
export interface LlmLike {
  chat(messages: any[], config?: any): Promise<{ text: string }>;
  chatStream(
    messages: any[],
    config?: any,
    onDelta?: (delta: string) => void
  ): Promise<string>;
}

function normalizeExt(ext: string): string {
  const e = ext.trim().toLowerCase();
  return e.startsWith('.') ? e : '.' + e;
}

function normalizeFormat(fmt: string): string {
  return fmt.trim().toLowerCase().replace(/^\./, '');
}

export class PluginManager {
  private plugins = new Map<string, LoadedPlugin>();
  private fileParsers = new Map<string, FileParser>();
  private writers = new Map<string, DocumentWriter>();
  private agentTools = new Map<string, AgentToolDefinition>();
  private context: HostContext;

  /**
   * @param pluginsDirs 插件搜索目录（按顺序扫描，先扫到的同名插件优先生效）
   * @param llmManager  宿主 LLM 管理器，注入给插件 context.llm 使用
   */
  constructor(
    private pluginsDirs: string[],
    private llmManager: LlmLike,
    private userPluginsDir?: string
  ) {
    this.context = {
      pluginsDir: userPluginsDir || pluginsDirs[pluginsDirs.length - 1] || '',
      registerFileParser: (ext, parser) => {
        const key = normalizeExt(ext);
        this.fileParsers.set(key, parser);
        console.log(`[PluginManager] Registered parser for: ${key}`);
      },
      registerDocumentWriter: (format, writer) => {
        const key = normalizeFormat(format);
        this.writers.set(key, writer);
        console.log(`[PluginManager] Registered document writer for: .${key}`);
      },
      registerAgentTool: (tool) => {
        if (!tool?.name) {
          console.warn('[PluginManager] registerAgentTool: tool.name 缺失，已忽略');
          return;
        }
        this.agentTools.set(tool.name, tool);
        console.log(`[PluginManager] Registered agent tool: ${tool.name}`);
      },
      logger: {
        info: (msg) => console.log(`[Plugin-Log] ${msg}`),
        warn: (msg) => console.warn(`[Plugin-Warn] ${msg}`),
        error: (msg, err) => console.error(`[Plugin-Error] ${msg}`, err),
      },
      llm: {
        chat: async (messages, config) => this.llmManager.chat(messages, config),
        chatStream: async (messages, config, onDelta) =>
          this.llmManager.chatStream(messages, config, onDelta),
      },
    };
  }

  /** 扫描并加载所有目录下的插件 */
  async loadPlugins(): Promise<void> {
    for (const dir of this.pluginsDirs) {
      try {
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
          continue;
        }
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          await this.loadSinglePlugin(path.join(dir, entry.name));
        }
      } catch (err) {
        console.error(`[PluginManager] 扫描插件目录失败: ${dir}`, err);
      }
    }
  }

  /** 加载单个插件目录 */
  private async loadSinglePlugin(pluginPath: string): Promise<void> {
    try {
      const pkgPath = path.join(pluginPath, 'package.json');
      if (!fs.existsSync(pkgPath)) return;

      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      const manifest: PluginManifest | undefined = pkg.pluginConfig;
      if (!manifest) {
        // 普通 npm 包，不是插件，静默跳过
        return;
      }
      if (!manifest.name || !manifest.entry) {
        console.warn(`[PluginManager] 插件元数据不完整，已跳过: ${pluginPath}`);
        return;
      }
      if (this.plugins.has(manifest.name)) {
        console.log(`[PluginManager] 插件 ${manifest.name} 已加载，跳过重复项`);
        return;
      }

      const entryPath = path.resolve(pluginPath, manifest.entry);
      if (!fs.existsSync(entryPath)) {
        console.error(
          `[PluginManager] 插件入口不存在: ${entryPath}，请先构建插件（npm run build:plugins）`
        );
        return;
      }

      // Node 动态加载（CJS / ESM 均可）
      const mod = await import(pathToFileURL(entryPath).href);
      // tsc 编译的 CJS 插件：mod.default 即 exports.default；兼容多层 default
      const PluginClass =
        (mod as any).default?.default || (mod as any).default || mod;
      if (typeof PluginClass !== 'function') {
        throw new Error('插件入口未导出默认类（需要 module.exports.default = PluginClass）');
      }

      const instance: IDesktopPlugin = new PluginClass();
      if (typeof instance.onActivate !== 'function') {
        throw new Error('插件未实现 onActivate(context) 方法');
      }
      await instance.onActivate(this.context);

      this.plugins.set(manifest.name, { instance, manifest, dir: pluginPath });
      console.log(
        `[PluginManager] Successfully activated plugin: ${manifest.name} v${manifest.version} (${manifest.displayName})`
      );
    } catch (error) {
      console.error(`[PluginManager] Failed to load plugin at ${pluginPath}:`, error);
    }
  }

  /** 卸载所有插件（应用退出时调用） */
  async unloadAll(): Promise<void> {
    for (const [name, loaded] of this.plugins) {
      try {
        await loaded.instance.onDeactivate?.();
        console.log(`[PluginManager] Deactivated plugin: ${name}`);
      } catch (err) {
        console.error(`[PluginManager] 卸载插件失败: ${name}`, err);
      }
    }
    this.plugins.clear();
    this.fileParsers.clear();
    this.writers.clear();
    this.agentTools.clear();
  }

  /** 获取文件解析器（ext 形如 ".docx"） */
  getParser(ext: string): FileParser | undefined {
    return this.fileParsers.get(normalizeExt(ext));
  }

  /** 通过插件解析文件，返回统一的结构化结果 */
  async parse(filePath: string): Promise<FileParseResult> {
    const ext = path.extname(filePath);
    const parser = this.getParser(ext);
    if (!parser) {
      throw new Error(
        `暂不支持该文件类型的解析: ${ext || '(无扩展名)'}，请检查是否安装对应插件。`
      );
    }
    const result = await parser(filePath);
    return typeof result === 'string' ? { text: result } : result;
  }

  /** 获取文档写回器（format 形如 "docx"） */
  getWriter(format: string): DocumentWriter | undefined {
    return this.writers.get(normalizeFormat(format));
  }

  /** 获取所有已注册的 Agent 工具 */
  getRegisteredTools(): AgentToolDefinition[] {
    return Array.from(this.agentTools.values());
  }

  /** 列出已加载插件的元数据（供 UI 展示） */
  listManifests(): PluginManifest[] {
    return Array.from(this.plugins.values()).map((p) => p.manifest);
  }
}
