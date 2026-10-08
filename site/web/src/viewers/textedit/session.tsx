import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Save, TextCursorInput, Undo2, X } from "lucide-react";
import { versionLabel } from "../../lib/api.ts";
import { clearTextDraft, loadTextDraft, saveTextDraft, saveTextEdit, useSegments, type Segment } from "../../lib/textedit.ts";
import { useConfirm } from "../../components/confirm/ConfirmProvider.tsx";
import { IconButton } from "../../components/IconButton.tsx";

/**
 * 텍스트 편집(2.0) 공통 세션: 조각 목록, 바뀐 조각, 임시 보관, 저장·취소.
 * 화면(HTML iframe, DOCX·PPTX 목록)은 write(id, text)로 자기 화면의 글자를 바꾸는 방법만 넘긴다.
 */

const short = (t: string, n = 28) => (t.length > n ? t.slice(0, n) + "…" : t);

export interface TextSession {
  segments: Segment[] | undefined;
  segs: Map<number, Segment>;
  error: unknown;
  version: string;
  changes: Map<number, string>;
  /** 화면에서 글자가 바뀌었을 때 알린다(원래 글자와 같으면 변경 목록에서 빠진다) */
  change: (id: number, text: string) => void;
  /** 화면 글자까지 바꾼다(되돌리기·임시 보관 불러오기) */
  set: (id: number, text: string) => void;
  revertAll: () => void;
  pendingDraft: Record<string, string> | null;
  restoreDraft: () => void;
  discardDraft: () => void;
  note: string;
  setNote: (n: string) => void;
  saving: boolean;
  message: string;
  save: () => Promise<void>;
  cancel: () => Promise<void>;
}

export function useTextSession({ menu, doc, version, onExit, write }: {
  menu: string; doc: string; version: string;
  onExit: (savedVersion?: string) => void;
  /** 화면의 조각 글자를 바꾼다(바뀜 표시 포함) */
  write: (id: number, text: string, changed: boolean) => void;
}): TextSession {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const { data, error } = useSegments(menu, doc, version);
  const draftId = `${menu}/${doc}@${version}`;
  const [changes, setChanges] = useState<Map<number, string>>(new Map());
  const [pendingDraft, setPendingDraft] = useState<Record<string, string> | null>(() => loadTextDraft(draftId));
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");

  const segs = useMemo(() => new Map((data?.segments ?? []).map((s) => [s.id, s])), [data]);
  const segsRef = useRef(segs);
  segsRef.current = segs;
  const writeRef = useRef(write);
  writeRef.current = write;

  const change = useCallback((id: number, text: string) => {
    const seg = segsRef.current.get(id);
    if (!seg) return;
    setChanges((prev) => {
      const next = new Map(prev);
      if (text === seg.text) next.delete(id); else next.set(id, text);
      return next;
    });
  }, []);
  const set = useCallback((id: number, text: string) => {
    const seg = segsRef.current.get(id);
    if (!seg) return;
    writeRef.current(id, text, text !== seg.text);
    change(id, text);
  }, [change]);

  // 작성 중 내용 임시 보관(불러오기·버리기를 고르기 전에는 덮어쓰지 않는다), 저장하지 않고 떠나면 경고
  useEffect(() => { if (!pendingDraft) saveTextDraft(draftId, changes); }, [changes, draftId, pendingDraft]);
  useEffect(() => {
    if (changes.size === 0) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    addEventListener("beforeunload", warn);
    return () => removeEventListener("beforeunload", warn);
  }, [changes.size]);

  const changeList = [...changes].map(([id, text]) => ({ seg: segs.get(id) as Segment, text }));

  async function save() {
    const ok = await confirm({
      title: `변경 ${changes.size}건을 저장할까요?`, confirmText: "저장",
      message: "기존 버전은 그대로 두고 새 버전으로 저장합니다. 태그·서식은 바뀌지 않습니다.",
      details: [
        ...changeList.slice(0, 6).map(({ seg, text }) => `「${short(seg.text)}」 → 「${short(text)}」`),
        ...(changeList.length > 6 ? [`외 ${changeList.length - 6}건`] : []),
        ...(note.trim() ? [`메모: ${note.trim()}`] : []),
      ],
    });
    if (!ok) return;
    setSaving(true);
    setMessage("");
    try {
      const r = await saveTextEdit(menu, doc, {
        baseVersion: version, note: note.trim() || `텍스트 ${changes.size}곳 수정`,
        changes: changeList.map(({ seg, text }) => ({ id: seg.id, hash: seg.hash, text })),
      });
      clearTextDraft(draftId);
      await qc.invalidateQueries({ queryKey: ["doc", menu, doc] });
      void qc.invalidateQueries({ queryKey: ["tree"] });
      onExit(r.version);
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function cancel() {
    if (changes.size > 0) {
      const ok = await confirm({
        title: `변경 ${changes.size}건을 버리고 편집을 끝낼까요?`, tone: "warning", confirmText: "버리기",
        message: "저장하지 않은 수정 내용이 사라집니다.",
      });
      if (!ok) return;
    }
    clearTextDraft(draftId);
    onExit();
  }

  return {
    segments: data?.segments, segs, error, version, changes, change, set,
    revertAll: () => { for (const id of [...changes.keys()]) set(id, segs.get(id)!.text); },
    pendingDraft,
    restoreDraft: () => { for (const [id, text] of Object.entries(pendingDraft ?? {})) set(Number(id), text); setPendingDraft(null); },
    discardDraft: () => { clearTextDraft(draftId); setPendingDraft(null); },
    note, setNote, saving, message, save, cancel,
  };
}

/** 편집 막대 + 임시 보관 안내 + 오류 + 한 줄 안내 */
export function EditBar({ s, hint, notice }: { s: TextSession; hint: string; notice: string }) {
  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 border-b border-line bg-accent-soft px-4 py-1.5">
        <TextCursorInput size={18} className="text-accent" aria-hidden />
        <span className="text-sm font-medium text-accent">텍스트 편집</span>
        <span className="text-xs text-muted">{hint}</span>
        <span className="ml-auto rounded-full bg-surface px-2 font-mono text-xs">변경 {s.changes.size}건</span>
        <input
          className="w-48 min-w-0 rounded-md border border-line bg-surface px-2 py-1 text-xs"
          placeholder="변경 메모 (선택)" value={s.note} onChange={(e) => s.setNote(e.target.value)}
        />
        <IconButton icon={Undo2} label="모두 되돌리기" disabled={s.changes.size === 0} onClick={s.revertAll} />
        <IconButton icon={X} label="편집 끝내기" onClick={() => void s.cancel()} />
        <IconButton icon={Save} label={s.saving ? "저장 중…" : "저장 (새 버전)"} variant="primary"
          disabled={s.changes.size === 0 || s.saving} onClick={() => void s.save()} />
      </div>
      {s.pendingDraft && (
        <div className="flex flex-wrap items-center gap-2 bg-med-soft px-4 py-1.5 text-xs text-med">
          저장하지 않은 수정 {Object.keys(s.pendingDraft).length}건이 브라우저에 남아 있습니다.
          <button className="underline" onClick={s.restoreDraft}>불러오기</button>
          <button className="underline" onClick={s.discardDraft}>버리기</button>
        </div>
      )}
      {s.message && <p className="bg-crit-soft px-4 py-1.5 text-xs text-crit">{s.message}</p>}
      <p className="bg-sunken px-4 py-1 text-[11px] text-muted">{notice} {versionLabel(s.version)} 기준으로 저장하면 새 버전이 됩니다.</p>
    </div>
  );
}
