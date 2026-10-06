import type { VersionFile } from "../lib/api.ts";
import { EmptyState } from "../components/EmptyState.tsx";
import { HtmlViewer } from "./HtmlViewer.tsx";
import { ImageViewer } from "./ImageViewer.tsx";
import { CodeViewer } from "./CodeViewer.tsx";

const ext = (p: string) => p.slice(p.lastIndexOf(".") + 1).toLowerCase();
const IMAGE = new Set(["svg", "png", "jpg", "jpeg", "gif", "webp"]);
const CODE = new Set(["md", "yaml", "yml", "json", "ts", "tsx", "js", "sh", "py", "sql", "txt", "mmd", "csv", "drawio", "xml"]);

/** 파일 확장자로 뷰어를 고른다. 3단계 이후 PDF·Office 뷰어가 여기에 추가된다. */
export function Viewer({ file }: { file: VersionFile }) {
  const e = ext(file.path);
  if (e === "html" || e === "htm") return <HtmlViewer url={file.url} />;
  if (IMAGE.has(e)) return <ImageViewer url={file.url} />;
  if (CODE.has(e)) return <CodeViewer url={file.url} lang={e} />;
  return (
    <EmptyState
      title={`.${e} 뷰어는 아직 없습니다`}
      body="PDF · PPTX · DOCX · XLSX 뷰어는 3단계에서 추가됩니다. 상단의 다운로드로 파일을 받을 수 있습니다."
    />
  );
}
