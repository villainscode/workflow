import { useCallback, useEffect, useRef, useState } from "react";
import { editViewUrl, injectStyle } from "../lib/textedit.ts";
import { copyText, formatSeg, refUrl } from "../lib/seg.ts";
import { RefBar } from "./RefBar.tsx";

/**
 * HTML·SVG 참조 보기(3.2, D-28). 텍스트 편집과 같은 사본(조각마다 data-seg, 스크립트 없음)을 같은 출처로 읽기 전용으로 연다.
 * - highlight: 주소 ?seg=의 조각을 강조하고 첫 조각으로 스크롤한다
 * - copy: 글자를 누르면 그 조각 참조 주소를, Alt+클릭이면 감싸는 블록 전체 범위를 클립보드로 복사한다
 * 링크·버튼·폼은 동작하지 않게 한다(눌러도 이동하지 않음).
 */

const REF_CSS = `
[data-ref-hit]{background:rgba(224,186,79,.38)!important;box-shadow:0 0 0 2px rgba(224,186,79,.38);border-radius:2px}
tspan[data-ref-hit]{fill:#946C00;font-weight:700}
html[data-ref-copy] [data-seg]{cursor:copy;border-radius:2px;outline:1px dashed transparent;outline-offset:1px}
html[data-ref-copy] span[data-seg]:hover{outline-color:rgba(31,95,191,.7);background:rgba(31,95,191,.08)}
html[data-ref-copy] tspan[data-seg]:hover{text-decoration:underline}
html[data-ref-copy] [data-ref-block]{outline:2px solid rgba(31,95,191,.6);outline-offset:2px;border-radius:2px}
`;
// Alt+클릭으로 통째로 가리킬 블록
const BLOCK = "p,li,h1,h2,h3,h4,h5,h6,td,th,pre,blockquote,dt,dd,figcaption,caption,summary,text,foreignObject";

const short = (t: string) => (t.length > 40 ? t.slice(0, 40) + "…" : t);

export function HtmlRefView({ category, menu, doc, version, highlight, copy, onExit }: {
  category: string; menu: string; doc: string; version: string; highlight: number[]; copy: boolean; onExit: () => void;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [copied, setCopied] = useState("");
  const props = useRef({ category, menu, doc, version, copy });
  props.current = { category, menu, doc, version, copy };

  const apply = useCallback(() => {
    const d = frame.current?.contentDocument;
    if (!d?.documentElement) return;
    d.documentElement.toggleAttribute("data-ref-copy", copy);
    d.querySelectorAll("[data-ref-hit]").forEach((n) => n.removeAttribute("data-ref-hit"));
    const hits = highlight.map((id) => d.querySelector(`[data-seg="${id}"]`)).filter((n): n is Element => !!n);
    hits.forEach((n) => n.setAttribute("data-ref-hit", ""));
    hits[0]?.scrollIntoView({ block: "center" });
  }, [highlight, copy]);
  useEffect(apply, [apply]);

  const onLoad = useCallback(() => {
    const d = frame.current?.contentDocument;
    if (!d) return;
    injectStyle(d, REF_CSS);
    // Alt를 누르고 있으면 블록 테두리를 미리 보여 준다
    let block: Element | null = null;
    const mark = (b: Element | null) => { block?.removeAttribute("data-ref-block"); block = b; b?.setAttribute("data-ref-block", ""); };
    d.addEventListener("mouseover", (e) => {
      if (!props.current.copy || !e.altKey) return mark(null);
      mark((e.target as Element).closest?.(BLOCK) ?? null);
    });
    d.addEventListener("keyup", () => mark(null));
    d.addEventListener("click", (e) => {
      const t = e.target as Element;
      if (t.closest("a, button, summary, label, form, input, select, textarea")) e.preventDefault();
      if (!props.current.copy) return;
      const seg = t.closest("[data-seg]");
      let ids: number[] = [];
      let label = "";
      if (e.altKey) {
        const b = t.closest(BLOCK);
        ids = b ? [...b.querySelectorAll("[data-seg]")].map((n) => Number(n.getAttribute("data-seg"))) : [];
        if (seg && !ids.length) ids = [Number(seg.getAttribute("data-seg"))];
        label = b?.textContent?.trim() ?? "";
      } else if (seg) {
        ids = [Number(seg.getAttribute("data-seg"))];
        label = seg.textContent ?? "";
      }
      if (!ids.length) return;
      e.preventDefault();
      const p = props.current;
      void copyText(refUrl(p.category, p.menu, p.doc, p.version, ids)).then((ok) =>
        setCopied(ok ? `[${formatSeg(ids)}] ‘${short(label.replace(/\s+/g, " "))}’` : "복사하지 못했습니다"));
    }, true);
    d.addEventListener("submit", (e) => e.preventDefault(), true);
    apply();
  }, [apply]);

  return (
    <div className="grid h-full grid-rows-[auto_minmax(0,1fr)]">
      <RefBar mode={copy ? "copy" : "highlight"} highlight={highlight} copied={copied} onExit={onExit} />
      <iframe
        ref={frame}
        src={editViewUrl(menu, doc, version)}
        title="참조 보기"
        className="block h-full w-full border-0 bg-surface"
        sandbox="allow-same-origin"
        onLoad={onLoad}
      />
    </div>
  );
}
