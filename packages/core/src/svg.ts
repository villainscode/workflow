import { parseDocument } from "htmlparser2";
import { Text, type ChildNode, type Document, type Element } from "domhandler";

/**
 * SVG 소독·정리(6.0 V4, spec/REQUIREMENT-6.0.md 4.4·11절). 런타임 무관(htmlparser2 xmlMode). Worker 자산·로컬 자산·MCP svg_put이 같이 쓴다.
 * 허용 목록 방식이다. 목록에 없는 요소·속성은 지우고 무엇을 지웠는지 removed로 돌려준다(진단).
 * - 요소: SVG 도형·글자·그라데이션·패턴·마커·clip/mask·필터(feImage 제외)·a·style·use. foreignObject 안에서는 XHTML 글자 요소만(draw.io 글자)
 * - 속성: 표시·기하 속성 + data-*·role·aria-*. on* 전부 지움. href는 #id, <image>의 래스터 data:, <a>의 http(s)만
 * - CSS(style 속성·<style>): url()은 #id만, @import·역슬래시·expression·behavior·-moz-binding·javascript:가 있으면 그 스타일을 버린다
 * - draw.io 편집 정보(루트 <svg>의 content 속성)는 남긴다. 지우면 draw.io로 다시 열어 고칠 수 없다
 * - DOCTYPE·ENTITY·처리 명령·주석은 지우고 CDATA는 글자로. 크기 5MB, 깊이 200, 요소 5만까지. 루트가 <svg>가 아니면 거부
 * V0 스파이크에서 실제 Chrome 공격 18건을 막고 정상 SVG 4개의 픽셀이 같았다(테스트 TC-VE-21).
 */

export class SvgError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

const SVG_NS = "http://www.w3.org/2000/svg";
const XLINK_NS = "http://www.w3.org/1999/xlink";
const XHTML_NS = "http://www.w3.org/1999/xhtml";

const SVG_TAGS = new Set(["svg", "g", "defs", "symbol", "use", "title", "desc", "switch", "a", "style",
  "path", "rect", "circle", "ellipse", "line", "polyline", "polygon", "text", "tspan", "textPath", "image",
  "clipPath", "mask", "pattern", "marker", "linearGradient", "radialGradient", "stop", "filter",
  "feBlend", "feColorMatrix", "feComponentTransfer", "feComposite", "feConvolveMatrix", "feDiffuseLighting", "feDisplacementMap",
  "feDistantLight", "feDropShadow", "feFlood", "feFuncA", "feFuncB", "feFuncG", "feFuncR", "feGaussianBlur", "feMerge", "feMergeNode",
  "feMorphology", "feOffset", "fePointLight", "feSpecularLighting", "feSpotLight", "feTile", "feTurbulence", "foreignObject"]);
// foreignObject 안(draw.io 글자)에서만
const XHTML_TAGS = new Set(["div", "span", "b", "i", "u", "s", "strong", "em", "br", "p", "font", "sub", "sup", "ul", "ol", "li", "code", "pre", "hr", "table", "tbody", "thead", "tr", "td", "th"]);
const ATTRS = new Set(["id", "class", "style", "transform", "viewBox", "preserveAspectRatio", "version", "width", "height", "x", "y", "x1", "y1", "x2", "y2",
  "cx", "cy", "r", "rx", "ry", "fx", "fy", "fr", "d", "points", "pathLength", "offset", "dx", "dy", "rotate", "textLength", "lengthAdjust",
  "fill", "fill-opacity", "fill-rule", "stroke", "stroke-width", "stroke-opacity", "stroke-dasharray", "stroke-dashoffset", "stroke-linecap", "stroke-linejoin", "stroke-miterlimit",
  "opacity", "color", "display", "visibility", "overflow", "clip-path", "clip-rule", "clipPathUnits", "mask", "maskUnits", "maskContentUnits", "filter", "filterUnits", "primitiveUnits",
  "marker-start", "marker-mid", "marker-end", "markerWidth", "markerHeight", "markerUnits", "refX", "refY", "orient",
  "patternUnits", "patternContentUnits", "patternTransform", "gradientUnits", "gradientTransform", "spreadMethod", "stop-color", "stop-opacity",
  "font-family", "font-size", "font-weight", "font-style", "font-variant", "text-anchor", "dominant-baseline", "alignment-baseline", "baseline-shift", "letter-spacing", "word-spacing", "text-decoration", "writing-mode", "white-space",
  "in", "in2", "result", "stdDeviation", "mode", "type", "values", "operator", "k1", "k2", "k3", "k4", "flood-color", "flood-opacity", "lighting-color", "radius", "scale", "xChannelSelector", "yChannelSelector", "baseFrequency", "numOctaves", "seed", "stitchTiles", "tableValues", "slope", "intercept", "amplitude", "exponent", "kernelMatrix", "order", "divisor", "bias", "targetX", "targetY", "edgeMode", "surfaceScale", "specularConstant", "specularExponent", "diffuseConstant", "azimuth", "elevation", "limitingConeAngle", "pointsAtX", "pointsAtY", "pointsAtZ", "z", "color-interpolation-filters",
  "requiredFeatures", "requiredExtensions", "systemLanguage", "pointer-events", "vector-effect", "shape-rendering", "text-rendering", "image-rendering", "mix-blend-mode", "isolation", "paint-order",
  "href", "xlink:href", "target", "xml:space", "xmlns", "xmlns:xlink", "content",
  // foreignObject 안 XHTML(font 포함)
  "face", "size", "align", "colspan", "rowspan"]);
// data-*와 접근성(role·aria-*)은 값이 그려지거나 실행되지 않는다
const isData = (n: string) => /^data-[a-z0-9_.-]+$/i.test(n) || /^aria-[a-z]+$/.test(n) || n === "role";
const PAINT_REF = /^(fill|stroke|filter|clip-path|mask|marker-(start|mid|end))$/;

export const MAX_SVG = 5_000_000;
/**
 * 소독한 SVG 자산 응답의 CSP(Worker 콘텐츠 도메인·로컬 서버 같게). 직접 열려도 스크립트가 돌지 않고(sandbox),
 * 소독을 빠져나간 CSS가 있어도 바깥 그림·글꼴·연결을 부르지 못한다(V6 보안 점검)
 */
export const SVG_ASSET_CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; sandbox";

// 공백·제어 문자(href 판정 전에 지운다: "java\tscript:" 같은 우회)
const WS_RANGES: [number, number][] = [[0, 32], [127, 160], [5760, 5760], [6158, 6158], [8192, 8233], [8287, 8287], [12288, 12288], [65279, 65279]];
const WS = new RegExp(`[${WS_RANGES.map(([a, b]) => `${String.fromCharCode(a)}-${String.fromCharCode(b)}`).join("")}]`, "g");
const clean = (v: string) => v.replace(WS, "");

/** href 값 허용: 같은 파일 안 참조(#id), 그림은 래스터 data:, 링크(a)는 http(s) */
function hrefOk(tag: string, v: string): boolean {
  const s = clean(v).toLowerCase();
  if (s.startsWith("#")) return true;
  if (tag === "image" && /^data:image\/(png|jpeg|gif|webp);base64,[a-z0-9+/=]*$/i.test(clean(v))) return true;
  return tag === "a" && /^https?:\/\//.test(s);
}
// CSS 함수 허용 목록: 주소를 받지 않는 것만. image-set·src·cross-fade·element·paint·local 같은 함수는 문자열 주소로 바깥을 부른다(V6 보안 점검)
const CSS_FUNCS = new Set(["url", "rgb", "rgba", "hsl", "hsla", "hwb", "lab", "lch", "oklab", "oklch", "color", "color-mix", "light-dark",
  "calc", "min", "max", "clamp", "var", "translate", "translatex", "translatey", "translate3d", "rotate", "scale", "scalex", "scaley",
  "matrix", "skew", "skewx", "skewy", "cubic-bezier", "steps", "linear-gradient", "radial-gradient",
  "blur", "brightness", "contrast", "drop-shadow", "grayscale", "hue-rotate", "invert", "opacity", "saturate", "sepia",
  "inset", "circle", "ellipse", "polygon", "rect",
  // 선택자 의사 클래스
  "not", "is", "where", "has", "nth-child", "nth-of-type", "nth-last-child", "nth-last-of-type", "lang", "dir"]);
/** CSS: 주석을 지우고, 바깥 주소 url()은 none으로. 위험한 구문·허용 밖 함수가 있으면 null(스타일을 버린다) */
function cssOk(raw: string): string | null {
  const css = raw.replace(/\/\*[\s\S]*?(\*\/|$)/g, "");
  if (/\\|@import|expression\s*\(|behavior\s*:|-moz-binding|javascript:/i.test(css)) return null;
  // 함수 토큰은 이름 바로 뒤에 (가 온다. @media( 같은 규칙 이름은 함수가 아니다
  for (const m of css.matchAll(/(?<![@\w-])(-?[a-z_][a-z0-9_-]*)\(/gi)) if (!CSS_FUNCS.has(m[1].toLowerCase())) return null;
  return css.replace(/url\(\s*(['"]?)\s*([^)'"]*)\1\s*\)/gi, (m, _q, u: string) => (u.trim().startsWith("#") ? m : "none"));
}

// 직렬화: XML 특수 문자만 바꾼다(dom-serializer는 한글까지 &#x..;로 바꿔 크기가 커진다)
const escT = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escA = (t: string) => escT(t).replace(/"/g, "&quot;");
// foreignObject 안(XHTML)의 빈 요소는 <div></div>로 쓴다. HTML 안에 인라인으로 넣으면 <div/>가 열린 태그로 읽힌다(br·hr만 닫는 꼴)
function render(n: ChildNode, inFO = false): string {
  if (n.type === "text") return escT((n as Text).data);
  const el = n as Element;
  const attrs = Object.entries(el.attribs).map(([k, v]) => ` ${k}="${escA(v)}"`).join("");
  const fo = inFO || el.name === "foreignObject";
  if (el.children.length) return `<${el.name}${attrs}>${el.children.map((c) => render(c, fo)).join("")}</${el.name}>`;
  return inFO && el.name !== "br" && el.name !== "hr" ? `<${el.name}${attrs}></${el.name}>` : `<${el.name}${attrs}/>`;
}

const isElement = (n: ChildNode): n is Element => n.type === "tag";
const textOf = (el: Element) => el.children.map((t) => (t.type === "text" ? (t as Text).data : "")).join("");

function parse(src: string): Document {
  if (typeof src !== "string" || !src.trim()) throw new SvgError(400, "SVG 내용이 비어 있습니다");
  if (src.length > MAX_SVG) throw new SvgError(413, "SVG는 5MB 이하만 올릴 수 있습니다");
  return parseDocument(src, { xmlMode: true });
}
function rootOf(doc: Document): Element {
  const roots = doc.children.filter(isElement);
  if (roots.length !== 1 || roots[0].name !== "svg") throw new SvgError(400, "SVG 파일이 아닙니다(맨 바깥 요소가 <svg> 하나여야 합니다)");
  return roots[0];
}

export interface SanitizedSvg {
  svg: string;
  /** 지운 요소(이름)·속성(@이름)·스타일(style-text). 같은 것은 한 번만 */
  removed: string[];
  /** draw.io 편집 정보(루트 content)가 있다 → draw.io로 다시 열어 고친다 */
  drawio: boolean;
}

export function sanitizeSvg(src: string): SanitizedSvg {
  const doc = parse(src);
  const removed = new Set<string>();
  let count = 0;
  const drop = (n: ChildNode) => { const p = n.parent!; p.children = p.children.filter((c) => c !== n); };
  const walk = (node: Document | Element, inFO: boolean, depth: number) => {
    if (depth > 200) throw new SvgError(400, "SVG가 너무 깊게 겹쳐 있습니다(200단계까지)");
    for (const ch of [...node.children]) {
      if (ch.type === "directive" || ch.type === "comment") { drop(ch); continue; }
      if (ch.type === "cdata") {
        // CDATA → 글자(직렬화에서 &lt;로 나간다)
        const t = ch.children.map((x) => (x as Text).data).join("");
        Object.assign(ch, { type: "text", data: t, children: [] });
        continue;
      }
      if (ch.type === "text") continue;
      if (!isElement(ch)) { drop(ch); continue; }
      if (++count > 50_000) throw new SvgError(400, "SVG 요소가 너무 많습니다(5만 개까지)");
      const name = ch.name;
      if (!(inFO ? XHTML_TAGS : SVG_TAGS).has(name)) { removed.add(name); drop(ch); continue; }
      for (const [k, v] of Object.entries(ch.attribs)) {
        const kl = k.toLowerCase();
        let keep = ATTRS.has(k) || isData(k);
        if (/^on/i.test(k)) keep = false;
        if (k === "xmlns") keep = v === (inFO ? XHTML_NS : SVG_NS);
        if (k === "xmlns:xlink") keep = v === XLINK_NS;
        if (k === "content") keep = name === "svg" && ch.parent?.type === "root";
        if (keep && (kl === "href" || kl === "xlink:href")) keep = hrefOk(name, v);
        if (keep && k === "style") { const c = cssOk(v); if (c === null) keep = false; else ch.attribs[k] = c; }
        if (keep && PAINT_REF.test(k) && /url\(/i.test(v) && !/^\s*url\(\s*['"]?#/i.test(v)) keep = false;
        if (!keep) { removed.add(`@${k}`); delete ch.attribs[k]; }
      }
      if (name === "style") {
        const css = cssOk(ch.children.map((t) => (t.type === "text" ? (t as Text).data : t.type === "cdata" ? t.children.map((x) => (x as Text).data).join("") : "")).join(""));
        if (css === null) removed.add("style-text");
        const t = new Text(css ?? "");
        t.parent = ch;
        ch.children = css ? [t] : [];
        continue;
      }
      walk(ch, inFO || name === "foreignObject", depth + 1);
    }
  };
  walk(doc, false, 0);
  const root = rootOf(doc);
  if (!root.attribs.xmlns) root.attribs.xmlns = SVG_NS;
  return { svg: render(root), removed: [...removed], drawio: !!root.attribs.content };
}

const num = (v: string | undefined) => {
  const m = /^\s*(\d+(?:\.\d+)?)\s*(px)?\s*$/.exec(v ?? "");
  return m ? Number(m[1]) : null;
};

/** 그릴 크기: width·height(px 또는 숫자), 없으면 viewBox, 그것도 없으면 300×150(브라우저 기본) */
export function svgSize(svg: string): { width: number; height: number } {
  const root = rootOf(parse(svg));
  const vb = (root.attribs.viewBox ?? "").trim().split(/[\s,]+/).map(Number);
  const vw = vb.length === 4 && vb[2] > 0 ? vb[2] : null, vh = vb.length === 4 && vb[3] > 0 ? vb[3] : null;
  let w = num(root.attribs.width) ?? null, h = num(root.attribs.height) ?? null;
  if (w === null && h === null) { w = vw; h = vh; }
  else if (w === null && h !== null && vw && vh) w = (h * vw) / vh;
  else if (h === null && w !== null && vw && vh) h = (w * vh) / vw;
  return { width: Math.max(1, Math.round(w ?? 300)), height: Math.max(1, Math.round(h ?? 150)) };
}

/**
 * <style> 글을 "선택자{선언}" 한 단계 규칙 목록으로 읽는다. 주석은 먼저 지운다(주석으로 접두어를 삼키는 우회, V6 보안 점검).
 * @규칙·중첩 규칙·짝이 맞지 않는 중괄호·따옴표 안 중괄호·규칙 밖 글자가 있으면 null(범위를 좁힐 수 없다)
 */
function flatRules(raw: string): { sel: string; body: string }[] | null {
  const css = raw.replace(/\/\*[\s\S]*?(\*\/|$)/g, "");
  if (css.includes("@") || /["'][^"']*[{}][^"']*["']/.test(css)) return null;
  const out: { sel: string; body: string }[] = [];
  let i = 0;
  while (i < css.length) {
    const open = css.indexOf("{", i);
    if (open < 0) return css.slice(i).trim() ? null : out;
    const close = css.indexOf("}", open + 1);
    const sel = css.slice(i, open);
    if (close < 0 || sel.includes("}") || css.slice(open + 1, close).includes("{") || !sel.trim()) return null;
    out.push({ sel, body: css.slice(open + 1, close) });
    i = close + 1;
  }
  return out;
}

/**
 * HTML 안에 인라인으로 넣을 SVG(D-60 예외 경로). SVG 안의 id와 <style>은 문서 전체에 걸리므로 범위를 좁힌다:
 * id는 접두어를 붙이고(참조 #id·url(#id)도 바꾼다), 루트 id를 접두어로 두고 <style> 선택자 앞에 #접두어를 붙인다.
 * 중첩 규칙(@media 등)이 있는 <style>은 범위를 좁힐 수 없어 지운다. 입력은 소독한 SVG여야 한다(여기서도 한 번 더 소독한다).
 */
export function scopeSvg(src: string, prefix: string): { svg: string; removed: string[] } {
  if (!/^[a-z][a-z0-9-]{0,40}$/.test(prefix)) throw new SvgError(400, "접두어는 영문 소문자·숫자·-만");
  const first = sanitizeSvg(src);
  const doc = parse(first.svg);
  const root = rootOf(doc);
  const removed = new Set(first.removed);
  const ids = new Map<string, string>();
  const all: Element[] = [];
  const collect = (el: Element) => { all.push(el); for (const c of el.children) if (isElement(c)) collect(c); };
  collect(root);
  // 이미 범위를 좁힌 SVG(복제)면 예전 접두어를 떼고 새로 붙인다
  const old = root.attribs.id;
  const bare = (id: string) => (old && id.startsWith(`${old}-`) ? id.slice(old.length + 1) : id);
  for (const el of all) if (el !== root && el.attribs.id) ids.set(el.attribs.id, `${prefix}-${bare(el.attribs.id)}`);
  if (root.attribs.id) ids.set(root.attribs.id, prefix);
  const swapRefs = (v: string) => v
    .replace(/url\(\s*(['"]?)#([^)'"]+)\1\s*\)/g, (m, q: string, id: string) => (ids.has(id) ? `url(${q}#${ids.get(id)}${q})` : m));
  for (const el of all) {
    for (const [k, v] of Object.entries(el.attribs)) {
      if (k === "id") { el.attribs.id = el === root ? prefix : ids.get(v) ?? v; continue; }
      if ((k === "href" || k === "xlink:href") && v.startsWith("#") && ids.has(v.slice(1))) { el.attribs[k] = `#${ids.get(v.slice(1))}`; continue; }
      if (k === "aria-labelledby" || k === "aria-describedby") { el.attribs[k] = v.split(/\s+/).map((x) => ids.get(x) ?? x).join(" "); continue; }
      if (k !== "content" && v.includes("url(")) el.attribs[k] = swapRefs(v);
    }
    if (el.name === "style") {
      const rules = flatRules(swapRefs(textOf(el)));
      if (!rules) { el.children = []; removed.add("style(@규칙·중첩)"); continue; }
      const scoped = rules.map(({ sel, body }) => {
        const sels = sel.split(",").map((s) => s.trim()).filter(Boolean)
          .map((s) => `#${prefix} ${s.replace(/#([A-Za-z_][\w-]*)/g, (m2, id: string) => (ids.has(id) ? `#${ids.get(id)}` : m2))}`);
        return `${sels.join(",")}{${body}}`;
      }).join("");
      const t = el.children.find((c) => c.type === "text") as Text | undefined;
      if (t) { t.data = scoped; el.children = [t]; }
    }
  }
  root.attribs.id = prefix;
  return { svg: render(root), removed: [...removed] };
}

/** svgedit(svgcanvas)이 그리는 내용 뿌리 id. 편집 중에는 <style> 규칙을 이 아래로만 걸리게 한다 */
export const SVGEDIT_SCOPE = "#svgcontent";

/**
 * 앱 화면(svgedit)에 올리기 전 SVG: 소독하고, <style> 규칙을 scope 아래로 좁힌다(V6 보안 점검).
 * svgcanvas는 SVG를 앱 문서에 그대로 붙이므로 <style>이 앱 화면 전체에 걸린다. 범위를 좁힐 수 없는 <style>은 비운다.
 * 꺼낼 때 tidySvgEdit가 scope를 다시 뗀다.
 */
export function svgForEditor(src: string, scope = SVGEDIT_SCOPE): { svg: string; removed: string[] } {
  const first = sanitizeSvg(src);
  const doc = parse(first.svg);
  const root = rootOf(doc);
  const removed = new Set(first.removed);
  const each = (el: Element) => {
    if (el.name === "style") {
      const rules = flatRules(textOf(el));
      if (!rules) { el.children = []; removed.add("style(@규칙·중첩)"); return; }
      const t = new Text(rules.map(({ sel, body }) => `${sel.split(",").map((x) => x.trim()).filter(Boolean).map((x) => `${scope} ${x}`).join(",")}{${body}}`).join(""));
      t.parent = el;
      el.children = [t];
      return;
    }
    for (const c of el.children) if (isElement(c)) each(c);
  };
  each(root);
  return { svg: render(root), removed: [...removed] };
}

const ROUND_ATTRS = new Set(["x", "y", "width", "height", "cx", "cy", "r", "rx", "ry", "x1", "y1", "x2", "y2"]);

/**
 * svgedit(svgcanvas)이 꺼낸 SVG 정리(V0 스파이크 2): 빠진 viewBox를 width·height로 다시 넣고, 「Layer 1」 묶음(g.layer와 그 title)을 풀고,
 * 끌기·크기 바꾸기가 남긴 소수 좌표를 둘째 자리로 반올림한다. 저장 전에 sanitizeSvg를 한 번 더 거친다.
 */
export function tidySvgEdit(src: string, original?: { viewBox?: string }): string {
  const doc = parse(src);
  const root = rootOf(doc);
  for (const k of Object.keys(root.attribs)) if (k === "xmlns:svg" || k === "xmlns:html" || k === "xmlns:se") delete root.attribs[k];
  if (!root.attribs.viewBox) {
    const w = num(root.attribs.width), h = num(root.attribs.height);
    if (original?.viewBox) root.attribs.viewBox = original.viewBox;
    else if (w && h) root.attribs.viewBox = `0 0 ${w} ${h}`;
  }
  // 레이어 묶음 풀기: <g class="layer"><title>Layer 1</title>…</g> → …
  root.children = root.children.flatMap((c) => {
    if (!isElement(c) || c.name !== "g" || c.attribs.class !== "layer") return [c];
    const inner = c.children.filter((x) => !(isElement(x) && x.name === "title"));
    for (const x of inner) x.parent = root;
    return inner;
  });
  const round = (el: Element) => {
    for (const [k, v] of Object.entries(el.attribs)) if (ROUND_ATTRS.has(k) && /^-?\d+\.\d{3,}$/.test(v)) el.attribs[k] = String(Math.round(Number(v) * 100) / 100);
    for (const c of el.children) if (isElement(c)) round(c);
  };
  round(root);
  // svgForEditor가 붙인 범위(#svgcontent)를 뗀다
  const unscope = (el: Element) => {
    if (el.name === "style") {
      for (const c of el.children) if (c.type === "text") (c as Text).data = (c as Text).data.split(`${SVGEDIT_SCOPE} `).join("");
      return;
    }
    for (const c of el.children) if (isElement(c)) unscope(c);
  };
  unscope(root);
  return render(root);
}
