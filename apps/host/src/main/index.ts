/**
 * Host 主进程入口
 *
 * 微内核职责：
 * 1. 初始化 PluginManager（扫描内置插件目录 + 用户插件目录）
 * 2. 初始化 LlmManager / AgentManager
 * 3. 注册统一 IPC
 * 4. 创建 BrowserWindow
 */
import { app, BrowserWindow, shell } from 'electron';
import path from 'path';
import { PluginManager } from './managers/plugin.manager';
import { LlmManager } from './managers/llm.manager';
import { AgentManager } from './managers/agent.manager';
import { registerIpc } from './ipc';

const isDev = process.env.NODE_ENV === 'development';

let mainWindow: BrowserWindow | null = null;
let pluginManager: PluginManager | null = null;

/** 内置插件目录：开发态为仓库 plugins/，打包后位于 app.asar/plugins */
function getBuiltinPluginsDir(): string {
  if (app.isPackaged) {
    return path.join(app.getAppPath(), 'plugins');
  }
  // dev: dist-electron/main.js -> apps/host/dist-electron -> 仓库根/plugins
  return path.resolve(__dirname, '../../../plugins');
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1024,
    minHeight: 680,
    title: 'AI Office Assistant - 智能办公助手',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  if (isDev) {
    mainWindow.loadURL('http://localhost:5173');
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

app.whenReady().then(async () => {
  // ---- 内核初始化 ----
  const userPluginsDir = path.join(app.getPath('userData'), 'plugins');
  const llmManager = new LlmManager(
    path.join(app.getPath('userData'), 'llm-config.json')
  );
  pluginManager = new PluginManager(
    [getBuiltinPluginsDir(), userPluginsDir],
    llmManager,
    userPluginsDir
  );
  const agentManager = new AgentManager(llmManager, pluginManager);

  registerIpc({ pluginManager, llmManager, agentManager });

  // ---- 动态加载插件 ----
  await pluginManager.loadPlugins();
  console.log(
    '[Host] 已加载插件:',
    pluginManager.listManifests().map((m) => m.name).join(', ') || '(无)'
  );

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', async () => {
  await pluginManager?.unloadAll();
});
