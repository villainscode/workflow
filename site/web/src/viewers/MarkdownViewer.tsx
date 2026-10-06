import { useEffect, useMemo, useState } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { EditorView } from "@codemirror/view";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { useQueryClient } from "@tanstack/react-query";
import { saveMarkdown, useText, type VersionFile } from "../lib/api.ts";
import { clearDraft, loadDraft, saveDraft } from "../lib/draft.ts";
import { useDark } from "../lib/useDark.ts";
import { EmptyState } from "../components/EmptyState.tsx";
import { MarkdownPreview } from "./MarkdownPreview.tsx";

type Mode = "edit" | "split" | "preview";
const tab = (on: boolean) => `rounded-md px-2.5 py-1 text-xs ${on ? "bg-accent-soft text-accent" : "text-muted hover:bg-sunken"}`;

export interface DocContext { menu: string; doc: string; version: string; isCurrent: boolean }

// 저장하면 최신 버전이 바뀌어 편집기가 새로 그려진다. 저장 결과 안내를 새 편집기에서 이어 보여주기 위해 잠시 기억한다.
let lastSaved: { id: string; at: number } | null = null;

export function MarkdownViewer({ file, src, ctx }: { file: VersionFile; src: string; ctx: DocContext }) {
  const { data: original, error } = useText(src);
  if (error) return <EmptyState title="파일을 읽을 수 없습니다" body={String(error)} />;
  if (original === undefined) return <EmptyState title="불러오는 중…" />;
  return <Editor key={src} original={original} file={file} ctx={ctx} />;
}

function Editor({ original, file, ctx }: { original: string; file: VersionFile; ctx: DocContext }) {
  const dark = useDark();
  const qc = useQueryClient();
  const draftId = `${ctx.menu}/${ctx.doc}@${ctx.version}`;
  const [text, setText] = useState(original);
  const [mode, setMode] = useState<Mode>(() => (matchMedia("(min-width: 1024px)").matches ? "split" : "preview"));
  const [pendingDraft, setPendingDraft] = useState(() => {
    const d = ctx.isCurrent ? loadDraft(draftId) : null;
    return d !== null && d !== original ? d : null;
  });
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(() =>
    lastSaved && lastSaved.id === draftId && Date.now() - lastSaved.at < 10_000
      ? { kind: "ok", text: `${ctx.version}으로 저장했습니다` }
      : null);

  const dirty = text !== original;
  const baseUrl = file.url.slice(0, file.url.lastIndexOf("/") + 1);
  const extensions = useMemo(
    () => [markdown({ base: markdownLanguage, codeLanguages: languages }), EditorView.lineWrapping],
    [],
  );

  // 작성 중인 내용을 임시 보관하고, 저장하지 않고 떠나려 하면 경고한다
  useEffect(() => {
    if (!ctx.isCurrent) return;
    const t = setTimeout(() => (dirty ? saveDraft(draftId, text) : clearDraft(draftId)), 400);
    return () => clearTimeout(t);
  }, [text, dirty, draftId, ctx.isCurrent]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    addEventListener("beforeunload", warn);
    return () => removeEventListener("beforeunload", warn);
  }, [dirty]);

  async function save() {
    setSaving(true);
    setMessage(null);
    try {
      const r = await saveMarkdown(ctx.menu, ctx.doc, { baseVersion: ctx.version, content: text, note });
      clearDraft(draftId);
      lastSaved = { id: `${ctx.menu}/${ctx.doc}@${r.version}`, at: Date.now() };
      setMessage({ kind: "ok", text: `${r.version}으로 저장했습니다` });
      await qc.invalidateQueries({ queryKey: ["doc", ctx.menu, ctx.doc] });
      await qc.invalidateQueries({ queryKey: ["tree"] });
    } catch (e) {
      setMessage({ kind: "error", text: (e as Error).message });
    } finally {
      setSaving(false);
    }
  }

  const showEditor = mode !== "preview";
  const showPreview = mode !== "edit";

  return (
    <div className="grid h-full grid-rows-[auto_auto_minmax(0,1fr)]">
      <div className="flex flex-wrap items-center gap-2 border-b border-line bg-surface px-4 py-1.5">
        <div className="flex gap-1">
          <button className={tab(mode === "edit")} onClick={() => setMode("edit")}>편집</button>
          <button className={`${tab(mode === "split")} hidden lg:inline`} onClick={() => setMode("split")}>나란히</button>
          <button className={tab(mode === "preview")} onClick={() => setMode("preview")}>미리보기</button>
        </div>
        {ctx.isCurrent ? (
          <form className="ml-auto flex min-w-0 flex-1 items-center justify-end gap-2" onSubmit={(e) => { e.preventDefault(); void save(); }}>
            {dirty && <span className="text-xs text-med">저장하지 않은 변경</span>}
            <input
              className="w-full max-w-64 min-w-0 rounded-md border border-line bg-surface px-2 py-1 text-xs"
              placeholder="변경 메모 (선택)" value={note} onChange={(e) => setNote(e.target.value)} disabled={!dirty}
            />
            <button type="submit" disabled={!dirty || saving}
              className="shrink-0 rounded-md bg-accent px-3 py-1 text-xs font-medium text-surface disabled:opacity-40">
              {saving ? "저장 중…" : "저장 → 새 버전"}
            </button>
          </form>
        ) : (
          <span className="ml-auto text-xs text-muted">이전 버전은 읽기 전용입니다. 최신 버전에서 편집하세요.</span>
        )}
      </div>

      <div>
        {pendingDraft !== null && (
          <div className="flex flex-wrap items-center gap-2 bg-med-soft px-4 py-1.5 text-xs text-med">
            저장하지 않은 작성 내용이 브라우저에 남아 있습니다.
            <button className="underline" onClick={() => { setText(pendingDraft); setPendingDraft(null); }}>불러오기</button>
            <button className="underline" onClick={() => { clearDraft(draftId); setPendingDraft(null); }}>버리기</button>
          </div>
        )}
        {message && (
          <p className={`px-4 py-1.5 text-xs ${message.kind === "ok" ? "bg-ok-soft text-ok" : "bg-high-soft text-high"}`}>{message.text}</p>
        )}
      </div>

      <div className={`grid min-h-0 ${showEditor && showPreview ? "grid-cols-2" : "grid-cols-1"}`}>
        {showEditor && (
          <div className="min-h-0 min-w-0 overflow-hidden border-r border-line">
            <CodeMirror
              value={text}
              onChange={setText}
              editable={ctx.isCurrent}
              readOnly={!ctx.isCurrent}
              theme={dark ? "dark" : "light"}
              extensions={extensions}
              height="100%"
              className="h-full text-[13px]"
              basicSetup={{ foldGutter: false, highlightActiveLineGutter: ctx.isCurrent }}
            />
          </div>
        )}
        {showPreview && (
          <div className="min-h-0 min-w-0 overflow-y-auto bg-surface px-6 py-5">
            <MarkdownPreview source={text} baseUrl={baseUrl} />
          </div>
        )}
      </div>
    </div>
  );
}
