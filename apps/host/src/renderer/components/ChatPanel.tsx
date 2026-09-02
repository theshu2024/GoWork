import { App, Button, Input, Tag, Tooltip, Modal } from 'antd';
import {
  SettingOutlined,
  ClearOutlined,
  SendOutlined,
  FileTextOutlined,
  BulbOutlined,
  EditOutlined,
  BarChartOutlined,
  SaveOutlined,
} from '@ant-design/icons';
import { useEffect, useRef, useState } from 'react';
import { useAppStore, getActiveDoc } from '../store/useAppStore';
import type { ChatMessage } from '../store/useAppStore';
import { marked } from 'marked';
import hljs from 'highlight.js';
import 'highlight.js/styles/github.css';
import {
  chat,
  runAgent,
  buildSummarizePrompt,
  buildQAPrompt,
  buildRewritePrompt,
  buildDataAnalyzePrompt,
  retrieveRelevantChunks,
  type AgentEvent,
} from '../services/ai';
import { SettingsModal } from './SettingsModal';

const { TextArea } = Input;

marked.setOptions({
  gfm: true,
  breaks: true,
});

function formatTime(ts: number) {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function ChatPanel() {
  const { message, modal } = App.useApp();
  const messages = useAppStore((s) => s.chatMessages);
  const loading = useAppStore((s) => s.chatLoading);
  const addMsg = useAppStore((s) => s.addChatMessage);
  const updateMsg = useAppStore((s) => s.updateChatMessage);
  const clearChat = useAppStore((s) => s.clearChat);
  const setLoading = useAppStore((s) => s.setChatLoading);
  const aiConfig = useAppStore((s) => s.aiConfig);
  const showSettings = useAppStore((s) => s.showSettings);
  const setShowSettings = useAppStore((s) => s.setShowSettings);

  const [input, setInput] = useState('');
  const [lastGenText, setLastGenText] = useState(''); // 用于写回
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, loading]);

  const activeDoc = getActiveDoc();
  const hasActiveDoc = !!activeDoc && !activeDoc.error;
  const isExcel = activeDoc && (activeDoc.ext === 'xlsx' || activeDoc.ext === 'xls');

  function makeId() {
    return 'm_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
  }

  /** 追加一条系统提示消息（工具调用状态等） */
  function pushSystemMessage(content: string) {
    addMsg({
      id: makeId(),
      role: 'system',
      content,
      timestamp: Date.now(),
    });
  }

  async function runAI(opts: {
    userText: string;
    kind: 'chat' | 'summary' | 'qa' | 'rewrite' | 'analyze';
    rewrittenText?: string;
    rewriteInstruction?: string;
  }) {
    if (opts.kind !== 'summary' && !opts.userText && !opts.rewrittenText) return;
    if (loading) return;

    if (!aiConfig.apiKey && aiConfig.provider === 'cloud') {
      Modal.warning({
        title: '请先配置 API Key',
        content: '当前选择的是云端大模型，尚未配置 API Key。请点击右上角设置按钮配置，或切换为本地 Ollama 模型。',
        okText: '前往设置',
        onOk: () => setShowSettings(true),
      });
      return;
    }

    setLoading(true);

    // 用户消息
    let userDisplay = opts.userText;
    if (opts.kind === 'summary') userDisplay = '✨ 请生成当前文档的摘要';
    else if (opts.kind === 'rewrite') userDisplay = `✍️ 改写：${opts.rewriteInstruction || opts.userText}`;
    else if (opts.kind === 'analyze') userDisplay = '📊 ' + (opts.userText || '数据分析与洞察');

    const userMsg: ChatMessage = {
      id: makeId(),
      role: 'user',
      content: userDisplay,
      timestamp: Date.now(),
    };
    addMsg(userMsg);

    // 助手消息（流式）
    const aiMsg: ChatMessage = {
      id: makeId(),
      role: 'ai',
      content: '',
      streaming: true,
      tool: opts.kind,
      timestamp: Date.now(),
    };
    addMsg(aiMsg);

    try {
      // 构建 messages
      let aiMsgs;
      const docText = activeDoc?.content || '';
      if (opts.kind === 'summary') {
        if (!hasActiveDoc) throw new Error('请先导入并选中文档');
        aiMsgs = buildSummarizePrompt(docText);
      } else if (opts.kind === 'qa' || opts.kind === 'chat') {
        if (!hasActiveDoc) {
          // 无文档时通用闲聊
          aiMsgs = [{ role: 'user', content: opts.userText }];
        } else {
          const ctx = retrieveRelevantChunks(docText, opts.userText);
          aiMsgs = buildQAPrompt(ctx, opts.userText);
        }
      } else if (opts.kind === 'rewrite') {
        const toRewrite = opts.rewrittenText || docText;
        aiMsgs = buildRewritePrompt(toRewrite, opts.rewriteInstruction || opts.userText);
      } else if (opts.kind === 'analyze') {
        if (!isExcel || !activeDoc?.sheets) throw new Error('请先选择 Excel 文档以启用数据分析');
        const md = sheetsToMarkdown(activeDoc.sheets);
        aiMsgs = buildDataAnalyzePrompt(md, opts.userText);
      } else {
        aiMsgs = [{ role: 'user', content: opts.userText }];
      }

      // 问答 / 自由对话走 Agent Loop（工具由插件动态注册），
      // 摘要 / 改写 / 数据分析走确定性 Prompt + 流式直调
      const useAgent = opts.kind === 'qa' || opts.kind === 'chat';
      let result = '';
      let acc = '';

      if (useAgent) {
        result = await runAgent(
          aiConfig,
          aiMsgs as any,
          (ev: AgentEvent) => {
            switch (ev.type) {
              case 'tool_start':
                pushSystemMessage(
                  `🔧 调用工具：${ev.name}(${JSON.stringify(ev.args)})`
                );
                break;
              case 'tool_result':
                pushSystemMessage(
                  `✅ 工具 ${ev.name} 返回：${truncate(JSON.stringify(ev.result), 200)}`
                );
                break;
              case 'tool_error':
                pushSystemMessage(`⚠️ 工具 ${ev.name} 执行出错：${ev.error}`);
                break;
              case 'delta':
                acc += ev.delta;
                updateMsg(aiMsg.id, { content: acc });
                break;
              case 'error':
                throw new Error(ev.error);
            }
          }
        );
      } else {
        result = await chat(
          aiConfig,
          aiMsgs as any,
          (chunk) => {
            acc += chunk;
            updateMsg(aiMsg.id, { content: acc });
          }
        );
      }
      setLastGenText(result || acc);
      updateMsg(aiMsg.id, { streaming: false, content: result || acc });
    } catch (err: any) {
      updateMsg(aiMsg.id, {
        content: '❌ ' + (err?.message || String(err)),
        streaming: false,
      });
      message.error(err?.message || String(err));
    } finally {
      setLoading(false);
    }
  }

  async function handleSend() {
    const text = input.trim();
    if (!text) return;
    setInput('');
    await runAI({ userText: text, kind: isExcel ? 'analyze' : 'qa' });
  }

  function handleSummary() {
    runAI({ userText: '', kind: 'summary' });
  }

  function handlePolish() {
    if (!hasActiveDoc) {
      message.warning('请先选中一篇文档');
      return;
    }
    modal.confirm({
      title: '改写 / 润色全文',
      content: (
        <div style={{ marginTop: 12 }}>
          <p style={{ margin: '0 0 8px', color: '#6b7280' }}>
            请输入改写指令（如："润色更正式" / "简化为口语" / "翻译成英语" / "扩展为详细段落"）：
          </p>
          <TextArea
            id="rewrite-input"
            rows={3}
            placeholder="例如：使用更正式的商务语言，修正语法和错别字"
            defaultValue="润色语言，使表述更专业、清晰，并修正可能的错别字"
          />
        </div>
      ),
      okText: '开始改写',
      cancelText: '取消',
      onOk: async () => {
        const ta = document.getElementById('rewrite-input') as HTMLTextAreaElement;
        const instruction = ta?.value || '润色语言，使表述更专业、清晰';
        await runAI({
          userText: instruction,
          kind: 'rewrite',
          rewriteInstruction: instruction,
        });
      },
    });
  }

  function handleAnalyze() {
    if (!isExcel) {
      message.warning('请先选择 Excel 文档');
      return;
    }
    Modal.confirm({
      title: 'Excel 数据分析',
      content: '请选择操作，或直接在下方输入框输入自定义问题：',
      okText: '生成指标分析',
      cancelText: '自定义',
      onOk: async () => {
        await runAI({ userText: '', kind: 'analyze' });
      },
      onCancel: () => {
        setInput('请对这张表格做描述性统计、异常值检查和关键洞察');
      },
    });
  }

  async function handleWriteBack() {
    if (!lastGenText) {
      message.warning('还没有可写回的 AI 内容，请先生成摘要/改写内容');
      return;
    }
    if (!activeDoc) {
      message.warning('请先选择要写回的目标文档');
      return;
    }
    const choice = await new Promise<number>((resolve) => {
      Modal.confirm({
        title: '将 AI 结果写回文档',
        content: (
          <div>
            <p style={{ color: '#6b7280' }}>
              将把最近一次 AI 输出结果写入文档。目标：<b>{activeDoc.name}</b>
            </p>
            <p style={{ color: '#9ca3af', fontSize: 12 }}>
              Word/PPT 会新建包含 AI 内容的文档；Excel 会在新工作表中写入（markdown 表格形式）。
            </p>
          </div>
        ),
        okText: '另存为新文件',
        okButtonProps: { onClick: () => resolve(1) },
        cancelText: '取消',
        cancelButtonProps: { onClick: () => resolve(0) },
      });
    });
    if (!choice) return;

    let data: any = {};
    if (activeDoc.ext === 'xlsx' || activeDoc.ext === 'xls') {
      const sheet = markdownToSheet(lastGenText);
      data = {
        sheets: [
          ...(activeDoc.sheets || []),
          { name: 'AI分析结果', data: sheet },
        ],
      };
    } else if (activeDoc.ext === 'pptx' || activeDoc.ext === 'ppt') {
      const slides = lastGenText
        .split(/\r?\n\r?\n/)
        .filter(Boolean)
        .map((s) => {
          const lines = s.split(/\r?\n/);
          return {
            title: lines[0].replace(/^#+\s*/, ''),
            bullets: lines.slice(1).map((l) => l.replace(/^[-*+•]\s*/, '')),
          };
        });
      data = { slides };
    } else {
      data = { text: lastGenText };
    }

    const resp = await window.electronAPI.writeDocument({
      sourcePath: activeDoc.path,
      saveAs: true,
      data,
    });
    if (resp.canceled) return;
    if (resp.error) message.error('写回失败：' + resp.error);
    else message.success('已保存：' + resp.savedPath);
  }

  return (
    <section className="chat-panel">
      <div className="chat-header">
        <div>
          <div style={{ fontWeight: 600, fontSize: 14 }}>AI 对话</div>
          <div style={{ fontSize: 11, color: '#9ca3af' }}>
            <Tag color={aiConfig.provider === 'cloud' ? 'blue' : 'purple'} style={{ fontSize: 11 }}>
              {aiConfig.provider === 'cloud' ? '☁️ ' + aiConfig.model : '🖥️  Ollama/' + aiConfig.ollamaModel}
            </Tag>
            {hasActiveDoc ? (
              <span style={{ fontSize: 11 }}>
                已绑定文档：<b>{activeDoc!.name}</b>
              </span>
            ) : (
              <span style={{ color: '#d97706', fontSize: 11 }}>未绑定文档（自由对话）</span>
            )}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 4 }}>
          <Tooltip title="写回文档">
            <Button icon={<SaveOutlined />} onClick={handleWriteBack} />
          </Tooltip>
          <Tooltip title="清空对话">
            <Button icon={<ClearOutlined />} onClick={() => clearChat()} />
          </Tooltip>
          <Tooltip title="设置">
            <Button icon={<SettingOutlined />} onClick={() => setShowSettings(true)} />
          </Tooltip>
        </div>
      </div>

      <div className="chat-body" ref={scrollRef}>
        {messages.length === 0 ? (
          <div className="empty-state" style={{ padding: 20 }}>
            <div className="empty-icon" style={{ fontSize: 40 }}>💬</div>
            <div style={{ fontSize: 14, color: '#6b7280', maxWidth: 320 }}>
              导入文档后，可以使用快捷操作：摘要、问答、改写、分析。
            </div>
          </div>
        ) : (
          messages.map((m) => <MessageItem key={m.id} msg={m} />)
        )}
      </div>

      <div className="chat-footer">
        <div className="quick-actions">
          <Button size="small" icon={<FileTextOutlined />} onClick={handleSummary} disabled={!hasActiveDoc || loading}>
            📝 文档摘要
          </Button>
          <Button size="small" icon={<BulbOutlined />} onClick={() => {
            setInput('这篇文档的核心结论是什么？');
          }} disabled={!hasActiveDoc || loading}>
            ❓ 核心结论
          </Button>
          <Button size="small" icon={<EditOutlined />} onClick={handlePolish} disabled={!hasActiveDoc || loading}>
            ✍️ 润色改写
          </Button>
          <Button
            size="small"
            icon={<BarChartOutlined />}
            onClick={handleAnalyze}
            disabled={!isExcel || loading}
          >
            📊 数据分析
          </Button>
        </div>
        <TextArea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              handleSend();
            }
          }}
          placeholder={
            loading
              ? 'AI 处理中...'
              : isExcel
              ? '针对表格提问（如：按列统计销售额Top 5 / 描述性统计 / 制作透视），Enter 发送，Shift+Enter 换行'
              : '基于文档内容提问，或直接输入指令。Enter 发送，Shift+Enter 换行'
          }
          autoSize={{ minRows: 2, maxRows: 5 }}
          disabled={loading}
          style={{ resize: 'none' }}
        />
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 8 }}>
          <Button
            type="primary"
            icon={<SendOutlined />}
            onClick={handleSend}
            disabled={loading || !input.trim()}
          >
            {loading ? '处理中' : '发送'}
          </Button>
        </div>
      </div>

      <SettingsModal open={showSettings} onClose={() => setShowSettings(false)} />
    </section>
  );
}

function MessageItem({ msg }: { msg: ChatMessage }) {
  const isUser = msg.role === 'user';
  const isSystem = msg.role === 'system';

  if (isSystem) {
    return (
      <div
        style={{
          alignSelf: 'center',
          maxWidth: '92%',
          fontSize: 12,
          color: '#6b7280',
          background: '#f3f4f6',
          borderRadius: 12,
          padding: '4px 12px',
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          wordBreak: 'break-word',
        }}
      >
        {msg.content}
      </div>
    );
  }

  return (
    <div className={'chat-msg ' + (isUser ? 'user' : 'ai')}>
      {!isUser && <div className="avatar">🤖</div>}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, alignItems: isUser ? 'flex-end' : 'flex-start' }}>
        {msg.tool && !isUser && (
          <Tag
            style={{ fontSize: 11, padding: '0 6px', lineHeight: '18px' }}
            color={
              msg.tool === 'summary'
                ? 'blue'
                : msg.tool === 'rewrite'
                ? 'purple'
                : msg.tool === 'analyze'
                ? 'cyan'
                : 'geekblue'
            }
          >
            {msg.tool === 'summary'
              ? '摘要'
              : msg.tool === 'qa'
              ? '问答'
              : msg.tool === 'chat'
              ? '自由对话'
              : msg.tool === 'rewrite'
              ? '改写'
              : msg.tool === 'analyze'
              ? '数据分析'
              : ''}
          </Tag>
        )}
        <div className="chat-bubble">
          {isUser ? (
            <span style={{ whiteSpace: 'pre-wrap' }}>{msg.content}</span>
          ) : (
            <div
              className="markdown-body"
              dangerouslySetInnerHTML={{
                __html:
                  marked.parse(msg.content || (msg.streaming ? '<span class="loading-dots">思考中</span>' : '')) as string,
              }}
            />
          )}
        </div>
        <div style={{ fontSize: 10, color: '#9ca3af' }}>{formatTime(msg.timestamp)}</div>
      </div>
      {isUser && <div className="avatar">我</div>}
    </div>
  );
}

// 辅助：截断长文本（工具结果展示）
function truncate(s: string, max: number) {
  return s.length > max ? s.slice(0, max) + '…' : s;
}

// 辅助：sheets -> markdown 表格
function sheetsToMarkdown(sheets: { name: string; data: any[][] }[]) {
  let md = '';
  for (const sh of sheets) {
    md += `## 工作表：${sh.name}\n\n`;
    const rows = sh.data || [];
    if (rows.length === 0) {
      md += '(空表)\n\n';
      continue;
    }
    // 限制行数
    const limited = rows.slice(0, 200);
    const maxCols = limited.reduce((m, r) => Math.max(m, r.length), 0);
    limited.forEach((r, i) => {
      const pad = new Array(Math.max(0, maxCols - r.length)).fill('');
      const cells = [...r, ...pad].map((c) => String(c ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' '));
      md += '| ' + cells.join(' | ') + ' |\n';
      if (i === 0) {
        md += '| ' + cells.map(() => '---').join(' | ') + ' |\n';
      }
    });
    md += '\n';
    if (rows.length > limited.length) {
      md += `> 注意：原表共 ${rows.length} 行，此处仅展示前 ${limited.length} 行。\n\n`;
    }
  }
  return md;
}

// markdown table -> aoa
function markdownToSheet(md: string): any[][] {
  const lines = md.split(/\r?\n/);
  const result: any[][] = [];
  let inTable = false;
  for (const line of lines) {
    if (/^\|.*\|$/.test(line.trim())) {
      const cells = line
        .trim()
        .replace(/^\|/, '')
        .replace(/\|$/, '')
        .split('|')
        .map((c) => c.trim());
      // 分隔行
      if (cells.every((c) => /^:?-{3,}:?$/.test(c))) {
        inTable = true;
        continue;
      }
      inTable = true;
      result.push(cells);
    } else if (inTable && line.trim() === '') {
      break;
    } else if (!inTable) {
      // 保留标题行（说明）
      if (line.trim()) result.push([line.trim()]);
    }
  }
  if (result.length === 0) result.push([md]);
  return result;
}
