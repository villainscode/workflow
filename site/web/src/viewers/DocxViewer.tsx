import { useEffect, useRef, useState } from "react";
import { FileText, FileType2 } from "lucide-react";
import { IconButton } from "../components/IconButton.tsx";
import { EmptyState } from "../components/EmptyState.tsx";
import { PdfViewer } from "./PdfViewer.tsx";


/** 기본은 브라우저에서 바로 렌더링한다. 레이아웃이 깨지면 LibreOffice로 변환한 PDF로 볼 수 있다. */
export function DocxViewer({ url, pdfUrl }: { url: string; pdfUrl: string }) {
  const [mode, setMode] = useState<"html" | "pdf">("html");
  const box = useRef<HTMLDivElement>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (mode !== "html" || !box.current) return;
    let cancelled = false;
    (async () => {
      try {
        const [{ renderAsync }, blob] = await Promise.all([import("docx-preview"), fetch(url).then((r) => r.blob())]);
        if (cancelled || !box.current) return;
        box.current.innerHTML = "";
        await renderAsync(blob, box.current, undefined, { inWrapper: true, breakPages: true, ignoreLastRenderedPageBreak: true });
      } catch (e) {
        setError((e as Error).message);
      }
    })();
    return () => { cancelled = true; };
  }, [url, mode]);

  return (
    <div className="grid h-full grid-rows-[auto_minmax(0,1fr)]">
      <div className="flex gap-1 border-b border-line bg-surface px-4 py-1.5">
        <IconButton icon={FileText} label="문서로 보기" active={mode === "html"} onClick={() => setMode("html")} />
        <IconButton icon={FileType2} label="PDF로 보기" active={mode === "pdf"} onClick={() => setMode("pdf")} />
      </div>
      {mode === "pdf" ? (
        <PdfViewer url={pdfUrl} />
      ) : error ? (
        <EmptyState title="문서를 그릴 수 없습니다" body={`${error} — 위의 PDF 아이콘(PDF로 보기)을 눌러 보세요.`} />
      ) : (
        // docx-preview는 페이지 폭을 원본 그대로 쓰므로 좁은 화면에서는 이 영역 안에서만 축소해 보여준다
        <div className="docx-host h-full overflow-y-auto" ref={box} />
      )}
    </div>
  );
}
