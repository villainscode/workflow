import type { Block } from "../../lib/structedit.ts";

/**
 * HTML 편집 사본 위 손잡이(6.0 V2): 표 열 경계·행 높이·표 너비, 그림 크기(비율 유지).
 * 편집 사본 iframe과 같은 크기의 겹친 층에 그린다(iframe은 배율 없이 1:1이라 안쪽 요소 좌표를 그대로 쓴다).
 * 끄는 동안은 사본 DOM에 미리 보여 주고, 놓을 때 연산 하나(수정본 하나)로 확정한다. 저장하면 사본을 다시 읽으므로 미리 보기는 버려진다.
 * 너비는 문서가 화면 폭을 따라가도록 감싸는 상자 대비 %로 쓴다(표 열은 colgroup %).
 */

type Apply = (ops: unknown[], summary: string) => void;
const round1 = (n: number) => Math.round(n * 10) / 10;

/** 손잡이를 누르고 끌기: 이동량(px)을 move로, 놓으면 up */
function drag(e: React.PointerEvent, move: (dx: number, dy: number) => void, up: () => void) {
  e.preventDefault();
  e.stopPropagation();
  const t = e.currentTarget as HTMLElement;
  t.setPointerCapture(e.pointerId);
  const x0 = e.clientX, y0 = e.clientY;
  const onMove = (ev: PointerEvent) => move(ev.clientX - x0, ev.clientY - y0);
  const onUp = () => { t.removeEventListener("pointermove", onMove); t.removeEventListener("pointerup", onUp); up(); };
  t.addEventListener("pointermove", onMove);
  t.addEventListener("pointerup", onUp);
}

/** 감싸는 상자의 안쪽 너비(padding 뺌) */
function innerWidth(el: Element | null): number {
  if (!el) return 0;
  const cs = el.ownerDocument.defaultView!.getComputedStyle(el);
  return el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
}

export function HtmlHandles({ selEl, blocks, busy, apply }: { selEl: Element | null; blocks: Map<string, Block>; busy: boolean; apply: Apply }) {
  if (!selEl || busy) return null;
  const table = selEl.closest<HTMLTableElement>("table[data-eid]");
  const tb = table ? blocks.get(table.getAttribute("data-eid")!) : undefined;
  const tr = selEl.closest<HTMLTableRowElement>("tr[data-eid]");
  const img = selEl.tagName === "IMG" ? (selEl as HTMLImageElement) : null;
  return (
    <>
      {table && tb?.table && !tb.table.merged && <ColumnHandles table={table} eid={tb.eid} apply={apply} />}
      {table && tr && <RowHandle tr={tr} table={table} apply={apply} />}
      {table && tb && <TableWidthHandle table={table} eid={tb.eid} apply={apply} />}
      {img && <ImageHandle img={img} b={blocks.get(img.getAttribute("data-eid")!)} apply={apply} />}
    </>
  );
}

function ColumnHandles({ table, eid, apply }: { table: HTMLTableElement; eid: string; apply: Apply }) {
  const first = table.querySelector("tr");
  const cells = first ? [...first.querySelectorAll<HTMLElement>(":scope > th, :scope > td")] : [];
  if (cells.length < 2) return null;
  const tr = table.getBoundingClientRect();
  const widths = cells.map((c) => c.getBoundingClientRect().width);
  let x = tr.left;
  return (
    <>
      {cells.slice(0, -1).map((c, i) => {
        x += widths[i];
        return (
          <div key={i} role="separator" aria-orientation="vertical" aria-label={`${i + 1}·${i + 2}열 경계`} data-handle="col"
            className="group pointer-events-auto absolute cursor-col-resize" style={{ left: x - 5, top: tr.top, width: 10, height: tr.height }}
            onPointerDown={(e) => {
              const pct = widths.map((w) => (w / tr.width) * 100);
              let next = pct;
              drag(e, (dx) => {
                const a = Math.max(5, Math.min(pct[i] + pct[i + 1] - 5, pct[i] + (dx / tr.width) * 100));
                next = pct.map((p, j) => (j === i ? a : j === i + 1 ? pct[i] + pct[i + 1] - a : p));
                cells.forEach((cell, j) => { cell.style.width = `${next[j]}%`; });
              }, () => { if (next !== pct) apply([{ t: "tableCols", eid, widths: next.map(round1) }], "표 열 너비"); });
            }}>
            <div className="mx-auto h-full w-[3px] bg-accent opacity-40 group-hover:opacity-100" />
          </div>
        );
      })}
    </>
  );
}

function RowHandle({ tr, table, apply }: { tr: HTMLTableRowElement; table: HTMLTableElement; apply: Apply }) {
  const r = tr.getBoundingClientRect(), t = table.getBoundingClientRect();
  return (
    <div role="separator" aria-orientation="horizontal" aria-label="행 높이" data-handle="row"
      className="group pointer-events-auto absolute flex cursor-row-resize items-center" style={{ left: t.left, top: r.bottom - 5, width: t.width, height: 10 }}
      onPointerDown={(e) => {
        let h = r.height;
        drag(e, (_dx, dy) => { h = Math.max(4, r.height + dy); tr.style.height = `${h}px`; },
          () => { if (Math.round(h) !== Math.round(r.height)) apply([{ t: "tableRowHeight", eid: tr.getAttribute("data-eid"), height: Math.round(h) }], "표 행 높이"); });
      }}>
      <div className="h-[3px] w-full bg-accent opacity-40 group-hover:opacity-100" />
    </div>
  );
}

function TableWidthHandle({ table, eid, apply }: { table: HTMLTableElement; eid: string; apply: Apply }) {
  const t = table.getBoundingClientRect();
  const box = innerWidth(table.parentElement);
  if (!box) return null;
  return (
    <div role="separator" aria-orientation="vertical" aria-label="표 너비" data-handle="table-width"
      className="pointer-events-auto absolute cursor-ew-resize rounded-sm border border-accent bg-surface" style={{ left: t.right - 4, top: t.top + t.height / 2 - 12, width: 8, height: 24 }}
      onPointerDown={(e) => {
        let pct = (t.width / box) * 100;
        drag(e, (dx) => { pct = Math.max(10, Math.min(100, ((t.width + dx) / box) * 100)); table.style.width = `${pct}%`; },
          () => { if (Math.abs(pct - (t.width / box) * 100) >= 0.5) apply([{ t: "setStyle", eid, set: { width: `${round1(pct)}%` } }], "표 너비"); });
      }} />
  );
}

function ImageHandle({ img, b, apply }: { img: HTMLImageElement; b: Block | undefined; apply: Apply }) {
  const r = img.getBoundingClientRect();
  const box = innerWidth(img.parentElement);
  if (!b || !box) return null;
  return (
    <div role="slider" aria-label="그림 크기" aria-valuenow={Math.round((r.width / box) * 100)} data-handle="image"
      className="pointer-events-auto absolute size-3 cursor-nwse-resize border border-accent bg-surface" style={{ left: r.right - 6, top: r.bottom - 6 }}
      onPointerDown={(e) => {
        let pct = (r.width / box) * 100;
        drag(e, (dx) => { pct = Math.max(5, Math.min(100, ((r.width + dx) / box) * 100)); img.style.width = `${pct}%`; img.style.height = "auto"; },
          () => {
            if (Math.abs(pct - (r.width / box) * 100) < 0.5) return;
            apply([{ t: "setStyle", eid: b.eid, set: { width: `${round1(pct)}%` }, ...(b.style.height ? { unset: ["height"] } : {}) }], "그림 크기");
          });
      }} />
  );
}
