import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import Moveable from "react-moveable";
import { findEl, serializeEl, type Slide, type SlideEl, type SlideOp } from "@workflow/core/slide";
import { uploadAsset } from "../../../lib/structedit.ts";
import { useConfirm } from "../../../components/confirm/ConfirmProvider.tsx";
import { SlideCanvas, SlideRenderer } from "../SlideRenderer.tsx";
import { TextEditor } from "./TextEditor.tsx";

/**
 * 편집 캔버스(명세 06·07·08절). 1920×1080 좌표계를 창에 맞춰 줄여 그리고, 같은 변환 안에 선택 상자(Moveable)와 표 손잡이를 둔다.
 * - 클릭: 가장 가까운 [data-eid] 선택, Shift+클릭: 추가 선택, Esc: 부모 선택, 두 번 클릭: 글자 편집(Tiptap)
 * - 고정 위치(position:absolute) 요소는 끌어 옮기고 크기를 바꾼다. 흐름 요소는 크기만. 놓을 때 setStyle 하나로 확정(되돌리기 한 번에 하나)
 * - 맞춤선: 캔버스 가장자리·여백선(128px)·가운데·형제 요소, 8px 격자
 * - 화살표 1px, Shift+화살표 8px 이동. Delete 지우기(확인 창), ⌘D 복제, ⌘Z·⇧⌘Z 되돌리기·다시 하기
 * - 그림 파일 끌어 놓기·붙여 넣기 → 자산 → 고정 위치 그림
 */

export const TEXT_TAGS = new Set(["h1", "h2", "h3", "p", "li", "th", "td", "div"]);
const isTextEl = (el: SlideEl) => TEXT_TAGS.has(el.tag) && el.children.every((c) => c.kind === "text");
const px = (n: number) => `${Math.round(n)}px`;

export interface CanvasProps {
  slide: Slide;
  family?: string;
  selection: string[];
  setSelection: (s: string[]) => void;
  apply: (ops: SlideOp[]) => boolean;
  onUndo: () => void;
  onRedo: () => void;
  setMessage: (m: string) => void;
  width: number;
}

export function EditCanvas({ slide, family, selection, setSelection, apply, onUndo, onRedo, setMessage, width }: CanvasProps) {
  const confirm = useConfirm();
  const layer = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(width / 1920);
  const [editing, setEditing] = useState<string | null>(null);
  const [targets, setTargets] = useState<HTMLElement[]>([]);
  const moveable = useRef<Moveable>(null);

  const root = () => layer.current?.querySelector<HTMLElement>(".slide-root") ?? null;
  const dom = (eid: string) => layer.current?.querySelector<HTMLElement>(`[data-eid="${CSS.escape(eid)}"]`) ?? null;
  const nodeOf = (eid: string) => findEl(slide.root, eid);

  // 선택이 바뀌거나 슬라이드가 다시 그려지면 Moveable 대상을 다시 잡는다(좌표는 저장하지 않고 매번 DOM에서 잰다)
  useLayoutEffect(() => {
    setTargets(selection.filter((e) => e !== slide.id && e !== editing).map(dom).filter((x): x is HTMLElement => !!x));
  }, [selection, slide, editing]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { void document.fonts.ready.then(() => moveable.current?.updateRect()); }, [slide]);
  useEffect(() => { setEditing(null); }, [slide.id]);

  const one = selection.length === 1 ? nodeOf(selection[0]) : null;
  const pinned = (eid: string) => nodeOf(eid)?.el.style.position === "absolute";
  const allPinned = targets.length > 0 && selection.every(pinned);

  const onPointerDown = (e: React.PointerEvent) => {
    const t = e.target as Element;
    if (t.closest(".moveable-control-box, [data-col-handle], .slide-text-editor")) return;
    const hit = t.closest("[data-eid]")?.getAttribute("data-eid");
    if (!hit) return;
    if (editing && hit !== editing) setEditing(null);
    if (e.shiftKey) setSelection(selection.includes(hit) ? selection.filter((x) => x !== hit) : [...selection.filter((x) => x !== slide.id), hit]);
    else if (!selection.includes(hit) || selection.length > 1) setSelection([hit]);
  };

  const onDoubleClick = (e: React.MouseEvent) => {
    const hit = (e.target as Element).closest("[data-eid]")?.getAttribute("data-eid");
    const n = hit ? nodeOf(hit) : null;
    if (n && isTextEl(n.el)) { setSelection([hit!]); setEditing(hit!); }
  };

  const removeSelected = async () => {
    const list = selection.filter((x) => x !== slide.id);
    if (!list.length) return;
    const cells = list.some((x) => ["tr", "td", "th"].includes(nodeOf(x)?.el.tag ?? ""));
    if (cells) { setMessage("표의 행·열은 오른쪽 표 묶음에서 지웁니다"); return; }
    const ok = await confirm({ title: `요소 ${list.length}개를 지울까요?`, confirmText: "지우기", tone: "danger", message: "되돌리기(⌘Z)로 다시 살릴 수 있습니다." });
    if (ok && apply(list.map((eid) => ({ t: "remove", eid })))) setSelection([]);
  };

  const duplicate = () => {
    if (!one || !one.parent) return;
    const copy = { ...one.el, style: { ...one.el.style } };
    if (copy.style.position === "absolute") {
      copy.style.left = px(parseFloat(copy.style.left ?? "0") + 24);
      copy.style.top = px(parseFloat(copy.style.top ?? "0") + 24);
    }
    apply([{ t: "insert", parent: one.parent.eid, index: one.index + 1, html: serializeEl(copy) }]);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (editing || (e.target as Element).closest("input, textarea, select, [contenteditable]")) return;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === "z") { e.preventDefault(); if (e.shiftKey) onRedo(); else onUndo(); return; }
    if (mod && e.key.toLowerCase() === "d") { e.preventDefault(); duplicate(); return; }
    if (e.key === "Escape" && one?.parent) { e.preventDefault(); setSelection([one.parent.eid]); return; }
    if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); void removeSelected(); return; }
    const arrows: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    if (arrows[e.key] && allPinned) {
      e.preventDefault();
      const step = e.shiftKey ? 8 : 1;
      const [dx, dy] = arrows[e.key];
      apply(selection.map((eid) => {
        const st = nodeOf(eid)!.el.style;
        return { t: "setStyle", eid, set: { left: px(parseFloat(st.left ?? "0") + dx * step), top: px(parseFloat(st.top ?? "0") + dy * step) } };
      }));
    }
  };

  // 그림 끌어 놓기·붙여 넣기 → 고정 위치 그림(가운데, 긴 변 896px 안)
  const insertImages = useCallback(async (files: File[], at?: { x: number; y: number }) => {
    for (const f of files) {
      if (!/^image\/(png|jpeg|webp|gif)$/.test(f.type)) { setMessage("PNG·JPEG·WebP·GIF만 넣을 수 있습니다"); continue; }
      try {
        const a = await uploadAsset(f);
        const k = Math.min(1, 896 / a.width, 640 / a.height);
        const w = Math.max(8, a.width * k), h = Math.max(8, a.height * k);
        const left = Math.min(1920 - w, Math.max(0, (at?.x ?? 960) - w / 2)), top = Math.min(1080 - h, Math.max(0, (at?.y ?? 540) - h / 2));
        const alt = f.name.replace(/\.[^.]+$/, "").replace(/"/g, "");
        apply([{ t: "insert", parent: slide.id, index: slide.root.children.length,
          html: `<img src="${a.asset}" alt="${alt}" style="position:absolute;left:${px(left)};top:${px(top)};width:${px(w)};height:${px(h)};object-fit:contain">` }]);
      } catch (err) { setMessage(String((err as Error).message)); }
    }
  }, [apply, slide, setMessage]);

  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      if (editing || (e.target as Element)?.closest?.("input, textarea, [contenteditable]")) return;
      const files = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith("image/"));
      if (files.length) { e.preventDefault(); void insertImages(files); }
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [editing, insertImages]);

  const editNode = editing ? nodeOf(editing)?.el : null;
  const finishText = (eid: string, html: string | null) => {
    setEditing(null);
    const n = nodeOf(eid);
    if (html === null || !n) return;
    const old = n.el.children.map((c) => (c as { html: string }).html).join("");
    if (html !== old) apply([{ t: "setText", eid, html }]);
  };
  /** 표 칸에서 Tab·Shift+Tab: 지금 칸을 확정하고 다음·이전 칸 편집 */
  const tabCell = (eid: string, back: boolean, html: string) => {
    finishText(eid, html);
    const n = nodeOf(eid);
    const table = n && layer.current ? dom(eid)?.closest("table") : null;
    if (!table) return;
    const cells = [...table.querySelectorAll<HTMLElement>("th[data-eid], td[data-eid]")];
    const next = cells[cells.findIndex((c) => c.dataset.eid === eid) + (back ? -1 : 1)]?.dataset.eid;
    if (next) setTimeout(() => { setSelection([next]); setEditing(next); }, 0);
  };

  const guidesV = [0, 128, 960, 1792, 1920], guidesH = [0, 128, 540, 952, 1080];
  const siblings = targets.length === 1 && one?.parent
    ? one.parent.children.filter((c): c is SlideEl => c.kind === "el" && c.eid !== one.el.eid).map((c) => dom(c.eid)).filter((x): x is HTMLElement => !!x)
    : [];

  return (
    <div className="outline-none" tabIndex={0} onKeyDown={onKeyDown} aria-label="슬라이드 편집 캔버스"
      onDragOver={(e) => { if (e.dataTransfer.types.includes("Files")) e.preventDefault(); }}
      onDrop={(e) => {
        const files = [...e.dataTransfer.files];
        if (!files.length) return;
        e.preventDefault();
        const base = root()?.getBoundingClientRect();
        void insertImages(files, base ? { x: (e.clientX - base.left) / scale, y: (e.clientY - base.top) / scale } : undefined);
      }}>
      <div className="shadow-sm ring-1 ring-line">
        <SlideCanvas width={width} onScale={setScale}>
          <div ref={layer} onPointerDown={onPointerDown} onDoubleClick={onDoubleClick} className="deck-edit-layer" style={{ position: "relative", width: 1920, height: 1080 }}>
            <SlideRenderer slide={slide} edit family={family}
              editing={editing && editNode ? { eid: editing, content: (
                <TextEditor key={editing} html={editNode.children.map((c) => (c as { html: string }).html).join("")}
                  onDone={(html) => finishText(editing, html)}
                  onTab={["td", "th"].includes(editNode.tag) ? (back, html) => tabCell(editing, back, html) : undefined} />
              ) } : undefined} />
            {selection.includes(slide.id) && <div className="pointer-events-none absolute inset-0 outline outline-4 -outline-offset-4 outline-accent" />}
            {one && one.el.tag === "table" && <ColumnHandles table={dom(one.el.eid)} root={root()} el={one.el} scale={scale} apply={apply} />}
            {targets.length > 0 && !editing && (
              <Moveable
                ref={moveable}
                target={targets.length === 1 ? targets[0] : targets}
                zoom={1 / scale}
                draggable={allPinned}
                resizable={targets.length === 1}
                keepRatio={one?.el.tag === "img"}
                throttleDrag={0}
                snappable
                snapContainer={root() ?? undefined}
                snapGridWidth={8}
                snapGridHeight={8}
                verticalGuidelines={guidesV}
                horizontalGuidelines={guidesH}
                elementGuidelines={siblings}
                snapThreshold={6}
                isDisplaySnapDigit={false}
                origin={false}
                onDrag={({ target, left, top }) => { target.style.left = px(left); target.style.top = px(top); }}
                onDragEnd={({ target, isDrag }) => {
                  if (!isDrag) return;
                  const eid = target.getAttribute("data-eid")!;
                  apply([{ t: "setStyle", eid, set: { left: target.style.left, top: target.style.top } }]);
                }}
                onDragGroup={({ events }) => events.forEach(({ target, left, top }) => { target.style.left = px(left); target.style.top = px(top); })}
                onDragGroupEnd={({ targets: ts, isDrag }) => {
                  if (!isDrag) return;
                  apply(ts.map((t) => ({ t: "setStyle", eid: t.getAttribute("data-eid")!, set: { left: (t as HTMLElement).style.left, top: (t as HTMLElement).style.top } })));
                }}
                onResize={({ target, width: w, height: h, drag }) => {
                  target.style.width = px(w);
                  target.style.height = px(h);
                  if (target.style.position === "absolute") { target.style.left = px(drag.left); target.style.top = px(drag.top); }
                }}
                onResizeEnd={({ target, isDrag }) => {
                  if (!isDrag) return;
                  const eid = target.getAttribute("data-eid")!;
                  const set: Record<string, string> = { width: target.style.width, height: target.style.height };
                  if (target.style.position === "absolute") { set.left = target.style.left; set.top = target.style.top; }
                  apply([{ t: "setStyle", eid, set }]);
                }}
              />
            )}
          </div>
        </SlideCanvas>
      </div>
    </div>
  );
}

/** 지금 화면 상자로 고정 위치 전환(toPinned). 속성 패널에서 부른다 */
export function measureBox(eid: string): { left: number; top: number; width: number; height: number } | null {
  const el = document.querySelector<HTMLElement>(`.deck-edit-layer [data-eid="${CSS.escape(eid)}"]`);
  const root = el?.closest<HTMLElement>(".slide-root");
  if (!el || !root) return null;
  const scale = root.getBoundingClientRect().width / 1920;
  const r = el.getBoundingClientRect(), b = root.getBoundingClientRect();
  return { left: (r.left - b.left) / scale, top: (r.top - b.top) / scale, width: r.width / scale, height: r.height / scale };
}

/**
 * 표 열 경계 손잡이(명세 07절). 끌면 이웃 두 열의 비율만 주고받고(각 5% 이상), 놓을 때 tableCols 하나로 확정한다.
 */
function ColumnHandles({ table, root, el, scale, apply }: { table: HTMLElement | null; root: HTMLElement | null; el: SlideEl; scale: number; apply: (ops: SlideOp[]) => boolean }) {
  const [, redraw] = useState(0);
  useEffect(() => { void document.fonts.ready.then(() => redraw((n) => n + 1)); }, [el]);
  if (!table || !root) return null;
  const firstRow = table.querySelector("tr");
  const cells = firstRow ? [...firstRow.querySelectorAll<HTMLElement>(":scope > th, :scope > td")] : [];
  if (cells.length < 2) return null;
  const base = root.getBoundingClientRect(), tr = table.getBoundingClientRect();
  const tableW = tr.width / scale;
  const widths = cells.map((c) => c.getBoundingClientRect().width / scale);
  const top = (tr.top - base.top) / scale, height = tr.height / scale;
  let x = (tr.left - base.left) / scale;
  return (
    <>
      {cells.slice(0, -1).map((c, i) => {
        x += widths[i];
        return (
          <div key={i} data-col-handle role="separator" aria-orientation="vertical" aria-label={`${i + 1}·${i + 2}열 경계`}
            style={{ position: "absolute", left: x - 6, top, width: 12, height, cursor: "col-resize", zIndex: 5 }}
            className="group"
            onPointerDown={(e) => {
              e.preventDefault();
              e.stopPropagation();
              (e.target as HTMLElement).setPointerCapture(e.pointerId);
              const start = e.clientX;
              const pct = widths.map((w) => (w / tableW) * 100);
              let next = pct;
              const move = (ev: PointerEvent) => {
                const d = ((ev.clientX - start) / scale / tableW) * 100;
                const a = Math.max(5, Math.min(pct[i] + pct[i + 1] - 5, pct[i] + d));
                next = pct.map((p, j) => (j === i ? a : j === i + 1 ? pct[i] + pct[i + 1] - a : p));
                cells.forEach((cell, j) => { cell.style.width = `${next[j]}%`; });
              };
              const up = () => {
                window.removeEventListener("pointermove", move);
                window.removeEventListener("pointerup", up);
                if (next !== pct) apply([{ t: "tableCols", eid: el.eid, widths: next.map((p) => Math.round(p * 10) / 10) }]);
              };
              window.addEventListener("pointermove", move);
              window.addEventListener("pointerup", up);
            }}>
            <div className="mx-auto h-full w-[3px] bg-accent opacity-40 group-hover:opacity-100" />
          </div>
        );
      })}
    </>
  );
}
