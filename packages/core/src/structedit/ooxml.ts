import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from "fflate";
import { Parser } from "htmlparser2";
import { imageSize } from "../image.ts";
import { StructEditError } from "./html.ts";

/**
 * OOXML 구조 편집(5.0 M5, D-47 C: 직접 구현). DOCX·PPTX 표의 행·열 넣기·빼기와 열 너비, 그림 교체, XLSX 열 너비.
 * 2.0 텍스트 편집과 같이 바뀐 XML 구간만 다시 쓰고, 바뀐 파트만 zip에 다시 넣는다. 나머지 파트·바이트는 그대로다.
 *
 * 표 id: "<파트 경로>#t<문서 안 순번>", 그림 id: "<파트 경로>#i<순번>", 시트 id: 시트 파트 경로.
 * 병합 칸(gridSpan·vMerge·rowSpan·hMerge)이 있는 표는 행·열 넣기·빼기를 거부하고 열 너비만 바꾼다.
 */

export type OoxmlKind = "docx" | "pptx" | "xlsx";

export type OoxmlOp =
  | { t: "tableRow"; table: string; at: number; op: "add" | "remove" }
  | { t: "tableCol"; table: string; at: number; op: "add" | "remove" }
  | { t: "tableCols"; table: string; widths: number[] }
  | { t: "replaceImage"; image: string; data: Uint8Array; mime: string }
  | { t: "colWidth"; sheet: string; col: number; width: number };

export interface OoxmlTable { id: string; where: string; rows: number; cols: number; widths: number[]; merged: boolean; header: string[] }
export interface OoxmlImage { id: string; where: string; media: string; mime: string; cx: number; cy: number }
export interface OoxmlSheet { id: string; name: string; widths: number[] }
export interface OoxmlStructure { tables: OoxmlTable[]; images: OoxmlImage[]; sheets: OoxmlSheet[] }

// ---------- XML 위치 트리 ----------

interface XEl { name: string; start: number; openEnd: number; end: number; attrs: Record<string, string>; children: XEl[]; parent: XEl | null; selfClosing: boolean }

function xmlTree(xml: string): XEl {
  const root: XEl = { name: "#root", start: 0, openEnd: 0, end: xml.length, attrs: {}, children: [], parent: null, selfClosing: false };
  let cur = root;
  const parser = new Parser({
    onopentag(name, attrs) {
      const el: XEl = { name, start: parser.startIndex, openEnd: parser.endIndex + 1, end: -1, attrs, children: [], parent: cur, selfClosing: false };
      cur.children.push(el);
      cur = el;
    },
    onclosetag(_name, implied) {
      cur.end = parser.endIndex + 1;
      // 자기 닫힘 태그(<a/>)는 열기 태그 끝이 곧 요소 끝이다
      cur.selfClosing = implied || cur.end === cur.openEnd;
      cur = cur.parent ?? root;
    },
  }, { xmlMode: true, recognizeSelfClosing: true });
  parser.write(xml);
  parser.end();
  return root;
}

const find = (el: XEl, name: string): XEl | undefined => el.children.find((c) => c.name === name);
const findAll = (el: XEl, name: string): XEl[] => el.children.filter((c) => c.name === name);
function walk(el: XEl, fn: (e: XEl) => void) { fn(el); el.children.forEach((c) => walk(c, fn)); }
const descendants = (el: XEl, name: string) => { const out: XEl[] = []; walk(el, (e) => { if (e.name === name && e !== el) out.push(e); }); return out; };
const ancestor = (el: XEl, name: string) => { let p = el.parent; while (p && p.name !== name) p = p.parent; return p; };
const textOf = (xml: string, el: XEl, tag: string) => descendants(el, tag).map((t) => xml.slice(t.openEnd, t.end - `</${tag}>`.length)).join("");

/** 문자열 수정 모음. 뒤에서부터 적용해 앞쪽 위치가 밀리지 않게 한다 */
class Edits {
  private list: [number, number, string][] = [];
  replace(s: number, e: number, t: string) { this.list.push([s, e, t]); }
  insert(at: number, t: string) { this.list.push([at, at, t]); }
  apply(xml: string) {
    return this.list.sort((a, b) => b[0] - a[0] || b[1] - a[1]).reduce((x, [s, e, t]) => x.slice(0, s) + t + x.slice(e), xml);
  }
}

/** 속성 하나를 바꾼 열기 태그 문자열(없으면 태그 이름 뒤에 넣는다) */
function withAttr(xml: string, el: XEl, name: string, value: string): string {
  const tag = xml.slice(el.start, el.openEnd);
  const re = new RegExp(`(\\s${name.replace(":", "\\:")}=")([^"]*)(")`);
  if (re.test(tag)) return tag.replace(re, `$1${value}$3`);
  return tag.replace(new RegExp(`^<${el.name}`), `<${el.name} ${name}="${value}"`);
}

// ---------- 공통: 파일 열기·쓰기 ----------

const PART_RE: Record<OoxmlKind, RegExp> = {
  docx: /^word\/document\.xml$/,
  pptx: /^ppt\/slides\/slide\d+\.xml$/,
  xlsx: /^xl\/worksheets\/sheet\d+\.xml$/,
};
const num = (s: string) => Number(s.match(/(\d+)\.xml$/)?.[1] ?? 0);

function relsPath(part: string) { const i = part.lastIndexOf("/"); return `${part.slice(0, i)}/_rels/${part.slice(i + 1)}.rels`; }
function rels(zip: Record<string, Uint8Array>, part: string): Map<string, string> {
  const r = zip[relsPath(part)];
  const out = new Map<string, string>();
  if (!r) return out;
  for (const m of strFromU8(r).matchAll(/<Relationship\b[^>]*>/g)) {
    const id = /\bId="([^"]+)"/.exec(m[0])?.[1], t = /\bTarget="([^"]+)"/.exec(m[0])?.[1];
    if (id && t) out.set(id, resolveTarget(part, t));
  }
  return out;
}
function resolveTarget(part: string, target: string): string {
  if (target.startsWith("/")) return target.slice(1);
  const parts = part.split("/").slice(0, -1);
  for (const seg of target.split("/")) { if (seg === "..") parts.pop(); else if (seg !== ".") parts.push(seg); }
  return parts.join("/");
}

const MIME_EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpeg", "image/gif": "gif", "image/webp": "webp" };
const EXT_MIME: Record<string, string> = { png: "image/png", jpeg: "image/jpeg", jpg: "image/jpeg", gif: "image/gif", webp: "image/webp", emf: "image/x-emf", wmf: "image/x-wmf", svg: "image/svg+xml" };

// ---------- 표 ----------

interface TableCtx { kind: "docx" | "pptx"; part: string; xml: string; el: XEl; id: string; where: string }

const T = (kind: "docx" | "pptx") => kind === "docx"
  ? { tbl: "w:tbl", grid: "w:tblGrid", col: "w:gridCol", w: "w:w", tr: "w:tr", tc: "w:tc" }
  : { tbl: "a:tbl", grid: "a:tblGrid", col: "a:gridCol", w: "w", tr: "a:tr", tc: "a:tc" };

function tablesOf(kind: "docx" | "pptx", zip: Record<string, Uint8Array>, slideNo: Map<string, number>): TableCtx[] {
  const out: TableCtx[] = [];
  for (const part of Object.keys(zip).filter((p) => PART_RE[kind].test(p)).sort((a, b) => num(a) - num(b))) {
    const xml = strFromU8(zip[part]);
    const tree = xmlTree(xml);
    descendants(tree, T(kind).tbl).forEach((el, i) => {
      out.push({ kind, part, xml, el, id: `${part}#t${i}`, where: kind === "pptx" ? `슬라이드 ${slideNo.get(part) ?? num(part)}` : `표 ${i + 1}` });
    });
  }
  return out;
}

const rowsOf = (t: TableCtx) => findAll(t.el, T(t.kind).tr);
const cellsOf = (t: TableCtx, row: XEl) => findAll(row, T(t.kind).tc);
const gridCols = (t: TableCtx) => { const g = find(t.el, T(t.kind).grid); return g ? findAll(g, T(t.kind).col) : []; };
const colW = (t: TableCtx, c: XEl) => Number(c.attrs[T(t.kind).w] ?? 0);

function isMerged(t: TableCtx): boolean {
  if (t.kind === "pptx") return rowsOf(t).some((r) => cellsOf(t, r).some((c) => c.attrs.gridSpan || c.attrs.rowSpan || c.attrs.hMerge || c.attrs.vMerge));
  const x = t.xml.slice(t.el.start, t.el.end);
  return /<w:gridSpan\b/.test(x) || /<w:vMerge\b/.test(x);
}

/** 빈 칸 XML: 칸 서식(tcPr)은 살리고 글자만 비운다. Word는 칸마다 문단이 하나 있어야 하고, PowerPoint는 txBody가 있어야 한다 */
function emptyCell(t: TableCtx, tc: XEl): string {
  const x = t.xml;
  if (t.kind === "docx") {
    const tcPr = find(tc, "w:tcPr");
    const p = find(tc, "w:p");
    const pPr = p ? find(p, "w:pPr") : undefined;
    return `<w:tc>${tcPr ? x.slice(tcPr.start, tcPr.end) : ""}<w:p>${pPr ? x.slice(pPr.start, pPr.end) : ""}</w:p></w:tc>`;
  }
  const tcPr = find(tc, "a:tcPr");
  const body = find(tc, "a:txBody");
  const bodyPr = body ? find(body, "a:bodyPr") : undefined;
  const lst = body ? find(body, "a:lstStyle") : undefined;
  const firstP = body ? find(body, "a:p") : undefined;
  const pPr = firstP ? find(firstP, "a:pPr") : undefined;
  const runPr = firstP ? (descendants(firstP, "a:rPr")[0] ?? find(firstP, "a:endParaRPr")) : undefined;
  const end = runPr ? x.slice(runPr.start, runPr.end).replace(/^<a:rPr/, "<a:endParaRPr").replace(/<\/a:rPr>$/, "</a:endParaRPr>") : "";
  return `${x.slice(tc.start, tc.openEnd).replace(/\s(gridSpan|rowSpan|hMerge|vMerge)="[^"]*"/g, "")}<a:txBody>${bodyPr ? x.slice(bodyPr.start, bodyPr.end) : "<a:bodyPr/>"}${lst ? x.slice(lst.start, lst.end) : "<a:lstStyle/>"}<a:p>${pPr ? x.slice(pPr.start, pPr.end) : ""}${end}</a:p></a:txBody>${tcPr ? x.slice(tcPr.start, tcPr.end) : ""}</a:tc>`;
}

/** DOCX 칸 너비(tcW)를 새 값으로(있을 때만) */
function setTcW(t: TableCtx, tc: XEl, w: number, edits: Edits) {
  if (t.kind !== "docx") return;
  const tcW = descendants(tc, "w:tcW")[0];
  if (tcW && (tcW.attrs["w:type"] ?? "dxa") === "dxa") edits.replace(tcW.start, tcW.openEnd, withAttr(t.xml, tcW, "w:w", String(Math.round(w))));
}

/** PPTX 표를 담은 그래픽 틀의 크기(a:ext cx·cy)를 바꾼다 */
function frameExt(t: TableCtx): XEl | undefined {
  if (t.kind !== "pptx") return undefined;
  const frame = ancestor(t.el, "p:graphicFrame");
  const xfrm = frame ? find(frame, "p:xfrm") : undefined;
  return xfrm ? find(xfrm, "a:ext") : undefined;
}

function applyTableOp(t: TableCtx, op: Extract<OoxmlOp, { table: string }>): string {
  const x = t.xml;
  const edits = new Edits();
  const rows = rowsOf(t);
  const cols = gridCols(t);
  if (op.t !== "tableCols" && isMerged(t)) throw new StructEditError(400, "병합된 칸이 있는 표는 행·열을 넣거나 뺄 수 없습니다");

  if (op.t === "tableRow") {
    const ext = frameExt(t);
    if (op.op === "remove") {
      if (rows.length <= 1) throw new StructEditError(400, "표에는 행이 하나 이상 있어야 합니다");
      const r = rows[op.at];
      if (!r) throw new StructEditError(400, `${op.at + 1}번째 행이 없습니다`);
      edits.replace(r.start, r.end, "");
      if (ext && r.attrs.h) edits.replace(ext.start, ext.openEnd, withAttr(x, ext, "cy", String(Math.max(0, Number(ext.attrs.cy) - Number(r.attrs.h)))));
    } else {
      if (op.at < 0 || op.at > rows.length) throw new StructEditError(400, "행 위치가 표 밖입니다");
      const tpl = rows[Math.min(op.at === 0 ? 0 : op.at - 1, rows.length - 1)];
      const cells = cellsOf(t, tpl);
      const head = x.slice(tpl.start, cells[0]?.start ?? tpl.openEnd);
      const rowXml = `${head}${cells.map((c) => emptyCell(t, c)).join("")}</${tpl.name}>`;
      edits.insert(op.at === rows.length ? rows[rows.length - 1].end : rows[op.at].start, rowXml);
      if (ext && tpl.attrs.h) edits.replace(ext.start, ext.openEnd, withAttr(x, ext, "cy", String(Number(ext.attrs.cy) + Number(tpl.attrs.h))));
    }
    return edits.apply(x);
  }

  if (op.t === "tableCol") {
    const n = cols.length;
    if (op.op === "remove") {
      if (n <= 1) throw new StructEditError(400, "표에는 열이 하나 이상 있어야 합니다");
      if (op.at < 0 || op.at >= n) throw new StructEditError(400, "열 위치가 표 밖입니다");
      // 지운 열 너비를 나머지에 비율대로 나눠 표 전체 너비를 지킨다
      const ws = cols.map((c) => colW(t, c));
      const removed = ws[op.at];
      const rest = ws.filter((_, i) => i !== op.at);
      const sum = rest.reduce((a, b) => a + b, 0) || 1;
      const next = rest.map((w) => w + (removed * w) / sum);
      edits.replace(cols[op.at].start, cols[op.at].end, "");
      cols.filter((_, i) => i !== op.at).forEach((c, i) => edits.replace(c.start, c.openEnd, withAttr(x, c, T(t.kind).w, String(Math.round(next[i])))));
      for (const r of rows) {
        const cs = cellsOf(t, r);
        if (cs[op.at]) edits.replace(cs[op.at].start, cs[op.at].end, "");
        cs.filter((_, i) => i !== op.at).forEach((c, i) => setTcW(t, c, next[i], edits));
      }
    } else {
      if (op.at < 0 || op.at > n) throw new StructEditError(400, "열 위치가 표 밖입니다");
      // 이웃 열을 반으로 나눠 새 열에 준다(표 전체 너비 유지)
      const nb = Math.min(op.at, n - 1);
      const half = Math.round(colW(t, cols[nb]) / 2);
      edits.replace(cols[nb].start, cols[nb].openEnd, withAttr(x, cols[nb], T(t.kind).w, String(colW(t, cols[nb]) - half)));
      const newCol = x.slice(cols[nb].start, cols[nb].end).replace(new RegExp(`(\\s${T(t.kind).w.replace(":", "\\:")}=")[^"]*"`), `$1${half}"`);
      edits.insert(op.at === n ? cols[n - 1].end : cols[op.at].start, newCol);
      for (const r of rows) {
        const cs = cellsOf(t, r);
        const tpl = cs[Math.min(op.at, cs.length - 1)];
        if (!tpl) continue;
        setTcW(t, cs[nb], colW(t, cols[nb]) - half, edits);
        let cell = emptyCell(t, tpl);
        if (t.kind === "docx") cell = cell.replace(/(<w:tcW\b[^>]*\sw:w=")[^"]*"/, `$1${half}"`);
        edits.insert(op.at >= cs.length ? cs[cs.length - 1].end : cs[op.at].start, cell);
      }
    }
    return edits.apply(x);
  }

  // tableCols: 퍼센트(합 100)를 지금 표 전체 너비에 맞춰 나눈다
  if (op.widths.length !== cols.length) throw new StructEditError(400, `열이 ${cols.length}개인데 너비가 ${op.widths.length}개입니다`);
  if (op.widths.some((w) => !(w > 0))) throw new StructEditError(400, "열 너비는 0보다 커야 합니다");
  const total = cols.reduce((a, c) => a + colW(t, c), 0);
  const sum = op.widths.reduce((a, b) => a + b, 0);
  const next = op.widths.map((w) => (total * w) / sum);
  cols.forEach((c, i) => edits.replace(c.start, c.openEnd, withAttr(x, c, T(t.kind).w, String(Math.round(next[i])))));
  if (!isMerged(t)) for (const r of rows) cellsOf(t, r).forEach((c, i) => setTcW(t, c, next[i], edits));
  return edits.apply(x);
}

// ---------- 그림 ----------

interface ImageCtx { part: string; xml: string; blip: XEl; rid: string; media: string; id: string; where: string; exts: XEl[] }

function imagesOf(kind: "docx" | "pptx", zip: Record<string, Uint8Array>, slideNo: Map<string, number>): ImageCtx[] {
  const out: ImageCtx[] = [];
  for (const part of Object.keys(zip).filter((p) => PART_RE[kind].test(p)).sort((a, b) => num(a) - num(b))) {
    const xml = strFromU8(zip[part]);
    const r = rels(zip, part);
    descendants(xmlTree(xml), "a:blip").forEach((blip, i) => {
      const rid = blip.attrs["r:embed"];
      const media = rid ? r.get(rid) : undefined;
      if (!rid || !media || !zip[media]) return;
      // 크기: DOCX는 wp:extent와 pic:spPr의 a:ext, PPTX는 p:pic의 a:ext
      const exts: XEl[] = [];
      if (kind === "docx") {
        const inline = ancestor(blip, "wp:inline") ?? ancestor(blip, "wp:anchor");
        if (inline) { const e = find(inline, "wp:extent"); if (e) exts.push(e); }
        const pic = ancestor(blip, "pic:pic");
        const spPr = pic ? find(pic, "pic:spPr") : undefined;
        const xfrm = spPr ? find(spPr, "a:xfrm") : undefined;
        const e2 = xfrm ? find(xfrm, "a:ext") : undefined;
        if (e2) exts.push(e2);
      } else {
        const pic = ancestor(blip, "p:pic");
        const spPr = pic ? find(pic, "p:spPr") : undefined;
        const xfrm = spPr ? find(spPr, "a:xfrm") : undefined;
        const e = xfrm ? find(xfrm, "a:ext") : undefined;
        if (e) exts.push(e);
      }
      out.push({ part, xml, blip, rid, media, id: `${part}#i${i}`, where: kind === "pptx" ? `슬라이드 ${slideNo.get(part) ?? num(part)}` : `그림 ${i + 1}`, exts });
    });
  }
  return out;
}

/** 그림 교체: 같은 형식이면 미디어 파일만 바꾸고, 형식이 다르면 새 미디어 파트를 만들어 이 그림만 가리키게 한다. 가로는 지키고 세로는 새 그림 비율로 */
function replaceImage(zip: Record<string, Uint8Array>, img: ImageCtx, data: Uint8Array, mime: string, changed: Map<string, Uint8Array>) {
  const ext = MIME_EXT[mime];
  if (!ext) throw new StructEditError(400, "PNG·JPEG·GIF·WebP만 넣을 수 있습니다");
  const size = imageSize(data);
  if (!size) throw new StructEditError(400, "이미지 파일을 읽을 수 없습니다");
  const oldExt = img.media.split(".").pop()!.toLowerCase();
  const sameType = EXT_MIME[oldExt] === mime;
  // 같은 미디어를 다른 그림도 쓰면 새 파트를 만들어 이 그림만 바꾼다
  const shared = Object.keys(zip).filter((p) => PART_RE.docx.test(p) || PART_RE.pptx.test(p))
    .some((p) => { const r = rels(zip, p); return [...strFromU8(zip[p]).matchAll(/r:embed="([^"]+)"/g)].filter((m) => r.get(m[1]) === img.media).length > (p === img.part ? 1 : 0); });
  const edits = new Edits();
  if (sameType && !shared) {
    changed.set(img.media, data);
  } else {
    const dir = img.media.slice(0, img.media.lastIndexOf("/") + 1);
    let n = 1, name = "";
    do { name = `${dir}edit-${n++}.${ext}`; } while (zip[name] || changed.has(name));
    changed.set(name, data);
    // 관계 하나 더 만들어 이 그림의 r:embed만 바꾼다
    const rp = relsPath(img.part);
    const relXml = strFromU8(changed.get(rp) ?? zip[rp]);
    const ids = new Set([...relXml.matchAll(/\bId="([^"]+)"/g)].map((m) => m[1]));
    let k = 1, rid = "";
    do { rid = `rIdEdit${k++}`; } while (ids.has(rid));
    const relTarget = relativeTarget(img.part, name);
    changed.set(rp, strToU8(relXml.replace("</Relationships>", `<Relationship Id="${rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="${relTarget}"/></Relationships>`)));
    edits.replace(img.blip.start, img.blip.openEnd, withAttr(img.xml, img.blip, "r:embed", rid));
    // 확장자 기본 형식 등록
    const ct = strFromU8(changed.get("[Content_Types].xml") ?? zip["[Content_Types].xml"]);
    if (!new RegExp(`<Default\\b[^>]*Extension="${ext}"`, "i").test(ct)) {
      changed.set("[Content_Types].xml", strToU8(ct.replace("</Types>", `<Default Extension="${ext}" ContentType="${mime}"/></Types>`)));
    }
  }
  for (const e of img.exts) {
    const cx = Number(e.attrs.cx);
    if (cx > 0) edits.replace(e.start, e.openEnd, withAttr(img.xml, e, "cy", String(Math.round((cx * size.height) / size.width))));
  }
  return edits.apply(img.xml);
}

function relativeTarget(fromPart: string, to: string): string {
  const from = fromPart.split("/").slice(0, -1), dest = to.split("/");
  let i = 0;
  while (i < from.length && from[i] === dest[i]) i++;
  return [...Array(from.length - i).fill(".."), ...dest.slice(i)].join("/");
}

// ---------- XLSX 열 너비 ----------

function sheetsOf(zip: Record<string, Uint8Array>): { part: string; name: string }[] {
  const wb = zip["xl/workbook.xml"];
  const r = rels(zip, "xl/workbook.xml");
  if (!wb) return [];
  return [...strFromU8(wb).matchAll(/<sheet\b[^>]*>/g)].map((m) => {
    const name = /\bname="([^"]*)"/.exec(m[0])?.[1] ?? "";
    const rid = /\br:id="([^"]+)"/.exec(m[0])?.[1] ?? "";
    return { part: r.get(rid) ?? "", name };
  }).filter((s) => s.part && zip[s.part]);
}

function sheetWidths(xml: string, count = 26): number[] {
  const tree = xmlTree(xml);
  const ws = find(tree, "worksheet");
  const fmt = ws ? find(ws, "sheetFormatPr") : undefined;
  const def = Number(fmt?.attrs.defaultColWidth ?? 8.43);
  const cols = ws ? find(ws, "cols") : undefined;
  const out = Array(count).fill(def);
  for (const c of cols ? findAll(cols, "col") : []) {
    for (let i = Number(c.attrs.min); i <= Math.min(Number(c.attrs.max), count); i++) out[i - 1] = Number(c.attrs.width ?? def);
  }
  return out;
}

function setColWidth(xml: string, col: number, width: number): string {
  if (!(width > 0 && width <= 255)) throw new StructEditError(400, "열 너비는 0~255(글자 수)입니다");
  const c1 = col + 1;
  const tree = xmlTree(xml);
  const ws = find(tree, "worksheet");
  if (!ws) throw new StructEditError(400, "시트를 읽을 수 없습니다");
  const cols = find(ws, "cols");
  const one = (min: number, max: number, attrs: Record<string, string>) =>
    `<col min="${min}" max="${max}"${Object.entries(attrs).filter(([k]) => k !== "min" && k !== "max").map(([k, v]) => ` ${k}="${v}"`).join("")}/>`;
  const target = `<col min="${c1}" max="${c1}" width="${Math.round(width * 100) / 100}" customWidth="1"/>`;
  if (!cols) {
    // <cols>는 sheetFormatPr 뒤, sheetData 앞에 둔다(스키마 순서)
    const data = find(ws, "sheetData");
    if (!data) throw new StructEditError(400, "시트에 sheetData가 없습니다");
    return xml.slice(0, data.start) + `<cols>${target}</cols>` + xml.slice(data.start);
  }
  const items = findAll(cols, "col");
  const covering = items.find((c) => Number(c.attrs.min) <= c1 && c1 <= Number(c.attrs.max));
  const edits = new Edits();
  if (covering) {
    const min = Number(covering.attrs.min), max = Number(covering.attrs.max);
    const parts = [
      min < c1 ? one(min, c1 - 1, covering.attrs) : "",
      `<col min="${c1}" max="${c1}"${Object.entries({ ...covering.attrs, width: String(Math.round(width * 100) / 100), customWidth: "1" }).filter(([k]) => k !== "min" && k !== "max").map(([k, v]) => ` ${k}="${v}"`).join("")}/>`,
      c1 < max ? one(c1 + 1, max, covering.attrs) : "",
    ];
    edits.replace(covering.start, covering.end, parts.join(""));
  } else {
    const after = items.filter((c) => Number(c.attrs.max) < c1).pop();
    edits.insert(after ? after.end : cols.openEnd, target);
  }
  return edits.apply(xml);
}

// ---------- 공개 함수 ----------

/** 풀었을 때 크기 상한(Worker 메모리 128MB 안). 넘으면 압축 폭탄으로 보고 413 */
export const MAX_UNZIPPED = 64 * 1024 * 1024;
/** 한 번에 받는 연산 수 상한 */
export const MAX_OPS = 500;

function unzipLimited(data: Uint8Array) {
  let total = 0;
  const zip = unzipSync(data, { filter: (f) => {
    total += f.originalSize;
    if (total > MAX_UNZIPPED) throw new StructEditError(413, `압축을 풀면 ${MAX_UNZIPPED / 1024 / 1024}MB를 넘는 파일은 고칠 수 없습니다`);
    return true;
  } });
  return zip;
}

function slideOrder(zip: Record<string, Uint8Array>): Map<string, number> {
  const order = new Map<string, number>();
  const pres = zip["ppt/presentation.xml"];
  if (!pres) return order;
  const r = rels(zip, "ppt/presentation.xml");
  [...strFromU8(pres).matchAll(/<p:sldId\b[^>]*\br:id="([^"]+)"/g)].forEach((m, i) => { const t = r.get(m[1]); if (t) order.set(t, i + 1); });
  return order;
}

export function ooxmlStructure(kind: OoxmlKind, data: Uint8Array): OoxmlStructure {
  const zip = unzipLimited(data);
  if (kind === "xlsx") {
    return { tables: [], images: [], sheets: sheetsOf(zip).map((s) => ({ id: s.part, name: s.name, widths: sheetWidths(strFromU8(zip[s.part])) })) };
  }
  const order = slideOrder(zip);
  const tables = tablesOf(kind, zip, order).map((t) => {
    const cols = gridCols(t);
    const ws = cols.map((c) => colW(t, c));
    const sum = ws.reduce((a, b) => a + b, 0) || 1;
    const first = rowsOf(t)[0];
    return { id: t.id, where: t.where, rows: rowsOf(t).length, cols: cols.length, widths: ws.map((w) => Math.round((w / sum) * 10000) / 100), merged: isMerged(t),
      header: first ? cellsOf(t, first).map((c) => textOf(t.xml, c, kind === "docx" ? "w:t" : "a:t").slice(0, 40)) : [] };
  });
  const images = imagesOf(kind, zip, order).map((i) => ({
    id: i.id, where: i.where, media: i.media, mime: EXT_MIME[i.media.split(".").pop()!.toLowerCase()] ?? "application/octet-stream",
    cx: Number(i.exts[0]?.attrs.cx ?? 0), cy: Number(i.exts[0]?.attrs.cy ?? 0),
  }));
  return { tables, images, sheets: [] };
}

/** 그림 파트의 바이트(목록 화면 미리보기용) */
export function ooxmlMedia(data: Uint8Array, media: string): Uint8Array | null {
  return unzipSync(data, { filter: (f) => f.name === media && f.originalSize <= MAX_UNZIPPED })[media] ?? null;
}

/** 연산을 차례로 적용한 새 파일. 바뀐 파트만 다시 쓴다 */
export function applyOoxmlOps(kind: OoxmlKind, data: Uint8Array, ops: OoxmlOp[]): Uint8Array {
  if (ops.length > MAX_OPS) throw new StructEditError(400, `연산은 한 번에 ${MAX_OPS}개까지입니다`);
  const zip = unzipLimited(data);
  const changed = new Map<string, Uint8Array>();
  const current = () => ({ ...zip, ...Object.fromEntries(changed) });
  for (const op of ops) {
    const z = current();
    if (op.t === "colWidth") {
      if (kind !== "xlsx") throw new StructEditError(400, "열 너비(시트)는 XLSX에서만 바꿉니다");
      if (!z[op.sheet] || !PART_RE.xlsx.test(op.sheet)) throw new StructEditError(404, `시트 ${op.sheet}이(가) 없습니다`);
      changed.set(op.sheet, strToU8(setColWidth(strFromU8(z[op.sheet]), op.col, op.width)));
      continue;
    }
    if (kind === "xlsx") throw new StructEditError(400, "XLSX는 열 너비만 바꿀 수 있습니다");
    if (op.t === "replaceImage") {
      const img = imagesOf(kind, z, slideOrder(z)).find((i) => i.id === op.image);
      if (!img) throw new StructEditError(409, `그림 ${op.image}을(를) 찾을 수 없습니다. 문서를 다시 불러오세요`);
      changed.set(img.part, strToU8(replaceImage(z, img, op.data, op.mime, changed)));
      continue;
    }
    const t = tablesOf(kind, z, slideOrder(z)).find((x) => x.id === op.table);
    if (!t) throw new StructEditError(409, `표 ${op.table}을(를) 찾을 수 없습니다. 문서를 다시 불러오세요`);
    changed.set(t.part, strToU8(applyTableOp(t, op)));
  }
  if (!changed.size) return data;
  // 원래 파트 순서를 지켜 다시 묶는다(새 파트는 끝에)
  const out: Zippable = {};
  for (const name of Object.keys(zip)) out[name] = changed.get(name) ?? zip[name];
  for (const [name, d] of changed) if (!(name in out)) out[name] = d;
  return zipSync(out, { level: 6 });
}
