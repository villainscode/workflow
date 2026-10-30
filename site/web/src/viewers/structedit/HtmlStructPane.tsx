import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Columns3, Heading2, ImagePlus, ImageUp, Pilcrow, Rows3, Table2, Trash2 } from "lucide-react";
import { editViewUrl, uploadAsset, type Block } from "../../lib/structedit.ts";
import { injectStyle } from "../../lib/textedit.ts";
import { useConfirm } from "../../components/confirm/ConfirmProvider.tsx";
import { IconButton } from "../../components/IconButton.tsx";
import type { StructCtx } from "./StructEditor.tsx";

/**
 * HTML 구조 편집(5.0 M3). 편집 사본(data-eid, 스크립트 없음)을 같은 출처 iframe으로 열고, 누른 요소를 골라 오른쪽에서 고친다.
 * 연산은 서버가 원본 바이트에 패치한다(packages/core/src/structedit/html.ts). 저장할 때마다 사본을 다시 읽는다(eid는 위치라 바뀐다).
 * 글자는 두 번 눌러 그 자리에서 고치고(인라인 서식만 남는다), 바깥을 누르거나 Enter면 저장, Esc면 취소.
 * 그림 파일을 문서 위에 끌어 놓거나 붙여 넣으면 고른 요소 뒤에(없으면 문서 끝 블록 뒤에) 넣는다.
 */

const EDIT_CSS = `
[data-eid]{cursor:default}
[data-eid]:hover{outline:1px dashed rgba(31,95,191,.55);outline-offset:1px}
[data-sel]{outline:2px solid #1F5FBF !important;outline-offset:1px}
[data-cell]{background:rgba(31,95,191,.10)}
[contenteditable="true"]{outline:2px solid #946C00 !important;background:rgba(224,186,79,.18);cursor:text}
td:empty,th:empty{min-width:3em;height:1.5em;outline:1px dashed rgba(0,0,0,.3);outline-offset:-1px}
`;
// 표 안 요소와 목록 항목은 표·목록 연산으로 다루고, 블록 넣기·옮기기·지우기는 감싸는 표·목록을 기준으로 한다
const INNER = new Set(["TD", "TH", "TR", "CAPTION", "LI", "DT", "DD"]);
const NAME: Record<string, string> = {
  p: "문단", h1: "제목 1", h2: "제목 2", h3: "제목 3", h4: "제목 4", h5: "제목 5", h6: "제목 6", table: "표", img: "그림", ul: "목록", ol: "번호 목록",
  li: "목록 항목", td: "칸", th: "머리 칸", tr: "행", figure: "그림 묶음", figcaption: "그림 설명", section: "구역", blockquote: "인용", pre: "코드",
};

const rowsOf = (t: Element) => [...t.querySelectorAll(":scope > tr, :scope > thead > tr, :scope > tbody > tr, :scope > tfoot > tr")];

export function HtmlStructPane({ ctx }: { ctx: StructCtx }) {
  const { menu, doc, s, busy, run, setMessage } = ctx;
  const confirm = useConfirm();
  const frame = useRef<HTMLIFrameElement>(null);
  const [sel, setSel] = useState<string | null>(null);
  // 고른 칸의 행·열(표 안을 골랐을 때)
  const [cell, setCell] = useState<{ row: number; col: number } | null>(null);
  const blocks = new Map((s.blocks ?? []).map((b) => [b.eid, b]));
  const runRef = useRef(run);
  runRef.current = run;
  const blocksRef = useRef(s.blocks);
  blocksRef.current = s.blocks;
  // eid는 위치라 저장하면 바뀐다. 다시 읽을 때 "같은 순번·같은 태그" 요소로 고름을 잇는다
  const selKey = useRef<{ index: number; tag: string } | null>(null);

  const d = () => frame.current?.contentDocument ?? null;
  const node = (eid: string | null) => (eid ? d()?.querySelector(`[data-eid="${eid}"]`) ?? null : null);

  /** 고른 요소가 표·목록 안이면 그 표·목록, 아니면 자신 */
  const anchorOf = (el: Element | null): Element | null => {
    if (!el) return null;
    if (!INNER.has(el.tagName)) return el;
    return el.closest("table, ul, ol, dl");
  };
  const selEl = node(sel);
  const table = selEl?.closest("table[data-eid]") ?? null;
  const anchor = anchorOf(selEl);
  const anchorEid = anchor?.getAttribute("data-eid") ?? null;

  // 사본을 다시 읽으면 강조를 다시 칠한다
  const paint = useCallback((eid: string | null, c: { row: number; col: number } | null) => {
    const doc = d();
    if (!doc) return;
    doc.querySelectorAll("[data-sel],[data-cell]").forEach((n) => { n.removeAttribute("data-sel"); n.removeAttribute("data-cell"); });
    const el = eid ? doc.querySelector(`[data-eid="${eid}"]`) : null;
    el?.setAttribute("data-sel", "");
    const t = el?.closest("table");
    if (t && c) rowsOf(t)[c.row]?.querySelectorAll(":scope > td, :scope > th")[c.col]?.setAttribute("data-cell", "");
  }, []);
  useEffect(() => paint(sel, cell), [sel, cell, paint]);

  /** 그림 파일 → 자산 → 고른 요소(또는 마지막 블록) 뒤에 넣기 */
  const insertImage = useCallback(async (file: File, ref: string | null) => {
    if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type)) { setMessage("PNG·JPEG·WebP·GIF만 넣을 수 있습니다"); return; }
    const target = ref ?? [...(d()?.body.querySelectorAll(":scope > [data-eid], :scope > * > [data-eid]") ?? [])].pop()?.getAttribute("data-eid");
    if (!target) { setMessage("그림을 넣을 자리를 먼저 고르세요"); return; }
    try {
      const a = await uploadAsset(file);
      await runRef.current([{ t: "insert", ref: target, where: "after", node: { kind: "image", src: a.asset, alt: file.name.replace(/\.[^.]+$/, "") } }], "그림 넣기");
    } catch (e) { setMessage(String((e as Error).message)); }
  }, [setMessage]);
  const anchorRef = useRef(anchorEid);
  anchorRef.current = anchorEid;

  // 사본이 열리면: 스타일, 고르기(클릭), 글자 편집(더블클릭), 링크 막기, 그림 끌어 놓기·붙여 넣기
  const onLoad = useCallback(() => {
    const doc = d();
    if (!doc) return;
    injectStyle(doc, EDIT_CSS);
    // 글자를 고칠 수 있는 요소 표시(사본에는 data-eid만 있다). 사본이 다 읽힌 뒤에 칠해야 한다
    for (const b of blocksRef.current ?? []) if (b.editable) doc.querySelector(`[data-eid="${b.eid}"]`)?.setAttribute("data-editable", "1");
    const k = selKey.current;
    const again = k ? doc.querySelectorAll("[data-eid]")[k.index] : undefined;
    setSel(again && again.tagName === k!.tag ? again.getAttribute("data-eid") : null);
    if (!again || again.tagName !== k!.tag) setCell(null);
    doc.addEventListener("click", (e) => {
      const t = e.target as Element;
      if (t.closest("a, button, summary, label, form")) e.preventDefault();
      if (t.closest('[contenteditable="true"]')) return;
      const el = t.closest("[data-eid]");
      setSel(el?.getAttribute("data-eid") ?? null);
      selKey.current = el ? { index: [...doc.querySelectorAll("[data-eid]")].indexOf(el), tag: el.tagName } : null;
      const td = t.closest("td, th");
      const tb = td?.closest("table");
      setCell(td && tb ? { row: rowsOf(tb).indexOf(td.parentElement!), col: [...td.parentElement!.children].filter((c) => /^T[DH]$/.test(c.tagName)).indexOf(td) } : null);
    }, true);
    doc.addEventListener("dblclick", (e) => {
      const el = (e.target as Element).closest<HTMLElement>("[data-eid]");
      if (!el || el.getAttribute("data-editable") !== "1") return;
      const before = el.innerHTML;
      el.setAttribute("contenteditable", "true");
      el.focus();
      const done = (save: boolean) => {
        el.removeEventListener("blur", onBlur);
        el.removeEventListener("keydown", onKey);
        el.removeAttribute("contenteditable");
        if (!save || el.innerHTML === before) { el.innerHTML = before; return; }
        void runRef.current([{ t: "setText", eid: el.getAttribute("data-eid"), html: el.innerHTML }], "글자 고침");
      };
      const onBlur = () => done(true);
      const onKey = (k: KeyboardEvent) => {
        if (k.isComposing || k.keyCode === 229) return;
        if (k.key === "Enter" && !k.shiftKey) { k.preventDefault(); el.blur(); }
        if (k.key === "Escape") { k.preventDefault(); done(false); }
      };
      el.addEventListener("blur", onBlur);
      el.addEventListener("keydown", onKey);
    });
    doc.addEventListener("submit", (e) => e.preventDefault(), true);
    doc.addEventListener("dragover", (e) => { if (e.dataTransfer?.types.includes("Files")) e.preventDefault(); });
    doc.addEventListener("drop", (e) => {
      const f = e.dataTransfer?.files[0];
      if (!f) return;
      e.preventDefault();
      const at = (e.target as Element).closest?.("[data-eid]");
      void insertImage(f, anchorOf(at ?? null)?.getAttribute("data-eid") ?? anchorRef.current);
    });
    doc.addEventListener("paste", (e) => {
      if ((e.target as Element).closest?.('[contenteditable="true"]')) return;
      const f = [...(e.clipboardData?.files ?? [])].find((x) => x.type.startsWith("image/"));
      if (f) { e.preventDefault(); void insertImage(f, anchorRef.current); }
    });
  }, [insertImage]);

  const b = sel ? blocks.get(sel) : undefined;
  const tb = table ? blocks.get(table.getAttribute("data-eid")!) : undefined;
  const ab = anchorEid ? blocks.get(anchorEid) : undefined;

  const remove = async (eid: string, label: string) => {
    const ok = await confirm({ title: `${label}을(를) 지울까요?`, confirmText: "지우기", tone: "danger", message: "되돌리기로 다시 살릴 수 있습니다." });
    if (ok && await run([{ t: "remove", eid }], `${label} 지움`)) setSel(null);
  };
  const move = (dir: -1 | 1) => {
    if (!anchor || !anchorEid) return;
    let sib = dir < 0 ? anchor.previousElementSibling : anchor.nextElementSibling;
    while (sib && !sib.hasAttribute("data-eid")) sib = dir < 0 ? sib.previousElementSibling : sib.nextElementSibling;
    const ref = sib?.getAttribute("data-eid");
    if (ref) void run([{ t: "move", eid: anchorEid, ref, where: dir < 0 ? "before" : "after" }], dir < 0 ? "위로 옮김" : "아래로 옮김");
  };

  return (
    <div className="grid min-h-0 grid-cols-[minmax(0,1fr)_17rem]">
      <iframe
        key={s.rev}
        ref={frame}
        src={editViewUrl(menu, doc, s.rev)}
        title="구조 편집"
        className="block h-full w-full border-0 bg-surface"
        sandbox="allow-same-origin"
        onLoad={onLoad}
      />
      <aside className="min-h-0 overflow-y-auto border-l border-line bg-surface p-3 text-sm" aria-label="고른 요소">
        {!b ? (
          <p className="text-xs text-muted">문서에서 고칠 요소를 누르세요. 그림 파일을 문서 위에 끌어 놓거나 붙여 넣어도 됩니다.</p>
        ) : (
          <div className="space-y-4">
            <section>
              <h3 className="mb-1 text-xs font-semibold text-muted">고른 요소</h3>
              <p className="font-medium">{NAME[b.tag] ?? b.tag} <span className="font-mono text-xs text-muted">&lt;{b.tag}&gt;</span></p>
              {b.text && <p className="mt-0.5 line-clamp-2 text-xs text-muted">{b.text}</p>}
              {b.editable && <p className="mt-1 text-xs text-muted">두 번 누르면 글자를 고칩니다.</p>}
            </section>

            {tb?.table && <TableSection ctx={ctx} eid={tb.eid} t={tb.table} cell={cell} onRemove={() => remove(tb.eid, "표")} />}
            {b.image && <ImageSection ctx={ctx} b={b} />}

            {ab && (
              <section>
                <h3 className="mb-1 text-xs font-semibold text-muted">{NAME[ab.tag] ?? ab.tag} 뒤에 넣기</h3>
                <div className="flex flex-wrap gap-1">
                  <IconButton icon={Pilcrow} label="문단 넣기" variant="outline" disabled={busy}
                    onClick={() => void run([{ t: "insert", ref: ab.eid, where: "after", node: { kind: "paragraph", text: "새 문단" } }], "문단 넣기")} />
                  <IconButton icon={Heading2} label="제목 넣기" variant="outline" disabled={busy}
                    onClick={() => void run([{ t: "insert", ref: ab.eid, where: "after", node: { kind: "heading", level: 2, text: "새 제목" } }], "제목 넣기")} />
                  <IconButton icon={Table2} label="표 넣기 (3행 3열)" variant="outline" disabled={busy}
                    onClick={() => void run([{ t: "insert", ref: ab.eid, where: "after", node: { kind: "table", rows: 3, cols: 3, header: true } }], "표 넣기")} />
                  <label className={`inline-flex cursor-pointer items-center rounded-md border border-line p-1.5 text-muted hover:bg-sunken hover:text-fg ${busy ? "pointer-events-none opacity-30" : ""}`} data-tip="그림 넣기">
                    <ImagePlus size={20} aria-hidden />
                    <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" className="sr-only" aria-label="그림 넣기"
                      onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void insertImage(f, ab.eid); }} />
                  </label>
                </div>
              </section>
            )}

            {ab && ab.tag !== "table" && (
              <section className="flex flex-wrap gap-1">
                <IconButton icon={ArrowUp} label="위로 옮기기" variant="outline" disabled={busy} onClick={() => move(-1)} />
                <IconButton icon={ArrowDown} label="아래로 옮기기" variant="outline" disabled={busy} onClick={() => move(1)} />
                <IconButton icon={Trash2} label={`${NAME[ab.tag] ?? ab.tag} 지우기`} variant="outline" disabled={busy}
                  onClick={() => void remove(ab.eid, NAME[ab.tag] ?? ab.tag)} />
              </section>
            )}
            {ab?.tag === "table" && (
              <section className="flex flex-wrap gap-1">
                <IconButton icon={ArrowUp} label="표 위로 옮기기" variant="outline" disabled={busy} onClick={() => move(-1)} />
                <IconButton icon={ArrowDown} label="표 아래로 옮기기" variant="outline" disabled={busy} onClick={() => move(1)} />
              </section>
            )}
          </div>
        )}
      </aside>
    </div>
  );
}

function TableSection({ ctx, eid, t, cell, onRemove }: {
  ctx: StructCtx; eid: string; t: NonNullable<Block["table"]>; cell: { row: number; col: number } | null; onRemove: () => void;
}) {
  const { busy, run } = ctx;
  const row = cell?.row ?? t.rows - 1, col = cell?.col ?? t.cols - 1;
  const even = Array(t.cols).fill(Math.round(1000 / t.cols) / 10);
  const [widths, setWidths] = useState<number[]>(t.widths ?? even);
  useEffect(() => setWidths(t.widths ?? even), [t.widths?.join(), t.cols]); // eslint-disable-line react-hooks/exhaustive-deps
  const sum = Math.round(widths.reduce((a, b) => a + b, 0) * 10) / 10;
  const op = (o: object, summary: string) => void run([{ eid, ...o }], summary);

  return (
    <section className="space-y-2">
      <h3 className="text-xs font-semibold text-muted">표 · {t.rows}행 {t.cols}열{cell ? ` · ${cell.row + 1}행 ${cell.col + 1}열 고름` : ""}</h3>
      {t.merged ? (
        <p className="rounded bg-med-soft px-2 py-1 text-xs text-med">합친 칸이 있는 표는 행·열을 넣거나 뺄 수 없습니다. 열 너비만 바꿀 수 있습니다.</p>
      ) : (
        <div className="grid grid-cols-[auto_1fr] items-center gap-x-2 gap-y-1 text-xs">
          <Rows3 size={16} className="text-muted" aria-label="행" />
          <div className="flex flex-wrap gap-1">
            <button className="rounded border border-line px-2 py-0.5 hover:bg-sunken disabled:opacity-30" disabled={busy}
              onClick={() => op({ t: "tableRow", at: row, op: "add" }, "표 행 넣기")}>위에 넣기</button>
            <button className="rounded border border-line px-2 py-0.5 hover:bg-sunken disabled:opacity-30" disabled={busy}
              onClick={() => op({ t: "tableRow", at: row + 1, op: "add" }, "표 행 넣기")}>아래에 넣기</button>
            <button className="rounded border border-line px-2 py-0.5 text-crit hover:bg-sunken disabled:opacity-30" disabled={busy || t.rows <= 1}
              onClick={() => op({ t: "tableRow", at: row, op: "remove" }, "표 행 지움")}>{row + 1}행 지우기</button>
          </div>
          <Columns3 size={16} className="text-muted" aria-label="열" />
          <div className="flex flex-wrap gap-1">
            <button className="rounded border border-line px-2 py-0.5 hover:bg-sunken disabled:opacity-30" disabled={busy}
              onClick={() => op({ t: "tableCol", at: col, op: "add" }, "표 열 넣기")}>왼쪽에 넣기</button>
            <button className="rounded border border-line px-2 py-0.5 hover:bg-sunken disabled:opacity-30" disabled={busy}
              onClick={() => op({ t: "tableCol", at: col + 1, op: "add" }, "표 열 넣기")}>오른쪽에 넣기</button>
            <button className="rounded border border-line px-2 py-0.5 text-crit hover:bg-sunken disabled:opacity-30" disabled={busy || t.cols <= 1}
              onClick={() => op({ t: "tableCol", at: col, op: "remove" }, "표 열 지움")}>{col + 1}열 지우기</button>
          </div>
        </div>
      )}
      <form className="space-y-1" onSubmit={(e) => { e.preventDefault(); op({ t: "tableCols", widths }, "표 열 너비"); }}>
        <p className="text-xs text-muted">열 너비(%) · 합 {sum}</p>
        <div className="flex flex-wrap gap-1">
          {widths.map((w, i) => (
            <input key={i} type="number" min={1} max={100} step={0.1} value={w} aria-label={`${i + 1}열 너비`}
              className="w-16 rounded border border-line bg-surface px-1 py-0.5 font-mono text-xs"
              onChange={(e) => setWidths(widths.map((x, j) => (j === i ? Number(e.target.value) : x)))} />
          ))}
        </div>
        <div className="flex gap-1">
          <button type="submit" className="rounded bg-accent px-2 py-0.5 text-xs text-surface disabled:opacity-30" disabled={busy || widths.some((w) => !(w > 0))}>너비 적용</button>
          <button type="button" className="rounded border border-line px-2 py-0.5 text-xs hover:bg-sunken" onClick={() => setWidths(even)}>똑같이</button>
        </div>
      </form>
      <IconButton icon={Trash2} label="표 지우기" text="표 지우기" variant="outline" disabled={busy} onClick={onRemove} />
    </section>
  );
}

function ImageSection({ ctx, b }: { ctx: StructCtx; b: Block }) {
  const { busy, run, setMessage } = ctx;
  const img = b.image!;
  const [alt, setAlt] = useState(img.alt);
  const [width, setWidth] = useState(img.width ?? 100);
  useEffect(() => { setAlt(img.alt); setWidth(img.width ?? 100); }, [img.alt, img.width]);
  return (
    <section className="space-y-2">
      <h3 className="text-xs font-semibold text-muted">그림</h3>
      <p className="truncate font-mono text-[11px] text-muted" data-tip={img.src}>{img.src}</p>
      <label className="block text-xs">설명(alt)
        <input className="mt-0.5 w-full rounded border border-line bg-surface px-2 py-1" value={alt} onChange={(e) => setAlt(e.target.value)}
          onBlur={() => { if (alt !== img.alt) void run([{ t: "setAttr", eid: b.eid, name: "alt", value: alt }], "그림 설명"); }} />
      </label>
      <label className="block text-xs">너비 {width}%
        <input type="range" min={10} max={100} step={5} className="mt-0.5 w-full" value={width} onChange={(e) => setWidth(Number(e.target.value))}
          onPointerUp={() => { if (width !== (img.width ?? 100)) void run([{ t: "setWidth", eid: b.eid, percent: width === 100 ? null : width }], "그림 너비"); }}
          onKeyUp={() => { if (width !== (img.width ?? 100)) void run([{ t: "setWidth", eid: b.eid, percent: width === 100 ? null : width }], "그림 너비"); }} />
      </label>
      <label className={`inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-line px-2.5 py-1 text-xs font-medium text-muted hover:bg-sunken hover:text-fg ${busy ? "pointer-events-none opacity-30" : ""}`}>
        <ImageUp size={16} aria-hidden /> 그림 바꾸기
        <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" className="sr-only"
          onChange={async (e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (!f) return;
            try {
              const a = await uploadAsset(f);
              await run([{ t: "setAttr", eid: b.eid, name: "src", value: a.asset }], "그림 바꿈");
            } catch (err) { setMessage(String((err as Error).message)); }
          }} />
      </label>
    </section>
  );
}
