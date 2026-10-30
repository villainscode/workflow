import { unzipSync } from "fflate";
import { extname } from "./path.ts";
import { checkDeck, DECK_ENTRY, formatDiagnostics, type DeckFileDiagnostic } from "./slide/deck.ts";

/** 업로드 규칙(로컬 사이트와 Cloudflare Worker 공용). 파일 경로 정리, zip 풀기, 대표 파일 고르기, 문서 형식 */

export interface IncomingFile { path: string; data: Uint8Array }

export const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const KIND: Record<string, string> = {
  html: "html", htm: "html", svg: "image", png: "image", jpg: "image", jpeg: "image", gif: "image", webp: "image",
  pdf: "pdf", pptx: "pptx", docx: "docx", xlsx: "xlsx", csv: "xlsx", md: "markdown", drawio: "drawio",
};
/** 대표 파일 확장자로 문서 형식(meta.yaml kind). 맨 위 deck.json은 슬라이드 덱(5.0 M4) */
export const kindOf = (entry: string) => (entry === DECK_ENTRY ? "deck" : KIND[extname(entry).slice(1).toLowerCase()] ?? "code");

/** 업로드 경로를 정리한다("a/./b" → "a/b"). 상위 폴더로 나가거나 숨김 파일이면 null */
export function safeRelPath(p: string): string | null {
  const parts: string[] = [];
  for (const seg of p.replace(/\\/g, "/").split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === ".." || seg.startsWith(".")) return null;
    parts.push(seg);
  }
  return parts.length ? parts.join("/") : null;
}

/** zip 하나만 올리면 풀어서 쓴다. 폴더째 올리면 공통 최상위 폴더 이름은 뗀다 */
export function normalizeFiles(files: IncomingFile[]): IncomingFile[] {
  let list = files;
  if (list.length === 1 && extname(list[0].path).toLowerCase() === ".zip") {
    const entries = unzipSync(list[0].data);
    list = Object.entries(entries).filter(([p]) => !p.endsWith("/") && !p.startsWith("__MACOSX/"))
      .map(([path, data]) => ({ path, data }));
  }
  const cleaned = list.flatMap((f) => {
    const p = safeRelPath(f.path);
    return p ? [{ path: p, data: f.data }] : [];
  });
  const tops = new Set(cleaned.map((f) => (f.path.includes("/") ? f.path.split("/")[0] : "")));
  if (tops.size === 1 && !tops.has("")) {
    const top = [...tops][0] + "/";
    return cleaned.map((f) => ({ ...f, path: f.path.slice(top.length) }));
  }
  return cleaned;
}

/** 대표 파일: 지정한 것, 없으면 맨 위 deck.json → index.html → 첫 HTML → 가장 얕은 첫 파일. 지정한 파일이 목록에 없으면 null */
export function pickEntry(paths: string[], wanted?: string): string | null {
  if (wanted) return paths.includes(wanted) ? wanted : null;
  if (paths.includes(DECK_ENTRY)) return DECK_ENTRY;
  const byDepth = [...paths].sort((a, b) => a.split("/").length - b.split("/").length);
  return byDepth.find((p) => /(^|\/)index\.html?$/i.test(p)) ?? byDepth.find((p) => /\.html?$/i.test(p)) ?? byDepth[0] ?? null;
}

/** 버전 작성 시각 yyyy-MM-dd HH:mm:ss. timeZone을 주면 그 시간대(Worker는 UTC라 Asia/Seoul을 준다), 없으면 실행 환경 시간대 */
export function nowStamp(d = new Date(), timeZone?: string): string {
  if (timeZone) {
    return new Intl.DateTimeFormat("sv-SE", {
      timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
    }).format(d);
  }
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * 덱 업로드 검사(5.0 M4): 대표 파일이 deck.json이면 색인과 모든 슬라이드를 검증하고, 슬라이드는 eid가 붙은 직렬화 형식으로 바꿔 저장한다.
 * 덱이 아니면 그대로. 문제가 있으면 error에 줄 단위 진단(파일:줄:칸 [코드] 메시지 → fix)
 */
export function prepareDeck(files: IncomingFile[], entry: string): { files: IncomingFile[]; error?: string; diagnostics?: DeckFileDiagnostic[] } {
  if (entry !== DECK_ENTRY) return { files };
  const dec = new TextDecoder();
  const r = checkDeck(new Map(files.filter((f) => f.path === DECK_ENTRY || /^slides\/[^/]+\.html$/.test(f.path)).map((f) => [f.path, dec.decode(f.data)])));
  if (r.diagnostics.length) return { files, error: `덱 형식 오류 ${r.diagnostics.length}건\n${formatDiagnostics(r.diagnostics)}`, diagnostics: r.diagnostics };
  const enc = new TextEncoder();
  return { files: files.map((f) => (r.slides.has(f.path) ? { path: f.path, data: enc.encode(r.slides.get(f.path)!) } : f)) };
}
