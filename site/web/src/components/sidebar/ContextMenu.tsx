import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { LucideIcon } from "lucide-react";

export type MenuEntry =
  | { label: string; icon: LucideIcon; onSelect: () => void; danger?: boolean; disabled?: boolean }
  | "separator";

/**
 * 사이드바 폴더·문서의 오른쪽 클릭(⋯) 메뉴. 화면 기준(fixed)으로 띄우고 화면 밖으로 나가지 않게 당긴다.
 * 바깥을 누르거나 Esc면 닫힌다. ↑↓로 항목을 옮긴다.
 */
export function ContextMenu({ x, y, label, items, onClose }: { x: number; y: number; label: string; items: MenuEntry[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  useLayoutEffect(() => {
    const r = ref.current!.getBoundingClientRect();
    setPos({ left: Math.max(8, Math.min(x, innerWidth - r.width - 8)), top: Math.max(8, Math.min(y, innerHeight - r.height - 8)) });
    ref.current!.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, [x, y]);

  useEffect(() => {
    const down = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) onClose(); };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); onClose(); return; }
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      e.preventDefault();
      const buttons = [...ref.current!.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
      const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
      buttons[(i + (e.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length]?.focus();
    };
    document.addEventListener("pointerdown", down, true);
    document.addEventListener("keydown", key);
    window.addEventListener("blur", onClose);
    return () => {
      document.removeEventListener("pointerdown", down, true);
      document.removeEventListener("keydown", key);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);

  return (
    <div ref={ref} role="menu" aria-label={label} style={pos}
      className="fixed z-50 grid min-w-48 rounded-lg border border-line bg-surface p-1 shadow-xl">
      {items.map((it, i) => it === "separator"
        ? <div key={i} role="separator" className="my-1 h-px bg-line" />
        : (
          <button key={it.label} type="button" role="menuitem" disabled={it.disabled}
            className={`flex items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm outline-none disabled:opacity-40 ${
              it.danger ? "text-crit hover:bg-crit-soft focus:bg-crit-soft" : "hover:bg-sunken focus:bg-sunken"}`}
            onClick={() => { onClose(); it.onSelect(); }}>
            <it.icon size={16} aria-hidden className={it.danger ? "" : "text-muted"} />
            {it.label}
          </button>
        ))}
    </div>
  );
}
