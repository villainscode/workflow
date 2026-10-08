import { useCallback, useRef, useState } from "react";
import { editViewUrl } from "../lib/textedit.ts";
import { EmptyState } from "../components/EmptyState.tsx";
import { EditBar, useTextSession } from "./textedit/session.tsx";

/**
 * HTML 문서를 화면 그대로 보면서 태그 안 글자만 고친다(2.0, REQUIREMENT-2.0 2.2).
 * - 편집용 사본(edit-view)을 스크립트 없이 같은 출처로 열어(sandbox="allow-same-origin") 조각마다 편집을 켠다
 * - 본문 글자: contenteditable="plaintext-only"로 그 자리 편집(서식·태그는 들어가지 않는다)
 * - SVG 다이어그램 글자: contenteditable이 안 되므로 누르면 그 위치에 작은 입력창
 * - Enter는 막는다(pre 안만 허용), Esc는 그 조각을 원래 글자로, 링크·버튼은 눌러도 이동하지 않는다
 * 저장·임시 보관·편집 막대는 textedit/session.tsx 공통 세션이 맡는다.
 */

const EDIT_CSS = `
[data-seg]{border-radius:2px;outline:1px dashed transparent;outline-offset:1px;transition:outline-color .1s,background .1s}
span[data-seg]{cursor:text}
span[data-seg]:hover{outline-color:rgba(31,95,191,.55)}
span[data-seg]:focus{outline:2px solid #1F5FBF;background:rgba(31,95,191,.08)}
span[data-changed]{background:rgba(224,186,79,.28);box-shadow:inset 0 -2px 0 #946C00}
tspan[data-seg]{cursor:pointer}
tspan[data-seg]:hover{text-decoration:underline}
tspan[data-changed]{fill:#946C00;font-weight:700}
`;

export function HtmlTextEditor({ menu, doc, version, onExit }: {
  menu: string; doc: string; version: string; onExit: (savedVersion?: string) => void;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [svgEdit, setSvgEdit] = useState<{ id: number; value: string; left: number; top: number; width: number } | null>(null);

  /** iframe 안 조각 요소 */
  const el = (id: number) => frame.current?.contentDocument?.querySelector<HTMLElement | SVGElement>(`[data-seg="${id}"]`) ?? null;

  const s = useTextSession({
    menu, doc, version, onExit,
    write: (id, text, changed) => {
      const node = el(id);
      if (!node) return;
      node.textContent = text;
      node.toggleAttribute("data-changed", changed);
    },
  });
  const sRef = useRef(s);
  sRef.current = s;

  // 편집용 사본이 열리면 조각마다 편집을 켜고 이벤트를 단다
  const onLoad = useCallback(() => {
    const d = frame.current?.contentDocument;
    if (!d) return;
    const style = d.createElement("style");
    style.textContent = EDIT_CSS;
    d.head.appendChild(style);
    d.querySelectorAll<HTMLElement>("span[data-seg]").forEach((n) => {
      n.setAttribute("contenteditable", "plaintext-only");
      n.spellcheck = false;
    });
    const segOf = (t: EventTarget | null) => {
      const node = (t as Element | null)?.closest?.("[data-seg]");
      const seg = node ? sRef.current.segs.get(Number(node.getAttribute("data-seg"))) : undefined;
      return node && seg ? { node: node as HTMLElement, seg } : null;
    };
    d.addEventListener("input", (e) => {
      const hit = segOf(e.target);
      if (!hit) return;
      let text = hit.node.textContent ?? "";
      // 줄바꿈 금지 조각에 붙여넣기 등으로 줄바꿈이 들어오면 공백으로 바꾼다(D-22)
      if (!hit.seg.multiline && /[\r\n]/.test(text)) { text = text.replace(/\r?\n/g, " "); hit.node.textContent = text; }
      hit.node.toggleAttribute("data-changed", text !== hit.seg.text);
      sRef.current.change(hit.seg.id, text);
    });
    d.addEventListener("keydown", (e) => {
      const hit = segOf(e.target);
      if (!hit) return;
      if (e.key === "Enter" && !hit.seg.multiline) e.preventDefault();
      if (e.key === "Escape") { e.preventDefault(); sRef.current.set(hit.seg.id, hit.seg.text); hit.node.blur(); }
    });
    // 편집 중에는 링크·버튼·폼이 동작하지 않게 한다(글자를 누르면 커서만 들어간다)
    d.addEventListener("click", (e) => {
      const t = e.target as Element;
      if (t.closest("a, button, summary, label, form")) e.preventDefault();
      const tspan = t.closest("tspan[data-seg]");
      if (tspan) {
        const seg = sRef.current.segs.get(Number(tspan.getAttribute("data-seg")));
        if (!seg) return;
        const r = tspan.getBoundingClientRect();
        setSvgEdit({ id: seg.id, value: tspan.textContent ?? "", left: r.left, top: r.top, width: Math.max(160, r.width + 40) });
      }
    }, true);
    d.addEventListener("submit", (e) => e.preventDefault(), true);
  }, []);

  if (s.error) return <EmptyState title="텍스트를 불러올 수 없습니다" body={String(s.error)} />;

  return (
    <div className="grid h-full grid-rows-[auto_minmax(0,1fr)]">
      <EditBar s={s} hint="글자만 고칠 수 있습니다 · 다이어그램 글자는 누르면 입력창 · Esc는 되돌리기"
        notice="편집 중에는 문서의 스크립트가 꺼집니다(접기·탭 같은 동작은 멈춥니다)." />
      <div className="relative min-h-0">
        {s.segments && (
          <iframe
            ref={frame}
            src={editViewUrl(menu, doc, version)}
            title="텍스트 편집"
            className="block h-full w-full border-0 bg-surface"
            sandbox="allow-same-origin"
            onLoad={onLoad}
          />
        )}
        {svgEdit && (
          <input
            autoFocus
            className="absolute z-10 rounded-md border-2 border-accent bg-surface px-2 py-1 text-sm shadow-lg"
            style={{ left: svgEdit.left, top: svgEdit.top - 4, width: svgEdit.width }}
            value={svgEdit.value}
            onChange={(e) => setSvgEdit({ ...svgEdit, value: e.target.value.replace(/\r?\n/g, " ") })}
            // 열리면 글자 전체를 선택한다: 바로 치면 바뀌고, 화살표로 옮겨 일부만 고칠 수도 있다
            onFocus={(e) => e.target.select()}
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); s.set(svgEdit.id, svgEdit.value); setSvgEdit(null); }
              if (e.key === "Escape") { e.preventDefault(); setSvgEdit(null); }
            }}
            onBlur={() => { s.set(svgEdit.id, svgEdit.value); setSvgEdit(null); }}
            aria-label="다이어그램 글자 편집"
          />
        )}
      </div>
    </div>
  );
}
