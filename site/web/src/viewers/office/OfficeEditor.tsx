import { useEffect, useRef, useState } from "react";
import { FileText, X } from "lucide-react";
import { IconButton } from "../../components/IconButton.tsx";
import { EmptyState } from "../../components/EmptyState.tsx";
import { keepOfficeAlive, loadDocsApi, officeState, officeStatus, openOfficeSession, type DocEditor } from "../../lib/office.ts";

/**
 * 오피스 편집기(6.0 VO, D-59): DOCX·PPTX·XLSX를 ONLYOFFICE Docs로 서식까지 고친다.
 * 1) 편집 서버가 깨어날 때까지 기다린다(콜드 스타트, 진행 막대) 2) 서명된 설정으로 편집기를 연다(이 문서의 다른 쓰기는 잠긴다)
 * 3) 닫으면 오피스 서버가 파일을 콜백으로 보내 수정본 하나가 된다(보통 닫고 10초 안). 저장이 끝나면 구조 편집 화면으로 돌아가
 *    「버전으로 저장」을 고른다. 같은 문서를 연 다른 사람이 있으면 모두 닫은 뒤에 저장된다(공동 편집).
 */

type Phase = "waking" | "opening" | "editing" | "saving" | "error";
const WAKE_LIMIT = 180_000, SAVE_LIMIT = 90_000;
const pause = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

export function OfficeEditor({ menu, doc, onExit }: { menu: string; doc: string; onExit: (savedRev?: number) => void }) {
  const [phase, setPhase] = useState<Phase>("waking");
  const [pct, setPct] = useState(0);
  const [message, setMessage] = useState("");
  const editor = useRef<DocEditor | null>(null);
  const session = useRef<{ key: string; rev: number } | null>(null);
  const closing = useRef(false);
  const host = useRef<HTMLDivElement>(null);
  const frameId = `office-frame-${menu}-${doc}`.replace(/[^\w-]/g, "_");

  useEffect(() => {
    let stop = false;
    let alive: ReturnType<typeof setInterval> | undefined;
    (async () => {
      // 깨우기: 서버가 준비될 때까지(보통 수십 초) 경과 시간으로 90%까지 채운다
      const t0 = Date.now();
      for (;;) {
        if (stop) return;
        const st = await officeStatus().catch(() => ({ enabled: true, ready: false }));
        if (!st.enabled) throw new Error("오피스 편집기를 쓸 수 없는 환경입니다");
        if (st.ready) break;
        if (Date.now() - t0 > WAKE_LIMIT) throw new Error("편집 서버가 3분 안에 준비되지 않았습니다. 잠시 뒤 다시 여세요");
        setPct(Math.round(90 * (1 - Math.exp(-(Date.now() - t0) / 30_000))));
        await pause(2000);
      }
      setPct(95);
      setPhase("opening");
      const s = await openOfficeSession(menu, doc);
      await loadDocsApi(s.apiUrl);
      if (stop || !window.DocsAPI) return;
      session.current = { key: s.key, rev: s.rev };
      // DocsAPI는 이 자리 요소를 iframe으로 바꾼다. React가 모르는 요소로 둔다(바뀐 뒤 React가 지우려다 오류가 나지 않게)
      const slot = document.createElement("div");
      slot.id = frameId;
      host.current?.replaceChildren(slot);
      editor.current = new window.DocsAPI.DocEditor(frameId, {
        ...s.config, width: "100%", height: "100%",
        events: { onDocumentReady: () => setPhase("editing"), onRequestClose: () => void close() },
      });
      setPct(100);
      setPhase("editing");
      // 세션 연장(15분 만료). 끊기면 잠금이 풀린 것이라 알린다
      alive = setInterval(() => {
        void keepOfficeAlive(menu, doc, s.key).then((r) => { if (!r.alive && !closing.current) setMessage("편집 세션이 끝났습니다. 닫고 다시 여세요"); }).catch(() => {});
      }, s.keepAliveMs);
    })().catch((e) => { if (!stop) { setPhase("error"); setMessage(String((e as Error).message)); } });
    return () => {
      stop = true;
      if (alive) clearInterval(alive);
      editor.current?.destroyEditor();
      editor.current = null;
    };
  }, [menu, doc]); // eslint-disable-line react-hooks/exhaustive-deps

  /** 닫기: 편집기를 내리고 오피스 서버의 저장 콜백(세션이 풀림)을 기다린다 */
  async function close() {
    if (closing.current) return;
    closing.current = true;
    editor.current?.destroyEditor();
    editor.current = null;
    if (!session.current) return onExit();
    setPhase("saving");
    const t0 = Date.now();
    while (Date.now() - t0 < SAVE_LIMIT) {
      setPct(Math.round(95 * (1 - Math.exp(-(Date.now() - t0) / 10_000))));
      const st = await officeState(menu, doc).catch(() => null);
      if (st && !st.active) return onExit(st.rev > session.current.rev ? st.rev : undefined);
      await pause(2000);
    }
    setMessage("다른 사람이 아직 같은 문서를 편집하고 있어 저장은 모두 닫은 뒤에 됩니다");
    await pause(3000);
    onExit();
  }

  const waiting = phase === "waking" || phase === "opening" || phase === "saving";
  return (
    <div className="grid h-full grid-rows-[auto_minmax(0,1fr)]">
      <div>
        <div className="flex flex-wrap items-center gap-2 border-b border-line bg-accent-soft px-4 py-1.5">
          <FileText size={18} className="text-accent" aria-hidden />
          <span className="text-sm font-medium text-accent">오피스 편집기</span>
          <span className="text-xs text-muted">닫으면 수정본으로 저장되고, 「버전으로 저장」은 다음 화면에서 고릅니다</span>
          <IconButton className="ml-auto" icon={X} label="닫고 저장" text="닫고 저장" variant="primary" disabled={phase === "saving"} onClick={() => void close()} />
        </div>
        {waiting && (
          <div role="status" className="border-b border-line bg-sunken px-4 py-1.5 text-xs text-muted">
            <p>{phase === "waking" ? "편집 서버를 깨우는 중…" : phase === "opening" ? "편집기를 여는 중…" : "저장하는 중…"} {pct}%</p>
            <div role="progressbar" aria-label="오피스 편집기 진행" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} className="mt-1 h-1.5 overflow-hidden rounded-sm bg-line">
              <div className="h-full bg-accent transition-[width] duration-150" style={{ width: `${pct}%` }} />
            </div>
          </div>
        )}
        {message && <p role="alert" className="bg-crit-soft px-4 py-1.5 text-xs text-crit">{message}</p>}
      </div>
      {phase === "error" ? <EmptyState title="오피스 편집기를 열 수 없습니다" body={message} />
        : <div ref={host} className="min-h-0 [&>*]:h-full" />}
    </div>
  );
}
