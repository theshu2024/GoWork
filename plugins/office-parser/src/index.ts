/**
 * office-parser 插件
 *
 * 从原单体应用 electron/file-parser.ts 抽离：
 * - 注册 .doc/.docx/.xls/.xlsx/.ppt/.pptx/.pdf 文件解析器
 * - 注册 docx/xlsx/pptx 文档写回器
 */
import mammoth from 'mammoth';
import * as XLSX from 'xlsx';
import PdfParse from 'pdf-parse';
import officeParser from 'officeparser';
import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
  AlignmentType,
} from 'docx';
import PptxGenJS from 'pptxgenjs';
import fs from 'fs';
import path from 'path';
import os from 'os';
import type {
  FileParseResult,
  HostContext,
  IDesktopPlugin,
} from './sdk';

export default class OfficeParserPlugin implements IDesktopPlugin {
  async onActivate(context: HostContext): Promise<void> {
    const log = context.logger;

    // ---------- 文件解析器 ----------
    context.registerFileParser('.docx', (p) => this.parseWord(p));
    context.registerFileParser('.doc', (p) => this.parseWord(p));
    context.registerFileParser('.xlsx', (p) => this.parseExcel(p));
    context.registerFileParser('.xls', (p) => this.parseExcel(p));
    context.registerFileParser('.pptx', (p) => this.parsePpt(p));
    context.registerFileParser('.ppt', (p) => this.parsePpt(p));
    context.registerFileParser('.pdf', (p) => this.parsePdf(p));

    // ---------- 文档写回器 ----------
    context.registerDocumentWriter('docx', (data) => this.writeWord(data));
    context.registerDocumentWriter('doc', (data) => this.writeWord(data));
    context.registerDocumentWriter('xlsx', (data) => this.writeExcel(data));
    context.registerDocumentWriter('xls', (data) => this.writeExcel(data));
    context.registerDocumentWriter('pptx', (data) => this.writePpt(data));
    context.registerDocumentWriter('ppt', (data) => this.writePpt(data));

    log.info('office-parser 插件已激活：注册了 Word/Excel/PPT/PDF 解析器与写回器');
  }

  async onDeactivate(): Promise<void> {
    // 纯函数式注册，无需释放资源
  }

  // ================= Word =================
  private async parseWord(filePath: string): Promise<FileParseResult> {
    const buffer = fs.readFileSync(filePath);
    try {
      const result = await mammoth.extractRawText({ buffer });
      return { text: result.value || '', meta: { engine: 'mammoth' } };
    } catch {
      // 回退到 officeparser
      const text: string = await new Promise((resolve, reject) => {
        officeParser.parseOffice(filePath, (err: any, data: string) => {
          if (err) reject(err);
          else resolve(data || '');
        });
      });
      return { text, meta: { engine: 'officeparser' } };
    }
  }

  private async writeWord(data: {
    paragraphs?: string[];
    text?: string;
  }): Promise<Buffer> {
    const parts: Paragraph[] = [];
    const content = data.text || '';
    const lines = content.split(/\r?\n/);

    for (const line of lines) {
      if (!line.trim()) {
        parts.push(new Paragraph({ children: [] }));
        continue;
      }
      if (/^#{1,6}\s+/.test(line)) {
        const stripped = line.replace(/^#{1,6}\s+/, '');
        parts.push(
          new Paragraph({
            heading: HeadingLevel.HEADING_2,
            children: [new TextRun(stripped)],
          })
        );
      } else {
        parts.push(
          new Paragraph({
            children: [new TextRun(line)],
            alignment: AlignmentType.JUSTIFIED,
          })
        );
      }
    }

    if (data.paragraphs && data.paragraphs.length > 0) {
      for (const p of data.paragraphs) {
        parts.push(
          new Paragraph({
            children: [new TextRun(p)],
            spacing: { after: 120 },
          })
        );
      }
    }

    const doc = new Document({
      sections: [{ properties: {}, children: parts }],
    });
    return Packer.toBuffer(doc);
  }

  // ================= Excel =================
  private async parseExcel(filePath: string): Promise<FileParseResult> {
    const buffer = fs.readFileSync(filePath);
    const wb = XLSX.read(buffer, { type: 'buffer' });
    const sheets: { name: string; data: any[][] }[] = [];
    let text = '';
    for (const sheetName of wb.SheetNames) {
      const ws = wb.Sheets[sheetName];
      const arr: any[][] = XLSX.utils.sheet_to_json(ws, {
        header: 1,
        defval: '',
      }) as any[][];
      sheets.push({ name: sheetName, data: arr });
      text += `【工作表: ${sheetName}】\n`;
      for (const row of arr) {
        text += row.map((c) => String(c ?? '')).join('\t') + '\n';
      }
      text += '\n';
    }
    return { text: text.trim(), sheets };
  }

  private async writeExcel(data: {
    sheets?: { name: string; data: any[][] }[];
    json?: any[];
  }): Promise<Buffer> {
    const wb = XLSX.utils.book_new();
    if (data.sheets && data.sheets.length) {
      for (const sh of data.sheets) {
        const ws = XLSX.utils.aoa_to_sheet(sh.data || []);
        XLSX.utils.book_append_sheet(wb, ws, sh.name || 'Sheet1');
      }
    } else if (data.json && data.json.length) {
      const ws = XLSX.utils.json_to_sheet(data.json);
      XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
    }
    const out = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    return Buffer.from(out as any);
  }

  // ================= PPT =================
  private async parsePpt(filePath: string): Promise<FileParseResult> {
    let targetPath = filePath;
    let tmpPath: string | null = null;
    try {
      if (!fs.existsSync(filePath)) {
        tmpPath = path.join(os.tmpdir(), 'ppt_tmp_' + Date.now() + '.pptx');
        fs.writeFileSync(tmpPath, fs.readFileSync(filePath));
        targetPath = tmpPath;
      }
      const text: string = await new Promise((resolve, reject) => {
        officeParser.parseOffice(targetPath, (err: any, data: string) => {
          if (err) reject(err);
          else resolve(data || '');
        });
      });
      const slides = text
        .split(/\n\s*\n/)
        .map((t, i) => ({ index: i + 1, text: t.trim() }))
        .filter((s) => s.text);
      return { text, slides };
    } catch (err) {
      return { text: '', slides: [] };
    } finally {
      if (tmpPath && fs.existsSync(tmpPath)) {
        try {
          fs.unlinkSync(tmpPath);
        } catch {}
      }
    }
  }

  private async writePpt(data: {
    slides?: { title?: string; content?: string[]; bullets?: string[] }[];
    text?: string;
  }): Promise<Buffer> {
    const pptx = new PptxGenJS();
    const slides = data.slides || [];
    if (slides.length === 0 && data.text) {
      const sections = data.text.split(/\r?\n\r?\n/);
      for (const sec of sections) {
        if (!sec.trim()) continue;
        const lines = sec.split(/\r?\n/);
        slides.push({
          title: lines[0],
          bullets: lines.slice(1).filter((l) => l.trim()),
        });
      }
    }
    for (const s of slides) {
      const slide = pptx.addSlide();
      if (s.title) {
        slide.addText(s.title, {
          x: 0.5,
          y: 0.4,
          w: 9,
          h: 0.8,
          fontSize: 32,
          bold: true,
        });
      }
      const bullets = s.bullets || s.content || [];
      if (bullets.length) {
        slide.addText(
          bullets.map((b) => ({ text: b, options: { bullet: true } })),
          { x: 0.5, y: 1.5, w: 9, h: 4, fontSize: 18 }
        );
      }
    }
    const buf = await pptx.write({ outputType: 'nodebuffer' });
    return buf as Buffer;
  }

  // ================= PDF =================
  private async parsePdf(filePath: string): Promise<FileParseResult> {
    const buffer = fs.readFileSync(filePath);
    const data = await PdfParse(buffer);
    return {
      text: data.text || '',
      meta: {
        numPages: data.numpages,
        info: data.info,
      },
    };
  }
}
