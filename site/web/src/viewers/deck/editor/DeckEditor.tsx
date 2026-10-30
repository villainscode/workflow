import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { BookmarkCheck, History, Presentation, Redo2, Undo2, X } from "lucide-react";
import { versionLabel } from "../../../lib/api.ts";
import { deckFamily, useDeckFonts } from "../../../lib/deck.ts";
import { publishWork, restoreRevision, SaveConflict } from "../../../lib/structedit.ts";
import { useConfirm } from "../../../components/confirm/ConfirmProvider.tsx";
import { IconButton } from "../../../components/IconButton.tsx";
import { EmptyState } from "../../../components/EmptyState.tsx";
import { FitSlide } from "../DeckViewer.tsx";
import { RevisionPanel } from "../../structedit/RevisionPanel.tsx";
import { EditCanvas } from "./EditCanvas.tsx";
import { Inspector } from "./Inspector.tsx";
import { SlideList } from "./SlideList.tsx";
import { useDeckEditor } from "./useDeckEditor.ts";
import { useOtherSave } from "../../../lib/live.ts";
import { useMe } from "../../../lib/me.ts";

/**
 * 슬라이드 편집기(5.0 M4, 명세 06절): 왼쪽 슬라이드 목록 · 가운데 캔버스 · 오른쪽 속성 패널.
 * 편집은 800ms 묶음으로 수정본에 자동 저장되고, 「버전으로 저장」을 눌러야 새 버전이 된다(구조 편집과 같은 두 층).
 */
export function DeckEditor({ menu, doc, onExit }: { menu: string; doc: string; onExit: (savedVersion?: string) => void }) {
  const ed = useDeckEditor(menu, doc);
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [current, setCurrent] = useState("");
  const [selection, setSelection] = useState<string[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [note, setNote] = useState("");
  useDeckFonts(ed.deck?.index);

  const order = ed.deck?.index.order ?? [];
  useEffect(() => { if (order.length && !order.includes(current)) setCurrent(order[0]); }, [order, current]);
  useEffect(() => { setSelection([]); }, [current]);
  // 다른 사람·Claude Code가 이 덱을 저장하면 최신으로 바꾼다(보내지 않은 내 편집은 보낼 때 서버가 최신본에 다시 얹는다)
  const me = useMe().me?.user?.id;
  useOtherSave(menu, doc, me, ed.deck?.rev, (e) => {
    if (ed.pending) return;
    void ed.reload().then(() => ed.setMessage(`${e.by === "claude-code" ? "Claude Code가" : "다른 사람이"} 저장해 최신 내용으로 바꿨습니다.`));
  });
  // 저장될 때마다 수정본 이력을 새로 읽는다
  useEffect(() => { void qc.invalidateQueries({ queryKey: ["revisions", menu, doc] }); }, [ed.deck?.rev, qc, menu, doc]);

  if (ed.error) return <EmptyState title="덱을 열 수 없습니다" body={ed.error} />;
  if (!ed.deck || !current || !ed.deck.slides[current]) return <EmptyState title="불러오는 중…" />;
  const deck = ed.deck;
  const slide = deck.slides[current];
  const family = deckFamily(deck.index);
  const palette = deck.index.palette ?? ["#1c2026", "#ffffff"];

  const go = async (id: string) => { await ed.flush(); setCurrent(id); };
  const travel = (fn: () => string | null) => { const sid = fn(); if (sid && sid !== current) setCurrent(sid); };

  async function publish() {
    await ed.flush();
    const ok = await confirm({
      title: "작업본을 버전으로 저장할까요?", confirmText: "버전으로 저장",
      message: `${versionLabel(deck.baseVersion)}은 그대로 두고 다음 버전을 만듭니다. 수정본 이력은 남습니다.`,
      details: [`작업본: 수정본 ${ed.deck!.rev}`, ...(note.trim() ? [`메모: ${note.trim()}`] : [])],
    });
    if (!ok) return;
    try {
      const r = await publishWork(menu, doc, ed.deck!.rev, note.trim() || undefined);
      void qc.invalidateQueries({ queryKey: ["doc", menu, doc] });
      onExit(r.version);
    } catch (e) {
      ed.setMessage(String((e as Error).message));
      if (e instanceof SaveConflict) await ed.reload();
    }
  }

  return (
    <div className="grid h-full grid-rows-[auto_minmax(0,1fr)]">
      <div>
        <div className="flex flex-wrap items-center gap-2 border-b border-line bg-accent-soft px-4 py-1.5">
          <Presentation size={18} className="text-accent" aria-hidden />
          <span className="text-sm font-medium text-accent">슬라이드 편집</span>
          <span className="text-xs text-muted">누르면 고르고 · 두 번 누르면 글자 · 끌어서 옮기기 · ⌘Z 되돌리기</span>
          <span className="ml-auto rounded-full bg-surface px-2 font-mono text-xs" aria-live="polite">
            {ed.saving || ed.pending ? "저장 중…" : deck.rev > 0 ? `수정본 ${deck.rev} · 자동 저장됨` : `${versionLabel(deck.baseVersion)} 그대로`}
          </span>
          <input className="w-40 min-w-0 rounded-md border border-line bg-surface px-2 py-1 text-xs" placeholder="버전 메모 (선택)"
            value={note} onChange={(e) => setNote(e.target.value)} aria-label="버전 메모" />
          <IconButton icon={Undo2} label="되돌리기 (⌘Z)" disabled={!ed.canUndo} onClick={() => travel(ed.undo)} />
          <IconButton icon={Redo2} label="다시 하기 (⇧⌘Z)" disabled={!ed.canRedo} onClick={() => travel(ed.redo)} />
          <IconButton icon={History} label="수정본 이력" active={historyOpen} onClick={() => setHistoryOpen((v) => !v)} />
          <IconButton icon={X} label="편집 끝내기 (작업본은 남습니다)" onClick={async () => { await ed.flush(); onExit(); }} />
          <IconButton icon={BookmarkCheck} label="버전으로 저장" text="버전으로 저장" variant="primary" disabled={ed.saving || deck.rev === 0} onClick={() => void publish()} />
        </div>
        {ed.message && <p role="alert" className="bg-crit-soft px-4 py-1.5 text-xs whitespace-pre-wrap text-crit">{ed.message}</p>}
      </div>
      <div className={`grid min-h-0 ${historyOpen ? "grid-cols-[12rem_minmax(0,1fr)_17rem_16rem]" : "grid-cols-[12rem_minmax(0,1fr)_17rem]"}`}>
        <SlideList order={order} slides={deck.slides} current={current} family={family} busy={ed.saving}
          onSelect={(id) => void go(id)}
          onReorder={(o) => void ed.reorder(o)}
          onAdd={async (after) => { const id = await ed.add(after); if (id) setCurrent(id); }}
          onDuplicate={async (id) => { const nid = await ed.add(order.indexOf(id), deck.slides[id]); if (nid) setCurrent(nid); }}
          onRemove={async (id) => {
            if (await confirm({ title: `${order.indexOf(id) + 1}번 슬라이드를 지울까요?`, confirmText: "지우기", tone: "danger",
              message: "수정본 이력에서 예전 수정본으로 되돌려 살릴 수 있습니다." })) await ed.remove(id);
          }} />
        <div className="flex min-h-0 flex-col">
          <FitSlide>{(w) => (
            <EditCanvas key={current} slide={slide} family={family} width={w} selection={selection} setSelection={setSelection}
              apply={(ops) => ed.apply(current, ops)} onUndo={() => travel(ed.undo)} onRedo={() => travel(ed.redo)} setMessage={ed.setMessage} />
          )}</FitSlide>
        </div>
        <Inspector slide={slide} selection={selection} setSelection={setSelection} apply={(ops) => ed.apply(current, ops)} palette={palette} setMessage={ed.setMessage} />
        {historyOpen && (
          <RevisionPanel menu={menu} doc={doc} current={deck.rev} busy={ed.saving} onRestore={async (rev) => {
            await ed.flush();
            const ok = await confirm({ title: rev === 0 ? `${versionLabel(deck.baseVersion)} 내용으로 되돌릴까요?` : `수정본 ${rev}(으)로 되돌릴까요?`,
              confirmText: "되돌리기", tone: "warning", message: "그 내용으로 새 수정본을 만듭니다. 지금까지의 수정본은 이력에 남습니다." });
            if (!ok) return;
            try { await restoreRevision(menu, doc, rev, ed.deck!.rev); } catch (e) { ed.setMessage(String((e as Error).message)); }
            await ed.reload();
            void qc.invalidateQueries({ queryKey: ["revisions", menu, doc] });
          }} />
        )}
      </div>
    </div>
  );
}

