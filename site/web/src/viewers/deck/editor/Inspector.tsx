import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlignCenterHorizontal, AlignCenterVertical, AlignEndHorizontal, AlignEndVertical, AlignHorizontalDistributeCenter, AlignStartHorizontal, AlignStartVertical, AlignVerticalDistributeCenter, ArrowDown, ArrowUp, ChevronRight, Columns3, Heading2, ImagePlus, ImageUp, Network, PenTool, Pin, Rows3, Table2, Trash2, Type } from "lucide-react";
import { findEl, type Slide, type SlideEl, type SlideOp } from "@workflow/core/slide";
import { uploadAsset } from "../../../lib/structedit.ts";
import { useConfirm } from "../../../components/confirm/ConfirmProvider.tsx";
import { IconButton } from "../../../components/IconButton.tsx";
import { CANVAS } from "@workflow/core/slide";
import { measureBox, TEXT_TAGS } from "./EditCanvas.tsx";
import { alignBoxes, distributeBoxes, type AlignHow, type Box } from "../../../editor/align.ts";
import { LayerPanel, type LayerItem } from "../../../editor/LayerPanel.tsx";
import type { FontOption } from "../../../editor/TextToolbar.tsx";
import { DrawioEditor } from "../../../editor/DrawioEditor.tsx";
import { SvgEditor } from "../../../editor/SvgEditor.tsx";
import { fetchSvg, IMAGE_ACCEPT, isDrawioSvg, uploadSvg } from "../../../editor/svgFile.ts";
import { useEditorConfig } from "../../../lib/editorConfig.ts";
import { API } from "../../../lib/base.ts";

/**
 * 속성 패널(명세 06절). 입력 칸은 허용 CSS 목록에서 요소 종류별 묶음만 보여 준다. 칸은 Enter·바깥 누름에서 setStyle 하나로 확정한다.
 * 위쪽 「넣기」 막대는 고른 상자(없으면 슬라이드) 끝에 글상자·제목·표·그림을 넣는다.
 * 고정 위치 요소를 여럿 고르면 정렬·분배(editor/align), 아래쪽 레이어 패널(editor/LayerPanel)에서 고르기·문서 순서 옮기기(move).
 * SVG(6.0 V4): 그림처럼 asset:으로 넣는다(서버가 소독). 「다이어그램 그리기」(draw.io), SVG 그림은 「SVG 고치기」(draw.io SVG는 draw.io, 아니면 svgedit)로 고쳐 새 자산으로 바꾼다.
 */

type SvgEdit = { kind: "drawio" | "svgedit"; svg?: string; title: string; save: (svg: string) => Promise<void> };
/** 그림 크기를 슬라이드 안(긴 변 896×640)으로 줄인 가운데 고정 위치 img */
const centeredImg = (asset: string, alt: string, width: number, height: number) => {
  const k = Math.min(1, 896 / width, 640 / height);
  const w = Math.round(width * k), h = Math.round(height * k);
  return `<img src="${asset}" alt="${alt.replace(/"/g, "")}" style="position:absolute;left:${Math.round(960 - w / 2)}px;top:${Math.round(540 - h / 2)}px;width:${w}px;height:${h}px;object-fit:contain">`;
};

/** 글자 크기 목록(속성 패널·글자 도구 막대) */
export const FONT_SIZES = ["24px", "28px", "32px", "40px", "44px", "56px", "64px", "80px", "96px", "120px"];

const NAME: Record<string, string> = {
  section: "슬라이드", div: "상자", h1: "제목 1", h2: "제목 2", h3: "제목 3", p: "문단", ul: "목록", ol: "번호 목록", li: "목록 항목",
  table: "표", tr: "행", th: "머리 칸", td: "칸", img: "그림", hr: "구분선",
};
const CONTAINER = new Set(["section", "div", "ul", "ol", "li", "td", "th"]);

/** 루트에서 eid까지의 조상 목록(자기 포함, 바깥부터) */
function pathTo(root: SlideEl, eid: string): SlideEl[] {
  const walk = (e: SlideEl, acc: SlideEl[]): SlideEl[] | null => {
    if (e.eid === eid) return [...acc, e];
    for (const c of e.children) if (c.kind === "el") { const r = walk(c, [...acc, e]); if (r) return r; }
    return null;
  };
  return walk(root, []) ?? [];
}

export function Inspector({ slide, selection, setSelection, apply, palette, fonts, setMessage }: {
  slide: Slide; selection: string[]; setSelection: (s: string[]) => void; apply: (ops: SlideOp[]) => boolean; palette: string[]; fonts: FontOption[]; setMessage: (m: string) => void;
}) {
  const confirm = useConfirm();
  const sel = selection.length === 1 ? findEl(slide.root, selection[0]) : null;
  const el = sel?.el ?? null;
  const path = el ? pathTo(slide.root, el.eid) : [];
  const table = [...path].reverse().find((e) => e.tag === "table") ?? null;
  const cell = el && (el.tag === "td" || el.tag === "th") ? el : null;
  const target = el && CONTAINER.has(el.tag) && !el.children.some((c) => c.kind === "text") ? el : slide.root;
  const set = (eid: string, prop: string, value: string) =>
    apply([value.trim() ? { t: "setStyle", eid, set: { [prop]: value.trim() } } : { t: "setStyle", eid, unset: [prop] }]);

  const insert = (html: string) => apply([{ t: "insert", parent: target.eid, index: target.children.length, html }]);
  const { drawio } = useEditorConfig();
  const [svgEdit, setSvgEdit] = useState<SvgEdit | null>(null);
  const drawNew = () => setSvgEdit({ kind: "drawio", title: "새 다이어그램", save: async (svg) => {
    const a = await uploadSvg(svg, "diagram.svg");
    if (!insert(centeredImg(a.asset, "다이어그램", a.width, a.height))) throw new Error("넣지 못했습니다");
  } });
  const editSvg = async (eid: string, url: string) => {
    try {
      const svg = await fetchSvg(url);
      const save = async (out: string) => {
        const a = await uploadSvg(out);
        if (!apply([{ t: "setAttr", eid, name: "src", value: a.asset }])) throw new Error("저장하지 못했습니다");
        if (a.removed?.length) setMessage(`SVG에서 허용하지 않는 것을 지웠습니다: ${a.removed.join(", ")}`);
      };
      if (isDrawioSvg(svg)) {
        if (!drawio) { setMessage("draw.io로 만든 SVG는 draw.io 편집기로 고칩니다. 이 사이트에는 draw.io 편집기가 설정되지 않았습니다(DRAWIO_ORIGIN)"); return; }
        setSvgEdit({ kind: "drawio", svg, title: "다이어그램 고치기", save });
      } else setSvgEdit({ kind: "svgedit", svg, title: "SVG 고치기", save });
    } catch (e) { setMessage(String((e as Error).message)); }
  };

  return (
    <aside className="min-h-0 space-y-4 overflow-y-auto border-l border-line bg-surface p-3 text-sm" aria-label="속성">
      <section>
        <h3 className="mb-1 text-xs font-semibold text-muted">{NAME[target.tag] ?? target.tag}에 넣기</h3>
        <div className="flex flex-wrap gap-1">
          <IconButton icon={Type} label="글상자 넣기 (고정 위치)" variant="outline"
            onClick={() => insert('<p style="position:absolute;left:128px;top:128px;width:800px;height:96px;font-size:40px">새 글상자</p>')} />
          <IconButton icon={Heading2} label="제목 넣기" variant="outline" onClick={() => insert("<h2>새 제목</h2>")} />
          <IconButton icon={Table2} label="표 넣기 (3행 3열)" variant="outline"
            onClick={() => insert(`<table style="font-size:28px"><tr>${'<th style="width:33.3%">머리</th>'.repeat(2)}<th style="width:33.4%">머리</th></tr>${`<tr>${"<td></td>".repeat(3)}</tr>`.repeat(2)}</table>`)} />
          <ImageInput label="그림 넣기 (SVG 포함)" icon={ImagePlus} onFile={async (f) => {
            const a = await uploadAsset(f);
            insert(centeredImg(a.asset, f.name.replace(/\.[^.]+$/, ""), a.width, a.height));
          }} setMessage={setMessage} />
          {drawio && <IconButton icon={Network} label="다이어그램 그리기 (draw.io)" variant="outline" onClick={drawNew} />}
        </div>
      </section>

      {selection.length > 1 ? (
        <ArrangeGroup slide={slide} selection={selection} apply={apply} />
      ) : !el ? (
        <p className="text-xs text-muted">요소를 누르면 여기에서 고칩니다. Shift+클릭으로 여러 개를 고르고, 그림 파일은 슬라이드에 끌어 놓거나 붙여 넣습니다.</p>
      ) : (
        <>
          <section>
            <nav className="mb-1 flex flex-wrap items-center gap-0.5 text-[11px] text-muted" aria-label="요소 경로">
              {path.map((p, i) => (
                <span key={p.eid} className="flex items-center gap-0.5">
                  {i > 0 && <ChevronRight size={12} aria-hidden />}
                  <button type="button" className={`rounded px-1 hover:bg-sunken ${p.eid === el.eid ? "font-semibold text-fg" : ""}`} onClick={() => setSelection([p.eid])}>{NAME[p.tag] ?? p.tag}</button>
                </span>
              ))}
            </nav>
            {TEXT_TAGS.has(el.tag) && el.children.every((c) => c.kind === "text") && <p className="text-xs text-muted">두 번 누르면 글자를 고칩니다(Shift+Enter 줄바꿈).</p>}
          </section>

          {el.tag === "section" && <SlideGroup slide={slide} apply={apply} set={set} palette={palette} fonts={fonts} />}
          {TEXT_TAGS.has(el.tag) && el.tag !== "div" && <TextGroup el={el} set={set} palette={palette} fonts={fonts} apply={apply} />}
          {(el.tag === "div" || el.tag === "ul" || el.tag === "ol") && <BoxGroup el={el} set={set} palette={palette} />}
          {el.tag === "img" && <ImageGroup el={el} set={set} apply={apply} setMessage={setMessage} onEditSvg={(url) => void editSvg(el.eid, url)} />}
          {table && <TableGroup table={table} cell={cell} path={path} apply={apply} set={set} confirm={confirm} />}
          {el.style.position === "absolute" && <ArrangeGroup slide={slide} selection={selection} apply={apply} />}

          {el.tag !== "section" && sel?.parent && !["tr", "td", "th"].includes(el.tag) && (
            <section className="space-y-2">
              <h3 className="text-xs font-semibold text-muted">위치·크기</h3>
              {el.style.position === "absolute" ? (
                <div className="grid grid-cols-4 gap-1">
                  {(["left", "top", "width", "height"] as const).map((k) => <Field key={k} label={{ left: "X", top: "Y", width: "너비", height: "높이" }[k]} value={el.style[k] ?? ""} onCommit={(v) => set(el.eid, k, px(v))} />)}
                </div>
              ) : (
                <>
                  <div className="grid grid-cols-2 gap-1">
                    <Field label="너비" value={el.style.width ?? ""} onCommit={(v) => set(el.eid, "width", px(v))} placeholder="자동" />
                    <Field label="높이" value={el.style.height ?? ""} onCommit={(v) => set(el.eid, "height", px(v))} placeholder="자동" />
                  </div>
                  <IconButton icon={Pin} label="지금 자리에 고정 위치로" text="고정 위치로 전환" variant="outline" onClick={() => {
                    const box = measureBox(el.eid);
                    if (box && sel.parent?.eid === slide.id) apply([{ t: "toPinned", eid: el.eid, box }]);
                    else setMessage("고정 위치는 슬라이드 바로 아래 요소만 쓸 수 있습니다(상자 안 요소는 상자가 배치를 정합니다)");
                  }} />
                </>
              )}
              <div className="flex flex-wrap gap-1">
                <IconButton icon={ArrowUp} label="앞으로 (그리는 순서·흐름 순서)" variant="outline" disabled={sel.index <= 0}
                  onClick={() => apply([{ t: "move", eid: el.eid, parent: sel.parent!.eid, index: sel.index - 1 }])} />
                <IconButton icon={ArrowDown} label="뒤로" variant="outline" disabled={sel.index >= sel.parent.children.length - 1}
                  onClick={() => apply([{ t: "move", eid: el.eid, parent: sel.parent!.eid, index: sel.index + 1 }])} />
                <IconButton icon={Trash2} label={`${NAME[el.tag] ?? el.tag} 지우기`} variant="outline" onClick={async () => {
                  if (await confirm({ title: `${NAME[el.tag] ?? el.tag}을(를) 지울까요?`, confirmText: "지우기", tone: "danger", message: "되돌리기(⌘Z)로 다시 살릴 수 있습니다." })) {
                    if (apply([{ t: "remove", eid: el.eid }])) setSelection([]);
                  }
                }} />
              </div>
            </section>
          )}
        </>
      )}
      <LayerPanel items={layerItems(slide)} selected={selection}
        onSelect={(id, add) => setSelection(add ? (selection.includes(id) ? selection.filter((x) => x !== id) : [...selection.filter((x) => x !== slide.id), id]) : [id])}
        onMove={(id, dir) => {
          const r = findEl(slide.root, id);
          if (r?.parent) apply([{ t: "move", eid: id, parent: r.parent.eid, index: r.index + dir }]);
        }} />
      {svgEdit?.kind === "drawio" && drawio && <DrawioEditor origin={drawio} svg={svgEdit.svg} title={svgEdit.title} onSave={svgEdit.save} onClose={() => setSvgEdit(null)} />}
      {svgEdit?.kind === "svgedit" && svgEdit.svg && <SvgEditor svg={svgEdit.svg} title={svgEdit.title} onSave={svgEdit.save} onClose={() => setSvgEdit(null)} />}
    </aside>
  );
}

/** 숫자만 쓰면 px를 붙인다 */
const px = (v: string) => (/^-?\d+(\.\d+)?$/.test(v.trim()) ? `${v.trim()}px` : v);

function Field({ label, value, onCommit, placeholder, type = "text" }: { label: string; value: string; onCommit: (v: string) => void; placeholder?: string; type?: string }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  const commit = () => { if (v !== value) onCommit(v); };
  return (
    <label className="block text-[11px] text-muted">{label}
      <input type={type} value={v} placeholder={placeholder} className="mt-0.5 w-full min-w-0 rounded border border-line bg-surface px-1.5 py-1 font-mono text-xs text-fg"
        onChange={(e) => setV(e.target.value)} onBlur={commit}
        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); commit(); } if (e.key === "Escape") setV(value); }} />
    </label>
  );
}

function Select({ label, value, options, onChange }: { label: string; value: string; options: [string, string][]; onChange: (v: string) => void }) {
  return (
    <label className="block text-[11px] text-muted">{label}
      <select value={value} onChange={(e) => onChange(e.target.value)} className="mt-0.5 w-full rounded border border-line bg-surface px-1 py-1 text-xs text-fg">
        {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
    </label>
  );
}

/** 색: 덱 팔레트 견본 + 직접 고르기 */
function ColorField({ label, value, palette, onChange }: { label: string; value: string; palette: string[]; onChange: (v: string) => void }) {
  return (
    <div className="text-[11px] text-muted">{label}
      <div className="mt-0.5 flex flex-wrap items-center gap-1">
        {palette.map((c) => (
          <button key={c} type="button" aria-label={`${label} ${c}`} data-tip={c} onClick={() => onChange(c)}
            className={`size-6 rounded border ${value.toLowerCase() === c.toLowerCase() ? "border-accent ring-2 ring-accent" : "border-line"}`} style={{ background: c }} />
        ))}
        <input type="color" aria-label={`${label} 직접 고르기`} value={/^#[0-9a-f]{6}$/i.test(value) ? value : "#000000"} onChange={(e) => onChange(e.target.value)}
          className="h-6 w-8 cursor-pointer rounded border border-line bg-surface" />
        {value && <button type="button" className="text-[11px] underline" onClick={() => onChange("")}>기본</button>}
      </div>
    </div>
  );
}

type SetFn = (eid: string, prop: string, value: string) => boolean;

/** 글꼴 패밀리: 덱 색인(faces)의 글꼴만 고른다. 목록 밖 값이 들어 있으면 그대로 보여 준다 */
function FontSelect({ el, fonts, set }: { el: SlideEl; fonts: FontOption[]; set: SetFn }) {
  const v = el.style["font-family"] ?? "";
  const opts: [string, string][] = [["", "기본(덱 글꼴)"], ...fonts.map((f) => [f.value, f.label] as [string, string])];
  if (v && !opts.some(([o]) => o === v)) opts.push([v, v]);
  return <Select label="글꼴" value={v} options={opts} onChange={(x) => set(el.eid, "font-family", x)} />;
}

/** 레이어 패널 목록: 슬라이드 아래 요소 트리(글자 조각 제외). 표 안 행·칸은 표 묶음에서 다루므로 펼치지 않는다 */
function layerItems(slide: Slide): LayerItem[] {
  const out: LayerItem[] = [];
  const walk = (e: SlideEl, depth: number) => {
    const kids = e.children.filter((c): c is SlideEl => c.kind === "el");
    kids.forEach((c, i) => {
      const text = c.children.find((x) => x.kind === "text");
      const snippet = text?.kind === "text" ? text.html.replace(/<[^>]+>/g, "").slice(0, 24) : c.tag === "img" ? (c.attrs.alt ?? "") : "";
      out.push({ id: c.eid, label: `${NAME[c.tag] ?? c.tag}${c.style.position === "absolute" ? " · 고정" : ""}${snippet ? ` · ${snippet}` : ""}`, depth, first: i === 0, last: i === kids.length - 1, movable: true });
      if (c.tag !== "table") walk(c, depth + 1);
    });
  };
  walk(slide.root, 0);
  return out;
}

/** 고정 위치 요소 정렬·분배. 하나면 슬라이드 기준, 여럿이면 고른 요소들 기준. 값은 style의 px(없으면 화면에서 잰다) */
function ArrangeGroup({ slide, selection, apply }: { slide: Slide; selection: string[]; apply: (ops: SlideOp[]) => boolean }) {
  const els = selection.map((eid) => findEl(slide.root, eid)?.el).filter((e): e is SlideEl => !!e && e.tag !== "section");
  const pinned = els.filter((e) => e.style.position === "absolute");
  if (!pinned.length) return <p className="text-xs text-muted">{els.length}개 골랐습니다. 정렬·분배는 고정 위치 요소끼리만 할 수 있습니다.</p>;
  const boxes = (): Box[] => pinned.map((e) => {
    const m = measureBox(e.eid);
    const n = (k: "left" | "top" | "width" | "height") => { const v = parseFloat(e.style[k] ?? ""); return Number.isFinite(v) ? v : m?.[k] ?? 0; };
    return { left: n("left"), top: n("top"), width: n("width"), height: n("height") };
  });
  const commit = (next: Box[]) => {
    const before = boxes();
    const ops: SlideOp[] = pinned.flatMap((e, i) => {
      const set: Record<string, string> = {};
      if (Math.round(next[i].left) !== Math.round(before[i].left)) set.left = `${Math.round(next[i].left)}px`;
      if (Math.round(next[i].top) !== Math.round(before[i].top)) set.top = `${Math.round(next[i].top)}px`;
      return Object.keys(set).length ? [{ t: "setStyle", eid: e.eid, set }] : [];
    });
    if (ops.length) apply(ops);
  };
  const slideBox = { left: 0, top: 0, width: CANVAS.width, height: CANVAS.height };
  const al = (how: AlignHow) => () => commit(alignBoxes(boxes(), how, slideBox));
  const ALIGN: [AlignHow, typeof AlignStartVertical, string][] = [
    ["left", AlignStartVertical, "왼쪽 맞춤"], ["hcenter", AlignCenterVertical, "가로 가운데 맞춤"], ["right", AlignEndVertical, "오른쪽 맞춤"],
    ["top", AlignStartHorizontal, "위 맞춤"], ["vcenter", AlignCenterHorizontal, "세로 가운데 맞춤"], ["bottom", AlignEndHorizontal, "아래 맞춤"],
  ];
  const base = pinned.length === 1 ? "슬라이드 기준" : `고른 ${pinned.length}개 기준`;
  return (
    <section className="space-y-1" aria-label="정렬">
      <h3 className="text-xs font-semibold text-muted">정렬 · {base}{pinned.length < els.length ? ` (고정 위치 아닌 ${els.length - pinned.length}개 제외)` : ""}</h3>
      <div className="flex flex-wrap gap-1">
        {ALIGN.map(([how, icon, label]) => <IconButton key={how} icon={icon} label={label} variant="outline" onClick={al(how)} />)}
        <IconButton icon={AlignHorizontalDistributeCenter} label="가로 간격 같게 (3개 이상)" variant="outline" disabled={pinned.length < 3} onClick={() => commit(distributeBoxes(boxes(), "x"))} />
        <IconButton icon={AlignVerticalDistributeCenter} label="세로 간격 같게 (3개 이상)" variant="outline" disabled={pinned.length < 3} onClick={() => commit(distributeBoxes(boxes(), "y"))} />
      </div>
    </section>
  );
}

function SlideGroup({ slide, apply, set, palette, fonts }: { slide: Slide; apply: (ops: SlideOp[]) => boolean; set: SetFn; palette: string[]; fonts: FontOption[] }) {
  const st = slide.root.style;
  const [notes, setNotes] = useState(slide.notes);
  useEffect(() => setNotes(slide.notes), [slide.notes]);
  return (
    <section className="space-y-2">
      <h3 className="text-xs font-semibold text-muted">슬라이드</h3>
      <ColorField label="배경" value={st.background ?? ""} palette={palette} onChange={(v) => set(slide.id, "background", v)} />
      <ColorField label="글자색" value={st.color ?? ""} palette={palette} onChange={(v) => set(slide.id, "color", v)} />
      {fonts.length > 0 && <FontSelect el={slide.root} fonts={fonts} set={set} />}
      <BoxFields el={slide.root} set={set} />
      <label className="block text-[11px] text-muted">발표자 노트
        <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3}
          onBlur={() => { if (notes !== slide.notes) apply([{ t: "setNotes", text: notes }]); }}
          className="mt-0.5 w-full rounded border border-line bg-surface px-1.5 py-1 text-xs text-fg" />
      </label>
    </section>
  );
}

function BoxFields({ el, set }: { el: SlideEl; set: SetFn }) {
  const st = el.style;
  return (
    <div className="grid grid-cols-2 gap-1">
      <Select label="배치" value={st.display ?? ""} onChange={(v) => set(el.eid, "display", v)} options={[["", "기본"], ["flex", "flex"], ["grid", "grid"], ["block", "block"]]} />
      <Select label="방향" value={st["flex-direction"] ?? ""} onChange={(v) => set(el.eid, "flex-direction", v)} options={[["", "가로(기본)"], ["row", "가로"], ["column", "세로"]]} />
      <Field label="간격(gap)" value={st.gap ?? ""} onCommit={(v) => set(el.eid, "gap", px(v))} />
      <Field label="안쪽 여백" value={st.padding ?? ""} onCommit={(v) => set(el.eid, "padding", px(v))} />
      <Select label="세로 맞춤" value={st["align-items"] ?? ""} onChange={(v) => set(el.eid, "align-items", v)}
        options={[["", "기본"], ["flex-start", "처음"], ["center", "가운데"], ["flex-end", "끝"], ["stretch", "늘림"]]} />
      <Select label="가로 맞춤" value={st["justify-content"] ?? ""} onChange={(v) => set(el.eid, "justify-content", v)}
        options={[["", "기본"], ["flex-start", "처음"], ["center", "가운데"], ["flex-end", "끝"], ["space-between", "양끝"]]} />
      {st.display === "grid" && <div className="col-span-2"><Field label="격자 열" value={st["grid-template-columns"] ?? ""} placeholder="1fr 1fr" onCommit={(v) => set(el.eid, "grid-template-columns", v)} /></div>}
    </div>
  );
}

function BoxGroup({ el, set, palette }: { el: SlideEl; set: SetFn; palette: string[] }) {
  return (
    <section className="space-y-2">
      <h3 className="text-xs font-semibold text-muted">상자</h3>
      <BoxFields el={el} set={set} />
      <ColorField label="배경" value={el.style.background ?? ""} palette={palette} onChange={(v) => set(el.eid, "background", v)} />
      <div className="grid grid-cols-2 gap-1">
        <Field label="테두리" value={el.style.border ?? ""} placeholder="2px solid #c9ccd1" onCommit={(v) => set(el.eid, "border", v)} />
        <Field label="모서리" value={el.style["border-radius"] ?? ""} onCommit={(v) => set(el.eid, "border-radius", px(v))} />
      </div>
    </section>
  );
}

function TextGroup({ el, set, palette, fonts, apply }: { el: SlideEl; set: SetFn; palette: string[]; fonts: FontOption[]; apply: (ops: SlideOp[]) => boolean }) {
  const st = el.style;
  // 글이 상자보다 길면 경고하고 높이 늘리기를 준다(글자 크기를 자동으로 줄이지 않는다, 명세 06절)
  const [over, setOver] = useState<number | null>(null);
  useEffect(() => {
    const d = document.querySelector<HTMLElement>(`.deck-edit-layer [data-eid="${CSS.escape(el.eid)}"]`);
    setOver(d && st.height && d.scrollHeight > d.clientHeight + 1 ? d.scrollHeight : null);
  });
  return (
    <section className="space-y-2">
      <h3 className="text-xs font-semibold text-muted">글자</h3>
      {over !== null && (
        <div role="alert" className="space-y-1 rounded bg-high-soft px-2 py-1 text-xs text-high">
          <p>글이 상자보다 깁니다.</p>
          <button type="button" className="underline" onClick={() => apply([{ t: "setStyle", eid: el.eid, set: { height: `${Math.ceil(over)}px` } }])}>상자 높이 늘리기</button>
        </div>
      )}
      <div className="grid grid-cols-2 gap-1">
        <Select label="크기" value={st["font-size"] ?? ""} onChange={(v) => set(el.eid, "font-size", v)}
          options={[["", "기본"], ...FONT_SIZES.map((x) => [x, x] as [string, string]),
            ...(st["font-size"] && !FONT_SIZES.includes(st["font-size"]) ? [[st["font-size"], st["font-size"]] as [string, string]] : [])]} />
        <Select label="굵기" value={st["font-weight"] ?? ""} onChange={(v) => set(el.eid, "font-weight", v)}
          options={[["", "기본"], ["400", "보통"], ["600", "굵게"], ["700", "더 굵게"]]} />
        <Select label="정렬" value={st["text-align"] ?? ""} onChange={(v) => set(el.eid, "text-align", v)}
          options={[["", "기본"], ["left", "왼쪽"], ["center", "가운데"], ["right", "오른쪽"]]} />
        <Field label="줄 간격" value={st["line-height"] ?? ""} placeholder="1.4" onCommit={(v) => set(el.eid, "line-height", v)} />
        {fonts.length > 0 && <div className="col-span-2"><FontSelect el={el} fonts={fonts} set={set} /></div>}
      </div>
      <ColorField label="색" value={st.color ?? ""} palette={palette} onChange={(v) => set(el.eid, "color", v)} />
    </section>
  );
}

function ImageInput({ label, icon, onFile, setMessage }: { label: string; icon: typeof ImageUp; onFile: (f: File) => Promise<void>; setMessage: (m: string) => void }) {
  const Icon = icon;
  return (
    <label className="inline-flex cursor-pointer items-center rounded-md border border-line p-1.5 text-muted hover:bg-sunken hover:text-fg" data-tip={label}>
      <Icon size={20} aria-hidden />
      <input type="file" accept={IMAGE_ACCEPT} className="sr-only" aria-label={label}
        onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) onFile(f).catch((err) => setMessage(String((err as Error).message))); }} />
    </label>
  );
}

function ImageGroup({ el, set, apply, setMessage, onEditSvg }: { el: SlideEl; set: SetFn; apply: (ops: SlideOp[]) => boolean; setMessage: (m: string) => void; onEditSvg: (url: string) => void }) {
  const [alt, setAlt] = useState(el.attrs.alt ?? "");
  // 자산 형식(SVG면 「SVG 고치기」)
  const sha = el.attrs.src?.startsWith("asset:") ? el.attrs.src.slice(6) : null;
  const meta = useQuery({ queryKey: ["asset-meta", sha], enabled: !!sha, staleTime: 10 * 60_000,
    queryFn: async () => { const r = await fetch(`${API}/assets/${sha}/url`); return r.ok ? (await r.json()) as { url: string; mime: string } : null; } }).data;
  useEffect(() => setAlt(el.attrs.alt ?? ""), [el.attrs.alt]);
  return (
    <section className="space-y-2">
      <h3 className="text-xs font-semibold text-muted">그림</h3>
      <div className="grid grid-cols-2 gap-1">
        <Select label="맞춤" value={el.style["object-fit"] ?? ""} onChange={(v) => set(el.eid, "object-fit", v)}
          options={[["", "기본"], ["contain", "다 보이게"], ["cover", "꽉 채우게(자름)"]]} />
        <Select label="자르기 위치" value={el.style["object-position"] ?? ""} onChange={(v) => set(el.eid, "object-position", v)}
          options={[["", "가운데"], ["top", "위"], ["bottom", "아래"], ["left", "왼쪽"], ["right", "오른쪽"]]} />
        <Field label="모서리" value={el.style["border-radius"] ?? ""} onCommit={(v) => set(el.eid, "border-radius", px(v))} />
        <Field label="테두리" value={el.style.border ?? ""} placeholder="2px solid #c9ccd1" onCommit={(v) => set(el.eid, "border", v)} />
      </div>
      <label className="block text-[11px] text-muted">대체 글(alt)
        <input value={alt} onChange={(e) => setAlt(e.target.value)} className="mt-0.5 w-full rounded border border-line bg-surface px-1.5 py-1 text-xs text-fg"
          onBlur={() => { if (alt !== (el.attrs.alt ?? "")) apply([{ t: "setAttr", eid: el.eid, name: "alt", value: alt }]); }} />
      </label>
      <div className="flex items-center gap-2 text-xs">
        <ImageInput label="그림 바꾸기" icon={ImageUp} setMessage={setMessage} onFile={async (f) => {
          const a = await uploadAsset(f);
          apply([{ t: "setAttr", eid: el.eid, name: "src", value: a.asset }]);
        }} />
        <span className="text-muted">그림 바꾸기</span>
        {meta?.mime === "image/svg+xml" && <IconButton icon={PenTool} label="SVG 고치기 (draw.io SVG는 draw.io로)" text="SVG 고치기" variant="outline" onClick={() => onEditSvg(meta.url)} />}
      </div>
    </section>
  );
}

function TableGroup({ table, cell, path, apply, set, confirm }: {
  table: SlideEl; cell: SlideEl | null; path: SlideEl[]; apply: (ops: SlideOp[]) => boolean; set: SetFn;
  confirm: ReturnType<typeof useConfirm>;
}) {
  const rows = table.children.filter((c): c is SlideEl => c.kind === "el" && c.tag === "tr");
  const cells0 = rows[0]?.children.filter((c): c is SlideEl => c.kind === "el") ?? [];
  const row = cell ? rows.findIndex((r) => r.eid === path[path.length - 2]?.eid) : -1;
  const col = cell && row >= 0 ? rows[row].children.filter((c) => c.kind === "el").findIndex((c) => (c as SlideEl).eid === cell.eid) : -1;
  const [widths, setWidths] = useState(cells0.map((c) => parseFloat(c.style.width ?? "") || Math.round(1000 / cells0.length) / 10));
  useEffect(() => setWidths(cells0.map((c) => parseFloat(c.style.width ?? "") || Math.round(1000 / cells0.length) / 10)), [table]); // eslint-disable-line react-hooks/exhaustive-deps
  const allCells = rows.flatMap((r) => r.children.filter((c): c is SlideEl => c.kind === "el"));
  const pad = allCells[0]?.style.padding ?? "";
  const btn = "rounded border border-line px-2 py-0.5 text-xs hover:bg-sunken disabled:opacity-30";
  const removeAt = async (kind: "tableRow" | "tableCol", at: number) => {
    if (await confirm({ title: `${at + 1}${kind === "tableRow" ? "행" : "열"}을 지울까요?`, confirmText: "지우기", tone: "danger", message: "되돌리기(⌘Z)로 다시 살릴 수 있습니다." })) {
      apply([{ t: kind, eid: table.eid, at, op: "remove" }]);
    }
  };
  return (
    <section className="space-y-2">
      <h3 className="text-xs font-semibold text-muted">표 · {rows.length}행 {cells0.length}열{cell ? ` · ${row + 1}행 ${col + 1}열 고름` : ""}</h3>
      <div className="grid grid-cols-2 gap-1">
        <Field label="글자 크기" value={table.style["font-size"] ?? ""} onCommit={(v) => set(table.eid, "font-size", px(v))} />
        <Field label="칸 안쪽 여백" value={pad} onCommit={(v) => apply(allCells.map((c) => (v.trim() ? { t: "setStyle", eid: c.eid, set: { padding: px(v) } } : { t: "setStyle", eid: c.eid, unset: ["padding"] })))} />
      </div>
      {cell ? (
        <div className="grid grid-cols-[auto_1fr] items-center gap-x-2 gap-y-1">
          <Rows3 size={16} className="text-muted" aria-label="행" />
          <div className="flex flex-wrap items-end gap-1">
            <div className="w-24"><Field label={`${row + 1}행 높이`} value={rows[row]?.style.height ?? ""} placeholder="자동" onCommit={(v) => set(rows[row].eid, "height", px(v))} /></div>
            <button className={btn} onClick={() => apply([{ t: "tableRow", eid: table.eid, at: row, op: "add" }])}>위에 넣기</button>
            <button className={btn} onClick={() => apply([{ t: "tableRow", eid: table.eid, at: row + 1, op: "add" }])}>아래에 넣기</button>
            <button className={`${btn} text-crit`} disabled={rows.length <= 1} onClick={() => void removeAt("tableRow", row)}>{row + 1}행 지우기</button>
          </div>
          <Columns3 size={16} className="text-muted" aria-label="열" />
          <div className="flex flex-wrap gap-1">
            <button className={btn} onClick={() => apply([{ t: "tableCol", eid: table.eid, at: col, op: "add" }])}>왼쪽에 넣기</button>
            <button className={btn} onClick={() => apply([{ t: "tableCol", eid: table.eid, at: col + 1, op: "add" }])}>오른쪽에 넣기</button>
            <button className={`${btn} text-crit`} disabled={cells0.length <= 1} onClick={() => void removeAt("tableCol", col)}>{col + 1}열 지우기</button>
          </div>
        </div>
      ) : <p className="text-[11px] text-muted">칸을 누르면 행·열을 넣고 뺄 수 있습니다. 열 경계를 끌어 너비를 바꿉니다.</p>}
      <form className="space-y-1" onSubmit={(e) => { e.preventDefault(); apply([{ t: "tableCols", eid: table.eid, widths }]); }}>
        <p className="text-[11px] text-muted">열 너비(%) · 합 {Math.round(widths.reduce((a, b) => a + b, 0) * 10) / 10}</p>
        <div className="flex flex-wrap gap-1">
          {widths.map((w, i) => (
            <input key={i} type="number" min={1} step={0.1} value={w} aria-label={`${i + 1}열 너비`}
              className="w-16 rounded border border-line bg-surface px-1 py-0.5 font-mono text-xs"
              onChange={(e) => setWidths(widths.map((x, j) => (j === i ? Number(e.target.value) : x)))} />
          ))}
        </div>
        <button type="submit" className="rounded bg-accent px-2 py-0.5 text-xs text-surface disabled:opacity-30" disabled={widths.some((w) => !(w > 0))}>너비 적용</button>
      </form>
    </section>
  );
}
