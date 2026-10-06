import { useCallback, useState, type CSSProperties } from "react";

const KEY = "workflow:sidebar-width";
const COLLAPSED_KEY = "workflow:sidebar-collapsed";
export const SIDEBAR_DEFAULT = 272;
export const SIDEBAR_COLLAPSED = 20;
const MIN = 200;
const MAX = 560;
const clamp = (w: number) => Math.round(Math.min(MAX, Math.max(MIN, w)));

function load(): number {
  try {
    const v = Number(localStorage.getItem(KEY));
    return v ? clamp(v) : SIDEBAR_DEFAULT;
  } catch {
    return SIDEBAR_DEFAULT; // 시크릿 창 등 저장소를 못 쓰면 기본값
  }
}

function loadCollapsed(): boolean {
  try { return localStorage.getItem(COLLAPSED_KEY) === "1"; } catch { return false; }
}

/**
 * 사이드바 너비와 접힘 상태. 둘 다 브라우저에 기억한다.
 * 접으면 20px 띠만 남기고, 펼치면 접기 전 너비로 돌아간다(너비 값은 접어도 지우지 않는다).
 */
export function useSidebarWidth() {
  const [width, setWidthState] = useState(load);
  const [collapsed, setCollapsedState] = useState(loadCollapsed);
  const setWidth = useCallback((w: number) => {
    const next = clamp(w);
    setWidthState(next);
    try { localStorage.setItem(KEY, String(next)); } catch { /* 저장 실패는 무시 */ }
  }, []);
  const setCollapsed = useCallback((c: boolean) => {
    setCollapsedState(c);
    try { localStorage.setItem(COLLAPSED_KEY, c ? "1" : "0"); } catch { /* 저장 실패는 무시 */ }
  }, []);
  const shown = collapsed ? SIDEBAR_COLLAPSED : width;
  return { width, setWidth, collapsed, setCollapsed, style: { "--sidebar-w": `${shown}px` } as CSSProperties };
}

/**
 * 사이드바 오른쪽 경계의 손잡이. 끌어서 너비를 바꾸고, 더블클릭하면 기본값, ←→ 키로도 조절한다.
 * 누르는 순간 포인터를 손잡이에 잡아 둔다(setPointerCapture). 그래야 HTML 문서 iframe 위를 지나가도
 * 이동 이벤트를 iframe에 뺏기지 않는다. 화면을 덮개로 가리지 않으므로 더블클릭도 그대로 손잡이에 들어온다.
 */
export function SidebarResizer({ width, setWidth }: { width: number; setWidth: (w: number) => void }) {
  const [drag, setDrag] = useState<{ startX: number; startW: number } | null>(null);

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="사이드바 너비 조절"
      aria-valuenow={width}
      aria-valuemin={MIN}
      aria-valuemax={MAX}
      tabIndex={0}
      title="끌어서 너비 조절 · 더블클릭하면 기본 너비"
      className={`absolute inset-y-0 z-20 hidden w-2 -translate-x-1/2 cursor-col-resize touch-none select-none md:block
        after:absolute after:inset-y-0 after:left-1/2 after:w-0.5 after:-translate-x-1/2 after:transition-colors
        hover:after:bg-accent focus-visible:outline-none focus-visible:after:bg-accent ${drag ? "after:bg-accent" : ""}`}
      style={{ left: "var(--sidebar-w)" }}
      onPointerDown={(e) => {
        // preventDefault를 하면 브라우저가 더블클릭을 만들지 않는다. 텍스트 선택은 select-none으로 막는다
        e.currentTarget.setPointerCapture(e.pointerId);
        setDrag({ startX: e.clientX, startW: width });
      }}
      onPointerMove={(e) => { if (drag) setWidth(drag.startW + e.clientX - drag.startX); }}
      onPointerUp={() => setDrag(null)}
      onLostPointerCapture={() => setDrag(null)}
      onClick={(e) => { if (e.detail === 2) setWidth(SIDEBAR_DEFAULT); }}
      onKeyDown={(e) => {
        if (e.key === "ArrowLeft") { e.preventDefault(); setWidth(width - 16); }
        if (e.key === "ArrowRight") { e.preventDefault(); setWidth(width + 16); }
      }}
    />
  );
}
