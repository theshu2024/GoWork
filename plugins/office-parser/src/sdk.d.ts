/**
 * 插件 SDK 类型声明（与 apps/host/src/types/plugin.sdk.ts 保持同步）
 *
 * 真实发布形态下，插件应依赖 @aioffice/plugin-sdk 包；
 * monorepo 内置插件直接内置本声明文件，保证插件可独立编译。
 */

export interface PluginManifest {
  name: string;
  version: string;
  displayName: string;
  description: string;
  entry: string;
  capabilities: string[];
  author?: string;
}

export interface FileParseResult {
  text: string;
  sheets?: { name: string; data: any[][] }[];
  slides?: { index: number; text: string }[];
  meta?: Record<string, any>;
}

export type FileParser = (filePath: string) => Promise<FileParseResult | string>;
export type DocumentWriter = (data: any) => Promise<Buffer>;

export interface AgentToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, any>;
  execute(args: any): Promise<any>;
}

export interface HostContext {
  registerFileParser(ext: string, parser: FileParser): void;
  registerDocumentWriter(format: string, writer: DocumentWriter): void;
  registerAgentTool(tool: AgentToolDefinition): void;
  logger: {
    info(message: string): void;
    warn(message: string): void;
    error(message: string, error?: any): void;
  };
  llm: {
    chat(messages: any[], config?: any): Promise<{ text: string }>;
    chatStream(
      messages: any[],
      config?: any,
      onDelta?: (delta: string) => void
    ): Promise<string>;
  };
  pluginsDir: string;
}

export interface IDesktopPlugin {
  onActivate(context: HostContext): Promise<void>;
  onDeactivate(): Promise<void>;
}
