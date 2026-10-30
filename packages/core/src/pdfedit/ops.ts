import fontkit from "@pdf-lib/fontkit";
import { BlendMode, degrees, LineCapStyle, PDFCheckBox, PDFDocument, PDFDropdown, PDFRadioGroup, PDFTextField, rgb, type PDFFont, type PDFPage } from "pdf-lib";

/**
 * PDF 편집(5.0 M6, 4.5절). 배치가 고정된 출력물이라 본문 글자 고치기·다시 흘리기는 하지 않는다.
 * - 덧그리기: 글상자(한글은 쓴 글자만 자른 글꼴), 그림, 형광펜(반투명 사각형), 펜(선). 페이지 내용에 그려 넣는다(어느 뷰어에서나 같게 보인다).
 * - 페이지: 회전·지우기·옮기기·다른 PDF 끼워 넣기. 양식 채우기(글자·체크·목록).
 * 좌표는 PDF 사용자 공간(pt, 왼쪽 아래 원점, 회전 전). x·y는 화면에서 본 상자의 왼쪽 위 꼭짓점이고(화면이 pdf.js viewport로 바꿔 준다),
 * 회전된 페이지에서는 페이지 회전만큼 돌려 그려 화면에서 똑바로 보이게 한다.
 */

export type PdfOp =
  | { t: "text"; page: number; x: number; y: number; size: number; text: string; color?: string }
  | { t: "image"; page: number; x: number; y: number; width: number; height: number; data: Uint8Array; mime: string }
  | { t: "rect"; page: number; x: number; y: number; width: number; height: number; color?: string; opacity?: number }
  | { t: "ink"; page: number; strokes: [number, number][][]; color?: string; width?: number }
  | { t: "rotate"; page: number; by: 90 | -90 | 180 }
  | { t: "deletePage"; page: number }
  | { t: "movePage"; from: number; to: number }
  | { t: "insertPdf"; at: number; data: Uint8Array }
  | { t: "fill"; values: Record<string, string | boolean> };

export interface PdfField { name: string; type: "text" | "checkbox" | "dropdown" | "radio" | "other"; value: string | boolean | null; options?: string[] }

export class PdfEditError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

const HEX = /^#[0-9a-fA-F]{6}$/;
const color = (c: string | undefined, fallback: string) => {
  const h = c && HEX.test(c) ? c : fallback;
  return rgb(parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255);
};

/** 글상자·양식 값에 쓰인 글자 전부(부분 글꼴을 한 번만 만든다) */
export function textOfOps(ops: PdfOp[]): string {
  return ops.map((o) => (o.t === "text" ? o.text : o.t === "fill" ? Object.values(o.values).filter((v) => typeof v === "string").join("") : "")).join("");
}

/** 페이지 회전(시계 방향 표시 각도)만큼 내용을 반시계로 돌려야 화면에서 똑바로 보인다. 화면 기준 "아래" 방향 단위 벡터 */
function frame(page: PDFPage) {
  const r = ((page.getRotation().angle % 360) + 360) % 360;
  const rad = (r * Math.PI) / 180;
  return { r, down: [Math.sin(rad), -Math.cos(rad)] as const };
}

export interface PdfOpsContext {
  /** 글자에 쓸 글꼴(TTF). 쓴 글자만 자른 글꼴을 돌려주면 PDF가 작다(subsetFont) */
  font?: (text: string) => Promise<Uint8Array>;
}

/** 연산을 차례로 적용한 새 PDF 바이트 */
export async function applyPdfOps(data: Uint8Array, ops: PdfOp[], ctx: PdfOpsContext = {}): Promise<Uint8Array> {
  if (!ops.length) return data;
  const doc = await PDFDocument.load(data, { updateMetadata: false });
  doc.registerFontkit(fontkit);
  const chars = textOfOps(ops);
  let font: PDFFont | undefined;
  if (chars.trim()) {
    if (!ctx.font) throw new PdfEditError(400, "글자를 쓰려면 글꼴이 필요합니다");
    font = await doc.embedFont(await ctx.font(chars), { subset: false });
  }
  const page = (i: number) => {
    const n = doc.getPageCount();
    if (!Number.isInteger(i) || i < 0 || i >= n) throw new PdfEditError(400, `${i + 1}쪽이 없습니다(전체 ${n}쪽)`);
    return doc.getPage(i);
  };
  const finite = (...xs: number[]) => { if (!xs.every(Number.isFinite)) throw new PdfEditError(400, "좌표가 올바르지 않습니다"); };

  for (const op of ops) {
    switch (op.t) {
      case "text": {
        finite(op.x, op.y, op.size);
        if (op.size < 4 || op.size > 400) throw new PdfEditError(400, "글자 크기는 4~400pt");
        const p = page(op.page), { r, down } = frame(p);
        const ascent = font!.heightAtSize(op.size, { descender: false });
        const lh = op.size * 1.3;
        op.text.split(/\r?\n/).forEach((line, i) => {
          if (!line) return;
          const d = ascent + i * lh;
          p.drawText(line, { x: op.x + down[0] * d, y: op.y + down[1] * d, size: op.size, font, color: color(op.color, "#1c2026"), rotate: degrees(r) });
        });
        break;
      }
      case "image": {
        finite(op.x, op.y, op.width, op.height);
        const p = page(op.page), { r, down } = frame(p);
        const img = op.mime === "image/png" ? await doc.embedPng(op.data) : op.mime === "image/jpeg" ? await doc.embedJpg(op.data)
          : (() => { throw new PdfEditError(400, "PDF에는 PNG·JPEG만 넣을 수 있습니다"); })();
        p.drawImage(img, { x: op.x + down[0] * op.height, y: op.y + down[1] * op.height, width: op.width, height: op.height, rotate: degrees(r) });
        break;
      }
      case "rect": {
        finite(op.x, op.y, op.width, op.height);
        const p = page(op.page), { r, down } = frame(p);
        p.drawRectangle({ x: op.x + down[0] * op.height, y: op.y + down[1] * op.height, width: op.width, height: op.height, rotate: degrees(r),
          color: color(op.color, "#ffd43b"), opacity: op.opacity ?? 0.35, blendMode: BlendMode.Multiply });
        break;
      }
      case "ink": {
        const p = page(op.page);
        const c = color(op.color, "#d6336c"), w = op.width ?? 2;
        for (const s of op.strokes) {
          s.forEach(([x, y]) => finite(x, y));
          if (s.length === 1) p.drawCircle({ x: s[0][0], y: s[0][1], size: w / 2, color: c });
          for (let i = 1; i < s.length; i++) {
            p.drawLine({ start: { x: s[i - 1][0], y: s[i - 1][1] }, end: { x: s[i][0], y: s[i][1] }, thickness: w, color: c, lineCap: LineCapStyle.Round });
          }
        }
        break;
      }
      case "rotate": {
        if (![90, -90, 180].includes(op.by)) throw new PdfEditError(400, "회전은 90·-90·180도만");
        const p = page(op.page);
        p.setRotation(degrees((((p.getRotation().angle + op.by) % 360) + 360) % 360));
        break;
      }
      case "deletePage": {
        page(op.page);
        if (doc.getPageCount() <= 1) throw new PdfEditError(400, "PDF에는 쪽이 하나 이상 있어야 합니다");
        doc.removePage(op.page);
        break;
      }
      case "movePage": {
        const p = page(op.from);
        const n = doc.getPageCount();
        if (!Number.isInteger(op.to) || op.to < 0 || op.to >= n) throw new PdfEditError(400, `${op.to + 1}쪽 자리가 없습니다`);
        if (op.from === op.to) break;
        doc.removePage(op.from);
        doc.insertPage(op.to, p);
        break;
      }
      case "insertPdf": {
        const n = doc.getPageCount();
        if (!Number.isInteger(op.at) || op.at < 0 || op.at > n) throw new PdfEditError(400, "끼워 넣을 자리가 없습니다");
        let src: PDFDocument;
        try { src = await PDFDocument.load(op.data, { updateMetadata: false }); } catch { throw new PdfEditError(400, "끼워 넣을 파일이 PDF가 아닙니다"); }
        const pages = await doc.copyPages(src, src.getPageIndices());
        pages.forEach((pg, i) => doc.insertPage(op.at + i, pg));
        break;
      }
      case "fill": {
        const form = doc.getForm();
        for (const [name, v] of Object.entries(op.values)) {
          let f;
          try { f = form.getField(name); } catch { throw new PdfEditError(400, `양식 칸이 없습니다: ${name}`); }
          if (f instanceof PDFTextField) f.setText(String(v));
          else if (f instanceof PDFCheckBox) { if (v === true || v === "true") f.check(); else f.uncheck(); }
          else if (f instanceof PDFDropdown) f.select(String(v));
          else if (f instanceof PDFRadioGroup) f.select(String(v));
          else throw new PdfEditError(400, `채울 수 없는 칸입니다: ${name}`);
        }
        // 기본 글꼴(Helvetica)은 한글을 못 그리므로 우리 글꼴로 칸 모양을 다시 만든다
        if (font) form.updateFieldAppearances(font);
        break;
      }
      default:
        throw new PdfEditError(400, `알 수 없는 연산: ${(op as { t: string }).t}`);
    }
  }
  return doc.save({ updateFieldAppearances: !font });
}

/** 양식 칸 목록(채우기 화면) */
export async function listPdfFields(data: Uint8Array): Promise<PdfField[]> {
  const doc = await PDFDocument.load(data, { updateMetadata: false });
  return doc.getForm().getFields().map((f) => {
    const name = f.getName();
    if (f instanceof PDFTextField) return { name, type: "text" as const, value: f.getText() ?? "" };
    if (f instanceof PDFCheckBox) return { name, type: "checkbox" as const, value: f.isChecked() };
    if (f instanceof PDFDropdown) return { name, type: "dropdown" as const, value: f.getSelected()[0] ?? null, options: f.getOptions() };
    if (f instanceof PDFRadioGroup) return { name, type: "radio" as const, value: f.getSelected() ?? null, options: f.getOptions() };
    return { name, type: "other" as const, value: null };
  });
}
