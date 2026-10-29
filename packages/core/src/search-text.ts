import { extname } from "./path.ts";

const TEXT_EXT = new Set([".md", ".markdown", ".html", ".htm", ".txt", ".yaml", ".yml", ".csv", ".json", ".mmd"]);

/** 검색용 본문. 텍스트 형식만 쓰고, HTML은 스크립트·스타일·SVG를 빼고 글자만 남긴다 */
export function searchText(path: string, raw: string): string {
  const ext = extname(path).toLowerCase();
  if (!TEXT_EXT.has(ext)) return "";
  if (ext !== ".html" && ext !== ".htm") return raw;
  return raw
    .replace(/<(script|style|svg)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

/** 검색 본문이 쓰이는 형식인가(텍스트를 읽을지 미리 판단) */
export const isSearchable = (path: string) => TEXT_EXT.has(extname(path).toLowerCase());
