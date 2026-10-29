import { useCallback, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { BookmarkCheck, History, LayoutPanelTop, Redo2, Undo2, X } from "lucide-react";
import { versionLabel } from "../../lib/api.ts";
import { getStructure, listRevisions, publishWork, restoreRevision, SaveConflict, applyOps, type Structure } from "../../lib/structedit.ts";
import { useConfirm } from "../../components/confirm/ConfirmProvider.tsx";
import { IconButton } from "../../components/IconButton.tsx";
import { EmptyState } from "../../components/EmptyState.tsx";
import { HtmlStructPane } from "./HtmlStructPane.tsx";
import { OfficeStructPane } from "./OfficeStructPane.tsx";
import { RevisionPanel } from "./RevisionPanel.tsx";

/**
 * 구조 편집(5.0 M2·M3·M5, Cloudflare). 표 행·열·열 너비, 그림 넣기·바꾸기, 블록 넣기·지우기·옮기기.
 * - 연산 하나가 곧 수정본 하나다(자동 저장). 버전은 그대로이고, "버전으로 저장"을 눌러야 다음 버전이 된다.
 * - 되돌리기·다시 하기는 이 화면에서 만든 수정본 사이를 오간다(서버 restore, 과거 수정본은 지우지 않는다).
 * - 다른 곳에서 먼저 저장했으면(409) 최신 작업본을 다시 불러온다. 오피스 표·그림 id는 위치가 아니라 순번이라 한 번 다시 적용한다.
 */

export interface StructCtx {
  menu: string; doc: string; s: Structure; busy: boolean;
  /** 연산을 적용해 수정본으로 저장한다. 성공하면 true */
  run: (ops: unknown[], summary?: string) => Promise<boolean>;
  setMessage: (m: string) => void;
}

export function StructEditor({ menu, doc, onExit }: { menu: string; doc: string; onExit: (savedVersion?: string) => void }) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const key = ["struct", menu, doc];
  const { data: s, error, refetch } = useQuery({ queryKey: key, queryFn: () => getStructure(menu, doc), staleTime: Infinity, gcTime: 0 });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [note, setNote] = useState("");
  // 이 화면에서 오간 수정본: 되돌리기는 undo의 마지막 rev로, 다시 하기는 redo의 마지막 rev로 restore한다
  const undo = useRef<number[]>([]);
  const redo = useRef<number[]>([]);
  const [, bump] = useState(0);

  const refresh = useCallback(async () => {
    await refetch();
    void qc.invalidateQueries({ queryKey: ["revisions", menu, doc] });
  }, [refetch, qc, menu, doc]);

  const run = useCallback(async (ops: unknown[], summary?: string) => {
    if (!s || busy) return false;
    setBusy(true);
    setMessage("");
    try {
      let base = s.rev;
      let r;
      try {
        r = await applyOps(menu, doc, base, ops, summary);
      } catch (e) {
        if (!(e instanceof SaveConflict) || s.kind === "html") throw e;
        // 오피스: 표·그림 id가 순번이라 최신 작업본에 같은 연산을 한 번 다시 적용한다
        base = (await refetch()).data!.rev;
        r = await applyOps(menu, doc, base, ops, summary);
      }
      if (r.changed) { undo.current.push(base); redo.current = []; }
      await refresh();
      return true;
    } catch (e) {
      if (e instanceof SaveConflict) {
        undo.current = []; redo.current = [];
        setMessage("다른 곳에서 먼저 저장해서 최신 작업본을 다시 불러왔습니다. 방금 바꾼 것을 다시 해 주세요.");
        await refresh();
      } else setMessage(String((e as Error).message));
      return false;
    } finally {
      setBusy(false);
      bump((n) => n + 1);
    }
  }, [s, busy, menu, doc, refetch, refresh]);

  /** from 맨 끝 rev로 되돌리고 지금 rev를 to에 쌓는다 */
  const travel = async (from: number[], to: number[]) => {
    if (!s || busy || from.length === 0) return;
    setBusy(true);
    setMessage("");
    try {
      await restoreRevision(menu, doc, from[from.length - 1], s.rev);
      from.pop();
      to.push(s.rev);
      await refresh();
    } catch (e) {
      if (e instanceof SaveConflict) { undo.current = []; redo.current = []; await refresh(); }
      setMessage(String((e as Error).message));
    } finally {
      setBusy(false);
      bump((n) => n + 1);
    }
  };

  const revisions = useQuery({ queryKey: ["revisions", menu, doc], queryFn: () => listRevisions(menu, doc) });
  const unpublished = !!revisions.data?.head && !revisions.data.revisions.find((r) => r.rev === revisions.data!.head)?.publishedAs;

  async function publish() {
    if (!s) return;
    const ok = await confirm({
      title: "작업본을 버전으로 저장할까요?", confirmText: "버전으로 저장",
      message: `${versionLabel(s.baseVersion)}은 그대로 두고 다음 버전을 만듭니다. 수정본 이력은 남습니다.`,
      details: [`작업본: 수정본 ${s.rev}`, `기준: ${versionLabel(s.baseVersion)}`, ...(note.trim() ? [`메모: ${note.trim()}`] : [])],
    });
    if (!ok) return;
    setBusy(true);
    try {
      const r = await publishWork(menu, doc, s.rev, note.trim() || undefined);
      void qc.invalidateQueries({ queryKey: ["doc", menu, doc] });
      onExit(r.version);
    } catch (e) {
      setMessage(String((e as Error).message));
      if (e instanceof SaveConflict) await refresh();
    } finally {
      setBusy(false);
    }
  }

  if (error) return <EmptyState title="구조를 불러올 수 없습니다" body={String((error as Error).message)} />;
  if (!s) return <EmptyState title="불러오는 중…" />;
  const ctx: StructCtx = { menu, doc, s, busy, run, setMessage };

  return (
    <div className="grid h-full grid-rows-[auto_minmax(0,1fr)]">
      <div>
        <div className="flex flex-wrap items-center gap-2 border-b border-line bg-accent-soft px-4 py-1.5">
          <LayoutPanelTop size={18} className="text-accent" aria-hidden />
          <span className="text-sm font-medium text-accent">구조 편집</span>
          <span className="text-xs text-muted">
            {s.kind === "html" ? "요소를 눌러 고르고 오른쪽에서 고칩니다 · 글자는 두 번 눌러 고침" : "표 행·열·열 너비와 그림을 고칩니다"}
          </span>
          <span className="ml-auto rounded-full bg-surface px-2 font-mono text-xs" aria-live="polite">
            {busy ? "저장 중…" : s.rev > 0 && unpublished ? `수정본 ${s.rev} · 자동 저장됨` : `${versionLabel(s.baseVersion)} 그대로`}
          </span>
          <input
            className="w-44 min-w-0 rounded-md border border-line bg-surface px-2 py-1 text-xs"
            placeholder="버전 메모 (선택)" value={note} onChange={(e) => setNote(e.target.value)} aria-label="버전 메모"
          />
          <IconButton icon={Undo2} label="되돌리기" disabled={busy || undo.current.length === 0} onClick={() => void travel(undo.current, redo.current)} />
          <IconButton icon={Redo2} label="다시 하기" disabled={busy || redo.current.length === 0} onClick={() => void travel(redo.current, undo.current)} />
          <IconButton icon={History} label="수정본 이력" active={historyOpen} onClick={() => setHistoryOpen((v) => !v)} />
          <IconButton icon={X} label="편집 끝내기 (작업본은 남습니다)" onClick={() => onExit()} />
          <IconButton icon={BookmarkCheck} label="버전으로 저장" text="버전으로 저장" variant="primary"
            disabled={busy || !unpublished} onClick={() => void publish()} />
        </div>
        {message && <p role="alert" className="bg-crit-soft px-4 py-1.5 text-xs text-crit">{message}</p>}
        <p className="bg-sunken px-4 py-1 text-[11px] text-muted">
          고칠 때마다 수정본으로 자동 저장됩니다. 보기 화면과 다른 사람에게는 「버전으로 저장」을 누른 뒤에 새 버전이 보입니다.
        </p>
      </div>
      <div className={`grid min-h-0 ${historyOpen ? "grid-cols-[minmax(0,1fr)_18rem]" : "grid-cols-1"}`}>
        {s.kind === "html" ? <HtmlStructPane key={`${menu}/${doc}`} ctx={ctx} /> : <OfficeStructPane ctx={ctx} />}
        {historyOpen && (
          <RevisionPanel menu={menu} doc={doc} current={s.rev} busy={busy} onRestore={async (rev) => {
            const ok = await confirm({
              title: rev === 0 ? `${versionLabel(s.baseVersion)} 내용으로 되돌릴까요?` : `수정본 ${rev}(으)로 되돌릴까요?`,
              confirmText: "되돌리기", tone: "warning",
              message: "그 내용으로 새 수정본을 만듭니다. 지금까지의 수정본은 이력에 남습니다.",
            });
            if (!ok) return;
            const stack = [rev];
            await travel(stack, undo.current);
            if (stack.length === 0) redo.current = [];
          }} />
        )}
      </div>
    </div>
  );
}
