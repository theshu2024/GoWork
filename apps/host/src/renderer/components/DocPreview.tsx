import { App, Tabs, Tag, Tooltip } from 'antd';
import { useEffect, useMemo, useState } from 'react';
import { useAppStore, getActiveDoc } from '../store/useAppStore';
import type { ParsedDocument } from '../../main/preload';
import { marked } from 'marked';

function renderTextToHtml(text: string) {
  // 避免表格被当作文本：保留换行
  if (!text) return '';
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return escaped.replace(/\r?\n/g, '<br/>');
}

function sheetToHtml(sheet: { name: string; data: any[][] }) {
  const data = sheet.data || [];
  const maxCols = data.reduce((m, r) => Math.max(m, r.length), 0);
  let html = `<h3 style="margin:16px 0 6px">📊 工作表：${sheet.name}</h3>`;
  html += '<table style="border-collapse:collapse;width:100%;font-size:13px">';
  data.forEach((row, ri) => {
    html += '<tr>';
    for (let i = 0; i < maxCols; i++) {
      const cell = row[i];
      const tag = ri === 0 ? 'th' : 'td';
      const bg = ri === 0 ? 'background:#f3f4f6;font-weight:600;' : '';
      html += `<${tag} style="border:1px solid #e5e7eb;padding:6px 10px;${bg}">${
        cell === undefined || cell === null || cell === '' ? '&nbsp;' : String(cell)
      }</${tag}>`;
    }
    html += '</tr>';
  });
  html += '</table>';
  return html;
}

function slidesToHtml(slides: { index: number; text: string }[]) {
  let html = '';
  slides.forEach((s) => {
    html += `<div style="border:1px solid #e5e7eb;border-radius:8px;padding:14px;margin-bottom:12px;background:#fafafa">
      <div style="font-weight:600;margin-bottom:8px;color:#4f46e5">🖼️ 第 ${s.index} 页</div>
      <div style="white-space:pre-wrap;line-height:1.7">${s.text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')}</div>
    </div>`;
  });
  return html;
}

export function DocPreview() {
  const activeDocId = useAppStore((s) => s.activeDocId);
  const [doc, setDoc] = useState<ParsedDocument | null>(null);
  const { message } = App.useApp();

  useEffect(() => {
    const d = getActiveDoc();
    setDoc(d);
    if (d?.error) {
      message.warning(d.error);
    }
  }, [activeDocId]);

  const contentHtml = useMemo(() => {
    if (!doc) return '';
    const ext = doc.ext;
    if (['xlsx', 'xls'].includes(ext) && doc.sheets && doc.sheets.length) {
      return doc.sheets.map(sheetToHtml).join('\n');
    }
    if (['ppt', 'pptx'].includes(ext) && doc.slides && doc.slides.length) {
      return slidesToHtml(doc.slides);
    }
    if (ext === 'md') {
      return marked.parse(doc.content || '') as string;
    }
    return `<div style="line-height:1.8;font-size:14px;color:#374151">${renderTextToHtml(doc.content || '')}</div>`;
  }, [doc]);

  if (!doc) {
    return (
      <div className="doc-preview">
        <div className="empty-state">
          <div className="empty-icon">📄</div>
          <h3 style={{ margin: '8px 0' }}>还没有选择文档</h3>
          <p style={{ maxWidth: 360 }}>
            请点击左侧「导入文档」选择 Word / Excel / PPT / PDF 文件，随后即可开始使用 AI
            处理文档内容。
          </p>
        </div>
      </div>
    );
  }

  const extInfo: Record<string, { color: string; label: string }> = {
    doc: { color: 'blue', label: 'Word' },
    docx: { color: 'blue', label: 'Word' },
    xls: { color: 'green', label: 'Excel' },
    xlsx: { color: 'green', label: 'Excel' },
    ppt: { color: 'red', label: 'PowerPoint' },
    pptx: { color: 'red', label: 'PowerPoint' },
    pdf: { color: 'red', label: 'PDF' },
  };
  const info = extInfo[doc.ext] || { color: 'default', label: doc.ext?.toUpperCase() };

  return (
    <div className="doc-preview">
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
        <h2 style={{ margin: 0, fontSize: 18 }}>{doc.name}</h2>
        <Tag color={info.color as any}>{info.label}</Tag>
        <Tooltip title={doc.path}>
          <span
            style={{
              color: '#9ca3af',
              fontSize: 12,
              maxWidth: 360,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              cursor: 'default',
            }}
          >
            📍 {doc.path}
          </span>
        </Tooltip>
      </div>

      {doc.error ? (
        <div style={{ color: '#dc2626', padding: 20, background: '#fef2f2', borderRadius: 8 }}>
          ⚠️ 文档解析失败：{doc.error}
        </div>
      ) : ['xlsx', 'xls'].includes(doc.ext) && doc.sheets ? (
        <Tabs
          size="small"
          items={(doc.sheets as any).map((sh: { name: string; data: any[][] }, idx: number) => ({
            key: String(idx),
            label: sh.name,
            children: (
              <div
                dangerouslySetInnerHTML={{ __html: sheetToHtml(sh) }}
                className="markdown-body"
              />
            ),
          }))}
        />
      ) : (
        <div
          className="markdown-body"
          dangerouslySetInnerHTML={{ __html: contentHtml }}
        />
      )}
    </div>
  );
}
