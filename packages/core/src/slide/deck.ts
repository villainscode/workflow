import type { Diagnostic } from "./css.ts";
import { parseSlide, serializeSlide, type Slide } from "./parse.ts";

/**
 * 덱 = kind: deck 문서(5.0 4.3, 명세 03절). 파일은 deck.json(색인, 대표 파일)과 slides/<슬라이드 id>.html(한 장 = 파일 하나).
 * 업로드·저장 전에 checkDeck으로 색인과 모든 슬라이드를 검증한다(로컬 사이트·Worker·MCP 공통).
 */

export interface DeckIndex {
  v: 1;
  title: string;
  order: string[];
  sections?: Record<string, { description: string; start: string }>;
  /** 글꼴: Google Fonts 링크만 */
  faces?: Record<string, { family: string; href: string }>;
  /** 속성 패널 색 견본 */
  palette?: string[];
}

export const DECK_ENTRY = "deck.json";
export const slidePath = (id: string) => `slides/${id}.html`;
const FONT_RE = /^https:\/\/fonts\.googleapis\.com\/css2\?[^"<>\s]+$/;
const HEX_RE = /^#[0-9a-fA-F]{6}$/;
const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export interface DeckFileDiagnostic extends Diagnostic { file: string }

/** 색인 JSON 검사. 진단은 file: deck.json */
export function parseDeckIndex(text: string): { index?: DeckIndex; diagnostics: DeckFileDiagnostic[] } {
  const d = (message: string, code = "deck"): DeckFileDiagnostic => ({ file: DECK_ENTRY, line: 1, col: 1, code, message });
  let raw: unknown;
  try { raw = JSON.parse(text); } catch (e) { return { diagnostics: [d(`deck.json이 JSON이 아닙니다: ${(e as Error).message}`, "json")] }; }
  const x = raw as Partial<DeckIndex>;
  const diags: DeckFileDiagnostic[] = [];
  if (x.v !== 1) diags.push(d("v는 1이어야 합니다"));
  if (typeof x.title !== "string" || !x.title.trim()) diags.push(d("title이 필요합니다"));
  if (!Array.isArray(x.order) || x.order.length === 0) diags.push(d("order(슬라이드 id 목록)가 필요합니다"));
  else {
    const seen = new Set<string>();
    for (const id of x.order) {
      if (typeof id !== "string" || !ID_RE.test(id)) diags.push(d(`슬라이드 id는 영문 소문자·숫자·-만: ${String(id)}`));
      else if (seen.has(id)) diags.push(d(`order에 같은 id가 두 번: ${id}`));
      seen.add(id as string);
    }
  }
  for (const [k, f] of Object.entries(x.faces ?? {})) {
    if (!f || typeof f.family !== "string" || !FONT_RE.test(f.href ?? "")) diags.push(d(`faces.${k}: href는 https://fonts.googleapis.com/css2?… 만 씁니다`, "font"));
  }
  for (const c of x.palette ?? []) if (!HEX_RE.test(String(c))) diags.push(d(`palette 색은 #rrggbb: ${String(c)}`));
  for (const [k, s] of Object.entries(x.sections ?? {})) {
    if (!s || typeof s.description !== "string" || !x.order?.includes(s.start)) diags.push(d(`sections.${k}: start는 order에 있는 슬라이드 id여야 합니다`));
  }
  if (diags.length) return { diagnostics: diags };
  return { index: { v: 1, title: x.title!, order: x.order!, ...(x.sections ? { sections: x.sections } : {}), ...(x.faces ? { faces: x.faces } : {}), ...(x.palette ? { palette: x.palette } : {}) }, diagnostics: [] };
}

/**
 * 덱 파일 묶음 검사: deck.json + order의 슬라이드 파일이 모두 있고 각각 형식에 맞는가.
 * 슬라이드는 직렬화 형식으로 다시 쓴 내용(eid가 붙은)을 돌려준다. 저장은 이것으로 한다.
 */
export function checkDeck(files: Map<string, string>): { index?: DeckIndex; slides: Map<string, string>; diagnostics: DeckFileDiagnostic[] } {
  const slides = new Map<string, string>();
  const text = files.get(DECK_ENTRY);
  if (text === undefined) return { slides, diagnostics: [{ file: DECK_ENTRY, line: 0, col: 0, code: "deck", message: "deck.json이 없습니다" }] };
  const { index, diagnostics } = parseDeckIndex(text);
  if (!index) return { slides, diagnostics };
  for (const id of index.order) {
    const file = slidePath(id);
    const html = files.get(file);
    if (html === undefined) { diagnostics.push({ file, line: 0, col: 0, code: "missing", message: `슬라이드 파일이 없습니다: ${file}` }); continue; }
    const r = parseSlide(html);
    diagnostics.push(...r.diagnostics.map((x) => ({ ...x, file })));
    if (r.slide && r.slide.id !== id) diagnostics.push({ file, line: 1, col: 1, code: "id", message: `section id(${r.slide.id})가 파일 이름(${id})과 다릅니다` });
    if (r.slide && !r.diagnostics.length) slides.set(file, serializeSlide(r.slide));
  }
  return { index, slides, diagnostics };
}

/** 슬라이드 하나 읽기(저장된 파일은 이미 검증을 거쳤다). 실패하면 예외 */
export function loadSlide(html: string): Slide {
  const r = parseSlide(html);
  if (!r.slide || r.diagnostics.length) throw new Error(`슬라이드를 읽을 수 없습니다: ${r.diagnostics[0]?.message ?? ""}`);
  return r.slide;
}

/** 진단을 사람·에이전트가 읽을 한 줄씩으로 */
export const formatDiagnostics = (list: DeckFileDiagnostic[] | Diagnostic[]) =>
  list.map((x) => `${"file" in x ? `${x.file}:` : ""}${x.line}:${x.col} [${x.code}] ${x.message}${x.fix ? ` → ${x.fix}` : ""}`).join("\n");
