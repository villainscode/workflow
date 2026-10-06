import { useEffect, useRef, useState } from "react";
import { EmptyState } from "../components/EmptyState.tsx";
import { PdfViewer } from "./PdfViewer.tsx";

const tab = (on: boolean) =>
  `rounded-md px-2.5 py-1 text-xs ${on ? "bg-accent-soft text-accent" : "text-muted hover:bg-sunken"}`;

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
        <button className={tab(mode === "html")} onClick={() => setMode("html")}>문서 보기</button>
        <button className={tab(mode === "pdf")} onClick={() => setMode("pdf")}>PDF로 보기</button>
      </div>
      {mode === "pdf" ? (
        <PdfViewer url={pdfUrl} />
      ) : error ? (
        <EmptyState title="문서를 그릴 수 없습니다" body={`${error} — "PDF로 보기"를 눌러 보세요.`} />
      ) : (
        // docx-preview는 페이지 폭을 원본 그대로 쓰므로 좁은 화면에서는 이 영역 안에서만 축소해 보여준다
        <div className="docx-host h-full overflow-y-auto" ref={box} />
      )}
    </div>
  );
}
