import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import * as pdfjs from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import {
  ArrowDown, ArrowUp, BookmarkCheck, FilePlus2, FileText, Highlighter, History, ImagePlus, MousePointer2, PenLine, RotateCcw, RotateCw,
  Save, Trash2, Type, Undo2, X,
} from "lucide-react";
import { listPdfFields, type PdfField, type PdfOp } from "@workflow/core/pdfedit";
import { versionLabel } from "../../lib/api.ts";
import { getWork, publishWork, restoreRevision, SaveConflict } from "../../lib/structedit.ts";
import { applyPdf, imageForPdf, saveWorkFile } from "../../lib/pdfedit.ts";
import { useConfirm } from "../../components/confirm/ConfirmProvider.tsx";
import { IconButton } from "../../components/IconButton.tsx";
import { EmptyState } from "../../components/EmptyState.tsx";
import { RevisionPanel } from "../structedit/RevisionPanel.tsx";
import { useOtherSave } from "../../lib/live.ts";
import { useMe } from "../../lib/me.ts";

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

/**
 * PDF 편집(5.0 M6, 4.5절). pdf.js로 쪽을 그리고 그 위에 덧그릴 것(글상자·형광펜·펜·그림)을 놓은 뒤 「적용」하면
 * pdf-lib로 쪽 내용에 그려 넣어 수정본으로 저장한다. 페이지 회전·옮기기·지우기·끼워 넣기와 양식 채우기는 누르면 바로 저장한다
 * (아직 적용하지 않은 덧그리기가 있으면 함께). 본문 글자 고치기는 하지 않는다(원본을 고쳐 PDF를 다시 만든다).
 * 좌표: 놓은 것은 화면에서 본 쪽(회전 반영) 기준 pt로 들고 있다가, 적용할 때 pdf.js viewport로 PDF 좌표로 바꾼다.
 */

type Tool = "select" | "text" | "highlight" | "pen" | "image";
type Item =
  | { id: number; kind: "text"; page: number; x: number; y: number; size: number; color: string; text: string }
  | { id: number; kind: "rect"; page: number; x: number; y: number; w: number; h: number; color: string }
  | { id: number; kind: "ink"; page: number; points: [number, number][]; color: string; width: number }
  | { id: number; kind: "image"; page: number; x: number; y: number; w: number; h: number; data: Uint8Array; mime: string; url: string };

/** 아직 id가 없는 놓을 것(유니언 각각에서 id를 뺀다) */
type NewItem = Item extends infer T ? (T extends Item ? Omit<T, "id"> : never) : never;

const COLORS = ["#1c2026", "#d6336c", "#1f5fbf", "#0e6b57"];
const HIGHLIGHT = "#ffd43b";
let nextId = 1;

export function PdfEditor({ menu, doc, onExit }: { menu: string; doc: string; onExit: (savedVersion?: string) => void }) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [state, setState] = useState<{ rev: number; baseVersion: string; entry: string; bytes: Uint8Array; pdf: pdfjs.PDFDocumentProxy } | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [tool, setTool] = useState<Tool>("select");
  const [items, setItems] = useState<Item[]>([]);
  const [sel, setSel] = useState<number | null>(null);
  const [page, setPage] = useState(0);
  const [color, setColor] = useState(COLORS[0]);
  const [size, setSize] = useState(14);
  const [note, setNote] = useState("");
  const [panel, setPanel] = useState<"" | "form" | "history">("");
  const [fields, setFields] = useState<PdfField[]>([]);
  const [width, setWidth] = useState(800);
  const box = useRef<HTMLDivElement>(null);
  const undoRevs = useRef<number[]>([]);
  const pendingImage = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    const w = await getWork(menu, doc);
    const f = w.files.find((x) => x.path === w.entry)!;
    const bytes = new Uint8Array(await (await fetch(`${f.url}?h=${f.sha256.slice(0, 12)}`)).arrayBuffer());
    const pdf = await pdfjs.getDocument({ data: bytes.slice() }).promise;
    setState({ rev: w.rev, baseVersion: w.baseVersion, entry: w.entry, bytes, pdf });
    setFields(await listPdfFields(bytes));
    setPage((p) => Math.min(p, pdf.numPages - 1));
  }, [menu, doc]);
  useEffect(() => { load().catch((e) => setError(String((e as Error).message))); }, [load]);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(Math.min(1000, el.clientWidth - 48)));
    ro.observe(el);
    return () => ro.disconnect();
  }, [state === null]); // eslint-disable-line react-hooks/exhaustive-deps

  // 다른 사람이 저장하면 최신 PDF로(놓은 것은 그대로 두고, 되돌리기 기록은 비운다)
  const me = useMe().me?.user?.id;
  useOtherSave(menu, doc, me, state?.rev, (e) => {
    if (busy) return;
    undoRevs.current = [];
    void load().then(() => setMessage(`${e.by === "claude-code" ? "Claude Code가" : "다른 사람이"} 저장해 최신 PDF로 바꿨습니다.`));
  });

  /** 놓은 것 → PDF 연산(화면 쪽 좌표 → PDF 좌표) */
  const itemOps = async (list: Item[]): Promise<PdfOp[]> => {
    const ops: PdfOp[] = [];
    for (const it of list) {
      const vp = (await state!.pdf.getPage(it.page + 1)).getViewport({ scale: 1 });
      const pt = (x: number, y: number) => vp.convertToPdfPoint(x, y) as [number, number];
      if (it.kind === "text") { if (it.text.trim()) { const [x, y] = pt(it.x, it.y); ops.push({ t: "text", page: it.page, x, y, size: it.size, text: it.text, color: it.color }); } }
      else if (it.kind === "rect") { const [x, y] = pt(it.x, it.y); ops.push({ t: "rect", page: it.page, x, y, width: it.w, height: it.h, color: it.color }); }
      else if (it.kind === "image") { const [x, y] = pt(it.x, it.y); ops.push({ t: "image", page: it.page, x, y, width: it.w, height: it.h, data: it.data, mime: it.mime }); }
      else ops.push({ t: "ink", page: it.page, strokes: [it.points.map(([x, y]) => pt(x, y))], color: it.color, width: it.width });
    }
    return ops;
  };

  /** 놓은 것 + 페이지·양식 연산을 적용해 수정본으로 저장 */
  const save = async (extra: PdfOp[], summary: string) => {
    if (!state || busy) return false;
    setBusy(true);
    setMessage("");
    try {
      const ops = [...(await itemOps(items)), ...extra];
      if (!ops.length) return false;
      const out = await applyPdf(state.bytes, ops);
      const r = await saveWorkFile(menu, doc, state.rev, state.entry, out, summary);
      if (r.changed) undoRevs.current.push(state.rev);
      setItems([]);
      setSel(null);
      await load();
      void qc.invalidateQueries({ queryKey: ["revisions", menu, doc] });
      return true;
    } catch (e) {
      setMessage(e instanceof SaveConflict ? "다른 곳에서 먼저 저장했습니다. 최신 PDF를 다시 불러왔습니다(놓은 것은 남아 있습니다)." : String((e as Error).message));
      if (e instanceof SaveConflict) await load();
      return false;
    } finally { setBusy(false); }
  };

  const undo = async () => {
    const prev = undoRevs.current.pop();
    if (prev === undefined || !state) return;
    setBusy(true);
    try { await restoreRevision(menu, doc, prev, state.rev); await load(); } catch (e) { setMessage(String((e as Error).message)); undoRevs.current = []; }
    finally { setBusy(false); }
  };

  const publish = async () => {
    if (!state) return;
    if (items.length) { setMessage("적용하지 않은 덧그리기가 있습니다. 먼저 「적용」하세요."); return; }
    const ok = await confirm({ title: "작업본을 버전으로 저장할까요?", confirmText: "버전으로 저장",
      message: `${versionLabel(state.baseVersion)}은 그대로 두고 다음 버전을 만듭니다.`, details: [`작업본: 수정본 ${state.rev}`, ...(note.trim() ? [`메모: ${note.trim()}`] : [])] });
    if (!ok) return;
    try {
      const r = await publishWork(menu, doc, state.rev, note.trim() || undefined);
      void qc.invalidateQueries({ queryKey: ["doc", menu, doc] });
      onExit(r.version);
    } catch (e) { setMessage(String((e as Error).message)); }
  };

  const exit = async () => {
    if (items.length && !(await confirm({ title: `적용하지 않은 덧그리기 ${items.length}개를 버릴까요?`, confirmText: "버리기", tone: "warning" }))) return;
    onExit();
  };

  // Delete로 고른 것 지우기(적용 전이라 확인 없이, 바로 다시 놓을 수 있다)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as Element)?.closest?.("input, textarea, select")) return;
      if ((e.key === "Delete" || e.key === "Backspace") && sel !== null) { e.preventDefault(); setItems((l) => l.filter((x) => x.id !== sel)); setSel(null); }
      if (e.key === "Escape") { setSel(null); setTool("select"); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sel]);

  if (error) return <EmptyState title="PDF를 열 수 없습니다" body={error} />;
  if (!state) return <EmptyState title="불러오는 중…" />;
  const n = state.pdf.numPages;
  const update = (id: number, patch: Partial<Item>) => setItems((l) => l.map((x) => (x.id === id ? ({ ...x, ...patch } as Item) : x)));
  const selected = items.find((x) => x.id === sel);

  const toolBtn = (t: Tool, icon: typeof Type, label: string) => (
    <IconButton icon={icon} label={label} active={tool === t} onClick={() => { setTool(t); if (t === "image") pendingImage.current?.click(); }} />
  );

  return (
    <div className="grid h-full grid-rows-[auto_minmax(0,1fr)]">
      <div>
        <div className="flex flex-wrap items-center gap-1.5 border-b border-line bg-accent-soft px-4 py-1.5">
          <FileText size={18} className="text-accent" aria-hidden />
          <span className="mr-2 text-sm font-medium text-accent">PDF 편집</span>
          {toolBtn("select", MousePointer2, "고르기·옮기기")}
          {toolBtn("text", Type, "글상자 (쪽을 눌러 놓기)")}
          {toolBtn("highlight", Highlighter, "형광펜 (끌어서 칠하기)")}
          {toolBtn("pen", PenLine, "펜 (끌어서 그리기)")}
          {toolBtn("image", ImagePlus, "그림·서명 넣기")}
          <input ref={pendingImage} type="file" accept="image/png,image/jpeg,image/webp,image/gif" className="sr-only" aria-label="넣을 그림"
            onChange={async (e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              setTool("select");
              if (!f) return;
              const img = await imageForPdf(f);
              const vp = (await state.pdf.getPage(page + 1)).getViewport({ scale: 1 });
              const k = Math.min(1, (vp.width * 0.4) / img.width, (vp.height * 0.4) / img.height);
              const w = img.width * k, h = img.height * k;
              const it: Item = { id: nextId++, kind: "image", page, x: (vp.width - w) / 2, y: (vp.height - h) / 2, w, h, data: img.data, mime: img.mime,
                url: URL.createObjectURL(new Blob([new Uint8Array(img.data)], { type: img.mime })) };
              setItems((l) => [...l, it]);
              setSel(it.id);
            }} />
          <span className="mx-1 h-5 w-px bg-line" aria-hidden />
          {COLORS.map((c) => (
            <button key={c} type="button" aria-label={`색 ${c}`} data-tip={c} onClick={() => { setColor(c); if (selected && selected.kind !== "image" && selected.kind !== "rect") update(selected.id, { color: c }); }}
              className={`size-5 rounded border ${color === c ? "ring-2 ring-accent" : "border-line"}`} style={{ background: c }} />
          ))}
          <select aria-label="글자 크기(pt)" value={size} className="rounded border border-line bg-surface px-1 py-0.5 text-xs"
            onChange={(e) => { setSize(Number(e.target.value)); if (selected?.kind === "text") update(selected.id, { size: Number(e.target.value) }); }}>
            {[9, 10, 12, 14, 18, 24, 32].map((s) => <option key={s} value={s}>{s}pt</option>)}
          </select>
          <IconButton icon={Save} label={`적용 (덧그리기 ${items.length}개를 PDF에 그려 넣기)`} text={`적용 ${items.length || ""}`.trim()} variant="outline"
            disabled={busy || items.length === 0} onClick={() => void save([], `덧그리기 ${items.length}개`)} />
          <span className="ml-auto rounded-full bg-surface px-2 font-mono text-xs" aria-live="polite">{busy ? "저장 중…" : state.rev > 0 ? `수정본 ${state.rev}` : `${versionLabel(state.baseVersion)} 그대로`}</span>
          <input className="w-36 min-w-0 rounded-md border border-line bg-surface px-2 py-1 text-xs" placeholder="버전 메모 (선택)" value={note} onChange={(e) => setNote(e.target.value)} aria-label="버전 메모" />
          <IconButton icon={Undo2} label="되돌리기 (이 화면에서 저장한 것)" disabled={busy || undoRevs.current.length === 0} onClick={() => void undo()} />
          <IconButton icon={FileText} label="양식 채우기" active={panel === "form"} disabled={fields.length === 0} onClick={() => setPanel(panel === "form" ? "" : "form")} />
          <IconButton icon={History} label="수정본 이력" active={panel === "history"} onClick={() => setPanel(panel === "history" ? "" : "history")} />
          <IconButton icon={X} label="편집 끝내기 (작업본은 남습니다)" onClick={() => void exit()} />
          <IconButton icon={BookmarkCheck} label="버전으로 저장" text="버전으로 저장" variant="primary" disabled={busy || state.rev === 0} onClick={() => void publish()} />
        </div>
        {message && <p role="alert" className="bg-crit-soft px-4 py-1.5 text-xs text-crit">{message}</p>}
        <p className="bg-sunken px-4 py-1 text-[11px] text-muted">
          덧그린 것은 「적용」하면 PDF에 그려 넣어 수정본으로 저장됩니다. 쪽 회전·옮기기·지우기·끼워 넣기, 양식 채우기는 바로 저장됩니다. 본문 글자는 고치지 않습니다.
        </p>
      </div>
      <div className={`grid min-h-0 ${panel ? "grid-cols-[10rem_minmax(0,1fr)_18rem]" : "grid-cols-[10rem_minmax(0,1fr)]"}`}>
        <PageList pdf={state.pdf} rev={state.rev} page={page} setPage={setPage} busy={busy}
          onRotate={(by) => void save([{ t: "rotate", page, by }], `${page + 1}쪽 회전`)}
          onMove={(d) => void save([{ t: "movePage", from: page, to: page + d }], `${page + 1}쪽 옮김`).then((ok) => ok && setPage(page + d))}
          onDelete={async () => {
            if (items.some((x) => x.page === page)) { setMessage("이 쪽에 적용하지 않은 덧그리기가 있습니다. 먼저 적용하거나 지우세요."); return; }
            if (await confirm({ title: `${page + 1}쪽을 지울까요?`, confirmText: "지우기", tone: "danger", message: "되돌리기로 다시 살릴 수 있습니다." })) void save([{ t: "deletePage", page }], `${page + 1}쪽 지움`);
          }}
          onInsert={async (file) => {
            const data = new Uint8Array(await file.arrayBuffer());
            if (await confirm({ title: `${file.name}을(를) ${page + 1}쪽 뒤에 끼워 넣을까요?`, confirmText: "끼워 넣기" })) void save([{ t: "insertPdf", at: page + 1, data }], `${file.name} 끼워 넣음`);
          }} />
        <div ref={box} className="min-h-0 overflow-y-auto bg-bg p-6">
          <div className="mx-auto space-y-6" style={{ width }}>
            {Array.from({ length: n }, (_, i) => (
              <PageView key={`${state.rev}-${i}`} pdf={state.pdf} index={i} width={width} tool={tool} active={i === page}
                items={items.filter((x) => x.page === i)} sel={sel} color={color} size={size}
                onFocus={() => setPage(i)} onSelect={setSel}
                onAdd={(it) => { setItems((l) => [...l, { ...it, id: nextId++ } as Item]); if (it.kind === "text") setTool("select"); }}
                onUpdate={update} onRemove={(id) => setItems((l) => l.filter((x) => x.id !== id))} />
            ))}
          </div>
        </div>
        {panel === "form" && <FormPanel fields={fields} busy={busy} onSave={(values) => void save([{ t: "fill", values }], `양식 ${Object.keys(values).length}칸 채움`)} />}
        {panel === "history" && (
          <RevisionPanel menu={menu} doc={doc} current={state.rev} busy={busy} onRestore={async (rev) => {
            if (!(await confirm({ title: rev === 0 ? `${versionLabel(state.baseVersion)} 내용으로 되돌릴까요?` : `수정본 ${rev}(으)로 되돌릴까요?`, confirmText: "되돌리기", tone: "warning",
              message: "그 내용으로 새 수정본을 만듭니다. 지금까지의 수정본은 이력에 남습니다." }))) return;
            try { await restoreRevision(menu, doc, rev, state.rev); undoRevs.current = []; await load(); } catch (e) { setMessage(String((e as Error).message)); }
          }} />
        )}
      </div>
    </div>
  );
}

function PageList({ pdf, rev, page, setPage, busy, onRotate, onMove, onDelete, onInsert }: {
  pdf: pdfjs.PDFDocumentProxy; rev: number; page: number; setPage: (n: number) => void; busy: boolean;
  onRotate: (by: 90 | -90) => void; onMove: (d: -1 | 1) => void; onDelete: () => void; onInsert: (f: File) => void;
}) {
  const n = pdf.numPages;
  const input = useRef<HTMLInputElement>(null);
  return (
    <div className="flex min-h-0 flex-col border-r border-line bg-surface">
      <ol className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2" aria-label="쪽 목록">
        {Array.from({ length: n }, (_, i) => (
          <li key={`${rev}-${i}`}>
            <button type="button" onClick={() => setPage(i)} aria-current={i === page ? "true" : undefined} aria-label={`${i + 1}쪽`}
              className={`flex w-full flex-col items-center gap-0.5 rounded-md p-1 ${i === page ? "bg-accent-soft" : "hover:bg-sunken"}`}>
              <Thumb pdf={pdf} index={i} />
              <span className="font-mono text-[11px] text-muted">{i + 1}</span>
            </button>
          </li>
        ))}
      </ol>
      <div className="grid grid-cols-3 gap-0.5 border-t border-line p-1.5" aria-label={`${page + 1}쪽 고치기`}>
        <IconButton icon={RotateCcw} label="왼쪽으로 돌리기" size={16} disabled={busy} onClick={() => onRotate(-90)} />
        <IconButton icon={RotateCw} label="오른쪽으로 돌리기" size={16} disabled={busy} onClick={() => onRotate(90)} />
        <IconButton icon={Trash2} label="이 쪽 지우기" size={16} disabled={busy || n <= 1} onClick={onDelete} />
        <IconButton icon={ArrowUp} label="앞으로" size={16} disabled={busy || page === 0} onClick={() => onMove(-1)} />
        <IconButton icon={ArrowDown} label="뒤로" size={16} disabled={busy || page === n - 1} onClick={() => onMove(1)} />
        <IconButton icon={FilePlus2} label="이 쪽 뒤에 PDF 끼워 넣기" size={16} disabled={busy} onClick={() => input.current?.click()} />
        <input ref={input} type="file" accept="application/pdf" className="sr-only" aria-label="끼워 넣을 PDF"
          onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) onInsert(f); }} />
      </div>
    </div>
  );
}

function Thumb({ pdf, index }: { pdf: pdfjs.PDFDocumentProxy; index: number }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let task: pdfjs.RenderTask | null = null;
    void pdf.getPage(index + 1).then((p) => {
      const vp = p.getViewport({ scale: 1 });
      const v = p.getViewport({ scale: 120 / vp.width });
      const c = canvas.current;
      if (!c) return;
      c.width = v.width; c.height = v.height;
      task = p.render({ canvas: c, viewport: v });
    });
    return () => task?.cancel();
  }, [pdf, index]);
  return <canvas ref={canvas} className="block w-[120px] border border-line bg-white" />;
}

/** 쪽 하나: 그린 쪽(canvas) + 덧그리기 층. 놓은 것은 화면 쪽 좌표(pt)로, 보일 때만 배율을 곱한다 */
function PageView({ pdf, index, width, tool, active, items, sel, color, size, onFocus, onSelect, onAdd, onUpdate, onRemove }: {
  pdf: pdfjs.PDFDocumentProxy; index: number; width: number; tool: Tool; active: boolean; items: Item[]; sel: number | null; color: string; size: number;
  onFocus: () => void; onSelect: (id: number | null) => void; onAdd: (it: NewItem) => void; onUpdate: (id: number, p: Partial<Item>) => void; onRemove: (id: number) => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const layer = useRef<HTMLDivElement>(null);
  const [vp, setVp] = useState<{ w: number; h: number; scale: number } | null>(null);
  const [draft, setDraft] = useState<Item | null>(null);
  const [editing, setEditing] = useState<number | null>(null);

  useEffect(() => {
    let task: pdfjs.RenderTask | null = null;
    void pdf.getPage(index + 1).then((p) => {
      const base = p.getViewport({ scale: 1 });
      const scale = width / base.width;
      const v = p.getViewport({ scale: scale * (window.devicePixelRatio || 1) });
      const c = canvas.current;
      if (!c) return;
      c.width = v.width; c.height = v.height;
      setVp({ w: base.width, h: base.height, scale });
      task = p.render({ canvas: c, viewport: v });
      task.promise.then(() => c.setAttribute("data-rendered", "1")).catch(() => {});
    });
    return () => task?.cancel();
  }, [pdf, index, width]);

  const at = (e: { clientX: number; clientY: number }) => {
    const r = layer.current!.getBoundingClientRect();
    return [(e.clientX - r.left) / vp!.scale, (e.clientY - r.top) / vp!.scale] as [number, number];
  };

  const onPointerDown = (e: React.PointerEvent) => {
    onFocus();
    if (!vp || (e.target as Element).closest("[data-item], textarea")) return;
    const [x, y] = at(e);
    if (tool === "select") { onSelect(null); return; }
    if (tool === "text") {
      // 기본 동작(포커스 옮기기)을 막아야 막 생긴 글자 칸이 바로 포커스를 잃고 빈 칸으로 지워지지 않는다
      e.preventDefault();
      onAdd({ kind: "text", page: index, x, y, size, color, text: "" });
      return;
    }
    (e.target as Element).setPointerCapture(e.pointerId);
    if (tool === "highlight") setDraft({ id: 0, kind: "rect", page: index, x, y, w: 0, h: 0, color: HIGHLIGHT });
    if (tool === "pen") setDraft({ id: 0, kind: "ink", page: index, points: [[x, y]], color, width: 2 });
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!draft || !vp) return;
    const [x, y] = at(e);
    if (draft.kind === "rect") setDraft({ ...draft, w: x - draft.x, h: y - draft.y });
    if (draft.kind === "ink") setDraft({ ...draft, points: [...draft.points, [x, y]] });
  };
  const onPointerUp = () => {
    if (!draft) return;
    if (draft.kind === "rect") {
      const r = { ...draft, x: Math.min(draft.x, draft.x + draft.w), y: Math.min(draft.y, draft.y + draft.h), w: Math.abs(draft.w), h: Math.abs(draft.h) };
      if (r.w > 2 && r.h > 2) onAdd(r);
    } else if (draft.kind === "ink" && draft.points.length > 1) onAdd(draft);
    setDraft(null);
  };

  // 고른 것을 끌어 옮기기(글상자·형광펜·그림), 그림은 오른쪽 아래 손잡이로 크기
  const drag = (e: React.PointerEvent, it: Item, mode: "move" | "resize") => {
    if (tool !== "select" || it.kind === "ink") return;
    e.stopPropagation();
    onSelect(it.id);
    const start = at(e), orig = { ...it };
    const move = (ev: PointerEvent) => {
      const [x, y] = at(ev);
      const dx = x - start[0], dy = y - start[1];
      if (mode === "move") onUpdate(it.id, { x: (orig as { x: number }).x + dx, y: (orig as { y: number }).y + dy });
      else if (orig.kind === "image") { const k = Math.max(0.05, (orig.w + dx) / orig.w); onUpdate(it.id, { w: orig.w * k, h: orig.h * k }); }
      else if (orig.kind === "rect") onUpdate(it.id, { w: Math.max(4, orig.w + dx), h: Math.max(4, orig.h + dy) });
    };
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const s = vp?.scale ?? 1;
  const cursor = tool === "select" ? "default" : tool === "text" ? "text" : "crosshair";
  const render = (it: Item, isDraft = false) => {
    const chosen = it.id === sel && !isDraft;
    const ring = chosen ? "outline outline-2 outline-accent" : "";
    if (it.kind === "ink") {
      return (
        <svg key={isDraft ? "draft" : it.id} data-item={isDraft ? undefined : ""} className={`pointer-events-auto absolute inset-0 ${ring}`} width="100%" height="100%"
          onPointerDown={(e) => { if (tool === "select") { e.stopPropagation(); onSelect(it.id); } }}>
          <polyline points={it.points.map(([x, y]) => `${x * s},${y * s}`).join(" ")} fill="none" stroke={it.color} strokeWidth={it.width * s} strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    }
    if (it.kind === "rect") {
      return (
        <div key={isDraft ? "draft" : it.id} data-item={isDraft ? undefined : ""} className={`absolute ${ring}`}
          style={{ left: Math.min(it.x, it.x + it.w) * s, top: Math.min(it.y, it.y + it.h) * s, width: Math.abs(it.w) * s, height: Math.abs(it.h) * s, background: it.color, opacity: 0.4, mixBlendMode: "multiply", cursor: tool === "select" ? "move" : undefined }}
          onPointerDown={(e) => drag(e, it, "move")}>
          {chosen && <Handle onPointerDown={(e) => drag(e, it, "resize")} />}
        </div>
      );
    }
    if (it.kind === "image") {
      return (
        <div key={it.id} data-item="" className={`absolute ${ring}`} style={{ left: it.x * s, top: it.y * s, width: it.w * s, height: it.h * s, cursor: tool === "select" ? "move" : undefined }}
          onPointerDown={(e) => drag(e, it, "move")}>
          <img src={it.url} alt="" draggable={false} className="h-full w-full" />
          {chosen && <Handle onPointerDown={(e) => drag(e, it, "resize")} />}
        </div>
      );
    }
    const lines = it.text.split("\n");
    const style = { left: it.x * s, top: it.y * s, fontSize: it.size * s, lineHeight: 1.3, color: it.color, fontFamily: "'NanumGothic', 'IBM Plex Sans KR', sans-serif" };
    if (editing === it.id || it.text === "") {
      return (
        <textarea key={it.id} data-item="" autoFocus aria-label="글상자 글자" defaultValue={it.text} rows={Math.max(1, lines.length)}
          className="absolute min-w-40 resize border border-dashed border-accent bg-white/80 p-0 outline-none" style={{ ...style, width: Math.max(160, Math.max(...lines.map((l) => l.length)) * it.size * s * 0.62) }}
          onBlur={(e) => { const v = e.target.value; setEditing(null); if (!v.trim()) onRemove(it.id); else onUpdate(it.id, { text: v }); }}
          onKeyDown={(e) => { if (e.key === "Escape") (e.target as HTMLTextAreaElement).blur(); }} />
      );
    }
    return (
      <div key={it.id} data-item="" className={`absolute whitespace-pre ${ring}`} style={{ ...style, cursor: tool === "select" ? "move" : undefined }}
        onPointerDown={(e) => drag(e, it, "move")} onDoubleClick={() => setEditing(it.id)}>
        {it.text}
      </div>
    );
  };

  return (
    <figure className={`relative mx-auto bg-white shadow-sm ring-1 ${active ? "ring-accent" : "ring-line"}`} style={{ width: vp ? vp.w * s : width, height: vp ? vp.h * s : width * 1.3 }} aria-label={`${index + 1}쪽`}>
      <canvas ref={canvas} className="block h-full w-full" data-page={index} />
      <div ref={layer} className="absolute inset-0" style={{ cursor }} data-layer={index}
        onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp}>
        {items.map((it) => render(it))}
        {draft && render(draft, true)}
      </div>
    </figure>
  );
}

function Handle({ onPointerDown }: { onPointerDown: (e: React.PointerEvent) => void }) {
  return <span role="presentation" className="absolute -right-1.5 -bottom-1.5 size-3 cursor-nwse-resize rounded-sm border border-accent bg-white" onPointerDown={onPointerDown} />;
}

function FormPanel({ fields, busy, onSave }: { fields: PdfField[]; busy: boolean; onSave: (v: Record<string, string | boolean>) => void }) {
  const [values, setValues] = useState<Record<string, string | boolean>>(() => Object.fromEntries(fields.map((f) => [f.name, f.value ?? ""])));
  useEffect(() => setValues(Object.fromEntries(fields.map((f) => [f.name, f.value ?? ""]))), [fields]);
  const changed = Object.fromEntries(Object.entries(values).filter(([k, v]) => v !== (fields.find((f) => f.name === k)?.value ?? "")));
  return (
    <aside className="min-h-0 space-y-2 overflow-y-auto border-l border-line bg-surface p-3 text-sm" aria-label="양식 채우기">
      <h3 className="text-xs font-semibold text-muted">양식 채우기 · {fields.length}칸</h3>
      {fields.map((f) => (
        <label key={f.name} className="block text-xs">
          <span className="font-mono text-[11px] text-muted">{f.name}</span>
          {f.type === "checkbox" ? (
            <input type="checkbox" className="ml-2" checked={values[f.name] === true} onChange={(e) => setValues({ ...values, [f.name]: e.target.checked })} />
          ) : f.type === "dropdown" || f.type === "radio" ? (
            <select className="mt-0.5 w-full rounded border border-line bg-surface px-1 py-1" value={String(values[f.name] ?? "")} onChange={(e) => setValues({ ...values, [f.name]: e.target.value })}>
              <option value="">(고르기)</option>
              {f.options?.map((o) => <option key={o} value={o}>{o}</option>)}
            </select>
          ) : f.type === "text" ? (
            <input className="mt-0.5 w-full rounded border border-line bg-surface px-2 py-1" value={String(values[f.name] ?? "")} onChange={(e) => setValues({ ...values, [f.name]: e.target.value })} />
          ) : <span className="ml-2 text-muted">(채울 수 없는 칸)</span>}
        </label>
      ))}
      <IconButton icon={Save} label="양식 저장" text={`양식 저장 ${Object.keys(changed).length || ""}`.trim()} variant="primary" disabled={busy || Object.keys(changed).length === 0}
        onClick={() => onSave(changed)} />
    </aside>
  );
}
