import { extname } from "./path.ts";

const MIME: Record<string, string> = {
  ".html": "text/html", ".htm": "text/html", ".md": "text/markdown", ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
  ".pdf": "application/pdf",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".csv": "text/csv", ".json": "application/json", ".yaml": "text/yaml", ".yml": "text/yaml",
  ".drawio": "application/vnd.jgraph.mxfile", ".mmd": "text/plain",
};
export const mimeOf = (p: string) => MIME[extname(p).toLowerCase()] ?? "text/plain";
