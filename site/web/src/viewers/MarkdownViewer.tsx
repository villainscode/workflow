import { useCallback, useEffect, useState } from "react";
import { useLocation } from "react-router";
import { Save } from "lucide-react";
import { IconButton } from "../components/IconButton.tsx";
import { useQueryClient } from "@tanstack/react-query";
import { nextVersion, saveMarkdown, useText, useTree, versionLabel, type MenuNode, type VersionFile } from "../lib/api.ts";
import { useConfirm } from "../components/confirm/ConfirmProvider.tsx";
import { clearDraft, loadDraft, saveDraft } from "../lib/draft.ts";
import { EmptyState } from "../components/EmptyState.tsx";
import { MarkdownEditor } from "./markdown-editor/MarkdownEditor.tsx";
import type { EditorLayout, WikiLinkItem } from "./markdown-editor/types.ts";

/** scripts: HTML 문서의 스크립트 실행 여부. 외부에서 가져온 문서는 처음에 끈다(3.3, D-25) */
export interface DocContext { menu: string; doc: string; version: string; isCurrent: boolean; scripts?: boolean }

// 저장하면 최신 버전이 바뀌어 편집기가 새로 그려진다. 저장 결과 안내를 새 편집기에서 이어 보여주기 위해 잠시 기억한다.
let lastSaved: { id: string; at: number } | null = null;

export function MarkdownViewer({ file, src, ctx }: { file: VersionFile; src: string; ctx: DocContext }) {
  const { data: original, error } = useText(src);
  if (error) return <EmptyState title="파일을 읽을 수 없습니다" body={String(error)} />;
  if (original === undefined) return <EmptyState title="불러오는 중…" />;
  return <Editor key={src} original={original} file={file} ctx={ctx} />;
}

/** `[[` 자동완성 후보: 제목·메뉴 이름·slug에 입력한 글자가 들어간 문서(최대 20개) */
function useWikiLinkSearch() {
  const { data: tree } = useTree();
  return useCallback((query: string): WikiLinkItem[] => {
    const q = query.trim().toLowerCase();
    const out: WikiLinkItem[] = [];
    const walk = (category: { key: string; name: string }, menus: MenuNode[], trail: string[]) => {
      for (const m of menus) {
        for (const d of m.documents) {
          const hay = `${d.title} ${m.name} ${d.slug} ${m.slug}`.toLowerCase();
          if (!q || hay.includes(q)) out.push({ title: d.title, path: `/${category.key}/${m.slug}/${d.slug}`, detail: [category.name, ...trail, m.name].join(" › ") });
        }
        walk(category, m.menus, [...trail, m.name]);
      }
    };
    for (const c of tree?.categories ?? []) walk(c, c.menus, []);
    // 제목에 맞은 문서를 앞에
    if (q) out.sort((a, b) => Number(!a.title.toLowerCase().includes(q)) - Number(!b.title.toLowerCase().includes(q)));
    return out.slice(0, 20);
  }, [tree]);
}

function Editor({ original, file, ctx }: { original: string; file: VersionFile; ctx: DocContext }) {
  const qc = useQueryClient();
  // 업로드 대화상자의 "새 Markdown 문서"에서 넘어오면 편집 창을 열고 커서를 둔다
  const justCreated = !!(useLocation().state as { edit?: boolean } | null)?.edit && ctx.isCurrent;
  const draftId = `${ctx.menu}/${ctx.doc}@${ctx.version}`;
  const [text, setText] = useState(original);
  const [layout, setLayout] = useState<EditorLayout>(() =>
    matchMedia("(min-width: 1024px)").matches ? "split" : justCreated ? "editor" : "preview");
  const [pendingDraft, setPendingDraft] = useState(() => {
    const d = ctx.isCurrent ? loadDraft(draftId) : null;
    return d !== null && d !== original ? d : null;
  });
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(() =>
    lastSaved && lastSaved.id === draftId && Date.now() - lastSaved.at < 10_000
      ? { kind: "ok", text: `${versionLabel(ctx.version)} 버전으로 저장했습니다` }
      : null);
  const wikiSearch = useWikiLinkSearch();

  const dirty = text !== original;
  const baseUrl = file.url.slice(0, file.url.lastIndexOf("/") + 1);

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

  const confirm = useConfirm();
  async function save() {
    const ok = await confirm({
      title: "저장할까요?", confirmText: "저장",
      message: "기존 버전은 그대로 두고 새 버전으로 저장합니다.",
      details: [`${versionLabel(ctx.version)} → ${nextVersion([ctx.version])}`, ...(note.trim() ? [`메모: ${note.trim()}`] : [])],
    });
    if (!ok) return;
    setSaving(true);
    setMessage(null);
    try {
      const r = await saveMarkdown(ctx.menu, ctx.doc, { baseVersion: ctx.version, content: text, note });
      clearDraft(draftId);
      lastSaved = { id: `${ctx.menu}/${ctx.doc}@${r.version}`, at: Date.now() };
      setMessage({ kind: "ok", text: `${versionLabel(r.version)} 버전으로 저장했습니다` });
      await qc.invalidateQueries({ queryKey: ["doc", ctx.menu, ctx.doc] });
      await qc.invalidateQueries({ queryKey: ["tree"] });
    } catch (e) {
      setMessage({ kind: "error", text: (e as Error).message });
    } finally {
      setSaving(false);
    }
  }

  const saveForm = ctx.isCurrent ? (
    <form className="ml-auto flex min-w-0 flex-1 basis-60 items-center justify-end gap-2" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      {dirty && <span className="shrink-0 text-xs text-med">저장하지 않은 변경</span>}
      <input
        className="w-full max-w-64 min-w-0 rounded-md border border-line bg-surface px-2 py-1 text-xs"
        placeholder="변경 메모 (선택)" value={note} onChange={(e) => setNote(e.target.value)} disabled={!dirty}
      />
      <IconButton type="submit" icon={Save} label={saving ? "저장 중…" : "저장 (새 버전)"} variant="primary"
        disabled={!dirty || saving} />
    </form>
  ) : (
    <span className="ml-auto text-xs text-muted">이전 버전은 읽기 전용입니다. 최신 버전에서 편집하세요.</span>
  );

  const notice = (
    <>
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
    </>
  );

  return (
    <MarkdownEditor value={text} onChange={setText} baseUrl={baseUrl} readOnly={!ctx.isCurrent}
      layout={layout} onLayoutChange={setLayout} autoFocus={justCreated}
      toolbarEnd={saveForm} notice={notice} onWikiLinkSearch={wikiSearch} />
  );
}
