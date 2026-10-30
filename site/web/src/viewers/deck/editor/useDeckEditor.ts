import { useCallback, useEffect, useRef, useState } from "react";
import { applyOps, formatDiagnostics, loadSlide, serializeSlide, SlideError, type DeckIndex, type Slide, type SlideOp } from "@workflow/core/slide";
import { getDeck, patchDeckIndex, patchSlide, putSlide } from "../../../lib/deckApi.ts";
import { SaveConflict } from "../../../lib/structedit.ts";

/**
 * 덱 편집 상태(명세 09·10절).
 * - 연산은 화면에서 먼저 적용하고(core applyOps, 역연산 받음) 슬라이드별로 모았다가 마지막 편집 800ms 뒤 한 번 보낸다.
 *   슬라이드를 바꾸거나 창을 닫을 때(pagehide)는 바로 보낸다(keepalive).
 * - 되돌리기는 역연산을 새 연산으로 적용·저장한다. 기록은 편집기 전체에 하나.
 * - 서버가 409(대상 요소가 사라짐)를 주면 최신 덱을 다시 받고, 그 슬라이드의 기록은 비운다.
 */

export interface DeckState { rev: number; baseVersion: string; index: DeckIndex; slides: Record<string, Slide> }
interface Entry { slideId: string; ops: SlideOp[]; inverse: SlideOp[] }
const SAVE_DELAY = 800;

export function useDeckEditor(menu: string, doc: string) {
  const [deck, setDeck] = useState<DeckState | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);
  const [, bump] = useState(0);
  const state = useRef<DeckState | null>(null);
  const queue = useRef(new Map<string, SlideOp[]>());
  const undo = useRef<Entry[]>([]);
  const redo = useRef<Entry[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flushing = useRef<Promise<void> | null>(null);

  const commit = (next: DeckState) => { state.current = next; setDeck(next); };

  const load = useCallback(async () => {
    const w = await getDeck(menu, doc);
    const slides: Record<string, Slide> = {};
    for (const s of w.slides) slides[s.id] = loadSlide(s.html);
    commit({ rev: w.rev, baseVersion: w.baseVersion, index: w.index, slides });
  }, [menu, doc]);

  useEffect(() => { load().catch((e) => setError(String((e as Error).message))); }, [load]);

  /** 모아 둔 연산을 보낸다. 이미 보내는 중이면 끝난 뒤 이어서 */
  const flush = useCallback(async (keepalive = false): Promise<void> => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    if (flushing.current) { await flushing.current; if (!queue.current.size) return; }
    const run = (async () => {
      setSaving(true);
      try {
        while (queue.current.size) {
          const [sid, ops] = queue.current.entries().next().value as [string, SlideOp[]];
          queue.current.delete(sid);
          try {
            const r = await patchSlide(menu, doc, sid, state.current!.rev, ops, keepalive);
            // 서버본(다른 사람 변경 포함)에 아직 못 보낸 연산을 다시 얹는다
            let slide = loadSlide(r.html);
            const later = queue.current.get(sid);
            if (later) slide = applyOps(slide, later).slide;
            commit({ ...state.current!, rev: r.rev, slides: { ...state.current!.slides, [sid]: slide } });
          } catch (e) {
            queue.current.delete(sid);
            undo.current = undo.current.filter((x) => x.slideId !== sid);
            redo.current = redo.current.filter((x) => x.slideId !== sid);
            setMessage(e instanceof SaveConflict ? `다른 사람이 지운 요소라 반영하지 못했습니다. 최신 슬라이드를 다시 불러왔습니다. (${e.message})`
              : `저장하지 못했습니다: ${(e as Error).message}`);
            await load();
          }
        }
      } finally {
        setSaving(false);
        flushing.current = null;
        bump((n) => n + 1);
      }
    })();
    flushing.current = run;
    await run;
  }, [menu, doc, load]);

  useEffect(() => {
    const onHide = () => { if (queue.current.size) void flush(true); };
    const onBefore = (e: BeforeUnloadEvent) => { if (queue.current.size || flushing.current) e.preventDefault(); };
    window.addEventListener("pagehide", onHide);
    window.addEventListener("beforeunload", onBefore);
    return () => { window.removeEventListener("pagehide", onHide); window.removeEventListener("beforeunload", onBefore); onHide(); };
  }, [flush]);

  /** 슬라이드에 연산 적용(화면 먼저) → 저장 대기열. 형식에 어긋나면 적용하지 않고 false */
  const apply = useCallback((slideId: string, ops: SlideOp[], record: "new" | "undo" | "redo" = "new"): boolean => {
    const cur = state.current;
    if (!cur || !ops.length) return false;
    let r;
    try { r = applyOps(cur.slides[slideId], ops); } catch (e) {
      setMessage(e instanceof SlideError ? `${e.message}${e.diagnostics.length ? ` — ${formatDiagnostics(e.diagnostics)}` : ""}` : String((e as Error).message));
      return false;
    }
    setMessage("");
    commit({ ...cur, slides: { ...cur.slides, [slideId]: r.slide } });
    const entry = { slideId, ops, inverse: r.inverse };
    if (record === "new") { undo.current.push(entry); redo.current = []; }
    else if (record === "undo") redo.current.push(entry);
    else undo.current.push(entry);
    queue.current.set(slideId, [...(queue.current.get(slideId) ?? []), ...ops]);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush(), SAVE_DELAY);
    bump((n) => n + 1);
    return true;
  }, [flush]);

  const travel = (from: Entry[], kind: "undo" | "redo") => {
    const e = from.pop();
    if (!e) return null;
    if (!apply(e.slideId, e.inverse, kind)) { from.length = 0; return null; }
    return e.slideId;
  };

  /** 덱 단위 변경(순서·추가·지우기): 대기 중 연산을 먼저 보내고 서버에 바로 쓴 뒤 다시 읽는다. 되돌리기 기록에는 넣지 않는다 */
  const deckChange = useCallback(async (fn: (rev: number) => Promise<unknown>) => {
    await flush();
    setSaving(true);
    try {
      await fn(state.current!.rev);
      await load();
      return true;
    } catch (e) {
      setMessage(e instanceof SaveConflict ? "다른 곳에서 먼저 저장해 최신 덱을 다시 불러왔습니다. 다시 해 주세요." : `저장하지 못했습니다: ${(e as Error).message}`);
      await load();
      return false;
    } finally { setSaving(false); }
  }, [flush, load]);

  const newId = (base: string) => {
    const used = new Set(state.current!.index.order);
    let i = 1;
    let id = base;
    while (used.has(id)) id = `${base}-${++i}`;
    return id;
  };

  return {
    deck, error, message, setMessage, saving, pending: queue.current.size > 0 || !!flushing.current,
    canUndo: undo.current.length > 0, canRedo: redo.current.length > 0,
    apply, flush, reload: load,
    undo: () => travel(undo.current, "undo"),
    redo: () => travel(redo.current, "redo"),
    reorder: (order: string[]) => deckChange((rev) => patchDeckIndex(menu, doc, rev, { order }, "슬라이드 순서 바꿈")),
    remove: (id: string) => deckChange((rev) => patchDeckIndex(menu, doc, rev, { order: state.current!.index.order.filter((x) => x !== id) })),
    rename: (title: string) => deckChange((rev) => patchDeckIndex(menu, doc, rev, { title }, "덱 제목 바꿈")),
    /** 새 슬라이드(빈 슬라이드 또는 복제). 만든 id를 돌려준다 */
    add: async (after: number, from?: Slide) => {
      const id = newId(from ? `${from.id}-copy` : "slide");
      const slide: Slide = from ? { ...from, id, root: { ...from.root, eid: id } }
        : loadSlide(`<section id="${id}" style="padding:128px;display:flex;flex-direction:column;gap:48px"><h2>제목</h2><p>내용</p></section>`);
      const ok = await deckChange((rev) => putSlide(menu, doc, id, rev, serializeSlide(slide), after + 1));
      return ok ? id : null;
    },
  };
}
export type DeckEditor = ReturnType<typeof useDeckEditor>;
