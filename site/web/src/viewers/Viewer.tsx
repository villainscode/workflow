import { convertSrc, fileSrc, type VersionFile } from "../lib/api.ts";
import { EmptyState } from "../components/EmptyState.tsx";
import { HtmlViewer } from "./HtmlViewer.tsx";
import { ImageViewer } from "./ImageViewer.tsx";
import { CodeViewer } from "./CodeViewer.tsx";
import { PdfViewer } from "./PdfViewer.tsx";
import { DocxViewer } from "./DocxViewer.tsx";
import { SheetViewer } from "./SheetViewer.tsx";
import { MarkdownViewer, type DocContext } from "./MarkdownViewer.tsx";

const ext = (p: string) => p.slice(p.lastIndexOf(".") + 1).toLowerCase();
const IMAGE = new Set(["svg", "png", "jpg", "jpeg", "gif", "webp"]);
const SLIDES = new Set(["pptx", "ppt", "odp"]);
const SHEET = new Set(["xlsx", "xls", "csv", "ods"]);
const CODE = new Set(["yaml", "yml", "json", "ts", "tsx", "js", "sh", "py", "sql", "txt", "mmd", "xml"]);

/** 대표 파일의 확장자로 뷰어를 고른다. */
export function Viewer({ file, ctx }: { file: VersionFile; ctx: DocContext }) {
  const e = ext(file.path);
  const src = fileSrc(file);
  if (e === "md" || e === "markdown") return <MarkdownViewer file={file} src={src} ctx={ctx} />;
  if (e === "html" || e === "htm") return <HtmlViewer url={src} />;
  if (IMAGE.has(e)) return <ImageViewer url={src} />;
  if (e === "drawio") return <ImageViewer url={convertSrc(file, "svg")} />;
  if (e === "pdf") return <PdfViewer url={src} />;
  if (SLIDES.has(e)) return <PdfViewer url={convertSrc(file, "pdf")} note="LibreOffice로 PDF로 변환해 보여줍니다. 처음 열 때는 변환에 몇 초 걸립니다." />;
  if (e === "docx" || e === "doc" || e === "odt") return <DocxViewer url={src} pdfUrl={convertSrc(file, "pdf")} />;
  if (SHEET.has(e)) return <SheetViewer url={src} csv={e === "csv"} />;
  if (CODE.has(e)) return <CodeViewer url={src} lang={e} />;
  return <EmptyState title={`.${e} 파일은 미리 볼 수 없습니다`} body="상단의 다운로드로 파일을 받을 수 있습니다." />;
}
