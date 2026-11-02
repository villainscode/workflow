import { useCallback, useEffect, useRef, useState } from "react";
import { AlignCenter, AlignLeft, AlignRight, ArrowDown, ArrowUp, BringToFront, Columns3, CopyPlus, Heading2, ImagePlus, ImageUp, Network, PenTool, Pilcrow, PinOff, Rows3, SendToBack, Smartphone, SquareDashedText, Table2, Trash2 } from "lucide-react";
import { editViewUrl, uploadAsset, type Block, type DocTheme } from "../../lib/structedit.ts";
import { injectStyle } from "../../lib/textedit.ts";
import { useConfirm } from "../../components/confirm/ConfirmProvider.tsx";
import { IconButton } from "../../components/IconButton.tsx";
import { TextToolbarView } from "../../editor/TextToolbar.tsx";
import { HtmlStylePanel, GENERIC, fontValue } from "./HtmlStylePanel.tsx";
import { HtmlHandles } from "./HtmlHandles.tsx";
import { containingBlock, minHeightFor, pinBoxOf, previewPin, type PinBox } from "./pinBox.ts";
import { inlineText } from "./inlineText.ts";
import { DrawioEditor } from "../../editor/DrawioEditor.tsx";
import { SvgEditor } from "../../editor/SvgEditor.tsx";
import { fetchSvg, IMAGE_ACCEPT, isDrawioSvg, uploadSvg } from "../../editor/svgFile.ts";
import { useEditorConfig } from "../../lib/editorConfig.ts";
import type { StructCtx } from "./StructEditor.tsx";

/**
 * HTML 구조 편집(5.0 M3). 편집 사본(data-eid, 스크립트 없음)을 같은 출처 iframe으로 열고, 누른 요소를 골라 오른쪽에서 고친다.
 * 연산은 서버가 원본 바이트에 패치한다(packages/core/src/structedit/html.ts). 저장할 때마다 사본을 다시 읽는다(eid는 위치라 바뀐다).
 * 글자는 두 번 눌러 그 자리에서 고치고(인라인 서식만 남는다), 바깥을 누르거나 Enter면 저장, Esc면 취소.
 * 그림 파일을 문서 위에 끌어 놓거나 붙여 넣으면 고른 요소 뒤에(없으면 문서 끝 블록 뒤에) 넣는다.
 * 6.0 V2 요소 편집: 속성 패널(서식, HtmlStylePanel), 글자 편집 중 도구 막대(editor/TextToolbar + inlineText),
 * 표 열 경계·행 높이·표 너비·그림 크기 손잡이(HtmlHandles), 복제(⌘D), 되돌리기(⌘Z·⇧⌘Z), 부모 고르기(Esc), 레이어 패널.
 * 6.0 V3 자유 배치: 옮기기 손잡이로 끌면 고정 위치(HtmlHandles), 고정 요소는 방향키로 1px·Shift 8px(잠깐 멈추면 저장), 앞뒤 순서·흐름으로 되돌리기.
 * 그림 파일을 끌어 놓거나 붙여 넣으면 놓은 자리(붙여 넣기는 고른 요소 자리)에 고정 그림으로, 「글상자 넣기」는 보이는 자리에 고정 글상자로 넣는다.
 * 좁은 화면 미리보기(640px)에서는 고정 요소가 흐름으로 돌아간 모습을 본다.
 * 6.0 V4 SVG: SVG 파일도 그림처럼 넣는다(파일 참조, 서버가 소독). 「다이어그램 그리기」는 draw.io(자체 호스팅)로 그려 넣고,
 * SVG 그림은 draw.io SVG면 draw.io로, 아니면 svgedit 캔버스로 고쳐 새 자산으로 바꾼다. 인라인 SVG는 도형을 눌러 채움·선·글자를 고친다(svgAttr).
 */

const IMAGE_RE = /^image\/(png|jpeg|webp|gif|svg\+xml)$/;
/** 열려 있는 SVG 편집기 */
type SvgEdit = { kind: "drawio" | "svgedit"; svg?: string; title: string; save: (svg: string) => Promise<void> };

const SIZES = ["12px", "14px", "16px", "18px", "20px", "24px", "28px", "32px"];
const NO_THEME: DocTheme = { fonts: [], tokens: [], dark: false };

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

/** 새 그림·글상자를 넣을 수 있는 기준 섹션(core PLACE_IN과 같다) */
const PLACE_IN = new Set(["SECTION", "MAIN", "BODY", "DIV", "ARTICLE", "ASIDE", "HEADER", "FOOTER", "NAV", "FIGURE", "FORM"]);
function placeBase(doc: Document, at: Element | null): HTMLElement | null {
  for (let p = at?.closest<HTMLElement>("[data-base]") ?? null; p; p = p.parentElement?.closest<HTMLElement>("[data-base]") ?? null) {
    if (PLACE_IN.has(p.tagName)) return p;
  }
  const root = doc.querySelector<HTMLElement>("[data-root][data-base]");
  return root && PLACE_IN.has(root.tagName) ? root : null;
}

const rowsOf = (t: Element) => [...t.querySelectorAll(":scope > tr, :scope > thead > tr, :scope > tbody > tr, :scope > tfoot > tr")];

export function HtmlStructPane({ ctx }: { ctx: StructCtx }) {
  const { menu, doc, s, busy, run, setMessage } = ctx;
  const theme = s.theme ?? NO_THEME;
  const confirm = useConfirm();
  const frame = useRef<HTMLIFrameElement>(null);
  const [sel, setSel] = useState<string | null>(null);
  // 사본을 스크롤하거나 크기가 바뀌면 손잡이 자리를 다시 잰다
  const [, setTick] = useState(0);
  const bump = useCallback(() => setTick((n) => n + 1), []);
  // 글자 편집 중인 요소와 도구 막대 명령
  const [editing, setEditing] = useState<{ el: HTMLElement; api: ReturnType<typeof inlineText>; done: (save: boolean) => void } | null>(null);
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;
  // 고른 칸의 행·열(표 안을 골랐을 때)
  const [cell, setCell] = useState<{ row: number; col: number } | null>(null);
  // 좁은 화면(640px) 미리보기, 처음 고정 위치로 바꿨을 때 한 줄 안내
  const [narrow, setNarrow] = useState(false);
  const [pinNote, setPinNote] = useState(false);
  // SVG 편집기(draw.io·svgedit)와 고른 인라인 SVG 도형
  const [svgEdit, setSvgEdit] = useState<SvgEdit | null>(null);
  const [shape, setShape] = useState<string | null>(null);
  const { drawio } = useEditorConfig();
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

  /** 자유 배치 연산 저장. 실패하면 미리 그린 사본을 버리고 다시 읽는다 */
  const pin = useCallback((ops: unknown[], summary: string, firstPin?: boolean) => {
    void runRef.current(ops, summary).then((ok) => {
      if (!ok) frame.current?.contentWindow?.location.reload();
      else if (firstPin) setPinNote(true);
    });
  }, []);

  /**
   * 기준 섹션의 점(x·y, 사본 화면 좌표)에 고정 요소를 넣는다. 미리 넣어 최소 높이를 잰 뒤 지우고 place 하나로 저장한다.
   * 그림은 섹션 너비의 절반·원래 크기 중 작은 너비, 글상자는 30%
   */
  const place = useCallback(async (base: HTMLElement, at: { x: number; y: number }, node: { kind: "image"; src: string; alt: string; width: number; height: number } | { kind: "textbox"; text: string }) => {
    const doc = d();
    if (!doc) return;
    const c = base.getBoundingClientRect();
    const cw = base.clientWidth;
    const w = node.kind === "image" ? Math.min(node.width, cw * 0.5) : cw * 0.3;
    const h = node.kind === "image" ? (w * node.height) / Math.max(1, node.width) : 0;
    const left = Math.min(Math.max(c.left + base.clientLeft, at.x - w / 2), c.left + base.clientLeft + cw - w);
    const top = Math.max(c.top + base.clientTop, at.y - h / 2);
    const box = pinBoxOf({ left, top, width: w }, base);
    const tmp = doc.createElement(node.kind === "image" ? "div" : "p");
    tmp.setAttribute("data-pin", "");
    tmp.textContent = node.kind === "textbox" ? node.text : "";
    tmp.style.cssText = `position:absolute;left:${box.left}%;top:${box.top}px;width:${box.width}%;margin:0${node.kind === "image" ? `;aspect-ratio:${node.width}/${Math.max(1, node.height)}` : ""}`;
    const prev = base.style.position;
    base.style.position = "relative";
    base.appendChild(tmp);
    const minHeight = await minHeightFor(doc, base);
    tmp.remove();
    base.style.position = prev;
    const out = { left: Math.round(box.left * 100) / 100, top: Math.round(box.top), width: Math.round(box.width * 100) / 100 };
    const n = node.kind === "image" ? { kind: "image", src: node.src, alt: node.alt } : { kind: "textbox", text: node.text };
    pin([{ t: "place", base: base.getAttribute("data-base"), node: n, box: out, minHeight }], node.kind === "image" ? "그림 자유 배치" : "글상자 넣기", true);
  }, [pin]);

  /** 그림 파일 → 자산 → 놓은 자리(at)가 있으면 그 섹션에 고정 그림, 없으면 고른 요소(또는 마지막 블록) 뒤에 넣기 */
  const insertImage = useCallback(async (file: File, ref: string | null, at?: { x: number; y: number; target: Element | null }) => {
    if (!IMAGE_RE.test(file.type)) { setMessage("PNG·JPEG·WebP·GIF·SVG만 넣을 수 있습니다"); return; }
    const doc = d();
    const base = at && doc ? placeBase(doc, at.target) : null;
    if (base && at) {
      try {
        const a = await uploadAsset(file);
        await place(base, at, { kind: "image", src: a.asset, alt: file.name.replace(/\.[^.]+$/, ""), width: a.width, height: a.height });
      } catch (e) { setMessage(String((e as Error).message)); }
      return;
    }
    const target = ref ?? [...(d()?.body.querySelectorAll(":scope > [data-eid], :scope > * > [data-eid]") ?? [])].pop()?.getAttribute("data-eid");
    if (!target) { setMessage("그림을 넣을 자리를 먼저 고르세요"); return; }
    try {
      const a = await uploadAsset(file);
      await runRef.current([{ t: "insert", ref: target, where: "after", node: { kind: "image", src: a.asset, alt: file.name.replace(/\.[^.]+$/, "") } }], "그림 넣기");
    } catch (e) { setMessage(String((e as Error).message)); }
  }, [setMessage, place]);
  const anchorRef = useRef(anchorEid);
  anchorRef.current = anchorEid;
  const selRef = useRef(sel);
  selRef.current = sel;
  const narrowRef = useRef(narrow);
  narrowRef.current = narrow;
  // 방향키 이동: 사본에 바로 그리고 잠깐(0.5초) 멈추면 toPinned 하나로 저장한다
  const nudgeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const nudge = useCallback((dx: number, dy: number) => {
    const doc = d(), eid = selRef.current, b = eid ? blocksRef.current?.find((x) => x.eid === eid) : undefined;
    const el = eid ? doc?.querySelector<HTMLElement>(`[data-eid="${eid}"]`) : null;
    const base = b?.pinBase ? doc?.querySelector<HTMLElement>(`[data-base="${b.pinBase}"]`) : null;
    if (!doc || !b?.pinned || !el || !base || narrowRef.current) return false;
    // 고정 요소의 위치 기준은 offsetParent(사본 iframe의 요소라 instanceof로 보지 않는다)
    const cb = (el.offsetParent as HTMLElement | null) ?? base;
    const r = el.getBoundingClientRect(), c = cb.getBoundingClientRect();
    const minL = c.left + cb.clientLeft, maxL = minL + cb.clientWidth - r.width;
    const box = pinBoxOf({ left: Math.min(Math.max(minL, r.left + dx), Math.max(minL, maxL)), top: Math.max(c.top + cb.clientTop, r.top + dy), width: r.width }, cb);
    el.style.left = `${box.left}%`;
    el.style.top = `${box.top}px`;
    bump();
    if (nudgeTimer.current) clearTimeout(nudgeTimer.current);
    nudgeTimer.current = setTimeout(() => {
      void minHeightFor(doc, base).then((minHeight) => pin([{ t: "toPinned", eid: b.eid,
        box: { left: Math.round(box.left * 100) / 100, top: Math.round(box.top), width: Math.round(box.width * 100) / 100 }, minHeight }], "옮기기"));
    }, 500);
    return true;
  }, [bump, pin]);
  useEffect(() => () => { if (nudgeTimer.current) clearTimeout(nudgeTimer.current); }, []);

  /** 속성 패널 위치 칸: 고른 요소를 기준 섹션 안 X(%)·Y(px)·너비(%)로 고정한다. 흐름 요소는 지금 자리에서 고정 위치로 바뀐다 */
  const pinBoxNow = (b: Block): PinBox | null => {
    const doc = d(), el = doc?.querySelector<HTMLElement>(`[data-eid="${b.eid}"]`);
    const base = b.pinBase ? doc?.querySelector<HTMLElement>(`[data-base="${b.pinBase}"]`) : null;
    if (!el || !base) return null;
    const cb = b.pinned ? ((el.offsetParent as HTMLElement | null) ?? base) : containingBlock(el, base);
    return pinBoxOf(el.getBoundingClientRect(), cb);
  };
  const setPinBox = (b: Block, part: Partial<PinBox>) => {
    const doc = d(), el = doc?.querySelector<HTMLElement>(`[data-eid="${b.eid}"]`);
    const base = b.pinBase ? doc?.querySelector<HTMLElement>(`[data-base="${b.pinBase}"]`) : null;
    const cur = pinBoxNow(b);
    if (!doc || !el || !base || !cur || narrow) return;
    const width = Math.min(100, Math.max(1, part.width ?? cur.width));
    const box = { left: Math.min(100 - width, Math.max(0, part.left ?? cur.left)), top: Math.max(0, part.top ?? cur.top), width };
    if (b.pinned) { el.style.left = `${box.left}%`; el.style.top = `${box.top}px`; el.style.width = `${box.width}%`; } else previewPin(el, base, box);
    void minHeightFor(doc, base).then((minHeight) => pin([{ t: "toPinned", eid: b.eid,
      box: { left: Math.round(box.left * 100) / 100, top: Math.round(box.top), width: Math.round(box.width * 100) / 100 }, minHeight }],
    b.pinned ? "위치" : "자유 배치", !b.pinned));
  };
  const duplicate = useCallback(() => {
    const eid = anchorRef.current;
    if (eid) void runRef.current([{ t: "duplicate", eid }], "복제");
  }, []);
  /** 고르기(사본 안 누르기·레이어 패널·Esc 공통): 순번을 기억해 다시 읽은 사본에서 잇는다 */
  const pick = useCallback((el: Element | null) => {
    const doc = d();
    setSel(el?.getAttribute("data-eid") ?? null);
    selKey.current = el && doc ? { index: [...doc.querySelectorAll("[data-eid]")].indexOf(el), tag: el.tagName } : null;
    const td = el?.closest("td, th");
    const tb = td?.closest("table");
    setCell(td && tb ? { row: rowsOf(tb).indexOf(td.parentElement!), col: [...td.parentElement!.children].filter((c) => /^T[DH]$/.test(c.tagName)).indexOf(td) } : null);
  }, []);

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
      setShape(t.closest("[data-shape]")?.getAttribute("data-shape") ?? null);
      pick(t.closest("[data-eid]"));
    }, true);
    doc.addEventListener("scroll", bump, { passive: true });
    doc.defaultView?.addEventListener("resize", bump);
    void doc.fonts?.ready.then(bump);
    doc.addEventListener("keydown", (e) => {
      if ((e.target as Element).closest?.('[contenteditable="true"]')) return;
      const mod = e.metaKey || e.ctrlKey, k = e.key.toLowerCase();
      if (mod && k === "z") { e.preventDefault(); if (e.shiftKey) ctxRef.current.redo(); else ctxRef.current.undo(); }
      else if (mod && k === "d") { e.preventDefault(); duplicate(); }
      else if (e.key.startsWith("Arrow") && !mod) {
        const step = e.shiftKey ? 8 : 1;
        const [dx, dy] = ({ ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] } as Record<string, [number, number]>)[e.key] ?? [0, 0];
        if ((dx || dy) && nudge(dx, dy)) e.preventDefault();
      }
      else if (e.key === "Escape") {
        // 부모 블록 고르기
        const cur = doc.querySelector("[data-sel]");
        const up = cur?.parentElement?.closest("[data-eid]");
        if (up) { e.preventDefault(); pick(up); }
      }
    });
    doc.addEventListener("dblclick", (e) => {
      const el = (e.target as Element).closest<HTMLElement>("[data-eid]");
      if (!el || el.getAttribute("data-editable") !== "1") return;
      const before = el.innerHTML;
      el.setAttribute("contenteditable", "true");
      el.focus();
      const api = inlineText(doc, el);
      const refresh = () => bump();
      el.addEventListener("keyup", refresh);
      el.addEventListener("mouseup", refresh);
      el.addEventListener("input", refresh);
      let finished = false;
      const done = (save: boolean) => {
        if (finished) return;
        finished = true;
        el.removeEventListener("blur", onBlur);
        el.removeEventListener("keydown", onKey);
        el.removeEventListener("keyup", refresh);
        el.removeEventListener("mouseup", refresh);
        el.removeEventListener("input", refresh);
        api.dispose();
        setEditing(null);
        el.removeAttribute("contenteditable");
        if (!save || el.innerHTML === before) { el.innerHTML = before; return; }
        void runRef.current([{ t: "setText", eid: el.getAttribute("data-eid"), html: el.innerHTML }], "글자 고침");
      };
      setEditing({ el, api, done });
      // 도구 막대(바깥 문서)의 목록·입력칸으로 포커스가 옮겨 가면 편집을 이어 간다. 막대를 떠나면 막대가 끝낸다(onLeave)
      const onBlur = () => setTimeout(() => {
        if (document.activeElement?.closest("[data-text-toolbar]") || doc.activeElement === el) return;
        done(true);
      }, 0);
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
      // 좁은 화면 미리보기에서는 고정 위치가 흐름이라 놓은 자리에 고정하지 않는다
      void insertImage(f, anchorOf(at ?? null)?.getAttribute("data-eid") ?? anchorRef.current,
        narrowRef.current ? undefined : { x: e.clientX, y: e.clientY, target: e.target as Element });
    });
    doc.addEventListener("paste", (e) => {
      if ((e.target as Element).closest?.('[contenteditable="true"]')) return;
      const f = [...(e.clipboardData?.files ?? [])].find((x) => x.type.startsWith("image/"));
      if (!f) return;
      e.preventDefault();
      // 고른 요소 자리(없으면 보이는 화면 가운데)에 고정 그림
      const cur = selRef.current ? doc.querySelector(`[data-eid="${selRef.current}"]`) : null;
      const r = cur?.getBoundingClientRect();
      const view = doc.defaultView!;
      void insertImage(f, anchorRef.current, narrowRef.current ? undefined
        : { x: r ? r.left + r.width / 2 : view.innerWidth / 2, y: r ? Math.max(0, r.top) + 40 : view.innerHeight / 2, target: cur });
    });
  }, [insertImage, pick, bump, duplicate, nudge]);

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

  /** 글상자 넣기: 고른 요소의 섹션(없으면 본문 뿌리), 보이는 위쪽 자리에 */
  const addTextbox = () => {
    const doc = d();
    if (!doc || narrow) return;
    const base = placeBase(doc, selEl);
    if (!base) { setMessage("글상자를 넣을 섹션이 없습니다"); return; }
    const c = base.getBoundingClientRect();
    void place(base, { x: c.left + base.clientWidth * 0.2, y: Math.max(c.top + 16, 16) }, { kind: "textbox", text: "새 글상자" });
  };
  /** draw.io로 새 다이어그램: 저장하면 SVG 자산으로 올려 고른 요소 뒤(없으면 끝 블록 뒤)에 그림으로 넣는다 */
  const drawNew = () => setSvgEdit({ kind: "drawio", title: "새 다이어그램", save: async (svg) => {
    const a = await uploadSvg(svg, "diagram.svg");
    const target = anchorRef.current ?? [...(d()?.body.querySelectorAll(":scope > [data-eid], :scope > * > [data-eid]") ?? [])].pop()?.getAttribute("data-eid");
    if (!target) throw new Error("다이어그램을 넣을 자리를 먼저 고르세요");
    if (!await runRef.current([{ t: "insert", ref: target, where: "after", node: { kind: "image", src: a.asset, alt: "다이어그램" } }], "다이어그램 넣기")) throw new Error("넣지 못했습니다");
  } });
  /** SVG 그림 고치기: draw.io SVG면 draw.io, 아니면 svgedit. 저장하면 새 자산으로 바꾼다 */
  const editSvgImage = async (eid: string, url: string) => {
    try {
      const svg = await fetchSvg(url);
      const save = async (out: string) => {
        const a = await uploadSvg(out);
        if (!await runRef.current([{ t: "setAttr", eid, name: "src", value: a.asset }], "SVG 고침")) throw new Error("저장하지 못했습니다");
        if (a.removed?.length) setMessage(`SVG에서 허용하지 않는 것을 지웠습니다: ${a.removed.join(", ")}`);
      };
      if (isDrawioSvg(svg)) {
        if (!drawio) { setMessage("draw.io로 만든 SVG는 draw.io 편집기로 고칩니다. 이 사이트에는 draw.io 편집기가 설정되지 않았습니다(DRAWIO_ORIGIN)"); return; }
        setSvgEdit({ kind: "drawio", svg, title: "다이어그램 고치기", save });
      } else setSvgEdit({ kind: "svgedit", svg, title: "SVG 고치기", save });
    } catch (e) { setMessage(String((e as Error).message)); }
  };
  const fonts = [...theme.fonts, ...GENERIC].map((f) => ({ label: f, value: fontValue(f) }));
  const palette = theme.tokens.map((t) => ({ value: `var(${t.name})`, label: t.name, swatch: t.value }));
  const ts = editing?.api.read();

  return (
    <div className="grid min-h-0 grid-cols-[minmax(0,1fr)_17rem]">
      <div className="flex min-h-0 flex-col">
        {editing && ts && (
          <TextToolbarView state={ts} cmd={wrapBump(editing.api.cmd, bump)} fonts={fonts} sizes={SIZES} palette={palette}
            isEditor={(el) => el.tagName === "IFRAME"} onLeave={() => editing.done(true)}
            note={theme.dark && ts.color && !ts.color.startsWith("var(") ? "직접 고른 색은 다크 모드에서 바뀌지 않습니다" : undefined} />
        )}
        {!editing && (
          <div className="flex flex-wrap items-center gap-1 border-b border-line bg-surface px-2 py-1">
            <IconButton icon={SquareDashedText} label="글상자 넣기 (보이는 자리에 고정 위치)" text="글상자" size={16} disabled={busy || narrow} onClick={addTextbox} />
            {drawio && <IconButton icon={Network} label="다이어그램 그리기 (draw.io, 고른 요소 뒤에 SVG로 넣기)" text="다이어그램" size={16} disabled={busy} onClick={drawNew} />}
            <IconButton icon={Smartphone} label={narrow ? "넓은 화면으로 돌아가기" : "좁은 화면 미리보기 (640px)"} size={16} active={narrow} onClick={() => setNarrow((v) => !v)} />
            {narrow && <span className="text-xs text-muted">640px 이하에서는 고정 위치 요소가 문서 순서대로 쌓입니다. 이 보기에서는 옮길 수 없습니다.</span>}
            {pinNote && !narrow && <span className="text-xs text-muted" role="status">옮긴 요소는 고정 위치가 됩니다. ⌘Z나 「흐름으로 되돌리기」로 되돌립니다.</span>}
          </div>
        )}
        <div className="relative min-h-0 flex-1">
          <div className={narrow ? "relative mx-auto h-full w-[640px] max-w-full border-x border-line" : "relative h-full"}>
            <iframe
              key={s.rev}
              ref={frame}
              src={editViewUrl(menu, doc, s.rev)}
              title="구조 편집"
              className="block h-full w-full border-0 bg-surface"
              sandbox="allow-same-origin"
              onLoad={onLoad}
            />
            {!editing && (
              <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-label="손잡이">
                <HtmlHandles selEl={selEl} blocks={blocks} busy={busy} narrow={narrow} pin={pin} apply={(ops, summary) => void run(ops, summary)} />
              </div>
            )}
          </div>
        </div>
      </div>
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

            <HtmlStylePanel key={b.eid} b={b} el={selEl as HTMLElement | null} theme={theme} busy={busy}
              apply={(set, unset, summary) => void run([{ t: "setStyle", eid: b.eid, ...(Object.keys(set).length ? { set } : {}), ...(unset.length ? { unset } : {}) }], summary)} />

            {tb?.table && <TableSection ctx={ctx} eid={tb.eid} t={tb.table} cell={cell} onRemove={() => remove(tb.eid, "표")} />}
            {b.image && <ImageSection ctx={ctx} b={b} url={(selEl as HTMLImageElement | null)?.src ?? ""} onEditSvg={(url) => void editSvgImage(b.eid, url)} />}
            {b.svg && <InlineSvgSection ctx={ctx} b={b} shape={shape} onShape={setShape} />}

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
                    <input type="file" accept={IMAGE_ACCEPT} className="sr-only" aria-label="그림 넣기"
                      onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void insertImage(f, ab.eid); }} />
                  </label>
                </div>
              </section>
            )}

            {b.pinBase && !narrow && (() => {
              const now = b.pinned ? { left: parseFloat(b.style.left ?? "0"), top: parseFloat(b.style.top ?? "0"), width: parseFloat(b.style.width ?? "0") } : pinBoxNow(b);
              return now && (
                <section className="space-y-1" aria-label="위치">
                  <h3 className="text-xs font-semibold text-muted">{b.pinned ? "위치 (자유 배치)" : "위치 (값을 넣으면 그 자리에 고정)"}</h3>
                  <div className="grid grid-cols-3 gap-1">
                    <PinNum key={`x${b.eid}${now.left}`} label="X" unit="%" value={now.left} disabled={busy} onCommit={(v) => setPinBox(b, { left: v })} />
                    <PinNum key={`y${b.eid}${now.top}`} label="Y" unit="px" value={now.top} disabled={busy} onCommit={(v) => setPinBox(b, { top: v })} />
                    <PinNum key={`w${b.eid}${now.width}`} label="너비" unit="%" value={now.width} disabled={busy} onCommit={(v) => setPinBox(b, { width: v })} />
                  </div>
                </section>
              );
            })()}
            {b.pinned && (
              <section>
                <div className="flex flex-wrap gap-1">
                  <IconButton icon={BringToFront} label="앞으로 가져오기 (나중에 그리기)" variant="outline" disabled={busy} onClick={() => move(1)} />
                  <IconButton icon={SendToBack} label="뒤로 보내기 (먼저 그리기)" variant="outline" disabled={busy} onClick={() => move(-1)} />
                  <IconButton icon={PinOff} label="흐름으로 되돌리기" text="흐름으로" variant="outline" disabled={busy}
                    onClick={() => pin([{ t: "unpin", eid: b.eid }], "흐름으로 되돌림")} />
                </div>
              </section>
            )}
            {!b.pinned && b.pinBase && <p className="text-xs text-muted">문서 위 옮기기 손잡이를 끌거나 위치 값을 넣으면 그 자리에 고정됩니다(자유 배치).</p>}

            {ab && ab.tag !== "table" && !b.pinned && (
              <section className="flex flex-wrap gap-1">
                <IconButton icon={ArrowUp} label="위로 옮기기" variant="outline" disabled={busy} onClick={() => move(-1)} />
                <IconButton icon={ArrowDown} label="아래로 옮기기" variant="outline" disabled={busy} onClick={() => move(1)} />
                <IconButton icon={CopyPlus} label="복제 (⌘D)" variant="outline" disabled={busy} onClick={duplicate} />
                <IconButton icon={Trash2} label={`${NAME[ab.tag] ?? ab.tag} 지우기`} variant="outline" disabled={busy}
                  onClick={() => void remove(ab.eid, NAME[ab.tag] ?? ab.tag)} />
              </section>
            )}
            {ab?.tag === "table" && (
              <section className="flex flex-wrap gap-1">
                <IconButton icon={ArrowUp} label="표 위로 옮기기" variant="outline" disabled={busy} onClick={() => move(-1)} />
                <IconButton icon={ArrowDown} label="표 아래로 옮기기" variant="outline" disabled={busy} onClick={() => move(1)} />
                <IconButton icon={CopyPlus} label="표 복제 (⌘D)" variant="outline" disabled={busy} onClick={duplicate} />
              </section>
            )}
          </div>
        )}
      </aside>
      {svgEdit?.kind === "drawio" && drawio && (
        <DrawioEditor origin={drawio} svg={svgEdit.svg} title={svgEdit.title} onSave={svgEdit.save} onClose={() => setSvgEdit(null)} />
      )}
      {svgEdit?.kind === "svgedit" && svgEdit.svg && (
        <SvgEditor svg={svgEdit.svg} title={svgEdit.title} onSave={svgEdit.save} onClose={() => setSvgEdit(null)} />
      )}
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

function ImageSection({ ctx, b, url, onEditSvg }: { ctx: StructCtx; b: Block; url: string; onEditSvg: (url: string) => void }) {
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
      <div className="flex items-center gap-1 text-xs">
        <span className="text-muted">정렬</span>
        {([["left", AlignLeft, "그림 왼쪽", { "margin-left": "0", "margin-right": "auto" }], ["center", AlignCenter, "그림 가운데", { "margin-left": "auto", "margin-right": "auto" }],
          ["right", AlignRight, "그림 오른쪽", { "margin-left": "auto", "margin-right": "0" }]] as const).map(([k, icon, label, m]) => (
          <IconButton key={k} icon={icon} label={label} size={16} disabled={busy}
            active={b.style["margin-left"] === m["margin-left"] && b.style["margin-right"] === m["margin-right"]}
            onClick={() => void run([{ t: "setStyle", eid: b.eid, set: { display: "block", ...m } }], label)} />
        ))}
      </div>
      <label className={`inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-line px-2.5 py-1 text-xs font-medium text-muted hover:bg-sunken hover:text-fg ${busy ? "pointer-events-none opacity-30" : ""}`}>
        <ImageUp size={16} aria-hidden /> 그림 바꾸기
        <input type="file" accept={IMAGE_ACCEPT} className="sr-only"
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
      {/\.svg(?:[?#].*)?$/i.test(img.src) && url && (
        <IconButton icon={PenTool} label="SVG 고치기 (draw.io SVG는 draw.io로)" text="SVG 고치기" variant="outline" disabled={busy} onClick={() => onEditSvg(url)} />
      )}
    </section>
  );
}

/** 인라인 SVG 도형(6.0 V4): 문서에서 도형을 누르거나 목록에서 골라 채움·선 색과 글자를 바꾼다(svgAttr) */
function InlineSvgSection({ ctx, b, shape, onShape }: { ctx: StructCtx; b: Block; shape: string | null; onShape: (eid: string | null) => void }) {
  const { busy, run } = ctx;
  const shapes = b.svg!.shapes;
  // 저장하면 eid(위치)가 바뀐다. 고른 도형은 순번으로 잇는다
  const last = useRef(-1);
  const at = shapes.findIndex((x) => x.eid === shape);
  const idx = at >= 0 ? at : shape ? last.current : -1;
  last.current = idx;
  const cur = idx >= 0 ? shapes[idx] ?? null : null;
  const [text, setText] = useState(cur?.text ?? "");
  useEffect(() => setText(cur?.text ?? ""), [cur?.eid, cur?.text]);
  const set = (name: "fill" | "stroke" | "text", value: string) => { if (cur) void run([{ t: "svgAttr", eid: cur.eid, name, value }], "SVG 도형"); };
  const hex = (v: string | null) => (v && /^#[0-9a-f]{6}$/i.test(v) ? v : "#000000");
  return (
    <section className="space-y-2">
      <h3 className="text-xs font-semibold text-muted">인라인 SVG · 도형 {shapes.length}개{b.svg!.drawio ? " · draw.io" : ""}</h3>
      <select className="w-full rounded border border-line bg-surface px-1 py-1 text-xs" aria-label="SVG 도형 고르기" value={cur?.eid ?? ""}
        onChange={(e) => onShape(e.target.value || null)}>
        <option value="">도형 고르기 (문서에서 눌러도 됩니다)</option>
        {shapes.map((x, i) => <option key={x.eid} value={x.eid}>{i + 1}. &lt;{x.tag}&gt;{x.text ? ` ${x.text.slice(0, 20)}` : ""}{x.fill ? ` · ${x.fill}` : ""}</option>)}
      </select>
      {cur && (
        <div className="grid grid-cols-[auto_1fr] items-center gap-x-2 gap-y-1 text-xs">
          <span className="text-muted">채움</span>
          <ColorField key={`f${cur.eid}${cur.fill}`} label="도형 채움 색" value={hex(cur.fill)} disabled={busy} onCommit={(v) => set("fill", v)} />
          <span className="text-muted">선</span>
          <ColorField key={`s${cur.eid}${cur.stroke}`} label="도형 선 색" value={hex(cur.stroke)} disabled={busy} onCommit={(v) => set("stroke", v)} />
          {cur.text !== null && (
            <>
              <span className="text-muted">글자</span>
              <input aria-label="도형 글자" value={text} disabled={busy} className="rounded border border-line bg-surface px-2 py-0.5"
                onChange={(e) => setText(e.target.value)} onBlur={() => { if (text !== cur.text) set("text", text); }}
                onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing) { e.preventDefault(); (e.target as HTMLInputElement).blur(); } }} />
            </>
          )}
        </div>
      )}
    </section>
  );
}

/** 위치 숫자 칸: Enter·칸 떠날 때 저장, Esc는 되돌림 */
function PinNum({ label, unit, value, disabled, onCommit }: { label: string; unit: string; value: number; disabled: boolean; onCommit: (v: number) => void }) {
  const shown = String(Math.round(value * 10) / 10);
  const [v, setV] = useState(shown);
  const commit = () => { const n = parseFloat(v); if (Number.isFinite(n) && String(n) !== shown) onCommit(n); else setV(shown); };
  return (
    <label className="flex items-center gap-1 text-xs">
      <span className="shrink-0 text-muted">{label}</span>
      <input type="number" step="any" aria-label={`위치 ${label} (${unit})`} disabled={disabled} value={v} className="w-full min-w-0 rounded border border-line bg-surface px-1 py-0.5 font-mono"
        onChange={(e) => setV(e.target.value)} onBlur={commit} onFocus={(e) => e.target.select()}
        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); commit(); } if (e.key === "Escape") setV(shown); }} />
      <span className="shrink-0 text-muted">{unit}</span>
    </label>
  );
}

/** 명령을 부른 뒤 막대 상태(굵게·색 등)를 다시 읽는다 */
function wrapBump<T extends object>(cmd: T, bump: () => void): T {
  return Object.fromEntries(Object.entries(cmd).map(([k, f]) => [k, (...a: unknown[]) => { const r = (f as (...x: unknown[]) => unknown)(...a); bump(); return r; }])) as T;
}

/** 색 고르기: 고르는 동안(input)은 저장하지 않고, 고르기를 마쳤을 때(change) 한 번 저장한다(연산 하나 = 수정본 하나) */
function ColorField({ label, value, disabled, onCommit }: { label: string; value: string; disabled?: boolean; onCommit: (v: string) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const commit = useRef(onCommit);
  commit.current = onCommit;
  useEffect(() => {
    const el = ref.current;
    const on = () => { if (el) commit.current(el.value); };
    el?.addEventListener("change", on);
    return () => el?.removeEventListener("change", on);
  }, []);
  return <input ref={ref} type="color" aria-label={label} defaultValue={value} disabled={disabled} className="h-6 w-10 border border-line" />;
}
