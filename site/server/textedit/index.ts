import { extname } from "node:path";
import type { Adapter } from "./types.ts";
import { htmlAdapter } from "./html.ts";
import { docxAdapter, pptxAdapter } from "./ooxml.ts";
import { xlsxAdapter } from "./xlsx.ts";

export { EditError, type Change, type Segment } from "./types.ts";

const ADAPTERS: Record<string, { format: "html" | "docx" | "pptx" | "xlsx"; adapter: Adapter }> = {
  ".html": { format: "html", adapter: htmlAdapter },
  ".htm": { format: "html", adapter: htmlAdapter },
  ".docx": { format: "docx", adapter: docxAdapter },
  ".pptx": { format: "pptx", adapter: pptxAdapter },
  ".xlsx": { format: "xlsx", adapter: xlsxAdapter },
};

/** 파일 이름으로 텍스트 편집 어댑터를 고른다. 지원하지 않는 형식이면 null */
export const adapterFor = (file: string) => ADAPTERS[extname(file).toLowerCase()] ?? null;
