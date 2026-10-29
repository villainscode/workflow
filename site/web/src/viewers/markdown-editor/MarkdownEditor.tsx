// MarkFlow 에디터의 본체(MarkdownEditor)를 사이트 구조에 맞게 고쳤다.
// - 값은 늘 밖(MarkdownViewer)에서 받는다. 저장·임시 보관·버전은 MarkdownViewer가 맡고, 툴바 오른쪽(toolbarEnd)과 그 아래(notice)에 붙인다.
// - 미리보기는 사이트 MarkdownPreview(MarkFlow 엔진 + Mermaid + 상대 경로)를 쓴다.
// - 이미지(툴바 올리기, 끌어 놓기, 붙여넣기)는 Cloudflare R2 Worker로 올리고 공개 주소를 넣는다.
// - 이모지 대신 Lucide 아이콘, 글자는 한국어.

import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import type { EditorView } from "@codemirror/view";
import { EditorSelection } from "@codemirror/state";
import { Check, CircleAlert, Copy, Eye, ImagePlus, Loader2, PenLine, RotateCcw, X } from "lucide-react";
import { IconButton } from "../../components/IconButton.tsx";
import { useDark } from "../../lib/useDark.ts";
import { copyText } from "../../lib/seg.ts";
import { MarkdownPreview, type MarkdownPreviewHandle } from "../MarkdownPreview.tsx";
import { Toolbar } from "./Toolbar.tsx";
import { EditorPane } from "./EditorPane.tsx";
import { UploadSettingsDialog, getSavedWorkerUrl } from "./UploadSettingsDialog.tsx";
import { API, CLOUD } from "../../lib/base.ts";
import { applyToolbarAction } from "./markdownActions.ts";
import { countWords } from "./wordCount.ts";
import { createCloudflareUploader } from "./cloudflareUploader.ts";
import { validateImageFile } from "./imageValidation.ts";
import type { EditorLayout, ToolbarAction, WikiLinkItem } from "./types.ts";

type Upload = { status: "idle" | "uploading" | "error"; fileName?: string; error?: string; retryFile?: File };

/** 커서 자리에 넣고(선택 영역은 바꾸고) 넣은 구간을 돌려준다 */
function insertAtCursor(view: EditorView, text: string) {
  const { from, to } = view.state.selection.main;
  view.dispatch({ changes: { from, to, insert: text }, selection: EditorSelection.cursor(from + text.length), scrollIntoView: true, userEvent: "input" });
  return { from, to: from + text.length };
}

function replaceRange(view: EditorView, from: number, to: number, text: string) {
  view.dispatch({ changes: { from, to, insert: text }, selection: EditorSelection.cursor(from + text.length), scrollIntoView: true, userEvent: "input" });
}

const imageOf = (files: Iterable<File>) => [...files].find((f) => f.type.startsWith("image/"));

export function MarkdownEditor({
  value, onChange, baseUrl, readOnly = false, layout, onLayoutChange, autoFocus, toolbarEnd, notice, onWikiLinkSearch,
}: {
  value: string;
  onChange: (value: string) => void;
  /** 미리보기의 상대 경로 기준(문서 버전 폴더) */
  baseUrl: string;
  readOnly?: boolean;
  layout: EditorLayout;
  onLayoutChange: (layout: EditorLayout) => void;
  autoFocus?: boolean;
  toolbarEnd?: ReactNode;
  notice?: ReactNode;
  onWikiLinkSearch?: (query: string) => WikiLinkItem[];
}) {
  const dark = useDark();
  const viewRef = useRef<EditorView | null>(null);
  const previewRef = useRef<MarkdownPreviewHandle>(null);
  const lastHeading = useRef<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);

  // Cloudflare(4.0)에서는 앱 API가 R2에 바로 올리므로 업로드 서버 설정이 필요 없다
  const [workerUrl, setWorkerUrl] = useState(() => (CLOUD ? API : getSavedWorkerUrl()));
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [copied, setCopied] = useState(false);
  const [upload, setUpload] = useState<Upload>({ status: "idle" });
  const [cursor, setCursor] = useState({ line: 1, col: 1 });

  const showEditor = layout !== "preview";
  const showPreview = layout !== "editor";

  // 커서가 움직이면 상태 표시줄을 고치고, 커서 위쪽 가장 가까운 제목으로 미리보기를 옮긴다
  const handleCursor = useCallback((view: EditorView) => {
    const pos = view.state.selection.main.head;
    const doc = view.state.doc;
    const at = doc.lineAt(pos);
    setCursor({ line: at.number, col: pos - at.from + 1 });
    for (let n = at.number; n >= 1; n--) {
      const m = /^#{1,6}\s+(.+)/.exec(doc.line(n).text);
      if (!m) continue;
      const heading = m[1].trim();
      if (heading !== lastHeading.current) {
        lastHeading.current = heading;
        previewRef.current?.scrollToHeading(heading);
      }
      return;
    }
  }, []);

  const handleAction = useCallback((action: ToolbarAction) => {
    if (viewRef.current) applyToolbarAction(viewRef.current, action);
  }, []);

  // ── 이미지 올리기 ─────────────────────────────────────────────────────────
  const uploadImage = useCallback(async (file: File) => {
    const view = viewRef.current;
    if (!view || readOnly) return;
    if (!workerUrl) { setSettingsOpen(true); return; }
    const valid = validateImageFile(file);
    if (!valid.valid) { setUpload({ status: "error", fileName: file.name, error: valid.error }); return; }

    const range = insertAtCursor(view, `![올리는 중 ${file.name}…]()`);
    setUpload({ status: "uploading", fileName: file.name });
    try {
      const url = await createCloudflareUploader(workerUrl, CLOUD ? "/images" : "/upload")(file);
      replaceRange(view, range.from, range.to, `![${file.name}](${url})`);
      setUpload({ status: "idle" });
    } catch (e) {
      replaceRange(view, range.from, range.to, `![올리기 실패 ${file.name}]()`);
      setUpload({ status: "error", fileName: file.name, error: (e as Error).message, retryFile: file });
    }
  }, [workerUrl, readOnly]);

  const onUploadClick = useCallback(() => {
    if (!workerUrl) setSettingsOpen(true);
    else fileInput.current?.click();
  }, [workerUrl]);

  const openSettings = useCallback(() => setSettingsOpen(true), []);

  async function copyMarkdown() {
    if (!(await copyText(value))) return;
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  const words = useMemo(() => countWords(value), [value]);
  const lines = useMemo(() => value.split("\n").length, [value]);
  const canDrop = !readOnly && showEditor;

  return (
    <div
      className={`relative grid h-full min-h-0 grid-rows-[auto_auto_minmax(0,1fr)_auto] ${dragOver ? "outline-2 -outline-offset-2 outline-accent outline-dashed" : ""}`}
      onDragEnter={(e) => {
        if (!canDrop || !e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        if (++dragDepth.current === 1) setDragOver(true);
      }}
      onDragOver={(e) => { if (canDrop && e.dataTransfer.types.includes("Files")) e.preventDefault(); }}
      onDragLeave={() => {
        if (!canDrop) return;
        if (--dragDepth.current <= 0) { dragDepth.current = 0; setDragOver(false); }
      }}
      onDrop={(e) => {
        dragDepth.current = 0;
        setDragOver(false);
        const file = canDrop ? imageOf(e.dataTransfer.files) : undefined;
        if (!file) return;
        e.preventDefault();
        void uploadImage(file);
      }}
      onPaste={(e) => {
        const item = readOnly ? undefined : [...e.clipboardData.items].find((i) => i.type.startsWith("image/"));
        const file = item?.getAsFile();
        if (!file) return;
        e.preventDefault();
        void uploadImage(file);
      }}
    >
      <input ref={fileInput} type="file" accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml" hidden
        onChange={(e) => { const f = e.target.files?.[0]; if (f) void uploadImage(f); e.target.value = ""; }} />

      <Toolbar onAction={handleAction} layout={layout} onLayoutChange={onLayoutChange} readOnly={readOnly}
        onSettingsClick={CLOUD ? undefined : openSettings} onImageUploadClick={onUploadClick} end={toolbarEnd} />

      <div>{notice}</div>

      <div className={`grid min-h-0 ${showEditor && showPreview ? "grid-cols-2" : "grid-cols-1"}`}>
        {showEditor && (
          <section className="grid min-h-0 min-w-0 grid-rows-[auto_minmax(0,1fr)] border-r border-line" aria-label="편집">
            <div className="flex items-center justify-between gap-2 h-7 border-b border-line bg-sunken px-3 text-[11px] font-semibold text-muted">
              <span className="flex items-center gap-1"><PenLine size={13} aria-hidden />편집</span>
              <IconButton icon={copied ? Check : Copy} size={14} label="Markdown 복사" text={copied ? "복사함" : "복사"}
                className={`!px-1.5 !py-0.5 !text-[11px] ${copied ? "!text-ok" : ""}`} onClick={() => void copyMarkdown()} />
            </div>
            <EditorPane ref={viewRef} value={value} onChange={onChange} dark={dark} readOnly={readOnly} autoFocus={autoFocus}
              onCursor={handleCursor} onWikiLinkSearch={onWikiLinkSearch} />
          </section>
        )}
        {showPreview && (
          <section className="grid min-h-0 min-w-0 grid-rows-[auto_minmax(0,1fr)]" aria-label="미리보기">
            <div className="flex items-center justify-between gap-2 h-7 border-b border-line bg-sunken px-3 text-[11px] font-semibold text-muted">
              <span className="flex items-center gap-1"><Eye size={13} aria-hidden />미리보기</span>
              <span className="font-normal">{words.toLocaleString()} 단어</span>
            </div>
            <div className="min-h-0 overflow-y-auto bg-surface px-6 py-5" data-md-preview>
              <MarkdownPreview ref={previewRef} source={value} baseUrl={baseUrl} />
            </div>
          </section>
        )}
      </div>

      <div className="flex items-center justify-between gap-3 border-t border-line bg-sunken px-3 py-0.5 text-[11px] text-muted" data-md-status>
        <span>{lines.toLocaleString()}줄 · {value.length.toLocaleString()}자{showEditor && !readOnly && ` · ${cursor.line}:${cursor.col}`}</span>
        {readOnly && <span className="font-semibold text-med">읽기 전용</span>}
      </div>

      {dragOver && (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center bg-accent/5 backdrop-blur-[2px]">
          <div className="flex flex-col items-center gap-2 rounded-xl border-2 border-dashed border-accent bg-surface px-8 py-6 text-sm font-semibold text-accent shadow-lg">
            <ImagePlus size={32} aria-hidden />
            이미지를 놓으면 Cloudflare R2에 올립니다
          </div>
        </div>
      )}

      {upload.status !== "idle" && (
        <div role={upload.status === "error" ? "alert" : "status"}
          className={`absolute bottom-8 left-1/2 z-20 flex max-w-[90%] -translate-x-1/2 items-center gap-2 rounded-lg border px-4 py-2 text-xs font-medium shadow-lg ${
            upload.status === "error" ? "border-high bg-high-soft text-high" : "border-accent bg-surface text-accent"}`}>
          {upload.status === "uploading"
            ? <><Loader2 size={16} className="shrink-0 animate-spin" aria-hidden /><span className="truncate">올리는 중: {upload.fileName}</span></>
            : <>
                <CircleAlert size={16} className="shrink-0" aria-hidden />
                <span className="truncate">{upload.error}</span>
                {upload.retryFile && <IconButton icon={RotateCcw} size={14} label="다시 올리기" text="다시 올리기" className="!text-high" onClick={() => void uploadImage(upload.retryFile!)} />}
                <IconButton icon={X} size={14} label="닫기" className="!text-high" onClick={() => setUpload({ status: "idle" })} />
              </>}
        </div>
      )}

      {settingsOpen && <UploadSettingsDialog onClose={() => setSettingsOpen(false)} onSave={setWorkerUrl} />}
    </div>
  );
}
