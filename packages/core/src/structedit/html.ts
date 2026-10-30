import { parse, parseFragment } from "parse5";
import type { DefaultTreeAdapterMap } from "parse5";

/**
 * HTML 구조 편집(5.0 M3, spec/REQUIREMENT-5.0.md 4.1). 2.0 텍스트 편집과 같은 원리를 요소 단위로 넓혔다:
 * parse5가 준 요소의 원본 위치만 다시 쓰고, 바뀌지 않은 바이트는 그대로 둔다. 디자인된 단일 파일 문서가 깨지지 않게 하기 위해서다.
 *
 * - 요소 id(eid)는 그 요소 시작 태그의 원본 위치("e<바이트 위치>")다. 같은 파일에서는 늘 같고, 파일이 바뀌면 다시 읽어야 한다.
 * - 연산은 하나씩 적용하고 적용할 때마다 다시 파싱한다(정확성이 우선, 문서는 수십~수백 KB).
 * - 새로 넣는 표·그림은 문서에 이미 있는 같은 종류 요소의 class를 따른다(문서 디자인 체계 유지).
 */

type Node = DefaultTreeAdapterMap["node"];
type Element = DefaultTreeAdapterMap["element"];

export type Eid = string;
export type Where = "before" | "after";

export type NewNode =
  | { kind: "table"; rows: number; cols: number; header?: boolean }
  | { kind: "image"; src: string; alt?: string; width?: number }
  | { kind: "paragraph"; text?: string }
  | { kind: "heading"; level: 2 | 3 | 4; text?: string };

export type HtmlOp =
  | { t: "setText"; eid: Eid; html: string }
  | { t: "setAttr"; eid: Eid; name: "src" | "alt" | "href"; value: string }
  | { t: "setWidth"; eid: Eid; percent: number | null }
  | { t: "insert"; ref: Eid; where: Where; node: NewNode }
  | { t: "remove"; eid: Eid }
  | { t: "move"; eid: Eid; ref: Eid; where: Where }
  | { t: "tableRow"; eid: Eid; at: number; op: "add" | "remove" }
  | { t: "tableCol"; eid: Eid; at: number; op: "add" | "remove" }
  | { t: "tableCols"; eid: Eid; widths: number[] };

export class StructEditError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

/** 고를 수 있는 요소(편집 사본에 data-eid를 붙이는 것) */
const BLOCKS = new Set(["section", "article", "header", "footer", "figure", "figcaption", "table", "img", "p", "h1", "h2", "h3", "h4", "h5", "h6",
  "ul", "ol", "li", "blockquote", "pre", "dl", "dt", "dd", "caption", "tr", "th", "td", "aside", "details", "summary", "hr"]);
/** 글자를 바꿀 수 있는 요소(안쪽 HTML을 인라인 마크로만 다시 쓴다) */
const TEXT_BLOCKS = new Set(["p", "h1", "h2", "h3", "h4", "h5", "h6", "li", "th", "td", "figcaption", "caption", "dt", "dd", "blockquote", "summary"]);
const SKIP = new Set(["head", "script", "style", "noscript", "template", "svg", "math"]);

interface Loc { start: number; end: number; innerStart: number; innerEnd: number; tagEnd: number }

const locOf = (el: Element): Loc | null => {
  const l = el.sourceCodeLocation;
  if (!l?.startTag) return null;
  return { start: l.startOffset, end: l.endOffset, tagEnd: l.startTag.endOffset, innerStart: l.startTag.endOffset, innerEnd: l.endTag ? l.endTag.startOffset : l.endOffset };
};
const eidOf = (el: Element) => `e${el.sourceCodeLocation!.startOffset}`;
const isEl = (n: Node): n is Element => "tagName" in n && !!(n as Element).tagName;
const kids = (el: Element) => ("childNodes" in el ? el.childNodes : []).filter(isEl);
const attr = (el: Element, name: string) => el.attrs.find((a) => a.name === name)?.value;

function parseDoc(html: string) {
  const doc = parse(html, { sourceCodeLocationInfo: true });
  const byEid = new Map<Eid, Element>();
  const parents = new Map<Element, Element | null>();
  const walk = (n: Node, parent: Element | null) => {
    if (isEl(n)) {
      if (SKIP.has(n.tagName)) return;
      parents.set(n, parent);
      if (BLOCKS.has(n.tagName) && n.sourceCodeLocation?.startTag) byEid.set(eidOf(n), n);
      parent = n;
    }
    if ("childNodes" in n) for (const c of n.childNodes) walk(c, parent);
  };
  walk(doc, null);
  return { doc, byEid, parents, firstOf: (tag: string) => [...byEid.values()].find((e) => e.tagName === tag) };
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escAttr = (s: string) => esc(s).replace(/"/g, "&quot;");

/** 줄 앞 들여쓰기(그 요소가 줄 처음에 있을 때) */
function indentAt(html: string, pos: number): string {
  const lineStart = html.lastIndexOf("\n", pos - 1) + 1;
  const before = html.slice(lineStart, pos);
  return /^[ \t]*$/.test(before) ? before : "";
}

/** 요소를 지울 때 그 줄의 들여쓰기·줄바꿈까지 함께 지울 구간 */
function removalRange(html: string, loc: Loc): [number, number] {
  const ind = indentAt(html, loc.start);
  let s = loc.start - ind.length;
  let e = loc.end;
  if (ind.length || html[s - 1] === "\n") {
    if (html[e] === "\r") e++;
    if (html[e] === "\n") e++;
    else if (s > 0 && html[s - 1] === "\n") s--;
  }
  return [s, e];
}

const splice = (html: string, s: number, e: number, text: string) => html.slice(0, s) + text + html.slice(e);

// ---------- 인라인 HTML 정리(setText) ----------

const DROP = new Set(["script", "style", "template", "iframe", "object", "embed", "noscript", "svg", "math", "textarea", "select"]);
const INLINE = new Set(["b", "strong", "i", "em", "u", "code", "br", "sub", "sup", "mark", "span", "a", "small", "s"]);

/** 글자 칸에 넣을 HTML을 인라인 마크만 남기고 다시 쓴다. 링크는 http(s)·#·상대 경로만 */
export function sanitizeInline(input: string): string {
  const frag = parseFragment(input);
  const out: string[] = [];
  const walk = (n: Node) => {
    if (n.nodeName === "#text") { out.push(esc((n as DefaultTreeAdapterMap["textNode"]).value)); return; }
    if (!isEl(n)) return;
    // 스크립트·스타일 같은 것은 안의 글자까지 버린다
    if (DROP.has(n.tagName)) return;
    if (!INLINE.has(n.tagName)) { for (const c of n.childNodes ?? []) walk(c); return; }
    if (n.tagName === "br") { out.push("<br>"); return; }
    let attrs = "";
    if (n.tagName === "a") {
      // 브라우저는 주소의 탭·줄바꿈을 지우므로(java\tscript:) 제어 문자를 먼저 지우고, 허용한 형태만 남긴다:
      // http(s)·mailto·#·상대 경로(스킴 없음, 역슬래시·// 없음)
      const href = (attr(n, "href") ?? "").replace(/[\u0000-\u001f\u007f\s]+/g, "");
      const ok = /^(https?:\/\/|mailto:|#)/i.test(href) || (!/^[a-z][\w+.-]*:/i.test(href) && !href.startsWith("//") && !href.includes("\\") && href !== "");
      if (!ok) { for (const c of n.childNodes) walk(c); return; }
      attrs = ` href="${escAttr(href)}"`;
    }
    out.push(`<${n.tagName}${attrs}>`);
    for (const c of n.childNodes) walk(c);
    out.push(`</${n.tagName}>`);
  };
  for (const c of frag.childNodes) walk(c);
  return out.join("");
}

// ---------- 표 ----------

interface TableShape { rows: Element[]; cells: Element[][]; colgroup: Element | null; caption: Element | null; merged: boolean }

function tableShape(table: Element): TableShape {
  const rows: Element[] = [];
  let colgroup: Element | null = null;
  let caption: Element | null = null;
  for (const c of kids(table)) {
    if (c.tagName === "tr") rows.push(c);
    else if (["thead", "tbody", "tfoot"].includes(c.tagName)) rows.push(...kids(c).filter((r) => r.tagName === "tr"));
    else if (c.tagName === "colgroup") colgroup = c;
    else if (c.tagName === "caption") caption = c;
  }
  const cells = rows.map((r) => kids(r).filter((c) => c.tagName === "td" || c.tagName === "th"));
  const merged = cells.some((row) => row.some((c) => Number(attr(c, "colspan") ?? 1) > 1 || Number(attr(c, "rowspan") ?? 1) > 1));
  return { rows, cells, colgroup, caption, merged };
}

const colCount = (s: TableShape) => Math.max(0, ...s.cells.map((r) => r.length));

/** 빈 칸: 원본 칸의 시작 태그(속성 포함)는 살리고 내용만 비운다 */
function emptyCellLike(html: string, cell: Element): string {
  const l = locOf(cell)!;
  return `${html.slice(l.start, l.tagEnd)}</${cell.tagName}>`;
}

function colgroupHtml(widths: number[], indent: string): string {
  return `<colgroup>${widths.map((w) => `<col style="width:${round(w)}%">`).join("")}</colgroup>${indent ? "\n" + indent : ""}`;
}
const round = (n: number) => Math.round(n * 100) / 100;

function normalizeWidths(widths: number[]): number[] {
  if (widths.some((w) => !(w > 0))) throw new StructEditError(400, "열 너비는 0보다 커야 합니다");
  const sum = widths.reduce((a, b) => a + b, 0);
  return widths.map((w) => (w / sum) * 100);
}

function colgroupWidths(cg: Element | null): number[] | null {
  if (!cg) return null;
  const ws = kids(cg).filter((c) => c.tagName === "col").map((c) => Number(/width:\s*([\d.]+)%/.exec(attr(c, "style") ?? "")?.[1] ?? NaN));
  if (!ws.length) return null;
  // 너비가 없는 열(<col>)은 남은 몫을 나눠 갖는다(예: 마지막 열만 비워 둔 문서)
  const given = ws.filter((w) => w > 0);
  const rest = Math.max(0, 100 - given.reduce((a, b) => a + b, 0));
  const missing = ws.length - given.length;
  return missing ? ws.map((w) => (w > 0 ? w : rest / missing)) : ws;
}

/** colgroup을 새 너비로 다시 쓰거나(있으면) 시작 태그(캡션) 뒤에 넣는다 */
function writeColgroup(html: string, table: Element, s: TableShape, widths: number[]): string {
  if (s.colgroup) {
    const l = locOf(s.colgroup)!;
    return splice(html, l.start, l.end, colgroupHtml(widths, ""));
  }
  const after = s.caption ? locOf(s.caption)!.end : locOf(table)!.tagEnd;
  const firstRow = s.rows[0] ? locOf(s.rows[0].parentNode as Element === table ? s.rows[0] : (s.rows[0].parentNode as Element)) : null;
  const ind = firstRow ? indentAt(html, firstRow.start) : "";
  return splice(html, after, after, (ind ? "\n" + ind : "") + colgroupHtml(widths, ""));
}

// ---------- 새 요소 ----------

function newNodeHtml(n: NewNode, ctx: ReturnType<typeof parseDoc>, html: string, indent: string): string {
  const cls = (tag: string) => { const e = ctx.firstOf(tag); const c = e && attr(e, "class"); return c ? ` class="${escAttr(c)}"` : ""; };
  const i1 = indent + "  ", i2 = indent + "    ";
  if (n.kind === "table") {
    if (n.rows < 1 || n.cols < 1 || n.rows > 50 || n.cols > 20) throw new StructEditError(400, "표는 1~50행, 1~20열까지 만들 수 있습니다");
    const tr = (tag: string) => `${i2}<tr>${Array.from({ length: n.cols }, () => `<${tag}></${tag}>`).join("")}</tr>`;
    const head = n.header !== false ? `${i1}<thead>\n${tr("th")}\n${i1}</thead>\n` : "";
    const bodyRows = n.header !== false ? n.rows - 1 : n.rows;
    const body = bodyRows > 0 ? `${i1}<tbody>\n${Array.from({ length: bodyRows }, () => tr("td")).join("\n")}\n${i1}</tbody>\n` : "";
    return `<table${cls("table")}>\n${i1}${colgroupHtml(Array(n.cols).fill(100 / n.cols), "")}\n${head}${body}${indent}</table>`;
  }
  if (n.kind === "image") {
    const src = checkSrc(n.src);
    const w = n.width ? ` style="width:${round(clampPct(n.width))}%"` : "";
    return `<figure${cls("figure")}><img src="${escAttr(src)}" alt="${escAttr(n.alt ?? "")}"${w}></figure>`;
  }
  if (n.kind === "heading") return `<h${n.level}${cls(`h${n.level}`)}>${esc(n.text ?? "")}</h${n.level}>`;
  return `<p>${esc(n.text ?? "")}</p>`;
}

const clampPct = (p: number) => { if (!(p > 0 && p <= 100)) throw new StructEditError(400, "너비는 1~100%입니다"); return p; };
/** 이미지 주소: 버전 폴더 상대 경로나 https만(서명 주소·data:·javascript: 금지) */
function checkSrc(src: string): string {
  const s = src.trim();
  if (/^https:\/\//i.test(s) && !s.includes("\\")) return s;
  if (/^[a-z][\w+.-]*:/i.test(s) || s.startsWith("/") || s.includes("\\") || /[\u0000-\u001f]/.test(s) || s.split("/").includes("..")) throw new StructEditError(400, "이미지는 문서 안 상대 경로나 https 주소만 쓸 수 있습니다");
  return s;
}

// ---------- 적용 ----------

function need(ctx: ReturnType<typeof parseDoc>, eid: Eid, tag?: string): Element {
  const el = ctx.byEid.get(eid);
  if (!el) throw new StructEditError(409, `요소 ${eid}을(를) 찾을 수 없습니다. 문서가 바뀌었으면 다시 불러오세요`);
  if (tag && el.tagName !== tag) throw new StructEditError(400, `요소 ${eid}은(는) ${tag}가 아닙니다`);
  return el;
}

/** 연산 하나를 적용한 새 HTML */
export function applyOp(html: string, op: HtmlOp): string {
  const ctx = parseDoc(html);
  switch (op.t) {
    case "setText": {
      const el = need(ctx, op.eid);
      if (!TEXT_BLOCKS.has(el.tagName)) throw new StructEditError(400, `${el.tagName}의 글자는 이 방식으로 고칠 수 없습니다`);
      if (kids(el).some((c) => !INLINE.has(c.tagName))) throw new StructEditError(400, "안에 다른 블록이 있는 요소는 글자를 통째로 바꿀 수 없습니다");
      const l = locOf(el)!;
      return splice(html, l.innerStart, l.innerEnd, sanitizeInline(op.html));
    }
    case "setAttr": {
      const el = need(ctx, op.eid);
      const ok = op.name === "href" ? el.tagName === "a" : el.tagName === "img";
      if (!ok) throw new StructEditError(400, `${el.tagName}에는 ${op.name}을(를) 바꿀 수 없습니다`);
      const value = op.name === "src" ? checkSrc(op.value) : op.value;
      return setAttribute(html, el, op.name, value);
    }
    case "setWidth": {
      const el = need(ctx, op.eid);
      if (!["img", "table", "figure"].includes(el.tagName)) throw new StructEditError(400, "너비는 그림·표에만 바꿀 수 있습니다");
      const style = (attr(el, "style") ?? "").replace(/(^|;)\s*width\s*:[^;]*/i, "").replace(/^;+|;+$/g, "").trim();
      const next = op.percent === null ? style : [style, `width:${round(clampPct(op.percent))}%`].filter(Boolean).join(";");
      return next ? setAttribute(html, el, "style", next) : removeAttribute(html, el, "style");
    }
    case "insert": {
      const ref = need(ctx, op.ref);
      const l = locOf(ref)!;
      const ind = indentAt(html, l.start);
      const node = newNodeHtml(op.node, ctx, html, ind);
      if (op.where === "before") return splice(html, l.start, l.start, ind ? `${node}\n${ind}` : node);
      return splice(html, l.end, l.end, ind ? `\n${ind}${node}` : node);
    }
    case "remove": {
      const el = need(ctx, op.eid);
      if (["tr", "td", "th"].includes(el.tagName)) throw new StructEditError(400, "표의 행·칸은 행·열 연산으로 지우세요");
      const [s, e] = removalRange(html, locOf(el)!);
      return splice(html, s, e, "");
    }
    case "move": {
      const el = need(ctx, op.eid), ref = need(ctx, op.ref);
      const a = locOf(el)!, b = locOf(ref)!;
      if (b.start >= a.start && b.end <= a.end) throw new StructEditError(400, "요소를 자기 안으로 옮길 수 없습니다");
      const piece = html.slice(a.start, a.end);
      const [rs, re] = removalRange(html, a);
      const without = splice(html, rs, re, "");
      const shift = (p: number) => (p >= re ? p - (re - rs) : p);
      const at = op.where === "before" ? shift(b.start) : shift(b.end);
      const ind = indentAt(without, op.where === "before" ? at : shift(b.start));
      return op.where === "before" ? splice(without, at, at, ind ? `${piece}\n${ind}` : piece) : splice(without, at, at, ind ? `\n${ind}${piece}` : piece);
    }
    case "tableRow": {
      const table = need(ctx, op.eid, "table");
      const s = tableShape(table);
      if (s.merged) throw new StructEditError(400, "병합된 칸이 있는 표는 행·열을 넣거나 뺄 수 없습니다");
      if (op.op === "remove") {
        if (s.rows.length <= 1) throw new StructEditError(400, "표에는 행이 하나 이상 있어야 합니다");
        const row = s.rows[op.at];
        if (!row) throw new StructEditError(400, `${op.at + 1}번째 행이 없습니다`);
        const [a, b] = removalRange(html, locOf(row)!);
        return splice(html, a, b, "");
      }
      if (op.at < 0 || op.at > s.rows.length) throw new StructEditError(400, "행 위치가 표 밖입니다");
      // 본문 행을 본뜬다(머리글 행 아래에 넣을 때도 본문 모양)
      const tplIdx = op.at === 0 ? 0 : op.at - 1;
      const bodyTpl = s.rows.find((r, i) => i >= tplIdx && (r.parentNode as Element).tagName !== "thead") ?? s.rows[tplIdx];
      const tl = locOf(bodyTpl)!;
      const cellsHtml = kids(bodyTpl).filter((c) => c.tagName === "td" || c.tagName === "th").map((c) => emptyCellLike(html, c)).join("");
      const rowHtml = `${html.slice(tl.start, tl.tagEnd)}${cellsHtml}</tr>`;
      // 끝이면 마지막 행 뒤, 아니면 그 자리 행 앞(머리글·본문 경계에서는 본문 첫 행 앞 = 본문 안)
      if (op.at === s.rows.length) {
        const prev = locOf(s.rows[op.at - 1] ?? s.rows[0])!;
        const ind = indentAt(html, prev.start);
        return splice(html, prev.end, prev.end, ind ? `\n${ind}${rowHtml}` : rowHtml);
      }
      const next = locOf(s.rows[op.at])!;
      const ind = indentAt(html, next.start);
      return splice(html, next.start, next.start, ind ? `${rowHtml}\n${ind}` : rowHtml);
    }
    case "tableCol": {
      const table = need(ctx, op.eid, "table");
      const s = tableShape(table);
      if (s.merged) throw new StructEditError(400, "병합된 칸이 있는 표는 행·열을 넣거나 뺄 수 없습니다");
      const n = colCount(s);
      if (op.op === "remove" && n <= 1) throw new StructEditError(400, "표에는 열이 하나 이상 있어야 합니다");
      if (op.at < 0 || op.at > (op.op === "add" ? n : n - 1)) throw new StructEditError(400, "열 위치가 표 밖입니다");
      // 뒤에서부터 고쳐 앞쪽 위치가 밀리지 않게 한다
      const edits: [number, number, string][] = [];
      for (const row of s.cells) {
        if (op.op === "remove") {
          const c = row[op.at];
          if (c) { const l = locOf(c)!; edits.push([l.start, l.end, ""]); }
        } else {
          const tpl = row[Math.min(op.at, row.length - 1)];
          if (!tpl) continue;
          const l = locOf(tpl)!;
          const at = op.at >= row.length ? l.end : l.start;
          edits.push([at, at, emptyCellLike(html, tpl)]);
        }
      }
      const cg = colgroupWidths(s.colgroup);
      if (s.colgroup) {
        const widths = cg ?? Array(n).fill(100 / n);
        const next = op.op === "add"
          ? [...widths.slice(0, op.at), 100 / (n + 1), ...widths.slice(op.at)].map((w, i) => (i === op.at ? w : (w * n) / (n + 1)))
          : normalizeWidths(widths.filter((_, i) => i !== op.at));
        const l = locOf(s.colgroup)!;
        edits.push([l.start, l.end, colgroupHtml(next, "")]);
      }
      edits.sort((a, b) => b[0] - a[0]);
      let out = html;
      for (const [a, b, t] of edits) out = splice(out, a, b, t);
      return out;
    }
    case "tableCols": {
      const table = need(ctx, op.eid, "table");
      const s = tableShape(table);
      const n = s.merged ? (colgroupWidths(s.colgroup)?.length ?? colCount(s)) : colCount(s);
      if (op.widths.length !== n) throw new StructEditError(400, `열이 ${n}개인데 너비가 ${op.widths.length}개입니다`);
      return writeColgroup(html, table, s, normalizeWidths(op.widths));
    }
  }
}

export function applyOps(html: string, ops: HtmlOp[]): string {
  return ops.reduce(applyOp, html);
}

function setAttribute(html: string, el: Element, name: string, value: string): string {
  const l = el.sourceCodeLocation!;
  const al = l.attrs?.[name];
  const text = `${name}="${escAttr(value)}"`;
  if (al) return splice(html, al.startOffset, al.endOffset, text);
  // 태그 이름 바로 뒤에 넣는다
  const at = l.startTag!.startOffset + 1 + el.tagName.length;
  return splice(html, at, at, " " + text);
}

function removeAttribute(html: string, el: Element, name: string): string {
  const al = el.sourceCodeLocation!.attrs?.[name];
  if (!al) return html;
  let s = al.startOffset;
  while (s > 0 && /[ \t]/.test(html[s - 1])) s--;
  return splice(html, s, al.endOffset, "");
}

// ---------- 보기·편집 사본 ----------

export interface Block {
  eid: Eid; tag: string; text: string;
  /** 표: 행·열 수, 열 너비(colgroup %), 병합 여부 */
  table?: { rows: number; cols: number; widths: number[] | null; merged: boolean };
  /** 그림: src, alt, 너비 % */
  image?: { src: string; alt: string; width: number | null };
  /** 글자를 바꿀 수 있는가 */
  editable: boolean;
}

/** 고를 수 있는 요소 목록(문서 순서) */
export function outline(html: string): Block[] {
  const ctx = parseDoc(html);
  const textOf = (n: Node): string => (n.nodeName === "#text" ? (n as DefaultTreeAdapterMap["textNode"]).value : "childNodes" in n ? n.childNodes.map(textOf).join("") : "");
  return [...ctx.byEid.values()].map((el) => {
    const b: Block = { eid: eidOf(el), tag: el.tagName, text: textOf(el).replace(/\s+/g, " ").trim().slice(0, 120),
      editable: TEXT_BLOCKS.has(el.tagName) && !kids(el).some((c) => !INLINE.has(c.tagName)) };
    if (el.tagName === "table") {
      const s = tableShape(el);
      b.table = { rows: s.rows.length, cols: colCount(s), widths: colgroupWidths(s.colgroup), merged: s.merged };
    }
    if (el.tagName === "img") {
      b.image = { src: attr(el, "src") ?? "", alt: attr(el, "alt") ?? "", width: Number(/width:\s*([\d.]+)%/.exec(attr(el, "style") ?? "")?.[1]) || null };
    }
    return b;
  });
}

/** 편집 사본: 고를 수 있는 요소마다 data-eid를 붙인다(원본 파일에는 쓰지 않는다). baseHref가 있으면 상대 경로 리소스가 그곳에서 읽히도록 <base>를 넣는다 */
export function markEids(html: string, baseHref?: string): string {
  const ctx = parseDoc(html);
  const inserts: (readonly [number, string])[] = [...ctx.byEid.values()].map((el) => [el.sourceCodeLocation!.startTag!.startOffset + 1 + el.tagName.length, ` data-eid="${eidOf(el)}"`] as const);
  const base = baseHref === undefined ? "" : `<base href="${escAttr(baseHref)}">`;
  const htmlEl = ctx.doc.childNodes.find((n) => isEl(n) && n.tagName === "html") as Element | undefined;
  const head = htmlEl?.childNodes.find((n) => isEl(n) && n.tagName === "head") as Element | undefined;
  const headPos = head?.sourceCodeLocation?.startTag?.endOffset;
  if (base && headPos !== undefined) inserts.push([headPos, base]);
  let out = html;
  for (const [at, text] of inserts.sort((a, b) => b[0] - a[0])) out = splice(out, at, at, text);
  return base && headPos === undefined ? base + out : out;
}
