import { parse } from "parse5";
import type { DefaultTreeAdapterMap } from "parse5";
import { resolveChanges, textHash, type Adapter, type Change, type Segment } from "./types.ts";

/**
 * HTML 어댑터. parse5가 주는 텍스트 노드의 원본 위치(startOffset·endOffset)로,
 * 바뀐 노드의 원본 구간만 교체한다. 들여쓰기·엔티티·속성 순서 등 나머지는 그대로 남는다.
 */

type Node = DefaultTreeAdapterMap["node"];
type TextNode = DefaultTreeAdapterMap["textNode"];

// 텍스트가 화면 글자가 아닌 곳
const SKIP = new Set(["head", "script", "style", "noscript", "template", "textarea"]);

/** 원본에서 편집할 가운데 구간(start..end). 앞뒤 공백(들여쓰기)은 이 구간 밖에 남는다 */
interface Located extends Segment { start: number; end: number }

// 앞뒤 공백은 일반 공백 문자만 본다. trim()은 nbsp(\u00a0)까지 지워 원본의 &nbsp;를 잃게 만든다
const LEAD = /^[ \t\n\r\f]*/;
const TRAIL = /[ \t\n\r\f]*$/;

function collect(html: string): Located[] {
  const doc = parse(html, { sourceCodeLocationInfo: true });
  const out: Located[] = [];
  const walk = (n: Node, ctx: { pre: boolean; svg: boolean; parent: string }) => {
    if (n.nodeName === "#text") {
      const t = n as TextNode;
      const loc = t.sourceCodeLocation;
      // 공백만 있는 노드(들여쓰기)는 편집 대상이 아니다. 위치가 없는 노드는 파서가 만든 것이라 원본에 없다
      if (!t.value.trim() || !loc) return;
      // pre 안은 공백도 내용이라 그대로 두고, 그 밖은 앞뒤 공백을 떼고 가운데만 편집한다
      const raw = html.slice(loc.startOffset, loc.endOffset);
      const lead = ctx.pre ? "" : raw.match(LEAD)![0];
      const trail = ctx.pre ? "" : raw.slice(lead.length).match(TRAIL)![0];
      const text = ctx.pre ? t.value : t.value.replace(LEAD, "").replace(TRAIL, "");
      out.push({
        id: out.length, text, hash: textHash(text), multiline: ctx.pre,
        group: ctx.parent, svg: ctx.svg || undefined,
        start: loc.startOffset + lead.length, end: loc.endOffset - trail.length,
      });
      return;
    }
    if (SKIP.has(n.nodeName)) return;
    const children = "childNodes" in n ? n.childNodes : [];
    const tag = "tagName" in n ? n.tagName : ctx.parent;
    for (const c of children) walk(c, { pre: ctx.pre || n.nodeName === "pre", svg: ctx.svg || n.nodeName === "svg", parent: tag });
  };
  walk(doc, { pre: false, svg: false, parent: "" });
  return out;
}

const escapeHtml = (t: string) =>
  t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/ /g, "&nbsp;");

const strip = ({ start: _s, end: _e, ...seg }: Located): Segment => seg;

export const htmlAdapter: Adapter = {
  extract(data) {
    return collect(new TextDecoder().decode(data)).map(strip);
  },

  apply(data, changes: Change[]) {
    const src = new TextDecoder().decode(data);
    const segs = collect(src);
    const edits = resolveChanges(segs, changes);
    if (edits.size === 0) return { data, changed: 0 };

    // 뒤쪽 구간부터 바꿔야 앞쪽 위치가 밀리지 않는다
    let out = src;
    for (const s of [...segs].sort((a, b) => b.start - a.start)) {
      const text = edits.get(s.id);
      if (text === undefined) continue;
      out = out.slice(0, s.start) + escapeHtml(text) + out.slice(s.end);
    }
    return { data: new TextEncoder().encode(out), changed: edits.size };
  },
};

/** 편집 화면(2.2)에서 조각 위치를 쓰기 위해 내보낸다 */
export const locateHtmlSegments = collect;

// SVG 안에서 화면에 그려지는 글자 요소. title·desc는 보이지 않으므로 편집용 사본에서 감싸지 않는다
const SVG_VISIBLE = new Set(["text", "tspan", "textPath"]);

/**
 * 편집 화면용 사본. 각 텍스트 조각을 <span data-seg="id">(SVG 글자는 <tspan data-seg="id">)로 감싸고,
 * 이미지·CSS 같은 상대 경로가 원래 위치(baseHref)에서 읽히도록 <base>를 넣는다.
 * 이 사본은 화면에만 쓰고 저장하지 않는다. 저장은 apply()가 원본 구간 교체로 한다.
 */
export function wrapForEdit(data: Uint8Array, baseHref: string): string {
  const html = new TextDecoder().decode(data);
  const inserts: { pos: number; str: string }[] = [];
  for (const s of collect(html)) {
    if (s.svg && !SVG_VISIBLE.has(s.group)) continue;
    const tag = s.svg ? "tspan" : "span";
    inserts.push({ pos: s.start, str: `<${tag} data-seg="${s.id}">` }, { pos: s.end, str: `</${tag}>` });
  }
  const doc = parse(html, { sourceCodeLocationInfo: true });
  const htmlEl = doc.childNodes.find((n) => n.nodeName === "html") as DefaultTreeAdapterMap["element"] | undefined;
  const head = htmlEl?.childNodes.find((n) => n.nodeName === "head") as DefaultTreeAdapterMap["element"] | undefined;
  const headPos = head?.sourceCodeLocation?.startTag?.endOffset;
  const base = `<base href="${baseHref.replace(/"/g, "&quot;")}">`;
  if (headPos !== undefined) inserts.push({ pos: headPos, str: base });

  let out = html;
  for (const { pos, str } of inserts.sort((a, b) => b.pos - a.pos)) out = out.slice(0, pos) + str + out.slice(pos);
  return headPos === undefined ? base + out : out;
}
