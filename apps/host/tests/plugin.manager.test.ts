/**
 * PluginManager 单元测试（node:test，通过 tsx 直接运行 TS）
 * 运行：npm test
 */
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { PluginManager } from '../src/main/managers/plugin.manager';

const mockLlm = {
  chat: async () => ({ text: '' }),
  chatStream: async () => '',
};

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('扫描空插件目录不报错，且 HostContext 正确初始化', async () => {
  const dir = makeTempDir('pm-empty-');
  const pm = new PluginManager([dir], mockLlm as any, dir);

  await pm.loadPlugins(); // 不应抛错

  assert.equal(pm.getRegisteredTools().length, 0);
  assert.equal(pm.getParser('.docx'), undefined);
  assert.equal(pm.getWriter('xlsx'), undefined);
  assert.equal(pm.listManifests().length, 0);

  await pm.unloadAll();
});

test('能加载 Mock 插件并注册文件解析器与 Agent 工具', async () => {
  const root = makeTempDir('pm-plugin-');
  const pluginDir = path.join(root, 'mock-plugin');
  fs.mkdirSync(path.join(pluginDir, 'dist'), { recursive: true });

  fs.writeFileSync(
    path.join(pluginDir, 'package.json'),
    JSON.stringify({
      name: 'mock-plugin-pkg',
      version: '1.0.0',
      main: 'dist/index.js',
      pluginConfig: {
        name: 'plugin-mock',
        version: '1.0.0',
        displayName: 'Mock 插件',
        description: '测试用',
        entry: 'dist/index.js',
        capabilities: ['file-system'],
      },
    })
  );

  // 模拟 tsc 编译后的 CJS 插件产物
  fs.writeFileSync(
    path.join(pluginDir, 'dist', 'index.js'),
    `
    class MockPlugin {
      async onActivate(ctx) {
        ctx.registerFileParser('.mock', async () => ({ text: 'MOCK_TEXT' }));
        ctx.registerDocumentWriter('mock', async () => Buffer.from('MOCK_WRITE'));
        ctx.registerAgentTool({
          name: 'ping',
          description: 'returns pong',
          parameters: { type: 'object', properties: {} },
          execute: async () => ({ pong: true }),
        });
      }
      async onDeactivate() {}
    }
    module.exports = { default: MockPlugin };
    `
  );

  const pm = new PluginManager([root], mockLlm as any, root);
  await pm.loadPlugins();

  // 解析器
  const parser = pm.getParser('.MOCK'); // 大小写不敏感
  assert.ok(parser, '解析器应已注册');
  const result = await pm.parse(path.join(pluginDir, 'a.mock'));
  assert.equal(result.text, 'MOCK_TEXT');

  // 写回器
  const writer = pm.getWriter('mock');
  assert.ok(writer);
  const buf = await writer!({});
  assert.equal(buf.toString(), 'MOCK_WRITE');

  // Agent 工具
  const tools = pm.getRegisteredTools();
  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, 'ping');
  assert.deepEqual(await tools[0].execute({}), { pong: true });

  // 元数据
  const manifests = pm.listManifests();
  assert.equal(manifests.length, 1);
  assert.equal(manifests[0].name, 'plugin-mock');

  await pm.unloadAll();
  assert.equal(pm.getRegisteredTools().length, 0, '卸载后工具应清空');
});

test('缺少 pluginConfig 的目录被静默跳过', async () => {
  const root = makeTempDir('pm-skip-');
  const plain = path.join(root, 'plain-pkg');
  fs.mkdirSync(plain, { recursive: true });
  fs.writeFileSync(
    path.join(plain, 'package.json'),
    JSON.stringify({ name: 'plain', version: '1.0.0', main: 'index.js' })
  );

  const pm = new PluginManager([root], mockLlm as any, root);
  await pm.loadPlugins();
  assert.equal(pm.listManifests().length, 0);
});

test('未安装解析器时给出友好错误', async () => {
  const dir = makeTempDir('pm-noparser-');
  const pm = new PluginManager([dir], mockLlm as any, dir);
  await pm.loadPlugins();
  await assert.rejects(
    () => pm.parse(path.join(dir, 'unknown.xyz')),
    /暂不支持该文件类型/
  );
});
