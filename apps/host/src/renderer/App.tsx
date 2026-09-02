import { App as AntdApp, Button } from 'antd';
import { Sidebar } from './components/Sidebar';
import { DocPreview } from './components/DocPreview';
import { ChatPanel } from './components/ChatPanel';
import { useAppStore } from './store/useAppStore';
import { UploadOutlined } from '@ant-design/icons';

export default function App() {
  const { message } = AntdApp.useApp();
  const addDocs = useAppStore((s) => s.addDocuments);

  async function handleOpen() {
    const res = await window.electronAPI.openDocument();
    if (res.canceled) return;
    if (!res.files.length) {
      message.warning('未选择任何文件');
      return;
    }
    const ok = res.files.filter((f) => !f.error);
    if (ok.length) {
      addDocs(ok);
      message.success(`已导入 ${ok.length} 个文档`);
    }
    const fail = res.files.filter((f) => f.error);
    if (fail.length) {
      message.error(`${fail.length} 个文档解析失败：${fail.map((f) => f.name).join('，')}`);
    }
  }

  return (
    <div className="app-layout">
      <Sidebar onOpen={handleOpen} />
      <div className="main">
        <div className="main-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <h1 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>
              🤖 AI 智能办公助手
            </h1>
            <span style={{ color: '#9ca3af', fontSize: 12 }}>
              让 AI 帮你读文档、写报告、分析数据
            </span>
          </div>
          <Button type="primary" icon={<UploadOutlined />} onClick={handleOpen}>
            导入文档
          </Button>
        </div>
        <div className="main-content">
          <DocPreview />
          <ChatPanel />
        </div>
      </div>
    </div>
  );
}
