import { useEffect, useRef, useState } from "react";
import { Circle, Minus, MousePointer2, Redo2, Save, Square, Trash2, Type, Undo2, X } from "lucide-react";
import { svgSize, tidySvgEdit } from "@workflow/core/svg";
import { IconButton } from "../components/IconButton.tsx";

/**
 * 일반 SVG 편집(6.0 V4, D-56 B안): svgedit 캔버스(@svgedit/svgcanvas 7.4.2, MIT)로 도형 고르기·옮기기·크기·채움·선·글자·도형 넣기.
 * 편집기 UI는 우리 것이고 캔버스만 쓴다. 열 때만 불러온다(동적 import, gzip 약 64kB. PDF 내보내기 모듈은 빈 모듈로 뺐다: vite.config.ts).
 * 꺼낸 SVG는 viewBox를 되살리고 「Layer 1」 묶음을 풀고(core tidySvgEdit) 서버가 다시 소독한다.
 * draw.io SVG(루트 content)는 svgedit가 편집 정보를 지우므로 여기서 열지 않는다(DrawioEditor).
 */

// svgcanvas 타입에 없는 메서드(스파이크에서 확인한 공개 메서드)
interface Canvas {
  setSvgString(s: string): boolean;
  getSvgString(): string;
  updateCanvas(w: number, h: number): void;
  setMode(m: string): void;
  setColor(type: "fill" | "stroke", color: string): void;
  changeSelectedAttribute(attr: string, val: string | number): void;
  deleteSelectedElements(): void;
  getSelectedElements(): (Element | null)[];
  bind(ev: string, cb: (...a: unknown[]) => void): void;
  undoMgr: { undo(): void; redo(): void; getUndoStackSize(): number; getRedoStackSize(): number };
  textActions: { setInputElem(el: HTMLInputElement): void };
}

const MODES = [
  ["select", MousePointer2, "고르기·옮기기 (끌어서 옮기고 손잡이로 크기)"],
  ["rect", Square, "사각형 그리기"],
  ["ellipse", Circle, "타원 그리기"],
  ["line", Minus, "선 그리기"],
  ["text", Type, "글자 넣기"],
] as const;

const hex = (v: string | null | undefined) => (v && /^#[0-9a-f]{6}$/i.test(v) ? v : v && /^#[0-9a-f]{3}$/i.test(v) ? `#${[...v.slice(1)].map((c) => c + c).join("")}` : "#000000");

export function SvgEditor({ svg, title, onSave, onClose }: {
  svg: string;
  title: string;
  onSave: (svg: string) => Promise<void>;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const canvas = useRef<Canvas | null>(null);
  const [mode, setModeState] = useState("select");
  const [sel, setSel] = useState<{ fill: string; stroke: string; width: string; text: string | null } | null>(null);
  const [status, setStatus] = useState("편집기를 여는 중…");
  const [, redraw] = useState(0);
  const size = svgSize(svg);
  const viewBox = /<svg\b[^>]*\sviewBox="([^"]+)"/.exec(svg)?.[1];

  useEffect(() => { dialog.current?.showModal(); }, []);
  useEffect(() => {
    let off = false;
    void (async () => {
      const { default: SvgCanvas } = await import("@svgedit/svgcanvas");
      if (off || !host.current) return;
      const c = new SvgCanvas(host.current, {
        initFill: { color: "FFFFFF", opacity: 1 }, initStroke: { color: "1C2026", opacity: 1, width: 2 },
        text: { stroke_width: 0, font_size: 20, font_family: "sans-serif" }, initOpacity: 1,
        dimensions: [size.width, size.height], baseUnit: "px", selectNew: true,
      }) as unknown as Canvas;
      c.updateCanvas(size.width, size.height);
      if (input.current) c.textActions.setInputElem(input.current);
      if (!c.setSvgString(svg)) { setStatus("이 SVG는 편집기로 읽을 수 없습니다"); return; }
      c.bind("selected", (_w, elems) => {
        const el = (elems as (Element | null)[]).filter(Boolean)[0] ?? null;
        setSel(el ? { fill: el.getAttribute("fill") ?? "", stroke: el.getAttribute("stroke") ?? "", width: el.getAttribute("stroke-width") ?? "1",
          text: el.tagName === "text" ? el.textContent ?? "" : null } : null);
      });
      c.bind("changed", () => redraw((n) => n + 1));
      canvas.current = c;
      (window as unknown as { svgCanvas?: Canvas }).svgCanvas = c; // 화면 테스트가 캔버스를 조작한다
      setStatus("");
    })().catch((e) => setStatus(`편집기를 열지 못했습니다: ${(e as Error).message}`));
    return () => { off = true; if (host.current) host.current.innerHTML = ""; canvas.current = null; };
  }, [svg, size.width, size.height]);

  const c = canvas.current;
  const setMode = (m: string) => { c?.setMode(m); setModeState(m); };
  const color = (type: "fill" | "stroke", v: string) => { c?.setColor(type, v); setSel((s) => (s ? { ...s, [type]: v } : s)); };
  const save = async () => {
    if (!c) return;
    setStatus("저장하는 중…");
    try {
      await onSave(tidySvgEdit(c.getSvgString(), { viewBox }));
      onClose();
    } catch (e) { setStatus(`저장하지 못했습니다: ${(e as Error).message}`); }
  };

  return (
    <dialog ref={dialog} onCancel={(e) => { e.preventDefault(); onClose(); }} aria-label={`SVG 편집: ${title}`}
      className="m-0 h-dvh max-h-none w-dvw max-w-none border-0 bg-surface p-0 text-fg backdrop:bg-black/40">
      <div className="grid h-full grid-rows-[auto_auto_minmax(0,1fr)]">
        <div className="flex flex-wrap items-center gap-1 border-b border-line px-3 py-1.5" role="toolbar" aria-label="SVG 편집 도구">
          <span className="mr-2 text-sm font-medium">{title}</span>
          {MODES.map(([m, icon, label]) => <IconButton key={m} icon={icon} label={label} size={18} active={mode === m} onClick={() => setMode(m)} />)}
          <span className="mx-1 h-5 w-px bg-line" aria-hidden />
          <label className="flex items-center gap-1 text-xs text-muted">채움
            <input type="color" aria-label="채움 색" value={hex(sel?.fill)} disabled={!sel} onChange={(e) => color("fill", e.target.value)} className="h-6 w-8 border border-line" />
          </label>
          <label className="flex items-center gap-1 text-xs text-muted">선
            <input type="color" aria-label="선 색" value={hex(sel?.stroke)} disabled={!sel} onChange={(e) => color("stroke", e.target.value)} className="h-6 w-8 border border-line" />
          </label>
          <label className="flex items-center gap-1 text-xs text-muted">굵기
            <input type="number" min={0} max={40} aria-label="선 굵기" value={sel?.width ?? "1"} disabled={!sel} className="w-14 rounded border border-line bg-surface px-1 py-0.5"
              onChange={(e) => { c?.changeSelectedAttribute("stroke-width", e.target.value); setSel((s) => (s ? { ...s, width: e.target.value } : s)); }} />
          </label>
          {sel?.text !== null && sel && (
            <input aria-label="글자" value={sel.text} className="w-40 rounded border border-line bg-surface px-2 py-0.5 text-xs"
              onChange={(e) => { c?.changeSelectedAttribute("#text", e.target.value); setSel((s) => (s ? { ...s, text: e.target.value } : s)); }} />
          )}
          <IconButton icon={Trash2} label="고른 도형 지우기" size={18} disabled={!sel} onClick={() => { c?.deleteSelectedElements(); setSel(null); }} />
          <IconButton icon={Undo2} label="되돌리기" size={18} disabled={!c?.undoMgr.getUndoStackSize()} onClick={() => c?.undoMgr.undo()} />
          <IconButton icon={Redo2} label="다시 하기" size={18} disabled={!c?.undoMgr.getRedoStackSize()} onClick={() => c?.undoMgr.redo()} />
          <span className="ml-auto" />
          <IconButton icon={X} label="닫기 (저장하지 않음)" text="닫기" variant="outline" onClick={onClose} />
          <IconButton icon={Save} label="저장" text="저장" variant="primary" disabled={!c} onClick={() => void save()} />
        </div>
        <p role="status" className={status ? "bg-sunken px-3 py-1 text-xs text-muted" : "sr-only"}>{status || "SVG 편집기"}</p>
        <div className="min-h-0 overflow-auto bg-sunken p-4">
          <div ref={host} id="svgedit-host" className="relative" style={{ width: size.width + 80, height: size.height + 80 }} />
          <input ref={input} aria-hidden tabIndex={-1} className="pointer-events-none absolute h-0 w-0 opacity-0" />
        </div>
      </div>
    </dialog>
  );
}
