import { useCallback, useRef, useState } from "react";
import { TriangleAlert } from "lucide-react";
import { editViewUrl, injectStyle } from "../lib/textedit.ts";
import { EmptyState } from "../components/EmptyState.tsx";
import { EditBar, useTextSession } from "./textedit/session.tsx";

/**
 * HTML 문서를 화면 그대로 보면서 태그 안 글자만 고친다(2.0, REQUIREMENT-2.0 2.2).
 * - 편집용 사본(edit-view)을 스크립트 없이 같은 출처로 열어(sandbox="allow-same-origin") 조각마다 편집을 켠다
 * - 본문 글자: contenteditable="plaintext-only"로 그 자리 편집(서식·태그는 들어가지 않는다)
 * - SVG 다이어그램 글자: contenteditable이 안 되므로 누르면 그 위치에 작은 입력창
 * - Enter는 막는다(pre 안만 허용), Esc는 그 조각을 원래 글자로, 링크·버튼은 눌러도 이동하지 않는다
 * 저장·임시 보관·편집 막대는 textedit/session.tsx 공통 세션이 맡는다.
 * SVG 문서(draw.io 내보내기 등)도 같은 화면으로 고친다. draw.io 글자가 칸(상자)을 넘치면 경고한다.
 */

/** 글자 덩어리: foreignObject 안에서 글자를 감싼 가장 안쪽 블록(draw.io는 inline-block div) */
const labelOf = (node: Element) => (node.closest("foreignObject") ? (node.closest("div") ?? node) : node);

/**
 * 고치기 전 글자를 담고 있던 도형. 칸은 가장 가까운 g[data-cell-id]이고, 그 칸에 바로 속한 도형 중 글자 가운데를 품은
 * 가장 작은 것을 고른다(표라면 머리 부분). draw.io 그림이 아니면 null
 */
function shapeOf(node: Element): Element | null {
  const cell = node.closest("g[data-cell-id]");
  if (!cell) return null;
  const shapes = [...cell.querySelectorAll("path, rect, ellipse, polygon")]
    .filter((s) => s.closest("g[data-cell-id]") === cell && !s.closest("switch"));
  const r = labelOf(node).getBoundingClientRect();
  const cx = (r.left + r.right) / 2, cy = (r.top + r.bottom) / 2;
  const area = (b: DOMRect) => b.width * b.height;
  const hits = shapes.map((s) => ({ s, b: s.getBoundingClientRect() }))
    .filter(({ b }) => cx >= b.left && cx <= b.right && cy >= b.top && cy <= b.bottom)
    .sort((x, y) => area(x.b) - area(y.b));
  return hits[0]?.s ?? null;
}

/** 글자가 그 도형 밖으로 넘치거나 테두리에 닿는가(2px 안쪽까지). 고치기 전부터 닿아 있던 칸은 경고하지 않는다 */
const EDGE = 2;
function overflows(node: Element, shape: Element | null): boolean {
  if (!shape) return false;
  const b = shape.getBoundingClientRect(), r = labelOf(node).getBoundingClientRect();
  return r.left < b.left + EDGE || r.right > b.right - EDGE || r.top < b.top + EDGE || r.bottom > b.bottom - EDGE;
}
const shortText = (t: string) => (t.length > 24 ? t.slice(0, 24) + "…" : t);

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
  menu: string; doc: string; version: string; onExit: (savedVersion?: string, warnings?: string[]) => void;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  // 글자가 칸을 넘치는 조각(id → 경고 문구). 처음부터 넘치던 칸은 경고하지 않는다
  const [overflow, setOverflow] = useState<Map<number, string>>(new Map());
  const baseline = useRef(new Map<number, { shape: Element | null; over: boolean }>());
  const remember = (id: number, node: Element) => {
    if (baseline.current.has(id)) return;
    const shape = shapeOf(node);
    baseline.current.set(id, { shape, over: overflows(node, shape) });
  };
  const checkOverflow = (id: number, node: Element, text: string) => {
    const base = baseline.current.get(id);
    const now = !!base && overflows(node, base.shape);
    setOverflow((prev) => {
      const next = new Map(prev);
      if (now && !base!.over) next.set(id, `[${id}] ‘${shortText(text)}’ 글자가 상자를 넘칩니다`); else next.delete(id);
      return next.size === prev.size && [...next].every(([k, v]) => prev.get(k) === v) ? prev : next;
    });
  };
  const [svgEdit, setSvgEdit] = useState<{ id: number; value: string; left: number; top: number; width: number } | null>(null);

  /** iframe 안 조각 요소 */
  const el = (id: number) => frame.current?.contentDocument?.querySelector<HTMLElement | SVGElement>(`[data-seg="${id}"]`) ?? null;

  const s = useTextSession({
    menu, doc, version, onExit,
    warnings: [...overflow.values()],
    write: (id, text, changed) => {
      const node = el(id);
      if (!node) return;
      remember(id, node);
      node.textContent = text;
      node.toggleAttribute("data-changed", changed);
      checkOverflow(id, node, text);
    },
  });
  const sRef = useRef(s);
  sRef.current = s;
  const checkRef = useRef(checkOverflow);
  checkRef.current = checkOverflow;
  const rememberRef = useRef(remember);
  rememberRef.current = remember;

  // 편집용 사본이 열리면 조각마다 편집을 켜고 이벤트를 단다
  const onLoad = useCallback(() => {
    const d = frame.current?.contentDocument;
    if (!d) return;
    injectStyle(d, EDIT_CSS);
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
      checkRef.current(hit.seg.id, hit.node, text);
    });
    // 처음 고치기 전의 넘침 상태를 기억한다(원래부터 넘치던 칸은 경고하지 않는다)
    d.addEventListener("focusin", (e) => {
      const hit = segOf(e.target);
      if (hit) rememberRef.current(hit.seg.id, hit.node);
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
      <div>
        <EditBar s={s} hint="글자만 고칠 수 있습니다 · 다이어그램 글자는 누르면 입력창 · Esc는 되돌리기"
          notice="편집 중에는 문서의 스크립트가 꺼집니다(접기·탭 같은 동작은 멈춥니다)." />
        {overflow.size > 0 && (
          <div role="alert" className="flex flex-wrap items-center gap-x-2 gap-y-0.5 bg-high-soft px-4 py-1.5 text-xs text-high">
            <TriangleAlert size={16} aria-hidden />
            <span className="font-medium">글자가 상자를 넘치는 곳 {overflow.size}곳</span>
            <span>{[...overflow.values()].slice(0, 3).join(" · ")}{overflow.size > 3 ? ` 외 ${overflow.size - 3}곳` : ""}</span>
            <span className="text-muted">저장은 할 수 있지만 그림에서 넘쳐 보입니다. 글자를 줄이거나 원본(.drawio)에서 상자를 키우세요.</span>
          </div>
        )}
      </div>
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
