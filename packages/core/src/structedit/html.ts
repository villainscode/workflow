import { parse, parseFragment } from "parse5";
import type { DefaultTreeAdapterMap } from "parse5";
import { parseStyle } from "../slide/css.ts";
import { checkDocStyle, docColors, docFonts, mergeStyle, PIN_ONLY, problemText } from "./docstyle.ts";

/**
 * HTML 구조 편집(5.0 M3, spec/REQUIREMENT-5.0.md 4.1). 2.0 텍스트 편집과 같은 원리를 요소 단위로 넓혔다:
 * parse5가 준 요소의 원본 위치만 다시 쓰고, 바뀌지 않은 바이트는 그대로 둔다. 디자인된 단일 파일 문서가 깨지지 않게 하기 위해서다.
 *
 * - 요소 id(eid)는 그 요소 시작 태그의 원본 위치("e<바이트 위치>")다. 같은 파일에서는 늘 같고, 파일이 바뀌면 다시 읽어야 한다.
 * - 연산은 하나씩 적용하고 적용할 때마다 다시 파싱한다(정확성이 우선, 문서는 수십~수백 KB).
 * - 새로 넣는 표·그림은 문서에 이미 있는 같은 종류 요소의 class를 따른다(문서 디자인 체계 유지).
 * - 속성 편집(6.0 V2, D-55): setStyle은 요소의 style 속성만 다시 쓴다(허용 목록은 docstyle.ts). 되돌리기는 수정본으로 한다(연산마다 수정본 하나).
 * - 자유 배치(6.0 V3, D-54): toPinned·place·unpin. 아래 "자유 배치" 절.
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

/** 고정 위치 상자: left·width는 기준 상자(가장 가까운 위치 지정 조상, 보통 섹션) 너비의 %, top은 px(6.0 11절: px만 쓰면 중간 폭에서 넘친다) */
export interface PinBox { left: number; top: number; width: number }
/** 끌어 놓은 자리에 새로 넣는 요소 */
export type PlaceNode = { kind: "image"; src: string; alt?: string } | { kind: "textbox"; text?: string };

export type HtmlOp =
  | { t: "setText"; eid: Eid; html: string }
  | { t: "setAttr"; eid: Eid; name: "src" | "alt" | "href"; value: string }
  | { t: "setWidth"; eid: Eid; percent: number | null }
  | { t: "insert"; ref: Eid; where: Where; node: NewNode }
  | { t: "remove"; eid: Eid }
  | { t: "move"; eid: Eid; ref: Eid; where: Where }
  | { t: "tableRow"; eid: Eid; at: number; op: "add" | "remove" }
  | { t: "tableCol"; eid: Eid; at: number; op: "add" | "remove" }
  | { t: "tableCols"; eid: Eid; widths: number[] }
  /** 인라인 style만 바꾼다(D-55 허용 목록). unset은 지울 속성 */
  | { t: "setStyle"; eid: Eid; set?: Record<string, string>; unset?: string[] }
  /** 표 행(tr) 높이 px, null이면 지움 */
  | { t: "tableRowHeight"; eid: Eid; height: number | null }
  /** 요소를 바로 뒤에 복제한다(안의 id 속성은 뺀다) */
  | { t: "duplicate"; eid: Eid }
  /** 고정 위치로 전환(이미 고정이면 위치·너비만 바꾼다). minHeight는 기준 섹션의 최소 높이 px(화면이 고정 요소 바닥까지 재서 보낸다) */
  | { t: "toPinned"; eid: Eid; box: PinBox; minHeight?: number }
  /** 고정 위치를 풀고 흐름(원래 style)으로 되돌린다 */
  | { t: "unpin"; eid: Eid }
  /** 기준 섹션(base, outline의 pinBase·isBase) 끝에 새 그림·글상자를 고정 위치로 넣는다 */
  | { t: "place"; base: Eid; node: PlaceNode; box: PinBox; minHeight?: number };

export class StructEditError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

/** 고를 수 있는 요소(편집 사본에 data-eid를 붙이는 것) */
const BLOCKS = new Set(["section", "article", "header", "footer", "div", "figure", "figcaption", "table", "img", "p", "h1", "h2", "h3", "h4", "h5", "h6",
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
  // 모든 요소(원본 위치가 있는 것). 자유 배치의 기준 섹션은 고를 수 있는 블록이 아닐 수도 있다(nav 등)
  const byOffset = new Map<Eid, Element>();
  const parents = new Map<Element, Element | null>();
  const walk = (n: Node, parent: Element | null) => {
    if (isEl(n)) {
      if (SKIP.has(n.tagName)) return;
      parents.set(n, parent);
      if (n.sourceCodeLocation?.startTag) {
        byOffset.set(eidOf(n), n);
        if (BLOCKS.has(n.tagName)) byEid.set(eidOf(n), n);
      }
      parent = n;
    }
    if ("childNodes" in n) for (const c of n.childNodes) walk(c, parent);
  };
  walk(doc, null);
  return { doc, byEid, byOffset, parents, firstOf: (tag: string) => [...byEid.values()].find((e) => e.tagName === tag) };
}
type Ctx = ReturnType<typeof parseDoc>;

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

// 글자 일부 서식(6.0 V2): span에 남기는 속성과 순서
const SPAN_PROPS = ["color", "font-family", "font-size", "font-weight"];

/** span style에서 허용 속성만(값 검사 통과) 정해진 순서로 남긴다. 큰따옴표는 작은따옴표로 */
function spanStyle(style: string, fonts?: string[]): string {
  const decl = new Map(parseStyle(style).map(([k, v]) => [k, v.replace(/"/g, "'")]));
  return SPAN_PROPS.filter((k) => decl.has(k) && !checkDocStyle(k, decl.get(k)!, fonts)).map((k) => `${k}:${decl.get(k)}`).join(";");
}

/** 글자 칸에 넣을 HTML을 인라인 마크만 남기고 다시 쓴다. 링크는 http(s)·#·상대 경로만, span은 글자색·글꼴·크기·굵기 style만 */
export function sanitizeInline(input: string, fonts?: string[]): string {
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
    if (n.tagName === "span") {
      const st = spanStyle(attr(n, "style") ?? "", fonts);
      if (st) attrs = ` style="${escAttr(st)}"`;
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

function need(ctx: Ctx, eid: Eid, tag?: string): Element {
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
      return splice(html, l.innerStart, l.innerEnd, sanitizeInline(op.html, docFonts(html)));
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
      return cleanupPins(splice(html, s, e, ""));
    }
    case "move": {
      const el = need(ctx, op.eid), ref = need(ctx, op.ref);
      const a = locOf(el)!, b = locOf(ref)!;
      if (b.start >= a.start && b.end <= a.end) throw new StructEditError(400, "요소를 자기 안으로 옮길 수 없습니다");
      if (attr(el, "data-pin") !== undefined && baseOf(ctx, ref) !== baseOf(ctx, el) && baseOf(ctx, el) !== ref) {
        throw new StructEditError(400, "고정 위치 요소는 같은 섹션 안에서만 앞뒤 순서를 바꿉니다(다른 섹션으로는 흐름으로 되돌린 뒤 옮기세요)");
      }
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
      // colgroup은 표 시작 태그 뒤라 먼저 고쳐도 시작 태그 위치는 그대로다. 열 너비가 지켜지게 table-layout:fixed를 함께 넣는다(6.0 4.2)
      const out = writeColgroup(html, table, s, normalizeWidths(op.widths));
      return /table-layout/i.test(attr(table, "style") ?? "") ? out : writeStyle(out, table, mergeStyle(attr(table, "style") ?? "", { "table-layout": "fixed" }));
    }
    case "setStyle": {
      const el = need(ctx, op.eid);
      const set = op.set ?? {}, unset = op.unset ?? [];
      if (!Object.keys(set).length && !unset.length) throw new StructEditError(400, "set이나 unset이 필요합니다");
      const fonts = docFonts(html);
      const problems = Object.entries(set).map(([k, v]) => [k, checkDocStyle(k, v, fonts)] as const).filter(([, x]) => x);
      const pinned = unset.filter((k) => PIN_ONLY.has(k.trim().toLowerCase()));
      if (problems.length) throw new StructEditError(400, problems.map(([, x]) => problemText(x!)).join(" · "));
      if (pinned.length) throw new StructEditError(400, `${pinned.join(", ")}는 속성 편집으로 지우지 않습니다`);
      return writeStyle(html, el, mergeStyle(attr(el, "style") ?? "", set, unset));
    }
    case "tableRowHeight": {
      const tr = need(ctx, op.eid, "tr");
      if (op.height !== null && !(Number.isFinite(op.height) && op.height >= 4 && op.height <= 2000)) throw new StructEditError(400, "행 높이는 4~2000px입니다");
      const style = attr(tr, "style") ?? "";
      return writeStyle(html, tr, op.height === null ? mergeStyle(style, {}, ["height"]) : mergeStyle(style, { height: `${Math.round(op.height)}px` }));
    }
    case "duplicate": {
      const el = need(ctx, op.eid);
      if (["td", "th", "caption", "figcaption", "summary"].includes(el.tagName)) throw new StructEditError(400, `${el.tagName}은(는) 복제할 수 없습니다(표 칸은 열 연산으로 넣으세요)`);
      const l = locOf(el)!;
      // 안의 id 속성은 빼서 같은 id가 두 번 생기지 않게 한다
      const ids: [number, number][] = [];
      const walk = (n: Node) => {
        if (isEl(n)) { const a = n.sourceCodeLocation?.attrs?.id; if (a) ids.push([a.startOffset, a.endOffset]); }
        if ("childNodes" in n) n.childNodes.forEach(walk);
      };
      walk(el);
      let piece = html.slice(l.start, l.end);
      for (const [a, b] of ids.sort((x, y) => y[0] - x[0])) {
        let s0 = a - l.start;
        while (s0 > 0 && /[ \t]/.test(piece[s0 - 1])) s0--;
        piece = piece.slice(0, s0) + piece.slice(b - l.start);
      }
      const ind = indentAt(html, l.start);
      return splice(html, l.end, l.end, ind ? `\n${ind}${piece}` : piece);
    }
    case "toPinned": return toPinned(html, ctx, op.eid, op.box, op.minHeight);
    case "unpin": return unpin(html, ctx, op.eid);
    case "place": return place(html, ctx, op);
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

/** style 속성을 새 값으로(빈 값이면 속성을 지운다). 같으면 원본 그대로 */
function writeStyle(html: string, el: Element, style: string): string {
  if (style === (attr(el, "style") ?? "")) return html;
  return style ? setAttribute(html, el, "style", style) : removeAttribute(html, el, "style");
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
  /** 요소의 인라인 style(속성 패널이 보여 준다) */
  style: Record<string, string>;
  /** 감싸는 블록(없으면 null)과 깊이(레이어 패널) */
  parent: Eid | null;
  depth: number;
  /** 자유 배치(6.0 V3): 고정 위치인가, 고정할 때 기준 섹션(없으면 고정할 수 없다), 이 블록이 기준 섹션인가 */
  pinned: boolean;
  pinBase: Eid | null;
  isBase: boolean;
}

/** 고를 수 있는 요소 목록(문서 순서) */
export function outline(html: string): Block[] {
  const ctx = parseDoc(html);
  const textOf = (n: Node): string => (n.nodeName === "#text" ? (n as DefaultTreeAdapterMap["textNode"]).value : "childNodes" in n ? n.childNodes.map(textOf).join("") : "");
  const blockParent = (el: Element) => { let p = ctx.parents.get(el) ?? null; while (p && !(p.sourceCodeLocation?.startTag && ctx.byEid.get(eidOf(p)) === p)) p = ctx.parents.get(p) ?? null; return p; };
  const depth = new Map<Element, number>();
  return [...ctx.byEid.values()].map((el) => {
    const parent = blockParent(el);
    depth.set(el, parent ? (depth.get(parent) ?? 0) + 1 : 0);
    const b: Block = { eid: eidOf(el), tag: el.tagName, text: textOf(el).replace(/\s+/g, " ").trim().slice(0, 120),
      editable: TEXT_BLOCKS.has(el.tagName) && !kids(el).some((c) => !INLINE.has(c.tagName)),
      style: Object.fromEntries(parseStyle(attr(el, "style") ?? "")), parent: parent ? eidOf(parent) : null, depth: depth.get(el)!,
      pinned: attr(el, "data-pin") !== undefined, pinBase: pinnable(ctx, el) ? eidOf(baseOf(ctx, el)!) : null, isBase: isBase(ctx, el) };
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

/** 속성 패널 견본: 문서가 쓰는 글꼴과 :root 색 토큰(다크 모드 여부) */
export function docTheme(html: string) {
  return { fonts: docFonts(html), ...docColors(html) };
}

/** 편집 사본: 고를 수 있는 요소마다 data-eid를 붙인다(원본 파일에는 쓰지 않는다). baseHref가 있으면 상대 경로 리소스가 그곳에서 읽히도록 <base>를 넣는다 */
export function markEids(html: string, baseHref?: string): string {
  const ctx = parseDoc(html);
  // 고를 수 있는 블록에는 data-eid, 자유 배치 기준 섹션에는 data-base(화면이 좌표를 잰다), 본문 뿌리에는 data-root
  const root = contentRoot(ctx);
  const inserts: (readonly [number, string])[] = [...ctx.byOffset.values()].flatMap((el) => {
    const marks = `${ctx.byEid.has(eidOf(el)) ? ` data-eid="${eidOf(el)}"` : ""}${isBase(ctx, el) ? ` data-base="${eidOf(el)}"` : ""}${el === root ? " data-root" : ""}`;
    return marks ? [[el.sourceCodeLocation!.startTag!.startOffset + 1 + el.tagName.length, marks] as const] : [];
  });
  const base = baseHref === undefined ? "" : `<base href="${escAttr(baseHref)}">`;
  const htmlEl = ctx.doc.childNodes.find((n) => isEl(n) && n.tagName === "html") as Element | undefined;
  const head = htmlEl?.childNodes.find((n) => isEl(n) && n.tagName === "head") as Element | undefined;
  const headPos = head?.sourceCodeLocation?.startTag?.endOffset;
  if (base && headPos !== undefined) inserts.push([headPos, base]);
  let out = html;
  for (const [at, text] of inserts.sort((a, b) => b[0] - a[0])) out = splice(out, at, at, text);
  return base && headPos === undefined ? base + out : out;
}

// ---------- 자유 배치(6.0 V3, D-54) ----------
//
// 옮긴 요소만 고정 위치(position:absolute)가 된다. 기준은 가장 가까운 section, 없으면 본문 뿌리(main 또는 body, 감싸개 하나뿐이면
// 그 안) 바로 아래 블록이다(6.0 11절). 표 안 요소·목록 항목은 따로 고정하지 않는다(표·목록 전체를 옮긴다).
// - 요소: style에 position·left(%)·top(px)·width(%)·margin:0, data-pin에 고정 전 원래 style을 둔다(unpin이 그대로 되돌린다)
// - 기준 섹션: position:relative·min-height(고정 요소 바닥까지), data-pin-box에 원래 style
// - 문서 <head>에 좁은 화면 규칙 한 번: 640px 이하에서 고정 요소는 흐름(문서 순서)으로 돌아가 가로 스크롤이 생기지 않는다
// 겹침 순서는 문서 순서다(앞뒤는 move). 고정 요소가 하나도 남지 않으면 섹션 style과 규칙도 지운다.

export const PIN_RULE = "<style data-pin-rule>@media (max-width:640px){[data-pin]{position:static!important;left:auto!important;top:auto!important;width:auto!important;max-width:100%!important;margin:0 0 1em!important}[data-pin-box]{min-height:0!important}}</style>";
const PIN_PROPS = ["position", "left", "top", "right", "bottom", "width", "margin"];
const BOX_PROPS = ["position", "min-height"];
/**
 * 따로 고정하지 않는 것: 표 부속·목록 항목, 그리고 표·pre 자체(줄바꿈되지 않는 최소 너비가 있어 % 너비로 줄이면 641px 근처에서
 * 가로 스크롤이 생겼다, 6.0 12절). 표는 흐름 안에서 너비·열만 바꾼다.
 */
const UNPINNABLE = new Set(["tr", "td", "th", "caption", "li", "dt", "dd", "thead", "tbody", "tfoot", "colgroup", "col", "summary", "figcaption", "table", "pre"]);
const NOT_CONTENT = new Set(["script", "style", "noscript", "template", "link", "meta"]);

/** 본문 뿌리: main(있으면) 또는 body. 그 안에 요소가 감싸개 하나뿐이면 감싸개로 내려간다. 원본에 시작 태그가 없으면(생략한 body) 기준으로 쓰지 않는다 */
const roots = new WeakMap<Ctx, Element | null>();
function contentRoot(ctx: Ctx): Element | null {
  if (!roots.has(ctx)) roots.set(ctx, findRoot(ctx));
  return roots.get(ctx)!;
}
function findRoot(ctx: Ctx): Element | null {
  const all = [...ctx.doc.childNodes.flatMap(function flat(n: Node): Element[] { return isEl(n) ? [n, ...n.childNodes.flatMap(flat)] : "childNodes" in n ? n.childNodes.flatMap(flat) : []; })];
  let root = all.find((e) => e.tagName === "main") ?? all.find((e) => e.tagName === "body") ?? null;
  for (let i = 0; root && i < 4; i++) {
    const k = kids(root).filter((c) => !NOT_CONTENT.has(c.tagName));
    // 감싸개(div·article)일 때만 내려간다. 섹션이나 글자 블록 하나뿐인 문서는 그대로
    if (k.length !== 1 || !["div", "article", "main"].includes(k[0].tagName)) break;
    root = k[0];
  }
  return root;
}
const located = (el: Element | null) => (el?.sourceCodeLocation?.startTag ? el : null);

/** 기준 섹션이 될 수 있는 것: section, 본문 뿌리, 뿌리 바로 아래 블록 */
function isBase(ctx: Ctx, el: Element): boolean {
  if (!located(el)) return false;
  if (el.tagName === "section") return true;
  const root = located(contentRoot(ctx));
  return !!root && (el === root || (ctx.parents.get(el) === root && !NOT_CONTENT.has(el.tagName)));
}
/** 새 요소를 넣을 수 있는 기준 섹션(글자 블록·표·그림 안에는 넣지 않는다) */
const PLACE_IN = new Set(["section", "main", "body", "div", "article", "aside", "header", "footer", "nav", "figure", "form"]);

/** 고정할 때 기준 섹션: 가장 가까운 section, 없으면 본문 뿌리 바로 아래 조상, 뿌리 바로 아래 요소면 뿌리 */
function baseOf(ctx: Ctx, el: Element): Element | null {
  const root = contentRoot(ctx);
  let below: Element | null = null;
  for (let p = ctx.parents.get(el) ?? null; p; p = ctx.parents.get(p) ?? null) {
    if (p.tagName === "section" && located(p)) return p;
    if (p === root) return below ?? located(root);
    if (root && ctx.parents.get(p) === root && located(p)) below = p;
  }
  return null;
}
/** 고정할 수 있는가: 기준 섹션이 있고, 표 안이 아니고, 목록 항목·표 부속이 아니다 */
function pinnable(ctx: Ctx, el: Element): boolean {
  // 섹션 자체는 옮기지 않는다(안의 요소를 옮긴다)
  if (UNPINNABLE.has(el.tagName) || el.tagName === "section" || !baseOf(ctx, el)) return false;
  for (let p = ctx.parents.get(el) ?? null; p; p = ctx.parents.get(p) ?? null) if (p.tagName === "table") return false;
  return true;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/** 상자 값 검사·보정: 너비 1~100%, 왼쪽은 오른쪽 끝이 100%를 넘지 않게, top 0 이상 */
function pinSet(box: PinBox): Record<string, string> {
  const ok = (n: unknown) => typeof n === "number" && Number.isFinite(n);
  if (!ok(box?.left) || !ok(box?.top) || !ok(box?.width)) throw new StructEditError(400, "box는 {left(%), top(px), width(%)} 숫자입니다");
  if (!(box.width > 0 && box.width <= 100)) throw new StructEditError(400, "너비(width)는 섹션 너비의 1~100%입니다");
  if (box.top < 0 || box.top > 100000) throw new StructEditError(400, "top은 0~100000px입니다");
  const width = r2(box.width), left = r2(Math.min(Math.max(0, box.left), 100 - width));
  return { position: "absolute", left: `${left}%`, top: `${Math.round(box.top)}px`, width: `${width}%`, margin: "0" };
}

const minHeightPx = (style: string) => Number(/(?:^|;)\s*min-height\s*:\s*([\d.]+)px/i.exec(style)?.[1] ?? 0);

/** 기준 섹션에 position:relative·min-height. 처음이면 원래 style을 data-pin-box에 둔다 */
function markBase(html: string, baseOff: Eid, minHeight: number): string {
  let base = parseDoc(html).byOffset.get(baseOff)!;
  const style = attr(base, "style") ?? "";
  const first = attr(base, "data-pin-box") === undefined;
  const mh = Math.ceil(Math.max(minHeight, first ? 0 : minHeightPx(style)));
  let out = writeStyle(html, base, mergeStyle(style, { position: "relative", ...(mh > 0 ? { "min-height": `${mh}px` } : {}) }));
  if (first) {
    base = parseDoc(out).byOffset.get(baseOff)!;
    out = setAttribute(out, base, "data-pin-box", style);
  }
  return ensureRule(out);
}

function checkMinHeight(n: number | undefined): number | undefined {
  if (n === undefined) return undefined;
  if (!(typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 100000)) throw new StructEditError(400, "minHeight는 0~100000px입니다");
  return n;
}

function toPinned(html: string, ctx: Ctx, eid: Eid, box: PinBox, minHeight?: number): string {
  const el = need(ctx, eid);
  if (!pinnable(ctx, el)) {
    throw new StructEditError(400, UNPINNABLE.has(el.tagName) || el.tagName === "section" || !baseOf(ctx, el)
      ? `${el.tagName}은(는) 따로 고정하지 않습니다(표·코드 블록은 흐름 안에서 너비를 바꾸고, 목록 항목은 목록 전체를, 섹션은 안의 요소를 옮기세요)`
      : "표 안 요소는 따로 고정하지 않습니다. 표 전체를 옮기세요");
  }
  const set = pinSet(box);
  const mh = checkMinHeight(minHeight) ?? Number(set.top.slice(0, -2));
  const baseOff = eidOf(baseOf(ctx, el)!);
  const style = attr(el, "style") ?? "";
  const pinned = attr(el, "data-pin") !== undefined;
  // 요소(뒤쪽) → 섹션(앞쪽) → head 규칙 순서로 고쳐 앞쪽 위치가 밀리지 않게 한다
  let out = writeStyle(html, el, mergeStyle(style, set, ["right", "bottom"]));
  if (!pinned) out = setAttribute(out, parseDoc(out).byOffset.get(eid)!, "data-pin", style);
  return markBase(out, baseOff, mh);
}

function place(html: string, ctx: Ctx, op: Extract<HtmlOp, { t: "place" }>): string {
  const base = ctx.byOffset.get(op.base);
  if (!base || !isBase(ctx, base)) throw new StructEditError(409, `기준 섹션 ${op.base}을(를) 찾을 수 없습니다. 문서가 바뀌었으면 다시 불러오세요`);
  if (!PLACE_IN.has(base.tagName)) throw new StructEditError(400, `${base.tagName} 안에는 넣지 않습니다. 감싸는 섹션(outline의 pinBase)을 기준으로 넣으세요`);
  const set = pinSet(op.box);
  const mh = checkMinHeight(op.minHeight) ?? Number(set.top.slice(0, -2));
  const st = escAttr(Object.entries(set).map(([k, v]) => `${k}:${v}`).join(";"));
  const n = op.node;
  const piece = n.kind === "image"
    ? `<img src="${escAttr(checkSrc(n.src))}" alt="${escAttr(n.alt ?? "")}" data-pin="" style="${st}">`
    : n.kind === "textbox" ? `<p data-pin="" style="${st}">${esc(n.text ?? "")}</p>`
    : (() => { throw new StructEditError(400, "place의 node.kind는 image·textbox입니다"); })();
  // 섹션의 마지막 요소 뒤(그리는 순서가 맨 앞), 요소가 없으면 섹션 안 처음
  const l = locOf(base)!;
  const last = kids(base).at(-1);
  let out: string;
  if (last) {
    const ll = locOf(last)!;
    // 마지막 요소가 줄 처음에 있으면(들여쓰기 없어도) 새 줄에 같은 들여쓰기로
    const lineStart = html.lastIndexOf("\n", ll.start - 1) + 1;
    const own = /^[ \t]*$/.test(html.slice(lineStart, ll.start));
    out = splice(html, ll.end, ll.end, own ? `\n${html.slice(lineStart, ll.start)}${piece}` : piece);
  } else out = splice(html, l.innerStart, l.innerStart, piece);
  return markBase(out, op.base, mh);
}

function unpin(html: string, ctx: Ctx, eid: Eid): string {
  const el = need(ctx, eid);
  const orig = attr(el, "data-pin");
  if (orig === undefined) throw new StructEditError(400, "고정 위치 요소가 아닙니다");
  const cur = attr(el, "style") ?? "";
  // 고정한 뒤 다른 서식을 바꾸지 않았으면 원래 style 그대로, 바꿨으면 위치 속성만 원래 값으로
  const rest = (s: string) => mergeStyle(s, {}, PIN_PROPS);
  const origMap = Object.fromEntries(parseStyle(orig));
  const next = rest(cur) === rest(orig) ? orig
    : mergeStyle(cur, Object.fromEntries(PIN_PROPS.filter((k) => k in origMap).map((k) => [k, origMap[k]])), PIN_PROPS.filter((k) => !(k in origMap)));
  let out = writeStyle(html, el, next);
  out = removeAttribute(out, parseDoc(out).byOffset.get(eid)!, "data-pin");
  return cleanupPins(out);
}

/** 고정 요소가 없는 기준 섹션은 원래 style로, 문서에 고정 요소가 없으면 좁은 화면 규칙도 지운다 */
function cleanupPins(html: string): string {
  let out = html;
  for (;;) {
    const ctx = parseDoc(out);
    const has = (el: Element): boolean => kids(el).some((c) => attr(c, "data-pin") !== undefined || has(c));
    const box = [...ctx.byOffset.values()].find((e) => attr(e, "data-pin-box") !== undefined && !has(e));
    if (!box) break;
    const orig = attr(box, "data-pin-box")!;
    const cur = attr(box, "style") ?? "";
    const rest = (s: string) => mergeStyle(s, {}, BOX_PROPS);
    const origMap = Object.fromEntries(parseStyle(orig));
    const next = rest(cur) === rest(orig) ? orig
      : mergeStyle(cur, Object.fromEntries(BOX_PROPS.filter((k) => k in origMap).map((k) => [k, origMap[k]])), BOX_PROPS.filter((k) => !(k in origMap)));
    const off = eidOf(box);
    out = writeStyle(out, box, next);
    out = removeAttribute(out, parseDoc(out).byOffset.get(off)!, "data-pin-box");
  }
  if (![...parseDoc(out).byOffset.values()].some((e) => attr(e, "data-pin") !== undefined)) out = out.replace(PIN_RULE, "");
  return out;
}

/** 좁은 화면 규칙을 한 번 넣는다: </head> 앞, </head>를 생략했으면 head의 마지막 요소 뒤, head가 없으면 <body> 앞(그것도 없으면 맨 앞) */
function ensureRule(html: string): string {
  if (html.includes("<style data-pin-rule>")) return html;
  const ctx = parseDoc(html);
  const doc = ctx.doc;
  const htmlEl = doc.childNodes.find((n) => isEl(n) && n.tagName === "html") as Element | undefined;
  const head = htmlEl?.childNodes.find((n) => isEl(n) && n.tagName === "head") as Element | undefined;
  const body = htmlEl?.childNodes.find((n) => isEl(n) && n.tagName === "body") as Element | undefined;
  const lastInHead = head?.childNodes.filter((n) => n.sourceCodeLocation).at(-1);
  const at = head?.sourceCodeLocation?.endTag?.startOffset ?? lastInHead?.sourceCodeLocation?.endOffset
    ?? body?.sourceCodeLocation?.startTag?.startOffset ?? 0;
  return splice(html, at, at, PIN_RULE);
}
