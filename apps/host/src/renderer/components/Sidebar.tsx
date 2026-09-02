import {
  FileWordOutlined,
  FileExcelOutlined,
  FilePptOutlined,
  FilePdfOutlined,
  FileUnknownOutlined,
  DeleteOutlined,
} from '@ant-design/icons';
import { useAppStore } from '../store/useAppStore';
import { Button, Empty, Popconfirm, Tooltip, Typography } from 'antd';
import type { ParsedDocument } from '../../main/preload';

const { Text } = Typography;

function DocIcon({ ext }: { ext: string }) {
  const props = { style: { fontSize: 22 } };
  switch (ext) {
    case 'doc':
    case 'docx':
      return <FileWordOutlined {...props} style={{ ...props.style, color: '#185abd' }} />;
    case 'xls':
    case 'xlsx':
      return <FileExcelOutlined {...props} style={{ ...props.style, color: '#137333' }} />;
    case 'ppt':
    case 'pptx':
      return <FilePptOutlined {...props} style={{ ...props.style, color: '#c5221f' }} />;
    case 'pdf':
      return <FilePdfOutlined {...props} style={{ ...props.style, color: '#d93025' }} />;
    default:
      return <FileUnknownOutlined {...props} style={{ ...props.style, color: '#6b7280' }} />;
  }
}

function formatSize(n?: number) {
  if (!n) return '';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}

export function Sidebar({ onOpen }: { onOpen: () => void }) {
  const docs = useAppStore((s) => s.documents);
  const activeId = useAppStore((s) => s.activeDocId);
  const setActive = useAppStore((s) => s.setActiveDoc);
  const removeDoc = useAppStore((s) => s.removeDoc);

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <div style={{ fontSize: 24 }}>🤖</div>
        <div className="sidebar-title">AI 办公助手</div>
      </div>

      <div style={{ padding: '10px 14px 6px' }}>
        <Button type="primary" block onClick={onOpen}>
          📂 导入文档
        </Button>
      </div>

      <div className="sidebar-body">
        {docs.length === 0 ? (
          <Empty
            description={<Text type="secondary" style={{ fontSize: 12 }}>暂无文档，请导入</Text>}
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            style={{ marginTop: 40 }}
          />
        ) : (
          docs.map((d: ParsedDocument) => (
            <div
              key={d.id}
              className={'doc-item' + (d.id === activeId ? ' active' : '')}
              onClick={() => setActive(d.id)}
              title={d.path}
            >
              <div className="doc-icon">
                <DocIcon ext={d.ext} />
              </div>
              <div className="doc-meta">
                <div className="doc-name">{d.name}</div>
                <div className="doc-sub">
                  {d.ext.toUpperCase()} · {formatSize(d.size)}
                  {d.error ? <span style={{ color: '#dc2626' }}> · 解析失败</span> : null}
                </div>
              </div>
              <Popconfirm
                title="从列表移除？"
                description="仅移除列表引用，不会删除本地原始文件。"
                onConfirm={(e) => {
                  e?.stopPropagation();
                  removeDoc(d.id);
                }}
                onCancel={(e) => e?.stopPropagation()}
                okText="移除"
                cancelText="取消"
              >
                <Tooltip title="从列表移除">
                  <Button
                    type="text"
                    size="small"
                    icon={<DeleteOutlined />}
                    style={{ color: '#9ca3af', padding: '4px 6px' }}
                    onClick={(e) => e.stopPropagation()}
                  />
                </Tooltip>
              </Popconfirm>
            </div>
          ))
        )}
      </div>

      <div className="sidebar-footer">
        <Text type="secondary" style={{ fontSize: 12 }}>
          支持 Word · Excel · PPT · PDF
        </Text>
      </div>
    </aside>
  );
}
