<br />

***

# 桌面端 AI 客户端插件化改造技术方案

## 1. 改造目标

将现有单体客户端（包含 Office 文件处理、大模型配置、Agent 核心）解耦为**微内核（Micro-kernel）架构**。

- **Host（内核）**：仅负责生命周期管理、插件加载、全局事件总线（Event Bus）、模型调度（LLM Manager）、以及统一的 IPC 通信。
- **Plugins（插件）**：Office 文件解析、特定的 Agent 工具、自定义模型对接等全部抽离为独立模块，通过动态加载的方式注册到 Host 中。

***

## 2. 目录结构调整

Code Agent 需要明确的新旧目录对比。请引导 Agent 按以下结构进行重构：

```text
// 改造后目录结构
├── apps/
│   └── host/                  # 宿主主程序 (Electron / Node.js Backend)
│       ├── src/
│       │   ├── main/
│       │   │   ├── index.ts   # 主入口
│       │   │   ├── managers/  # 宿主核心管理器
│       │   │   │   ├── plugin.manager.ts # 插件加载与生命周期管理
│       │   │   │   ├── llm.manager.ts    # 模型配置与调度
│       │   │   │   └── agent.manager.ts  # Agent Loop 调度
│       │   │   └── ipc/       # 统一 IPC 通信
│       │   └── renderer/      # 前端 UI (React/Vue)
│       └── package.json
└── plugins/                   # 插件开发目录 (Monorepo 管理或独立打包)
    ├── office-parser/         # 抽离出来的 Office 处理插件
    │   ├── package.json       # 必须包含 main, name, version 以及 custom metadata
    │   ├── src/
    │   │   └── index.ts       # 插件入口
    │   └── tsconfig.json
    └── custom-tool-agent/     # 示例：自定义子 Agent / 工具插件
```

***

## 3. 核心接口定义 (TypeScript SDK)

定义宿主与插件之间的标准契约。在 `apps/host/src/types/plugin.sdk.ts` 中创建以下定义，供所有插件引入。

```typescript
// plugin.sdk.ts

// 1. 插件元数据规范 (对应插件的 package.json 中的 "pluginConfig")
export interface PluginManifest {
  name: string;        // 唯一标识，如 "plugin-office-parser"
  version: string;
  displayName: string;
  description: string;
  entry: string;       // 插件入口文件路径
  capabilities: string[]; // 声明插件需要使用的权限/能力，如 ["file-system", "llm-call"]
}

// 2. 宿主向插件开放的能力上下文 (Host Context)
export interface HostContext {
  // 注册文件解析器
  registerFileParser(ext: string, parser: (filePath: string) => Promise<string>): void;
  // 注册 Agent 工具 (给 LLM Tool Calling 使用)
  registerAgentTool(tool: AgentToolDefinition): void;
  // 提供统一的日志服务
  logger: {
    info(message: string): void;
    error(message: string, error?: any): void;
  };
  // 允许插件调用宿主配置好的大模型
  llm: {
    chatStream(messages: any[], config?: any): Promise<ReadableStream>;
    chat(messages: any[], config?: any): Promise<{ text: string }>;
  };
}

// 3. 插件必须实现的接口
export interface IDesktopPlugin {
  // 插件激活：宿主启动或插件热插拔时调用
  onActivate(context: HostContext): Promise<void>;
  // 插件禁用：释放资源
  onDeactivate(): Promise<void>;
}

// Agent 工具定义标准
export interface AgentToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, any>; // JSON Schema
  execute(args: any): Promise<any>;
}
```

***

## 4. 核心模块实现：插件加载器 (PluginManager)

这是 Host 内核中最关键的组件。Code Agent 需要在 `apps/host/src/main/managers/plugin.manager.ts` 中实现它。

**实现逻辑要点**：

1. 扫描指定目录（如 `userData/plugins` 和内置的 `plugins` 目录）。
2. 读取插件的 `package.json` 并校验 `pluginConfig` 元数据。
3. 使用 Node.js 的动态 `import()` 或 `require()` 载入插件模块。
4. 实例化插件并调用 `onActivate(context)`，将 Host 的上下文和注册 API 注入给插件。

```typescript
// plugin.manager.ts
import fs from 'fs';
import path from 'path';
import { HostContext, IDesktopPlugin, PluginManifest } from '../types/plugin.sdk';

export class PluginManager {
  private plugins: Map<string, IDesktopPlugin> = new Map();
  private fileParsers: Map<string, (filePath: string) => Promise<string>> = new Map();
  private agentTools: Map<string, any> = new Map();
  private context!: HostContext;

  constructor(private pluginsDir: string, private llmManager: any) {
    this.initContext();
  }

  private initContext() {
    this.context = {
      registerFileParser: (ext, parser) => {
        this.fileParsers.set(ext.toLowerCase(), parser);
        console.log(`[PluginManager] Registered parser for: ${ext}`);
      },
      registerAgentTool: (tool) => {
        this.agentTools.set(tool.name, tool);
        console.log(`[PluginManager] Registered agent tool: ${tool.name}`);
      },
      logger: {
        info: (msg) => console.log(`[Plugin-Log] ${msg}`),
        error: (msg, err) => console.error(`[Plugin-Error] ${msg}`, err),
      },
      llm: {
        chat: async (messages, config) => this.llmManager.chat(messages, config),
        chatStream: async (messages, config) => this.llmManager.chatStream(messages, config),
      }
    };
  }

  // 扫描并加载所有插件
  async loadPlugins() {
    if (!fs.existsSync(this.pluginsDir)) {
      fs.mkdirSync(this.pluginsDir, { recursive: true });
    }

    const entries = fs.readdirSync(this.pluginsDir, { withFileTypes: true });
    
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const pluginPath = path.join(this.pluginsDir, entry.name);
        await this.loadSinglePlugin(pluginPath);
      }
    }
  }

  private async loadSinglePlugin(pluginPath: string) {
    try {
      const pkgPath = path.join(pluginPath, 'package.json');
      if (!fs.existsSync(pkgPath)) return;

      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      const manifest: PluginManifest = pkg.pluginConfig;
      if (!manifest) return;

      // 动态载入插件入口文件
      const entryPath = path.resolve(pluginPath, pkg.main || 'dist/index.js');
      
      // Node.js 环境下动态 import
      const module = await import(`file://${entryPath}`);
      const PluginClass = module.default;
      
      const pluginInstance: IDesktopPlugin = new PluginClass();
      await pluginInstance.onActivate(this.context);
      
      this.plugins.set(manifest.name, pluginInstance);
      console.log(`Successfully activated plugin: ${manifest.name}`);
    } catch (error) {
      console.error(`Failed to load plugin at ${pluginPath}:`, error);
    }
  }

  // 获取文件解析器
  getParser(ext: string) {
    return this.fileParsers.get(ext.toLowerCase());
  }

  // 获取所有已注册的 Agent 工具
  getRegisteredTools() {
    return Array.from(this.agentTools.values());
  }
}
```

***

## 5. 迁移改造步骤（Agent 逐步执行指南）

为了避免 Agent 一次性修改过多代码导致崩溃，请让 Agent 按照以下**原子化步骤**进行重构和测试：

### 步骤 1：创建 SDK 与基础 Manager

- **任务**：在 Host 侧建立 `plugin.sdk.ts`，并编写核心 `PluginManager`。
- **验证标准**：编写一个 Mock 单元测试，确保 `PluginManager` 能够扫描指定空目录不报错，并能正确初始化 `HostContext`。

### 步骤 2：解耦并迁移 Office 解析模块

- **任务**：
  1. 定位当前工程中处理 `.docx`、`.xlsx` 等 Office 文件的现有逻辑代码（例如 `src/services/officeParser.ts`）。
  2. 将其完整移出 Host 目录，放入新目录 `plugins/office-parser/` 中。
  3. 在 `plugins/office-parser/` 中创建 `index.ts`，使其实现 `IDesktopPlugin` 接口，并在 `onActivate` 中调用 `context.registerFileParser`。
- **验证标准**：
  - 插件能够独立编译（如果需要编译步骤，如 `tsc`）。
  - 编译产物放入 Host 的 `plugins` 运行时目录下，Host 启动时能正确打印出 `[PluginManager] Registered parser for: .docx`。

### 步骤 3：改造 Host 的 RAG/文档导入工作流

- **任务**：
  1. 修改 Host 的 RAG 知识库管理模块。原先直接 `import { parseDocx } from './officeParser'` 的地方，全部改为通过 `PluginManager` 动态获取。
- **修改后的伪代码**：
  ```typescript
  // 导入文件时的逻辑
  const ext = path.extname(filePath);
  const parser = pluginManager.getParser(ext);

  if (!parser) {
    throw new Error(`暂不支持该文件类型的解析: ${ext}，请检查是否安装对应插件。`);
  }

  const rawText = await parser(filePath);
  // 后续执行 chunking & embedding ...
  ```
- **验证标准**：拖入一个 Word 文档，系统依然能够通过动态加载的插件完成解析和导入。

### 步骤 4：改造 Agent 工具调用（Tool Calling）

- **任务**：
  1. 找到 Host 中现有的大模型 Tool Calling 调度模块。
  2. 将大模型可选的 tools 参数，由“硬编码数组”修改为“动态从 `pluginManager.getRegisteredTools()` 中获取”。
- **验证标准**：通过插件注册一个简单的计算工具（如 `calculate_sales`），并在聊天中对 AI 说“帮我计算一下”，AI 能够识别并触发该插件工具。

***

## 给 Code Agent 的执行 Prompts 模版

你在将任务分派给 Code Agent 时，可以直接发送如下指令：

> **Task**: Refactor the monolithic desktop client into a micro-kernel (plugin-based) architecture.
>
> **Context**: We currently have a single app codebase that parses Office documents and configures LLM agents. We want to extract the Office parser and Agent tools into dynamic plugins loaded at runtime.
>
> **Instructions**:
>
> 1. Read the provided `plugin.sdk.ts` and `plugin.manager.ts` technical specs.
> 2. Create the TS interface in `apps/host/src/types/plugin.sdk.ts`.
> 3. Implement the `PluginManager` in `apps/host/src/main/managers/plugin.manager.ts`.
> 4. Identify the existing Office parsing files (e.g., Mammoth, SheetJS calls), move them into a new folder `plugins/office-parser/`, configure its `package.json`, and make it implement the `IDesktopPlugin` interface.
> 5. Refactor the Host's document importing logic to retrieve the active parser from `PluginManager` instead of direct imports.
> 6. Ensure no breaking changes to the UI; if a parser is missing, show a user-friendly message in the frontend via IPC.
>
> Please execute Step 1 and Step 2 first, and show me the file changes before proceeding to step 3.

