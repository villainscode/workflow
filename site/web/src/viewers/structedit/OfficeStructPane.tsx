import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Columns3, ImageUp, Rows3, Sheet, Table2 } from "lucide-react";
import { getWork, uploadAsset, workPdfUrl } from "../../lib/structedit.ts";
import type { OoxmlImage, OoxmlSheet, OoxmlTable } from "@workflow/core/structedit/ooxml";
import { useConfirm } from "../../components/confirm/ConfirmProvider.tsx";
import { DocxViewer } from "../DocxViewer.tsx";
import { SheetViewer } from "../SheetViewer.tsx";
import { PdfViewer } from "../PdfViewer.tsx";
import type { StructCtx } from "./StructEditor.tsx";

/**
 * DOCX·PPTX·XLSX 구조 편집(5.0 M5, D-47 C). 왼쪽 목록에서 표 행·열·열 너비, 그림 교체, 시트 열 너비를 고치고
 * 오른쪽에서 작업본을 미리 본다(DOCX는 docx-preview, PPTX는 PDF 변환, XLSX는 SheetJS).
 * 병합 칸이 있는 표는 행·열을 넣거나 빼지 않는다(열 너비만).
 */

const btn = "rounded border border-line px-2 py-0.5 text-xs hover:bg-sunken disabled:opacity-30";
const COLS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

export function OfficeStructPane({ ctx }: { ctx: StructCtx }) {
  const { menu, doc, s } = ctx;
  const work = useQuery({ queryKey: ["work", menu, doc, s.rev], queryFn: () => getWork(menu, doc), staleTime: Infinity });
  const entry = work.data?.files.find((f) => f.path === work.data!.entry);
  const src = entry ? `${entry.url}?h=${entry.sha256.slice(0, 12)}` : "";

  return (
    <div className="grid min-h-0 grid-cols-[22rem_minmax(0,1fr)]">
      <div className="min-h-0 space-y-3 overflow-y-auto border-r border-line bg-surface p-3">
        {s.kind !== "xlsx" && (
          <>
            <h3 className="flex items-center gap-1.5 text-xs font-semibold text-muted"><Table2 size={16} aria-hidden /> 표 {s.tables?.length ?? 0}개</h3>
            {(s.tables ?? []).map((t) => <TableCard key={t.id} ctx={ctx} t={t} />)}
            <h3 className="flex items-center gap-1.5 pt-2 text-xs font-semibold text-muted"><ImageUp size={16} aria-hidden /> 그림 {s.images?.length ?? 0}개</h3>
            {(s.images ?? []).map((i) => <ImageCard key={i.id} ctx={ctx} i={i} />)}
          </>
        )}
        {s.kind === "xlsx" && (
          <>
            <h3 className="flex items-center gap-1.5 text-xs font-semibold text-muted"><Sheet size={16} aria-hidden /> 시트 열 너비(글자 수)</h3>
            {(s.sheets ?? []).map((sh) => <SheetCard key={sh.id} ctx={ctx} sh={sh} />)}
            <p className="text-[11px] text-muted">셀 글자는 「텍스트 편집」에서 고칩니다.</p>
          </>
        )}
      </div>
      <div className="min-h-0 bg-bg">
        {!src ? null : s.kind === "docx" ? (
          <DocxViewer key={src} url={src} pdfUrl={workPdfUrl(menu, doc, s.rev)} />
        ) : s.kind === "pptx" ? (
          <PdfViewer key={s.rev} url={workPdfUrl(menu, doc, s.rev)} note="작업본을 PDF로 바꿔 보여 줍니다. 바꿀 때마다 몇 초 걸립니다." />
        ) : (
          <SheetViewer key={src} url={src} />
        )}
      </div>
    </div>
  );
}

function TableCard({ ctx, t }: { ctx: StructCtx; t: OoxmlTable }) {
  const { busy, run } = ctx;
  const confirm = useConfirm();
  const [row, setRow] = useState(t.rows);
  const [col, setCol] = useState(t.cols);
  const [widths, setWidths] = useState(t.widths);
  useEffect(() => { setRow(t.rows); setCol(t.cols); setWidths(t.widths); }, [t.rows, t.cols, t.widths.join()]); // eslint-disable-line react-hooks/exhaustive-deps
  const op = (o: object, summary: string) => void run([{ table: t.id, ...o }], summary);
  const removeAt = async (kind: "tableRow" | "tableCol", at: number) => {
    const label = kind === "tableRow" ? `${at + 1}행` : `${at + 1}열`;
    const ok = await confirm({ title: `${t.where}의 표에서 ${label}을 지울까요?`, confirmText: "지우기", tone: "danger", message: "그 칸의 글자도 함께 지워집니다. 되돌리기로 다시 살릴 수 있습니다." });
    if (ok) op({ t: kind, at, op: "remove" }, kind === "tableRow" ? "표 행 지움" : "표 열 지움");
  };
  const pos = (n: number, end: boolean) => Array.from({ length: n + (end ? 1 : 0) }, (_, i) => i);

  return (
    <article className="space-y-2 rounded-md border border-line p-2">
      <p className="text-xs"><span className="font-medium">{t.where}</span> · {t.rows}행 {t.cols}열</p>
      {t.header.some(Boolean) && <p className="truncate text-[11px] text-muted">{t.header.filter(Boolean).join(" · ")}</p>}
      {t.merged ? (
        <p className="rounded bg-med-soft px-2 py-1 text-xs text-med">합친 칸이 있어 행·열은 그대로 두고 열 너비만 바꿀 수 있습니다.</p>
      ) : (
        <div className="grid grid-cols-[auto_1fr] items-center gap-x-2 gap-y-1 text-xs">
          <Rows3 size={16} className="text-muted" aria-label="행" />
          <div className="flex flex-wrap items-center gap-1">
            <select className="rounded border border-line bg-surface px-1 py-0.5" value={row} onChange={(e) => setRow(Number(e.target.value))} aria-label="행 위치">
              {pos(t.rows, true).map((i) => <option key={i} value={i}>{i === t.rows ? "끝" : `${i + 1}행`}</option>)}
            </select>
            <button className={btn} disabled={busy} onClick={() => op({ t: "tableRow", at: row, op: "add" }, "표 행 넣기")}>{row === t.rows ? "끝에" : "앞에"} 넣기</button>
            <button className={`${btn} text-crit`} disabled={busy || t.rows <= 1} onClick={() => void removeAt("tableRow", Math.min(row, t.rows - 1))}>
              {Math.min(row, t.rows - 1) + 1}행 지우기
            </button>
          </div>
          <Columns3 size={16} className="text-muted" aria-label="열" />
          <div className="flex flex-wrap items-center gap-1">
            <select className="rounded border border-line bg-surface px-1 py-0.5" value={col} onChange={(e) => setCol(Number(e.target.value))} aria-label="열 위치">
              {pos(t.cols, true).map((i) => <option key={i} value={i}>{i === t.cols ? "끝" : `${i + 1}열`}</option>)}
            </select>
            <button className={btn} disabled={busy} onClick={() => op({ t: "tableCol", at: col, op: "add" }, "표 열 넣기")}>{col === t.cols ? "끝에" : "앞에"} 넣기</button>
            <button className={`${btn} text-crit`} disabled={busy || t.cols <= 1} onClick={() => void removeAt("tableCol", Math.min(col, t.cols - 1))}>
              {Math.min(col, t.cols - 1) + 1}열 지우기
            </button>
          </div>
        </div>
      )}
      <form className="flex flex-wrap items-center gap-1" onSubmit={(e) => { e.preventDefault(); op({ t: "tableCols", widths }, "표 열 너비"); }}>
        <span className="w-full text-[11px] text-muted">열 너비(%) · 표 전체 너비는 그대로</span>
        {widths.map((w, i) => (
          <input key={i} type="number" min={1} step={0.1} value={w} aria-label={`${i + 1}열 너비`}
            className="w-16 rounded border border-line bg-surface px-1 py-0.5 font-mono text-xs"
            onChange={(e) => setWidths(widths.map((x, j) => (j === i ? Number(e.target.value) : x)))} />
        ))}
        <button type="submit" className="rounded bg-accent px-2 py-0.5 text-xs text-surface disabled:opacity-30"
          disabled={busy || widths.some((w) => !(w > 0)) || widths.join() === t.widths.join()}>적용</button>
      </form>
    </article>
  );
}

function ImageCard({ ctx, i }: { ctx: StructCtx; i: OoxmlImage }) {
  const { busy, run, setMessage } = ctx;
  const cm = (emu: number) => (emu / 360000).toFixed(1);
  return (
    <article className="flex items-center gap-2 rounded-md border border-line p-2 text-xs">
      <div className="min-w-0 flex-1">
        <p><span className="font-medium">{i.where}</span> · {cm(i.cx)}×{cm(i.cy)} cm</p>
        <p className="truncate font-mono text-[11px] text-muted">{i.media.split("/").pop()}</p>
      </div>
      <label className={`inline-flex shrink-0 cursor-pointer items-center gap-1 rounded-md border border-line px-2 py-1 font-medium text-muted hover:bg-sunken hover:text-fg ${busy ? "pointer-events-none opacity-30" : ""}`}>
        <ImageUp size={16} aria-hidden /> 바꾸기
        <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" className="sr-only" aria-label={`${i.where} 그림 바꾸기`}
          onChange={async (e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (!f) return;
            try {
              const a = await uploadAsset(f);
              await run([{ t: "replaceImage", image: i.id, asset: a.asset }], "그림 교체");
            } catch (err) { setMessage(String((err as Error).message)); }
          }} />
      </label>
    </article>
  );
}

function SheetCard({ ctx, sh }: { ctx: StructCtx; sh: OoxmlSheet }) {
  const { busy, run } = ctx;
  return (
    <article className="space-y-1 rounded-md border border-line p-2">
      <p className="text-xs font-medium">{sh.name}</p>
      <div className="grid grid-cols-6 gap-1">
        {sh.widths.map((w, c) => (
          <label key={c} className="flex items-center gap-0.5 font-mono text-[11px] text-muted">
            {COLS[c]}
            <input type="number" min={1} max={255} step={0.5} defaultValue={Math.round(w * 100) / 100} disabled={busy} aria-label={`${sh.name} ${COLS[c]}열 너비`}
              className="w-full min-w-0 rounded border border-line bg-surface px-1 py-0.5 text-fg"
              key={`${c}:${w}`}
              onBlur={(e) => {
                const v = Number(e.target.value);
                if (v > 0 && Math.abs(v - w) > 0.001) void run([{ t: "colWidth", sheet: sh.id, col: c, width: v }], `${sh.name} ${COLS[c]}열 너비`);
              }}
              onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />
          </label>
        ))}
      </div>
    </article>
  );
}
