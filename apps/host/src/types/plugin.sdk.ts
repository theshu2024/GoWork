/**
 * 插件 SDK 契约（Host <-> Plugin 标准接口）
 *
 * 所有插件通过 `import type { ... }` 引用本文件；
 * 类型仅在编译期使用，不会产生运行时耦合。
 */

/** 1. 插件元数据规范（对应插件 package.json 中的 "pluginConfig" 字段） */
export interface PluginManifest {
  /** 唯一标识，如 "plugin-office-parser" */
  name: string;
  version: string;
  displayName: string;
  description: string;
  /** 插件入口文件（相对插件目录），如 "dist/index.js" */
  entry: string;
  /** 声明插件需要的权限/能力，如 ["file-system", "llm-call", "document-write"] */
  capabilities: string[];
  author?: string;
}

/**
 * 文件解析结果。
 * 基础契约只要求 text；插件可附带结构化数据（sheets/slides/meta）供宿主使用。
 */
export interface FileParseResult {
  text: string;
  /** Excel 等表格类文档的工作表数据 */
  sheets?: { name: string; data: any[][] }[];
  /** PPT 等分页文档的页内容 */
  slides?: { index: number; text: string }[];
  /** 其他元信息（如 PDF 页数） */
  meta?: Record<string, any>;
}

/** 文件解析器：输入文件绝对路径，输出文本或结构化结果 */
export type FileParser = (filePath: string) => Promise<FileParseResult | string>;

/** 文档写回器：将宿主提供的数据写入 Buffer（docx/xlsx/pptx 等） */
export type DocumentWriter = (data: any) => Promise<Buffer>;

/** Agent 工具定义标准（供 LLM Tool Calling 使用） */
export interface AgentToolDefinition {
  name: string;
  description: string;
  /** JSON Schema 形式的参数定义 */
  parameters: Record<string, any>;
  execute(args: any): Promise<any>;
}

/** 2. 宿主向插件开放的能力上下文（Host Context） */
export interface HostContext {
  /** 注册文件解析器（ext 形如 ".docx"，可带或不带前导点，大小写不敏感） */
  registerFileParser(ext: string, parser: FileParser): void;
  /** 注册文档写回器（format 形如 "docx"） */
  registerDocumentWriter(format: string, writer: DocumentWriter): void;
  /** 注册 Agent 工具（给 LLM Tool Calling 使用） */
  registerAgentTool(tool: AgentToolDefinition): void;
  /** 统一日志服务 */
  logger: {
    info(message: string): void;
    warn(message: string): void;
    error(message: string, error?: any): void;
  };
  /** 允许插件调用宿主配置好的大模型 */
  llm: {
    chat(messages: any[], config?: any): Promise<{ text: string }>;
    chatStream(
      messages: any[],
      config?: any,
      onDelta?: (delta: string) => void
    ): Promise<string>;
  };
  /** 运行时插件目录（用户级插件安装目录） */
  pluginsDir: string;
}

/** 3. 插件必须实现的接口 */
export interface IDesktopPlugin {
  /** 插件激活：宿主启动或插件热插拔时调用 */
  onActivate(context: HostContext): Promise<void>;
  /** 插件禁用：释放资源 */
  onDeactivate(): Promise<void>;
}
