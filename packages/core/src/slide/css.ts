/**
 * 슬라이드 형식의 허용 CSS(명세 docs/slide-editor-spec.html 03절). 값 문법을 직접 검사한다(허용 범위가 좁아 css-tree 없이 충분하다).
 * 단위는 px·%·fr만. 금지: margin(→ gap·padding), z-index(그리는 순서 = 문서 순서), url(), 그라데이션·그림자 같은 장식.
 */

export type Style = Record<string, string>;
export interface Diagnostic { line: number; col: number; code: string; message: string; fix?: string }

const LEN = String.raw`(?:-?\d+(?:\.\d+)?(?:px|%)|0)`;
const LEN_FR = String.raw`(?:-?\d+(?:\.\d+)?(?:px|%|fr)|0|auto)`;
const COLOR = String.raw`(?:#[0-9a-fA-F]{3,4}|#[0-9a-fA-F]{6}|#[0-9a-fA-F]{8}|rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(?:,\s*(?:0|1|0?\.\d+)\s*)?\)|transparent|currentColor)`;
const re = (s: string) => new RegExp(`^${s}$`, "i");
const list = (item: string, max: number) => re(`${item}(?:\\s+${item}){0,${max - 1}}`);
const kw = (...words: string[]) => re(`(?:${words.join("|")})`);

const LENGTH = re(LEN);
const SIZE = re(`(?:${LEN}|auto)`);
const BOX4 = list(LEN, 4);
const BORDER = re(`(?:(?:${LEN}|solid|dashed|dotted|none|${COLOR})(?:\\s+|$)){1,3}`);

const RULES: Record<string, RegExp> = {
  position: kw("absolute", "relative"),
  left: LENGTH, top: LENGTH, right: LENGTH, bottom: LENGTH, width: SIZE, height: SIZE,
  "min-width": LENGTH, "min-height": LENGTH, "max-width": LENGTH, "max-height": LENGTH,
  display: kw("flex", "grid", "block", "none"),
  "flex-direction": kw("row", "column", "row-reverse", "column-reverse"),
  "flex-wrap": kw("wrap", "nowrap"),
  "flex-grow": re(String.raw`\d+(?:\.\d+)?`), "flex-shrink": re(String.raw`\d+(?:\.\d+)?`),
  "flex-basis": SIZE,
  flex: re(String.raw`(?:none|auto|\d+(?:\.\d+)?(?:\s+\d+(?:\.\d+)?)?(?:\s+${LEN_FR})?)`),
  "grid-template-columns": re(`(?:${LEN_FR}|repeat\\(\\s*\\d+\\s*,\\s*${LEN_FR}\\s*\\))(?:\\s+(?:${LEN_FR}|repeat\\(\\s*\\d+\\s*,\\s*${LEN_FR}\\s*\\)))*`),
  gap: list(LEN, 2), "row-gap": LENGTH, "column-gap": LENGTH,
  "align-items": kw("flex-start", "flex-end", "center", "stretch", "baseline", "start", "end"),
  "align-content": kw("flex-start", "flex-end", "center", "stretch", "space-between", "space-around", "start", "end"),
  "align-self": kw("auto", "flex-start", "flex-end", "center", "stretch", "baseline", "start", "end"),
  "justify-content": kw("flex-start", "flex-end", "center", "space-between", "space-around", "space-evenly", "start", "end"),
  "justify-items": kw("start", "end", "center", "stretch"),
  "justify-self": kw("auto", "start", "end", "center", "stretch"),
  padding: BOX4, "padding-top": LENGTH, "padding-right": LENGTH, "padding-bottom": LENGTH, "padding-left": LENGTH,
  "font-family": re(String.raw`(?:(?:"[^"<>;]+"|'[^'<>;]+'|[A-Za-z][\w -]*)(?:\s*,\s*)?)+`),
  "font-size": LENGTH,
  "font-weight": re("(?:[1-9]00|normal|bold)"),
  "font-style": kw("normal", "italic"),
  "line-height": re(String.raw`(?:\d+(?:\.\d+)?|${LEN}|normal)`),
  "letter-spacing": re(`(?:${LEN}|normal)`),
  color: re(COLOR),
  "text-align": kw("left", "center", "right", "justify", "start", "end"),
  "text-decoration": kw("none", "underline", "line-through"),
  background: re(COLOR), "background-color": re(COLOR),
  border: BORDER, "border-top": BORDER, "border-right": BORDER, "border-bottom": BORDER, "border-left": BORDER,
  "border-color": re(COLOR), "border-width": BOX4, "border-style": kw("solid", "dashed", "dotted", "none"),
  "border-radius": BOX4,
  "object-fit": kw("cover", "contain", "fill", "none", "scale-down"),
  "object-position": re(`(?:${LEN}|left|center|right|top|bottom)(?:\\s+(?:${LEN}|left|center|right|top|bottom))?`),
};
export const ALLOWED_PROPS = Object.keys(RULES);

const FIX: [RegExp, string][] = [
  [/^margin/, "margin은 쓰지 않습니다. 부모의 gap이나 padding으로 간격을 주세요"],
  [/^z-index$/, "z-index는 쓰지 않습니다. 그리는 순서는 문서 순서입니다(move 연산으로 앞뒤를 바꾸세요)"],
  [/^(box-shadow|text-shadow|filter|backdrop-filter|opacity|transform|transition|animation)/, "장식·효과 속성은 형식에서 허용하지 않습니다"],
  [/^background-image$/, "배경 그림은 쓰지 않습니다. 단색 background나 img 요소를 쓰세요"],
];

/** 속성 하나 검사. 문제가 없으면 null */
export function validateStyle(prop: string, value: string): Omit<Diagnostic, "line" | "col"> | null {
  const p = prop.trim().toLowerCase(), v = value.trim();
  const rule = RULES[p];
  if (!rule) {
    const fix = FIX.find(([r]) => r.test(p))?.[1];
    return { code: "css-prop", message: `허용하지 않는 CSS 속성: ${p}`, ...(fix ? { fix } : {}) };
  }
  if (/url\s*\(|expression\s*\(|gradient\s*\(|!important/i.test(v)) {
    return { code: "css-value", message: `${p}: 외부 주소·그라데이션·!important는 쓸 수 없습니다`, fix: "단색 값을 쓰세요" };
  }
  if (!rule.test(v)) {
    const unit = /\d(?:em|rem|vh|vw|pt|cm|mm|in)\b/i.test(v) ? "단위는 px·%만 씁니다(grid는 fr도)" : undefined;
    return { code: "css-value", message: `${p}의 값이 형식에 맞지 않습니다: ${v}`, ...(unit ? { fix: unit } : {}) };
  }
  return null;
}

/** style 속성 문자열 → 객체(형식 검사는 따로) */
export function parseStyle(text: string): [string, string][] {
  return text.split(";").map((d) => d.trim()).filter(Boolean).flatMap((d) => {
    const i = d.indexOf(":");
    return i < 0 ? [[d.toLowerCase(), ""] as [string, string]] : [[d.slice(0, i).trim().toLowerCase(), d.slice(i + 1).trim()] as [string, string]];
  });
}

export const styleText = (s: Style) => Object.entries(s).map(([k, v]) => `${k}:${v}`).join(";");
