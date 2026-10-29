import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { CircleHelp, OctagonAlert, TriangleAlert, type LucideIcon } from "lucide-react";

/**
 * 공통 확인 창. 저장·수정·삭제·다운로드·휴지통 이동처럼 데이터를 바꾸거나 내보내는 작업은 이 창을 거쳐 실행한다.
 *   const confirm = useConfirm();
 *   if (!(await confirm({ title: "삭제할까요?", message: "...", tone: "danger" }))) return;
 */

export type Tone = "default" | "warning" | "danger";

export interface ConfirmOptions {
  title: string;
  message?: ReactNode;
  /** 무엇이 바뀌는지 짧게 나열 (예: ["대상: 리뷰 게이트", "버전: v0.2"]) */
  details?: ReactNode[];
  confirmText?: string;
  cancelText?: string;
  tone?: Tone;
}

const TONE: Record<Tone, { icon: LucideIcon; iconClass: string; button: string }> = {
  default: { icon: CircleHelp, iconClass: "bg-accent-soft text-accent", button: "bg-accent text-surface" },
  warning: { icon: TriangleAlert, iconClass: "bg-med-soft text-med", button: "bg-med text-surface" },
  danger: { icon: OctagonAlert, iconClass: "bg-crit-soft text-crit", button: "bg-crit text-surface" },
};

type Ask = (options: ConfirmOptions) => Promise<boolean>;
const Ctx = createContext<Ask>(async () => false);
export const useConfirm = () => useContext(Ctx);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<{ options: ConfirmOptions; resolve: (ok: boolean) => void } | null>(null);
  const ask = useCallback<Ask>((options) => new Promise((resolve) => setPending({ options, resolve })), []);
  const answer = (ok: boolean) => { pending?.resolve(ok); setPending(null); };
  return (
    <Ctx.Provider value={ask}>
      {children}
      {pending && <ConfirmDialog options={pending.options} onAnswer={answer} />}
    </Ctx.Provider>
  );
}

function ConfirmDialog({ options, onAnswer }: { options: ConfirmOptions; onAnswer: (ok: boolean) => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const okRef = useRef<HTMLButtonElement>(null);
  const tone = TONE[options.tone ?? "default"];
  const Icon = tone.icon;
  const armed = useRef(false);

  useEffect(() => {
    const dialog = ref.current!;
    dialog.showModal();
    // showModal은 첫 버튼("취소")에 바로 포커스를 준다. 이 창을 연 Enter 바로 뒤에 Enter가 한 번 더 오면(맥 한글 입력기는 조합 끝에 Enter를 두 번 보낸다)
    // 그 Enter가 "취소"를 눌러 버리므로, 처음에는 창 자체에 포커스를 두고 버튼 포커스는 잠깐 뒤에 준다. 그 전의 Enter·Space는 버린다.
    // 위험한 작업은 실수로 Enter를 눌러도 실행되지 않도록 "취소"에 포커스를 둔다
    dialog.focus();
    const t = setTimeout(() => { armed.current = true; (options.tone === "danger" ? cancelRef : okRef).current?.focus(); }, 60);
    return () => clearTimeout(t);
  }, [options.tone]);

  return (
    <dialog
      ref={ref}
      tabIndex={-1}
      onCancel={(e) => { e.preventDefault(); onAnswer(false); }}
      onKeyDownCapture={(e) => { if (!armed.current && (e.key === "Enter" || e.key === " ")) e.preventDefault(); }}
      className="m-auto w-[min(420px,calc(100vw-24px))] rounded-xl border border-line bg-surface p-0 text-fg outline-none backdrop:bg-black/40"
      aria-labelledby="confirm-title"
    >
      <div className="grid gap-4 p-5">
        <div className="flex gap-3">
          <span className={`grid size-10 shrink-0 place-items-center rounded-full ${tone.iconClass}`}>
            <Icon size={22} aria-hidden />
          </span>
          <div className="grid min-w-0 flex-1 gap-1.5 pt-1">
            <h2 id="confirm-title" className="text-base font-bold">{options.title}</h2>
            {options.message && <div className="text-sm text-muted">{options.message}</div>}
            {options.details && options.details.length > 0 && (
              <ul className="mt-1 grid gap-0.5 rounded-md bg-sunken px-3 py-2 text-xs break-all">
                {options.details.map((d, i) => <li key={i}>{d}</li>)}
              </ul>
            )}
          </div>
        </div>
        <div className="flex justify-end gap-2">
          <button ref={cancelRef} type="button" className="rounded-md border border-line px-4 py-1.5 text-sm hover:bg-sunken" onClick={() => onAnswer(false)}>
            {options.cancelText ?? "취소"}
          </button>
          <button ref={okRef} type="button" className={`rounded-md px-4 py-1.5 text-sm font-medium hover:opacity-90 ${tone.button}`} onClick={() => onAnswer(true)}>
            {options.confirmText ?? "확인"}
          </button>
        </div>
      </div>
    </dialog>
  );
}
