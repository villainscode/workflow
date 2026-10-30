import { validateStyle, type Diagnostic, type Style } from "./css.ts";
import { allEids, ASSET_RE, findEl, parseSlide, sanitizeInline, serializeEl, type Eid, type Slide, type SlideEl } from "./parse.ts";

/**
 * 슬라이드 편집 연산(명세 04·07절). 사람(화면)과 에이전트(MCP)가 같은 연산을 쓴다. 대상은 eid로 가리킨다.
 * applyOps는 바뀐 슬라이드와 역연산을 돌려준다. 되돌리기는 역연산을 새 연산으로 적용해 저장한다(서버에 되돌리기 개념이 없다).
 * 요소 넣기(insert)는 HTML 한 조각으로 받는다(파서가 검증하고 eid를 붙인다). 지우기의 역연산(restore)은 지운 요소를 같은 eid로 되살린다.
 */

export type Box = { left: number; top: number; width: number; height: number };
export type SlideOp =
  | { t: "setText"; eid: Eid; html: string }
  | { t: "setStyle"; eid: Eid; set?: Style; unset?: string[] }
  | { t: "setAttr"; eid: Eid; name: "alt" | "src"; value: string }
  | { t: "insert"; parent: Eid; index: number; html: string }
  | { t: "remove"; eid: Eid }
  /** 지운 요소를 같은 eid로 되살린다(역연산) */
  | { t: "restore"; parent: Eid; index: number; html: string }
  | { t: "move"; eid: Eid; parent: Eid; index: number }
  | { t: "toPinned"; eid: Eid; box: Box }
  | { t: "tableCols"; eid: Eid; widths: number[] }
  | { t: "tableRow"; eid: Eid; at: number; op: "add" | "remove" }
  | { t: "tableCol"; eid: Eid; at: number; op: "add" | "remove" }
  | { t: "setNotes"; text: string };

export class SlideError extends Error {
  constructor(public status: number, message: string, public diagnostics: Diagnostic[] = []) { super(message); }
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const TEXT_TAGS = new Set(["h1", "h2", "h3", "p", "li", "th", "td", "div"]);
const CONTAINERS = new Set(["section", "div", "ul", "ol", "li", "td", "th"]);

function need(slide: Slide, eid: Eid) {
  const r = findEl(slide.root, eid);
  if (!r) throw new SlideError(409, `요소 ${eid}이(가) 없습니다(다른 곳에서 지웠을 수 있습니다)`);
  return r;
}
const fail = (message: string, diagnostics: Diagnostic[] = []) => new SlideError(400, message, diagnostics);

/** 표: 행(tr)과 행마다 칸(th·td) */
function tableShape(table: SlideEl) {
  if (table.tag !== "table") throw fail(`${table.eid}은(는) 표가 아닙니다`);
  const rows = table.children.filter((c): c is SlideEl => c.kind === "el" && c.tag === "tr");
  const cells = rows.map((r) => r.children.filter((c): c is SlideEl => c.kind === "el" && (c.tag === "td" || c.tag === "th")));
  return { rows, cells, cols: Math.max(0, ...cells.map((r) => r.length)) };
}

/** 넣을 HTML 한 조각 → 요소. 슬라이드에 이미 있는 eid는 새로 붙인다(복사·붙여 넣기). keep이면 그대로 둔다(되살리기) */
function fragment(slide: Slide, html: string, keep: boolean): SlideEl {
  // 행·칸·목록 항목은 브라우저 파서가 표·목록 밖에서 버리므로 감싸서 읽고 꺼낸다
  const tag = /^\s*<([a-z0-9]+)/i.exec(html)?.[1]?.toLowerCase() ?? "";
  const [pre, post, depth] = tag === "tr" ? ["<table>", "</table>", 1] : tag === "td" || tag === "th" ? ["<table><tr>", "</tr></table>", 2] : tag === "li" ? ["<ul>", "</ul>", 1] : ["", "", 0];
  const r = parseSlide(`<section id="frag">${pre}${html}${post}</section>`);
  if (r.diagnostics.length || !r.slide) throw fail("넣을 HTML이 형식에 맞지 않습니다", r.diagnostics);
  let holder: SlideEl = r.slide.root;
  for (let i = 0; i < depth; i++) holder = holder.children[0] as SlideEl;
  const els = holder.children.filter((c): c is SlideEl => c.kind === "el");
  if (els.length !== 1 || holder.children.length !== 1) throw fail("insert에는 요소 하나만 넣습니다");
  const el = els[0];
  const used = allEids(slide.root);
  let n = Math.max(0, ...[...used].map((e) => Number(/^e(\d+)$/.exec(e)?.[1] ?? 0)));
  const walk = (e: SlideEl) => {
    if (used.has(e.eid) && !keep) { while (used.has(`e${++n}`)); e.eid = `e${n}`; }
    else if (used.has(e.eid)) throw new SlideError(409, `요소 ${e.eid}이(가) 이미 있습니다`);
    used.add(e.eid);
    e.children.forEach((c) => c.kind === "el" && walk(c));
  };
  walk(el);
  return el;
}

function checkStyle(set: Style) {
  const diags: Diagnostic[] = [];
  for (const [k, v] of Object.entries(set)) { const d = validateStyle(k, v); if (d) diags.push({ line: 0, col: 0, ...d }); }
  if (diags.length) throw fail("허용하지 않는 스타일입니다", diags);
}

/** 연산 하나를 그 자리에서 적용하고 역연산을 돌려준다 */
function apply(slide: Slide, op: SlideOp): SlideOp[] {
  switch (op.t) {
    case "setText": {
      const { el } = need(slide, op.eid);
      if (!TEXT_TAGS.has(el.tag) || el.children.some((c) => c.kind === "el")) throw fail(`<${el.tag}> ${el.eid}의 글자는 이 방식으로 고칠 수 없습니다`);
      const diags: Diagnostic[] = [];
      const html = sanitizeInline(op.html.trim(), diags);
      if (diags.length) throw fail("글자에 허용하지 않는 마크가 있습니다", diags);
      const old = el.children.map((c) => (c as { html: string }).html).join("");
      el.children = html ? [{ kind: "text", html }] : [];
      return [{ t: "setText", eid: op.eid, html: old }];
    }
    case "setStyle": {
      const { el } = need(slide, op.eid);
      const set = op.set ?? {};
      checkStyle(set);
      const back: Style = {}, gone: string[] = [];
      for (const k of [...Object.keys(set), ...(op.unset ?? [])]) {
        if (k in back || gone.includes(k)) continue;
        if (el.style[k] !== undefined) back[k] = el.style[k]; else gone.push(k);
      }
      for (const k of op.unset ?? []) delete el.style[k];
      Object.assign(el.style, set);
      return [{ t: "setStyle", eid: op.eid, set: back, unset: gone }];
    }
    case "setAttr": {
      const { el } = need(slide, op.eid);
      if (el.tag !== "img") throw fail("alt·src는 그림(img)에만 있습니다");
      if (op.name === "src" && !ASSET_RE.test(op.value)) throw fail(`그림 주소는 asset:<sha256>만 씁니다: ${op.value}`);
      const old = el.attrs[op.name] ?? "";
      el.attrs[op.name] = op.value;
      return [{ t: "setAttr", eid: op.eid, name: op.name, value: old }];
    }
    case "insert": {
      const { el: parent } = need(slide, op.parent);
      if (!CONTAINERS.has(parent.tag)) throw fail(`<${parent.tag}> 안에는 요소를 넣을 수 없습니다`);
      if (parent.children.some((c) => c.kind === "text")) throw fail(`${parent.eid}은(는) 글자를 담은 요소라 블록을 넣을 수 없습니다`);
      const el = fragment(slide, op.html, false);
      const index = Math.max(0, Math.min(op.index, parent.children.length));
      parent.children.splice(index, 0, el);
      return [{ t: "remove", eid: el.eid }];
    }
    case "remove": {
      const { el, parent, index } = need(slide, op.eid);
      if (!parent) throw fail("슬라이드 자체는 지울 수 없습니다");
      parent.children.splice(index, 1);
      return [{ t: "restore", parent: parent.eid, index, html: serializeEl(el) }];
    }
    case "restore": {
      const { el: parent } = need(slide, op.parent);
      const el = fragment(slide, op.html, true);
      parent.children.splice(Math.max(0, Math.min(op.index, parent.children.length)), 0, el);
      return [{ t: "remove", eid: el.eid }];
    }
    case "move": {
      const { el, parent: from, index: fromIndex } = need(slide, op.eid);
      const { el: to } = need(slide, op.parent);
      if (!from) throw fail("슬라이드 자체는 옮길 수 없습니다");
      if (findEl(el, op.parent)) throw fail("요소를 자기 안으로 옮길 수 없습니다");
      if (!CONTAINERS.has(to.tag) || to.children.some((c) => c.kind === "text")) throw fail(`${to.eid} 안으로는 옮길 수 없습니다`);
      from.children.splice(fromIndex, 1);
      const index = Math.max(0, Math.min(op.index, to.children.length));
      to.children.splice(index, 0, el);
      return [{ t: "move", eid: op.eid, parent: from.eid, index: fromIndex }];
    }
    case "toPinned": {
      const b = op.box;
      if (![b.left, b.top, b.width, b.height].every(Number.isFinite) || b.width <= 0 || b.height <= 0) throw fail("상자 좌표가 올바르지 않습니다");
      const px = (n: number) => `${Math.round(n)}px`;
      return apply(slide, { t: "setStyle", eid: op.eid, set: { position: "absolute", left: px(b.left), top: px(b.top), width: px(b.width), height: px(b.height) } });
    }
    case "tableCols": {
      const { el } = need(slide, op.eid);
      const { cells, cols } = tableShape(el);
      if (op.widths.length !== cols) throw fail(`열이 ${cols}개인데 너비가 ${op.widths.length}개입니다`);
      if (op.widths.some((w) => !(w > 0))) throw fail("열 너비는 0보다 커야 합니다");
      const sum = op.widths.reduce((a, b) => a + b, 0);
      // 합 100이 되게 맞추고 마지막 열이 끝수를 받는다
      const pct = op.widths.map((w) => Math.round((w / sum) * 1000) / 10);
      pct[pct.length - 1] = Math.round((100 - pct.slice(0, -1).reduce((a, b) => a + b, 0)) * 10) / 10;
      return cells[0].flatMap((cell, i) => apply(slide, { t: "setStyle", eid: cell.eid, set: { width: `${pct[i]}%` } }));
    }
    case "tableRow": {
      const { el } = need(slide, op.eid);
      const { rows, cols } = tableShape(el);
      if (op.op === "remove") {
        if (rows.length <= 1) throw fail("표에는 행이 하나 이상 있어야 합니다");
        const row = rows[op.at];
        if (!row) throw fail(`${op.at + 1}번째 행이 없습니다`);
        const index = el.children.indexOf(row);
        el.children.splice(index, 1);
        return [{ t: "restore", parent: el.eid, index, html: serializeEl(row) }];
      }
      if (op.at < 0 || op.at > rows.length) throw fail("행 위치가 표 밖입니다");
      // 본문 행(머리 행이 아닌 쪽)을 본떠 같은 칸 스타일의 빈 행
      const tpl = rows[Math.min(Math.max(op.at, 1), rows.length - 1)] ?? rows[0];
      const cellsHtml = (tpl ? tpl.children : []).filter((c): c is SlideEl => c.kind === "el")
        .map((c) => { const { width: _w, ...st } = c.style; return serializeEl({ ...c, eid: "x", style: st, children: [] }).replace(' data-eid="x"', ""); });
      while (cellsHtml.length < cols) cellsHtml.push("<td></td>");
      const html = `<tr${tpl && Object.keys(tpl.style).length ? ` style="${Object.entries(tpl.style).map(([k, v]) => `${k}:${v}`).join(";")}"` : ""}>${cellsHtml.join("")}</tr>`;
      const row = fragment(slide, html, false);
      const index = op.at === rows.length ? el.children.indexOf(rows[rows.length - 1]) + 1 : el.children.indexOf(rows[op.at]);
      el.children.splice(index, 0, row);
      return [{ t: "remove", eid: row.eid }];
    }
    case "tableCol": {
      const { el } = need(slide, op.eid);
      const { rows, cells, cols } = tableShape(el);
      if (op.op === "remove") {
        if (cols <= 1) throw fail("표에는 열이 하나 이상 있어야 합니다");
        if (op.at < 0 || op.at >= cols) throw fail("열 위치가 표 밖입니다");
        const inv: SlideOp[] = [];
        // 남은 열 너비를 비율대로 늘린다(첫 행 칸에 너비가 있을 때)
        const widths = cells[0].map((c) => parseFloat(c.style.width ?? ""));
        rows.forEach((row, r) => {
          const cell = cells[r][op.at];
          if (!cell) return;
          const index = row.children.indexOf(cell);
          row.children.splice(index, 1);
          inv.unshift({ t: "restore", parent: row.eid, index, html: serializeEl(cell) });
        });
        if (widths.every((w) => w > 0)) {
          const rest = widths.filter((_, i) => i !== op.at);
          inv.unshift(...apply(slide, { t: "tableCols", eid: el.eid, widths: rest }));
        }
        return inv;
      }
      if (op.at < 0 || op.at > cols) throw fail("열 위치가 표 밖입니다");
      const hadWidths = cells[0].length > 0 && cells[0].every((c) => parseFloat(c.style.width ?? "") > 0);
      const removes: SlideOp[] = [];
      rows.forEach((row, r) => {
        const tpl = cells[r][Math.min(op.at, cells[r].length - 1)];
        const { width: _w, ...st } = tpl?.style ?? {};
        const html = serializeEl({ kind: "el", eid: "x", tag: tpl?.tag ?? "td", style: st, attrs: {}, children: [] }).replace(' data-eid="x"', "");
        const cell = fragment(slide, html, false);
        const index = op.at >= cells[r].length ? row.children.length : row.children.indexOf(cells[r][op.at]);
        row.children.splice(index, 0, cell);
        removes.push({ t: "remove", eid: cell.eid });
      });
      // 열을 넣으면 너비를 똑같이 다시 나눈다(명세 07절). 되돌릴 때는 너비를 먼저 되돌리고 칸을 지운다
      const widthsBack = hadWidths ? apply(slide, { t: "tableCols", eid: el.eid, widths: Array(cols + 1).fill(1) }) : [];
      return [...widthsBack, ...removes];
    }
    case "setNotes": {
      const old = slide.notes;
      slide.notes = op.text.trim();
      return [{ t: "setNotes", text: old }];
    }
  }
  throw fail(`알 수 없는 연산: ${(op as { t: string }).t}`);
}

/** 연산을 차례로 적용한다. 원본은 바꾸지 않는다. 역연산은 되돌릴 순서(마지막 연산의 역부터)로 돌려준다 */
export function applyOps(slide: Slide, ops: SlideOp[]): { slide: Slide; inverse: SlideOp[] } {
  const next = clone(slide);
  const inverse: SlideOp[] = [];
  for (const op of ops) inverse.unshift(...apply(next, op));
  return { slide: next, inverse };
}
