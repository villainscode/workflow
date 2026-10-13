import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef } from "react";
import { useDark } from "../lib/useDark.ts";
import { parseMarkdown } from "./markdown-editor/parseMarkdown.ts";
import "./markdown-editor/preview.css";

export interface MarkdownPreviewHandle {
  /** 편집 위치의 제목으로 미리보기를 옮긴다(MarkFlow의 제목 기준 스크롤 맞춤) */
  scrollToHeading: (text: string) => void;
}

let mermaidSeq = 0;

/** mermaid 코드 블록을 다이어그램으로 바꾼다. 실패하면 블록 아래에 오류를 보여 준다 */
async function renderMermaid(root: HTMLElement, dark: boolean, cancelled: () => boolean) {
  const blocks = [...root.querySelectorAll<HTMLElement>("pre > code.language-mermaid")];
  if (!blocks.length) return;
  const { default: mermaid } = await import("mermaid");
  mermaid.initialize({ startOnLoad: false, theme: dark ? "dark" : "default", securityLevel: "strict" });
  for (const code of blocks) {
    if (cancelled()) return;
    const pre = code.parentElement!;
    const box = document.createElement("div");
    box.className = "mf-mermaid";
    try {
      const { svg } = await mermaid.render(`mf-mermaid-${++mermaidSeq}`, code.textContent ?? "");
      if (cancelled()) return;
      box.innerHTML = svg;
      pre.replaceWith(box);
    } catch (e) {
      if (cancelled()) return;
      box.className = "mf-mermaid-error";
      box.textContent = `Mermaid 오류: ${(e as Error).message}`;
      pre.after(box);
    }
  }
}

/**
 * Markdown 미리보기(MarkFlow 엔진). 상대 경로 이미지·링크는 문서 버전 폴더(baseUrl) 기준으로 푼다.
 * 편집기·보기 화면·프레젠테이션이 함께 쓴다.
 */
export const MarkdownPreview = forwardRef<MarkdownPreviewHandle, { source: string; baseUrl: string }>(
  function MarkdownPreview({ source, baseUrl }, ref) {
    const dark = useDark();
    const box = useRef<HTMLDivElement>(null);
    const html = useMemo(() => parseMarkdown(source, baseUrl), [source, baseUrl]);

    useEffect(() => {
      const el = box.current;
      if (!el) return;
      let off = false;
      void renderMermaid(el, dark, () => off);
      return () => { off = true; };
    }, [html, dark]);

    const scrollToHeading = useCallback((text: string) => {
      const target = text.trim().toLowerCase();
      for (const h of box.current?.querySelectorAll("h1, h2, h3, h4, h5, h6") ?? []) {
        if ((h.textContent ?? "").trim().toLowerCase() === target) {
          h.scrollIntoView({ block: "start", behavior: "smooth" });
          return;
        }
      }
    }, []);
    useImperativeHandle(ref, () => ({ scrollToHeading }), [scrollToHeading]);

    if (!html) return <p className="text-sm text-muted italic">미리 볼 내용이 없습니다.</p>;
    // 테마가 바뀌면 다시 그려 mermaid 블록을 원래 코드에서 새 색으로 만든다
    return <article key={dark ? "dark" : "light"} ref={box} className="mf-preview" dangerouslySetInnerHTML={{ __html: html }} />;
  },
);
