import { parseFragment } from "parse5";
import type { DefaultTreeAdapterMap } from "parse5";
import { parseStyle, styleText, validateStyle, type Diagnostic, type Style } from "./css.ts";

/**
 * 슬라이드 한 장(제한된 HTML 한 조각)의 파서·검증·직렬화(명세 03·04절). Node·Workers·브라우저 공통(node:* 없음).
 * - 최상위는 <section id="…">  하나. 직계 <aside>는 발표자 노트.
 * - 요소마다 data-eid가 없으면 붙인다(한 번 붙은 eid는 바뀌지 않는다). section의 eid는 id와 같다.
 * - 글자는 인라인 마크(b i u a[href^=https] span[style=color] br)만 있는 조각(text 노드)으로 둔다.
 * - 검증 실패는 Diagnostic(줄·칸·코드·fix)으로 모은다. 하나라도 있으면 저장하지 않는다.
 */

export type Eid = string;
export const BLOCK_TAGS = ["section", "div", "h1", "h2", "h3", "p", "ul", "ol", "li", "table", "tr", "th", "td", "img", "hr"] as const;
export type BlockTag = (typeof BLOCK_TAGS)[number];
export type SlideNode =
  | { kind: "el"; eid: Eid; tag: BlockTag; style: Style; attrs: Record<string, string>; children: SlideNode[] }
  | { kind: "text"; html: string };
export type SlideEl = Extract<SlideNode, { kind: "el" }>;
export interface Slide { id: string; root: SlideEl; notes: string }
export type { Diagnostic, Style };

export const CANVAS = { width: 1920, height: 1080, margin: 128 } as const;

type Node = DefaultTreeAdapterMap["node"];
type Element = DefaultTreeAdapterMap["element"];
const isEl = (n: Node): n is Element => "tagName" in n;
const BLOCKS = new Set<string>(BLOCK_TAGS);
const INLINE = new Set(["b", "i", "u", "a", "span", "br"]);
const VOID = new Set(["img", "hr"]);
// 표 안 thead·tbody는 형식에 없다(브라우저 파서가 tbody를 자동으로 넣으므로 투명하게 건너뛴다)
const TRANSPARENT = new Set(["tbody", "thead", "tfoot"]);
const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const ASSET_RE = /^asset:[0-9a-f]{64}$/;

export const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escAttr = (s: string) => esc(s).replace(/"/g, "&quot;");
const attr = (el: Element, name: string) => el.attrs.find((a) => a.name === name)?.value;
const loc = (n: Node) => ({ line: n.sourceCodeLocation?.startLine ?? 0, col: n.sourceCodeLocation?.startCol ?? 0 });

// ---------- 인라인 조각 ----------

/** 인라인 HTML을 허용 마크만 남긴 같은 형식으로 다시 쓴다. 허용 밖은 진단으로 모은다 */
export function sanitizeInline(html: string, diags: Diagnostic[] = [], base = { line: 0, col: 0 }): string {
  const frag = parseFragment(html, { sourceCodeLocationInfo: true });
  const out = (nodes: Node[]): string => nodes.map((n) => {
    if (n.nodeName === "#text") return esc((n as DefaultTreeAdapterMap["textNode"]).value);
    if (!isEl(n)) return "";
    const where = n.sourceCodeLocation ? { line: base.line + n.sourceCodeLocation.startLine - 1, col: n.sourceCodeLocation.startCol } : base;
    if (!INLINE.has(n.tagName)) {
      diags.push({ ...where, code: "inline-tag", message: `글자 안에 쓸 수 없는 태그: <${n.tagName}>`, fix: "b·i·u·a·span(color)·br만 씁니다" });
      return out(n.childNodes);
    }
    if (n.tagName === "br") return "<br>";
    if (n.tagName === "a") {
      const href = attr(n, "href") ?? "";
      if (!/^https:\/\/[^\s"<>]+$/.test(href)) diags.push({ ...where, code: "link", message: `링크는 https: 주소만: ${href}` });
      return `<a href="${escAttr(href)}">${out(n.childNodes)}</a>`;
    }
    if (n.tagName === "span") {
      const decls = parseStyle(attr(n, "style") ?? "");
      const color = decls.find(([k]) => k === "color")?.[1];
      if (decls.length !== 1 || !color || validateStyle("color", color)) {
        diags.push({ ...where, code: "inline-style", message: "span에는 글자색(color)만 쓸 수 있습니다" });
      }
      return color ? `<span style="color:${escAttr(color)}">${out(n.childNodes)}</span>` : out(n.childNodes);
    }
    const extra = n.attrs.filter((a) => a.name !== "data-eid");
    if (extra.length) diags.push({ ...where, code: "attr", message: `<${n.tagName}>에는 속성을 쓸 수 없습니다: ${extra.map((a) => a.name).join(", ")}` });
    return `<${n.tagName}>${out(n.childNodes)}</${n.tagName}>`;
  }).join("");
  return out(frag.childNodes);
}

// ---------- 파싱 ----------

export interface ParseResult { slide?: Slide; diagnostics: Diagnostic[] }

/** 슬라이드 HTML → 노드 트리. eid가 없는 요소에는 새 eid(e1, e2 …, 이미 있는 번호 다음)를 붙인다 */
export function parseSlide(html: string): ParseResult {
  const diags: Diagnostic[] = [];
  const frag = parseFragment(html, { sourceCodeLocationInfo: true });
  const tops = frag.childNodes.filter((n) => isEl(n) || (n.nodeName === "#text" && (n as DefaultTreeAdapterMap["textNode"]).value.trim()));
  if (tops.length !== 1 || !isEl(tops[0]) || tops[0].tagName !== "section") {
    diags.push({ line: 1, col: 1, code: "root", message: "슬라이드는 <section id=\"…\"> 하나여야 합니다" });
    return { diagnostics: diags };
  }
  const section = tops[0];
  const id = attr(section, "id") ?? "";
  if (!ID_RE.test(id)) diags.push({ ...loc(section), code: "id", message: `section id는 영문 소문자·숫자·-만: ${id || "(없음)"}` });

  const used = new Set<string>();
  const pending: SlideEl[] = [];
  let notes = "";

  const element = (el: Element): SlideEl | null => {
    const tag = el.tagName;
    const at = loc(el);
    const node: SlideEl = { kind: "el", eid: "", tag: tag as BlockTag, style: {}, attrs: {}, children: [] };
    for (const a of el.attrs) {
      if (a.name === "data-eid") {
        if (!/^[\w-]{1,64}$/.test(a.value)) diags.push({ ...at, code: "eid", message: `data-eid 형식이 틀렸습니다: ${a.value}` });
        else if (used.has(a.value)) diags.push({ ...at, code: "eid-dup", message: `data-eid가 겹칩니다: ${a.value}`, fix: "겹치는 쪽의 data-eid를 지우면 새로 붙습니다" });
        else { node.eid = a.value; used.add(a.value); }
      } else if (a.name === "style") {
        for (const [k, v] of parseStyle(a.value)) {
          const d = validateStyle(k, v);
          if (d) diags.push({ ...at, ...d }); else node.style[k] = v;
        }
      } else if (a.name === "id" && tag === "section") {
        /* section id */
      } else if (tag === "img" && (a.name === "src" || a.name === "alt")) {
        if (a.name === "src" && !ASSET_RE.test(a.value)) diags.push({ ...at, code: "src", message: `그림 주소는 asset:<sha256>만 씁니다: ${a.value}`, fix: "asset_put으로 올린 뒤 받은 주소를 쓰세요" });
        node.attrs[a.name] = a.value;
      } else if (/^on/i.test(a.name)) {
        diags.push({ ...at, code: "attr", message: `이벤트 속성은 쓸 수 없습니다: ${a.name}` });
      } else {
        diags.push({ ...at, code: "attr", message: `<${tag}>에 쓸 수 없는 속성: ${a.name}` });
      }
    }
    if (tag === "img" && !node.attrs.src) diags.push({ ...at, code: "src", message: "img에는 src(asset:…)가 있어야 합니다" });
    if (tag === "img" && node.attrs.alt === undefined) node.attrs.alt = "";
    if (!node.eid) pending.push(node);
    if (tag === "section") node.eid = id;
    if (!VOID.has(tag)) node.children = children(el);
    return node;
  };

  const children = (parent: Element): SlideNode[] => {
    const out: SlideNode[] = [];
    let run = "";
    let runAt = loc(parent);
    const flush = () => {
      if (run.trim()) out.push({ kind: "text", html: sanitizeInline(run.trim(), diags, runAt) });
      run = "";
    };
    for (const n of parent.childNodes) {
      if (n.nodeName === "#text") {
        if (!run) runAt = loc(n);
        run += escText((n as DefaultTreeAdapterMap["textNode"]).value);
      } else if (n.nodeName === "#comment") {
        continue;
      } else if (isEl(n) && INLINE.has(n.tagName)) {
        if (!run) runAt = loc(n);
        run += outerHtml(n);
      } else if (isEl(n) && TRANSPARENT.has(n.tagName) && parent.tagName === "table") {
        flush();
        out.push(...children(n));
      } else if (isEl(n) && n.tagName === "aside" && parent === section) {
        flush();
        notes = textOf(n).trim();
      } else if (isEl(n) && BLOCKS.has(n.tagName) && n.tagName !== "section") {
        flush();
        const c = element(n);
        if (c) out.push(c);
      } else if (isEl(n)) {
        flush();
        const fix = n.tagName === "style" ? "글꼴은 덱 색인(faces)에, 스타일은 style 속성에 씁니다" : n.tagName === "script" ? "스크립트는 쓸 수 없습니다"
          : /^(em|strong|code|small|sub|sup|mark|s|del|ins|font)$/.test(n.tagName) ? "글자 안 마크는 b·i·u·a·span(color)·br만 씁니다" : undefined;
        diags.push({ ...loc(n), code: "tag", message: `허용하지 않는 태그: <${n.tagName}>`, ...(fix ? { fix } : {}) });
      }
    }
    flush();
    return out;
  };

  const root = element(section)!;
  let n = 0;
  for (const u of used) { const m = /^e(\d+)$/.exec(u); if (m) n = Math.max(n, Number(m[1])); }
  for (const el of pending) if (el.tag !== "section") { while (used.has(`e${++n}`)); el.eid = `e${n}`; used.add(el.eid); }
  diags.sort((a, b) => a.line - b.line || a.col - b.col);
  return { slide: { id, root, notes }, diagnostics: diags };
}

const escText = (s: string) => esc(s);
function textOf(n: Node): string {
  if (n.nodeName === "#text") return (n as DefaultTreeAdapterMap["textNode"]).value;
  return "childNodes" in n ? n.childNodes.map(textOf).join("") : "";
}
/** 인라인 요소를 다시 HTML로(검증은 sanitizeInline이 한다) */
function outerHtml(el: Element): string {
  const attrs = el.attrs.map((a) => ` ${a.name}="${escAttr(a.value)}"`).join("");
  if (el.tagName === "br") return "<br>";
  return `<${el.tagName}${attrs}>${el.childNodes.map((c) => (c.nodeName === "#text" ? escText((c as DefaultTreeAdapterMap["textNode"]).value) : isEl(c) ? outerHtml(c) : "")).join("")}</${el.tagName}>`;
}

// ---------- 직렬화 ----------

/** 항상 같은 모양으로 쓴다: 블록마다 한 줄, 두 칸 들여쓰기, 속성 순서 data-eid → id → src → alt → style */
export function serializeSlide(slide: Slide): string {
  return writeEl(slide.root, 0, slide).join("\n") + "\n";
}

/** 요소 하나(와 그 아래)를 같은 모양으로. 연산의 역연산(insert)과 복사에 쓴다 */
export const serializeEl = (el: SlideEl) => writeEl(el, 0, null).join("\n");

function writeEl(el: SlideEl, depth: number, slide: Slide | null): string[] {
  const pad = "  ".repeat(depth);
  let open = `<${el.tag}`;
  if (el.tag === "section" && slide) open += ` id="${escAttr(slide.id)}"`;
  open += ` data-eid="${escAttr(el.eid)}"`;
  if (el.attrs.src !== undefined) open += ` src="${escAttr(el.attrs.src)}"`;
  if (el.attrs.alt !== undefined) open += ` alt="${escAttr(el.attrs.alt)}"`;
  const st = styleText(el.style);
  if (st) open += ` style="${escAttr(st)}"`;
  open += ">";
  if (VOID.has(el.tag)) return [pad + open];
  const isRoot = !!slide && el === slide.root;
  if (!isRoot && el.children.every((c) => c.kind === "text")) {
    return [`${pad}${open}${el.children.map((c) => (c as { html: string }).html).join("")}</${el.tag}>`];
  }
  const lines = [pad + open];
  for (const c of el.children) {
    if (c.kind === "text") lines.push(`${pad}  ${c.html}`);
    else lines.push(...writeEl(c, depth + 1, null));
  }
  if (isRoot && slide!.notes) lines.push(`${pad}  <aside>${esc(slide!.notes)}</aside>`);
  lines.push(`${pad}</${el.tag}>`);
  return lines;
}

// ---------- 찾기 ----------

export function findEl(root: SlideEl, eid: Eid): { el: SlideEl; parent: SlideEl | null; index: number } | null {
  if (root.eid === eid) return { el: root, parent: null, index: -1 };
  const walk = (p: SlideEl): ReturnType<typeof findEl> => {
    for (let i = 0; i < p.children.length; i++) {
      const c = p.children[i];
      if (c.kind !== "el") continue;
      if (c.eid === eid) return { el: c, parent: p, index: i };
      const r = walk(c);
      if (r) return r;
    }
    return null;
  };
  return walk(root);
}

export function allEids(root: SlideEl): Set<Eid> {
  const s = new Set<Eid>();
  const walk = (e: SlideEl) => { s.add(e.eid); e.children.forEach((c) => c.kind === "el" && walk(c)); };
  walk(root);
  return s;
}
