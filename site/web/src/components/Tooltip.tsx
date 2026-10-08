import { useEffect, useRef, useState } from "react";

/**
 * 공통 툴팁. 화면 어디서든 `data-tip="설명"`이 붙은 요소에 마우스를 올리거나 키보드로 포커스하면 설명을 띄운다.
 * 앱 맨 위에 한 번만 둔다(main.tsx). 브라우저 기본 title 툴팁은 늦게 뜨고 모양을 바꿀 수 없어 쓰지 않는다.
 * - Popover API(popover="manual")로 최상위 층에 띄운다. 그래서 showModal 대화상자와 프레젠테이션 전체 화면 위에도 보인다.
 * - 기본은 요소 아래, 화면 아래가 모자라면 위. `data-tip-side="right"`면 오른쪽(세로 손잡이 등).
 * - 처음에는 잠깐(400ms) 기다렸다 띄우고, 툴팁이 떠 있거나 막 닫힌 뒤 옆 아이콘으로 옮기면 바로 띄운다.
 * - 누르거나, 스크롤하거나, Esc를 누르면 닫는다.
 */

const DELAY = 400;
const WARM = 600; // 이 시간 안에 다른 아이콘으로 옮기면 기다리지 않는다
const GAP = 6;
const EDGE = 8;

interface Tip { text: string; x: number; y: number; ready: boolean }

export function TooltipLayer() {
  const ref = useRef<HTMLDivElement>(null);
  const [tip, setTip] = useState<Tip | null>(null);
  const target = useRef<Element | null>(null);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let closedAt = 0;
    let shown = false; // 지금 툴팁이 떠 있는가

    const hide = () => {
      clearTimeout(timer);
      if (shown) closedAt = Date.now();
      shown = false;
      target.current = null;
      setTip(null);
    };
    const show = (el: Element) => {
      const text = el.getAttribute("data-tip");
      if (!text) return;
      clearTimeout(timer);
      target.current = el;
      const open = () => { if (target.current === el) { shown = true; setTip({ text, x: 0, y: 0, ready: false }); } };
      if (shown || Date.now() - closedAt < WARM) open(); else timer = setTimeout(open, DELAY);
    };
    const tipOf = (e: Event) => (e.target instanceof Element ? e.target.closest("[data-tip]") : null);

    const onOver = (e: PointerEvent) => {
      if (e.pointerType === "touch") return;
      const el = tipOf(e);
      if (el === target.current) return;
      if (el) show(el); else hide();
    };
    const onFocus = (e: FocusEvent) => {
      const el = tipOf(e);
      // 마우스로 누른 포커스에는 띄우지 않고 키보드 포커스에만 띄운다
      if (el && el.matches(":focus-visible")) show(el);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") hide(); };

    document.addEventListener("pointerover", onOver);
    document.addEventListener("pointerdown", hide, true);
    document.addEventListener("focusin", onFocus);
    document.addEventListener("focusout", hide);
    document.addEventListener("keydown", onKey, true);
    addEventListener("scroll", hide, true);
    addEventListener("blur", hide);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("pointerover", onOver);
      document.removeEventListener("pointerdown", hide, true);
      document.removeEventListener("focusin", onFocus);
      document.removeEventListener("focusout", hide);
      document.removeEventListener("keydown", onKey, true);
      removeEventListener("scroll", hide, true);
      removeEventListener("blur", hide);
    };
  }, []);

  // 띄운 뒤 크기를 재서 자리를 정한다. 요소가 사라졌으면(조건부 버튼) 닫는다
  useEffect(() => {
    const box = ref.current;
    if (!box) return;
    if (!tip) { if (box.matches(":popover-open")) box.hidePopover(); return; }
    if (tip.ready) return;
    const el = target.current;
    if (!el || !el.isConnected) { setTip(null); return; }
    if (!box.matches(":popover-open")) box.showPopover();
    const r = el.getBoundingClientRect();
    const w = box.offsetWidth, h = box.offsetHeight;
    let x: number, y: number;
    if (el.getAttribute("data-tip-side") === "right") {
      x = r.right + GAP;
      y = r.top + r.height / 2 - h / 2;
    } else {
      x = r.left + r.width / 2 - w / 2;
      y = r.bottom + GAP + h > innerHeight - EDGE ? r.top - GAP - h : r.bottom + GAP;
    }
    x = Math.min(Math.max(EDGE, x), innerWidth - w - EDGE);
    y = Math.min(Math.max(EDGE, y), innerHeight - h - EDGE);
    setTip({ ...tip, x, y, ready: true });
  }, [tip]);

  return (
    <div
      ref={ref}
      popover="manual"
      role="tooltip"
      className="pointer-events-none fixed m-0 max-w-[280px] rounded-md border-0 bg-fg px-2 py-1 text-xs leading-snug text-bg shadow-lg"
      style={{ inset: "auto", left: tip?.x ?? 0, top: tip?.y ?? 0, opacity: tip?.ready ? 1 : 0 }}
    >
      {tip?.text}
    </div>
  );
}
