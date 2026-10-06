import { useEffect, useRef, type ReactNode } from "react";
import { X } from "lucide-react";
import { IconButton } from "./IconButton.tsx";

/** 공통 대화상자. 닫기(Esc, ✕, 바깥 배경)는 onClose로 알린다. */
export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { ref.current?.showModal(); }, []);
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(e) => { if (e.target === ref.current) onClose(); }}
      className={`m-auto ${wide ? "w-[min(720px,calc(100vw-24px))]" : "w-[min(460px,calc(100vw-24px))]"} max-h-[calc(100dvh-24px)] rounded-xl border border-line bg-surface p-0 text-fg backdrop:bg-black/40`}
    >
      <div className="grid gap-4 p-5">
        <div className="flex items-center justify-between gap-4">
          <h2 className="text-lg font-bold">{title}</h2>
          <IconButton icon={X} label="닫기" size={22} onClick={onClose} />
        </div>
        {children}
      </div>
    </dialog>
  );
}

export const ui = {
  field: "w-full rounded-md border border-line bg-surface px-2.5 py-1.5 text-sm",
  label: "grid gap-1 text-xs font-medium text-muted",
  primary: "rounded-md bg-accent px-4 py-1.5 text-sm font-medium text-surface disabled:opacity-50",
  secondary: "rounded-md border border-line px-4 py-1.5 text-sm hover:bg-sunken",
  danger: "rounded-md border border-crit px-4 py-1.5 text-sm text-crit hover:bg-crit-soft",
  error: "rounded-md bg-high-soft px-3 py-2 text-sm text-high",
};
