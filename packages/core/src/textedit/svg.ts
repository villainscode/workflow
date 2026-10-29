import { Parser } from "htmlparser2";
import { decodeXml, encodeXml } from "./ooxml.ts";
import { resolveChanges, textHash, type Adapter, type Change, type Segment } from "./types.ts";

/**
 * SVG 어댑터(2.0 확장). SVG는 XML이므로 htmlparser2(xmlMode)로 글자 노드의 원본 위치를 찾고, 바뀐 글자 구간만 교체한다.
 * 특수 문자는 XML 방식(&amp; &lt; &gt;)으로만 쓴다. HTML 어댑터는 &nbsp;를 써서 SVG를 깨뜨리므로 쓰지 않는다.
 *
 * draw.io가 내보낸 SVG는 글자마다 두 벌이 있다.
 *   <switch><foreignObject>…HTML 글자(브라우저가 보여 줌)…</foreignObject><text>예비 글자(다른 프로그램용)</text></switch>
 * HTML 글자만 조각으로 보여 주고, 저장할 때 예비 글자를 새 글자로 다시 만든다. 예비 글자는 줄이 미리 나뉘어(<tspan>)
 * 있으므로 원래 줄 수를 지키고, 원래 줄 길이 비율대로 새 글자를 나눠 넣는다.
 * draw.io가 아닌 SVG의 <text>·<tspan> 글자는 그대로 조각이 된다.
 * 상자 크기는 바뀌지 않으므로, 줄이 원래보다 눈에 띄게 길어지면 경고를 돌려준다.
 */

// 화면에 그려지지 않는 글자
const SKIP = new Set(["title", "desc", "style", "script", "metadata"]);
// HTML(foreignObject 안)에서 줄을 나누는 요소
const BLOCK = new Set(["div", "p", "li", "h1", "h2", "h3", "h4", "h5", "h6", "tr"]);
const LEAD = /^[ \t\n\r\f]*/;
const TRAIL = /[ \t\n\r\f]*$/;

/** 글자 노드 하나. start..end가 원본 구간, 편집 구간은 그 안의 앞뒤 공백을 뺀 inner */
interface TextNode { start: number; end: number; raw: string; innerStart: number; innerEnd: number; seg?: number }
/** draw.io 글자 하나: HTML 글자 노드(줄별)와 예비 글자 줄(<tspan> 또는 <text> 바로 안 글자) */
interface Label { lines: TextNode[][]; fallback: TextNode[]; counts: number[] | null; widths: number[]; ext?: boolean }
interface Parsed { segments: (Segment & { node: TextNode })[]; labels: Label[]; plain: TextNode[] }

/** 보이는 폭: 한글·한자·전각은 2, 나머지는 1 */
export const visualWidth = (t: string) =>
  [...t].reduce((n, c) => n + (/[ᄀ-ᇿ⺀-꓏가-힯豈-﫿︰-﹏＀-｠￠-￦]/.test(c) ? 2 : 1), 0);
const squash = (t: string) => t.replace(/[ \t\n\r\f]+/g, " ").trim();
const noSpace = (t: string) => t.replace(/[\s ]+/g, "");

function parse(xml: string): Parsed {
  const segments: Parsed["segments"] = [];
  const labels: Label[] = [];
  const plain: TextNode[] = [];
  // 열린 요소: 이름, draw.io 칸 id
  const stack: { name: string; cell?: string; dead?: boolean }[] = [];
  let label: Label | null = null;           // 지금 읽는 <switch> 안 draw.io 글자
  let inForeign = 0, inFallback = 0, skip = 0, inSvgText = 0;
  let fbTspanDepth = 0;
  let lastText: TextNode | null = null;
  let lastKind: "fo" | "fb" | "plain" | null = null;

  const cell = () => { for (let i = stack.length - 1; i >= 0; i--) if (stack[i].cell) return stack[i].cell; return undefined; };
  const breakLine = () => { if (label && label.lines[label.lines.length - 1].length) label.lines.push([]); };

  const parser = new Parser({
    onopentag(name, attrs) {
      const local = name.includes(":") ? name.slice(name.indexOf(":") + 1) : name;
      stack.push({ name: local, cell: attrs["data-cell-id"] });
      lastText = null;
      if (SKIP.has(local)) { skip++; return; }
      // <switch>에서 브라우저는 Extensibility(foreignObject)를 지원하는 첫 갈래를 그린다. 그 뒤 갈래의 글자는 브라우저에 보이지 않는다
      if (label && attrs.requiredFeatures?.includes("Extensibility")) label.ext = true;
      if (local === "switch") label = { lines: [[]], fallback: [], counts: null, widths: [] };
      else if (local === "foreignObject") inForeign++;
      else if (inForeign && (local === "br" || BLOCK.has(local))) breakLine();
      else if (local === "text" && !inForeign) {
        if (label && label.lines.some((l) => l.length)) inFallback++;
        else if (label?.ext) { skip++; stack[stack.length - 1].dead = true; } // 예: draw.io "Text is not SVG" 안내
        else inSvgText++;
      } else if (local === "tspan" && inFallback) fbTspanDepth++;
    },
    onclosetag(name) {
      const local = name.includes(":") ? name.slice(name.indexOf(":") + 1) : name;
      const top = stack.pop();
      lastText = null;
      if (SKIP.has(local) || top?.dead) { skip--; return; }
      if (local === "foreignObject") inForeign--;
      else if (inForeign && BLOCK.has(local)) breakLine();
      else if (local === "text" && !inForeign) { if (inFallback) inFallback--; else if (inSvgText) inSvgText--; }
      else if (local === "tspan" && inFallback) fbTspanDepth--;
      else if (local === "switch" && label) {
        if (label.lines.some((l) => l.length)) {
          if (!label.lines[label.lines.length - 1].length) label.lines.pop();
          labels.push(label);
        }
        label = null;
      }
    },
    ontext(text) {
      if (skip) return;
      const start = parser.startIndex, end = parser.endIndex + 1;
      const kind = inForeign && label ? "fo" : inFallback && label ? "fb" : inSvgText ? "plain" : null;
      if (!kind) return;
      // 한 글자 노드가 여러 번에 나뉘어 올 수 있어 이어 붙인다
      if (lastText && lastKind === kind && lastText.end === start) { lastText.end = end; lastText.raw = xml.slice(lastText.start, end); return; }
      const node: TextNode = { start, end, raw: text, innerStart: start, innerEnd: end };
      lastText = node; lastKind = kind;
      if (kind === "fo") label!.lines[label!.lines.length - 1].push(node);
      else if (kind === "fb") {
        // 예비 글자 줄: <tspan>마다 한 줄, tspan이 없으면 <text> 바로 안 글자가 한 줄. tspan 사이 공백은 줄이 아니다
        if (fbTspanDepth || text.trim()) label!.fallback.push(node);
      } else plain.push(node);
      node.raw = xml.slice(start, end);
    },
  }, { xmlMode: true, decodeEntities: false });
  parser.write(xml);
  parser.end();

  // 편집 구간(앞뒤 공백 제외)과 조각 번호. 공백만 있는 노드는 조각이 아니다
  const addSeg = (node: TextNode, svg: boolean, group: string) => {
    const lead = node.raw.match(LEAD)![0];
    const trail = node.raw.slice(lead.length).match(TRAIL)![0];
    node.innerStart = node.start + lead.length;
    node.innerEnd = node.end - trail.length;
    if (node.innerEnd <= node.innerStart) return;
    const text = decodeXml(xml.slice(node.innerStart, node.innerEnd));
    node.seg = segments.length;
    segments.push({ id: segments.length, text, hash: textHash(text), multiline: false, group, svg: svg || undefined, node });
  };

  // 조각 id는 문서 순서. draw.io 글자와 일반 글자를 원본 위치 순으로 합친다
  const items: { pos: number; run: () => void }[] = [];
  for (const l of labels) {
    for (const n of l.lines.flat()) items.push({ pos: n.start, run: () => addSeg(n, false, groupAt(xml, n.start) ?? "label") });
    const fb = l.fallback.map((n) => decodeXml(n.raw));
    l.widths = fb.map((t) => visualWidth(squash(t)));
    // HTML 줄마다 예비 글자 몇 줄을 썼는지 맞춰 본다(글자를 공백 없이 비교). 맞지 않으면 null → 전체 비율로 나눈다
    const counts: number[] = [];
    let k = 0, okMatch = true;
    for (const line of l.lines) {
      const target = noSpace(decodeXml(line.map((n) => n.raw).join("")));
      let acc = "", c = 0;
      while (acc.length < target.length && k < fb.length) { acc += noSpace(fb[k]); k++; c++; }
      if (acc !== target) { okMatch = false; break; }
      counts.push(Math.max(c, target ? c : 0));
    }
    l.counts = okMatch && k === fb.length ? counts : null;
  }
  for (const n of plain) items.push({ pos: n.start, run: () => addSeg(n, true, groupAt(xml, n.start) ?? "text") });
  items.sort((a, b) => a.pos - b.pos).forEach((i) => i.run());
  return { segments, labels, plain };
}

/** 그 위치를 감싸는 가장 가까운 draw.io 칸 id(data-cell-id). 화면 묶음 이름으로 쓴다 */
function groupAt(xml: string, pos: number): string | undefined {
  const before = xml.slice(0, pos);
  const re = /<g\b[^>]*\bdata-cell-id="([^"]+)"/g;
  let m: RegExpExecArray | null, last: string | undefined;
  while ((m = re.exec(before))) last = m[1];
  return last;
}

/**
 * 글자를 n줄로 나눈다. 원래 줄 폭 비율(widths)대로 끊되, 끊는 자리 가까이에 공백이 있으면 공백에서 끊고 그 공백은 버린다.
 */
export function splitLines(text: string, n: number, widths: number[]): string[] {
  if (n <= 1) return [text];
  const total = visualWidth(text);
  const sum = widths.reduce((a, b) => a + b, 0) || n;
  const chars = [...text];
  const out: string[] = [];
  let i = 0, acc = 0, used = 0;
  for (let line = 0; line < n - 1; line++) {
    acc += (widths[line] ?? 1) / sum;
    const goal = Math.round(total * acc);
    let j = i, w = used;
    while (j < chars.length && w + visualWidth(chars[j]) <= goal) { w += visualWidth(chars[j]); j++; }
    // 끊을 자리 앞쪽 절반 안에서 가장 가까운 공백을 찾는다
    let cut = j, skipSpace = 0;
    for (let k = j; k > i + Math.floor((j - i) / 2); k--) if (chars[k] === " ") { cut = k; skipSpace = 1; break; }
    if (!skipSpace && chars[j] === " ") skipSpace = 1;
    out.push(chars.slice(i, cut).join(""));
    used += visualWidth(chars.slice(i, cut + skipSpace).join(""));
    i = cut + skipSpace;
  }
  out.push(chars.slice(i).join(""));
  return out;
}

export const svgAdapter: Adapter = {
  extract(data) {
    return parse(new TextDecoder().decode(data)).segments.map(({ node: _n, ...s }) => s);
  },
  apply(data: Uint8Array, changes: Change[]) {
    const xml = new TextDecoder().decode(data);
    const p = parse(xml);
    const next = resolveChanges(p.segments, changes);
    if (next.size === 0) return { data, changed: 0, warnings: [] };
    const edits: { start: number; end: number; str: string }[] = [];
    const warnings: string[] = [];
    const short = (t: string) => (t.length > 24 ? t.slice(0, 24) + "…" : t);
    const segOf = (n: TextNode) => (n.seg === undefined ? undefined : p.segments[n.seg]);

    for (const [id, text] of next) {
      const s = p.segments[id];
      edits.push({ start: s.node.innerStart, end: s.node.innerEnd, str: encodeXml(text) });
    }

    // 바뀐 draw.io 글자의 예비 글자를 다시 만든다
    for (const l of p.labels) {
      const nodes = l.lines.flat();
      if (!nodes.some((n) => n.seg !== undefined && next.has(n.seg))) continue;
      const nodeText = (n: TextNode) => {
        const raw = decodeXml(n.raw);
        const s = segOf(n);
        if (!s || !next.has(s.id)) return raw;
        const lead = n.raw.match(LEAD)![0], trail = n.raw.slice(lead.length).match(TRAIL)![0];
        return lead + next.get(s.id)! + trail;
      };
      const lineTexts = l.lines.map((line) => squash(line.map(nodeText).join("")));
      let fbLines: string[];
      if (l.counts) {
        fbLines = [];
        let k = 0;
        l.lines.forEach((_, j) => {
          const c = l.counts![j];
          if (c > 0) fbLines.push(...splitLines(lineTexts[j], c, l.widths.slice(k, k + c)));
          k += c;
        });
      } else {
        fbLines = splitLines(lineTexts.join(" "), l.fallback.length, l.widths);
      }
      l.fallback.forEach((n, i) => {
        const lead = n.raw.match(LEAD)![0], trail = n.raw.slice(lead.length).match(TRAIL)![0];
        edits.push({ start: n.start, end: n.end, str: lead + encodeXml(fbLines[i] ?? "") + trail });
      });
      // 상자 폭 추정: 이 글자의 원래 줄 중 가장 긴 줄. 새 줄이 그보다 15% 넘게 길면 넘칠 수 있다
      const box = Math.max(...l.widths, 1);
      const over = fbLines.filter((t) => visualWidth(t) > box * 1.15 + 1);
      if (l.fallback.length && over.length) {
        const seg = nodes.map(segOf).find((s) => s && next.has(s.id))!;
        warnings.push(`[${seg.id}] ‘${short(lineTexts.join(" "))}’ 글자가 상자보다 길어져 넘칠 수 있습니다`);
      }
    }

    // 일반 SVG 글자: 원래보다 눈에 띄게 길어지면 다른 요소와 겹칠 수 있다
    for (const n of p.plain) {
      const s = segOf(n);
      if (!s || !next.has(s.id)) continue;
      if (visualWidth(next.get(s.id)!) > visualWidth(s.text) * 1.15 + 1) {
        warnings.push(`[${s.id}] ‘${short(next.get(s.id)!)}’ 글자가 원래보다 길어져 다른 요소와 겹칠 수 있습니다`);
      }
    }

    let out = xml;
    for (const e of edits.sort((a, b) => b.start - a.start)) out = out.slice(0, e.start) + e.str + out.slice(e.end);
    return { data: new TextEncoder().encode(out), changed: next.size, warnings };
  },
};

/** 편집 화면용 사본: HTML 글자는 <span data-seg>(XHTML), SVG 글자는 <tspan data-seg>로 감싼다. 저장에는 쓰지 않는다 */
export function wrapSvgForEdit(data: Uint8Array): string {
  const xml = new TextDecoder().decode(data);
  const { segments } = parse(xml);
  const inserts: { pos: number; str: string }[] = [];
  for (const s of segments) {
    const tag = s.svg ? "tspan" : "span";
    inserts.push({ pos: s.node.innerStart, str: `<${tag} data-seg="${s.id}">` }, { pos: s.node.innerEnd, str: `</${tag}>` });
  }
  let out = xml;
  for (const { pos, str } of inserts.sort((a, b) => b.pos - a.pos)) out = out.slice(0, pos) + str + out.slice(pos);
  return out;
}
