import { parseStyle, validateStyle } from "../slide/css.ts";

/**
 * HTML 문서 속성 편집의 허용 스타일(6.0 D-55). 덱 검사기(slide/css.ts)를 기준으로 문서용으로 넓히고 좁힌다.
 * - 넓힘: margin(px·%·em·rem·auto), 글자 크기·줄 간격·자간의 em·rem, 색의 var(--토큰)
 * - 좁힘: position·left·top·right·bottom은 setStyle로 못 바꾼다(자유 배치 toPinned만, V3)
 * - 글꼴: 문서가 불러오거나 쓰는 글꼴 + 일반 계열만(그 밖은 화면에서 대체 글꼴로 보인다)
 * 문서의 글꼴·색 토큰 목록(docFonts·docColors)도 여기서 뽑는다. 속성 패널 견본과 검사가 같은 목록을 쓴다.
 */

export interface StyleProblem { code: string; message: string; fix?: string }

export const GENERIC_FONTS = ["sans-serif", "serif", "monospace", "system-ui"];
export const PIN_ONLY = new Set(["position", "left", "top", "right", "bottom"]);
const COLOR_PROPS = new Set(["color", "background", "background-color", "border-color"]);
const TOKEN = /^var\(\s*--[\w-]+\s*\)$/;
const LEN = String.raw`(?:-?\d+(?:\.\d+)?(?:px|%|em|rem)|0)`;
const MARGIN1 = new RegExp(`^(?:${LEN}|auto)$`, "i");
const MARGIN = new RegExp(`^(?:${LEN}|auto)(?:\\s+(?:${LEN}|auto)){0,3}$`, "i");
const EM = /^\d+(?:\.\d+)?(?:em|rem)$/i;
const MARGINS = new Set(["margin-top", "margin-right", "margin-bottom", "margin-left"]);

/** 글꼴 스택 → 이름 목록(따옴표 뗌) */
export const fontNames = (stack: string) => stack.split(",").map((s) => s.trim().replace(/^["']|["']$/g, "").trim()).filter(Boolean);

/** 속성 하나 검사. fonts를 주면 font-family의 이름이 그 목록·일반 계열 안에 있는지도 본다 */
export function checkDocStyle(prop: string, value: string, fonts?: string[]): StyleProblem | null {
  const p = String(prop).trim().toLowerCase(), v = String(value).trim();
  if (PIN_ONLY.has(p)) return { code: "css-prop", message: `${p}는 속성 편집으로 바꾸지 않습니다`, fix: "요소를 끌어 놓으면 자유 배치(toPinned)로 위치가 정해집니다" };
  if (/!important/i.test(v)) return { code: "css-value", message: `${p}: !important는 쓸 수 없습니다` };
  if (/\d(?:vw|vh|vmin|vmax)\b/i.test(v)) return { code: "css-value", message: `${p}: vw·vh 단위는 쓸 수 없습니다`, fix: "px·%·em·rem을 쓰세요" };
  if (COLOR_PROPS.has(p) && TOKEN.test(v)) return null;
  if (p === "margin") return MARGIN.test(v) ? null : { code: "css-value", message: `margin의 값이 형식에 맞지 않습니다: ${v}`, fix: "px·%·em·rem·auto를 1~4개" };
  if (MARGINS.has(p)) return MARGIN1.test(v) ? null : { code: "css-value", message: `${p}의 값이 형식에 맞지 않습니다: ${v}`, fix: "px·%·em·rem·auto 하나" };
  if ((p === "font-size" || p === "line-height" || p === "letter-spacing") && EM.test(v)) return null;
  const d = validateStyle(p, v);
  if (d) return { code: d.code, message: d.message, ...(d.fix && !/^margin/.test(p) ? { fix: d.fix } : {}) };
  if (p === "font-family" && fonts) {
    const ok = new Set([...fonts, ...GENERIC_FONTS].map((f) => f.toLowerCase()));
    const bad = fontNames(v).filter((f) => !ok.has(f.toLowerCase()));
    if (bad.length) return { code: "font", message: `문서가 불러오지 않은 글꼴입니다: ${bad.join(", ")}`, fix: `쓸 수 있는 글꼴: ${[...fonts, ...GENERIC_FONTS].join(", ")}` };
  }
  return null;
}

/** 검사에 걸린 것을 사람·에이전트가 읽을 한 줄로 */
export const problemText = (x: StyleProblem) => `${x.message}${x.fix ? ` (${x.fix})` : ""}`;

/**
 * style 병합: 기존 선언 순서를 지키고, 같은 속성은 그 자리에서 값만 바꾸고, unset은 지우고, 새 속성은 끝에 붙인다.
 * 값 안의 큰따옴표는 작은따옴표로 바꾼다(속성 값에 &quot;가 생기지 않게).
 */
export function mergeStyle(old: string, set: Record<string, string> = {}, unset: string[] = []): string {
  const next = new Map(Object.entries(set).map(([k, v]) => [k.trim().toLowerCase(), v.trim().replace(/"/g, "'")]));
  const drop = new Set(unset.map((k) => k.trim().toLowerCase()));
  const out: [string, string][] = [];
  for (const [k, v] of parseStyle(old)) {
    if (drop.has(k)) continue;
    if (next.has(k)) { out.push([k, next.get(k)!]); next.delete(k); } else out.push([k, v]);
  }
  for (const [k, v] of next) if (!drop.has(k)) out.push([k, v]);
  return out.map(([k, v]) => `${k}:${v}`).join(";");
}

const FONT_NAME = /^[\p{L}\p{N} \-]{1,64}$/u;
const styleBlocks = (html: string) => [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]);

/** 문서가 불러오거나 쓰는 글꼴(일반 계열 제외, 처음 나온 순서): Google Fonts 링크, @font-face, <style>의 font-family·글꼴 변수 */
export function docFonts(html: string): string[] {
  const out: string[] = [];
  const add = (name: string) => {
    const n = name.trim();
    if (!n || !FONT_NAME.test(n) || GENERIC_FONTS.includes(n.toLowerCase()) || /^(inherit|initial|unset|revert)$/i.test(n)) return;
    if (!out.some((x) => x.toLowerCase() === n.toLowerCase())) out.push(n);
  };
  for (const m of html.matchAll(/<link\b[^>]*href\s*=\s*["']([^"']*fonts\.googleapis\.com[^"']*)["']/gi)) {
    const q = m[1].replace(/&amp;/g, "&").split("?")[1] ?? "";
    for (const part of q.split("&")) if (part.startsWith("family=")) add(decodeURIComponent(part.slice(7).replace(/\+/g, " ")).split(":")[0]);
  }
  for (const css of styleBlocks(html)) {
    for (const m of css.matchAll(/@import\s+url\(\s*["']?([^"')]*fonts\.googleapis\.com[^"')]*)/gi)) {
      for (const part of (m[1].split("?")[1] ?? "").split("&")) if (part.startsWith("family=")) add(decodeURIComponent(part.slice(7).replace(/\+/g, " ")).split(":")[0]);
    }
    for (const m of css.matchAll(/(?:^|[;{\s])(?:font-family|--[\w-]*font[\w-]*)\s*:\s*([^;}]+)/gi)) {
      if (/var\(/.test(m[1])) continue;
      fontNames(m[1]).forEach(add);
    }
  }
  return out;
}

const COLOR_VALUE = /^(?:#[0-9a-f]{3,8}|rgba?\([^)]*\)|hsla?\([^)]*\))$/i;

/** 문서 :root의 색 변수(처음 정의한 값)와 다크 모드 여부 */
export function docColors(html: string): { tokens: { name: string; value: string }[]; dark: boolean } {
  const tokens: { name: string; value: string }[] = [];
  let dark = false;
  for (const css of styleBlocks(html)) {
    if (/prefers-color-scheme\s*:\s*dark|\[data-theme=["']?dark/i.test(css)) dark = true;
    for (const m of css.matchAll(/:root\b[^{]*\{([^}]*)\}/g)) {
      for (const [k, v] of parseStyle(m[1])) {
        if (k.startsWith("--") && COLOR_VALUE.test(v) && !tokens.some((t) => t.name === k)) tokens.push({ name: k, value: v });
      }
    }
  }
  return { tokens, dark };
}
