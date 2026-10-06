import { useEffect, useRef, useState, type ReactNode } from "react";
import { fileSrc, useText, type VersionFile } from "../lib/api.ts";
import { EmptyState } from "../components/EmptyState.tsx";
import { MarkdownPreview } from "./MarkdownPreview.tsx";
import { Viewer } from "./Viewer.tsx";
import type { DocContext } from "./MarkdownViewer.tsx";

/** 프레젠테이션 기준 너비. 문서를 이 너비로 그린 뒤 화면 너비에 맞춰 같은 비율로 키운다(또는 줄인다). */
const BASE_WIDTH = 1280;

/**
 * 내용을 BASE_WIDTH 폭으로 그리고 부모 크기에 맞춰 통째로 확대한다.
 * 큰 화면에서 레이아웃이 넓어지기만 하고 글자는 그대로인 대신, 글자·여백·그림이 함께 커진다.
 */
function ScaledBox({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: BASE_WIDTH, h: 800 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setSize({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const scale = size.w / BASE_WIDTH;
  return (
    <div ref={ref} className="h-full w-full overflow-hidden">
      <div style={{ width: BASE_WIDTH, height: size.h / scale, transform: `scale(${scale})`, transformOrigin: "top left" }}>
        {children}
      </div>
    </div>
  );
}

function MarkdownSlide({ file }: { file: VersionFile }) {
  const { data } = useText(fileSrc(file));
  if (data === undefined) return <EmptyState title="불러오는 중…" />;
  return (
    <div className="h-full overflow-y-auto bg-surface px-16 py-12">
      <MarkdownPreview source={data} baseUrl={file.url.slice(0, file.url.lastIndexOf("/") + 1)} />
    </div>
  );
}

const ext = (p: string) => p.slice(p.lastIndexOf(".") + 1).toLowerCase();

/**
 * 전체 화면에서 보여줄 내용.
 * - HTML·Markdown: 기준 너비로 그린 뒤 화면 너비에 비례해 확대 (Markdown은 편집기 없이 미리보기만)
 * - 이미지·PDF·표 등: 원래 화면을 채우는 뷰어라 그대로 넓힌다
 */
export function PresentationContent({ file, ctx }: { file: VersionFile; ctx: DocContext }) {
  const e = ext(file.path);
  if (e === "html" || e === "htm") {
    return (
      <ScaledBox>
        <iframe src={fileSrc(file)} title="문서" className="block h-full w-full border-0 bg-surface"
          sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox allow-downloads" />
      </ScaledBox>
    );
  }
  if (e === "md" || e === "markdown") return <ScaledBox><MarkdownSlide file={file} /></ScaledBox>;
  return <Viewer file={file} ctx={{ ...ctx, isCurrent: false }} />;
}
