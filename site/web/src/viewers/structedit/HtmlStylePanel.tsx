import { useEffect, useRef, useState } from "react";
import { HexColorInput, HexColorPicker } from "react-colorful";
import { AlignCenter, AlignJustify, AlignLeft, AlignRight } from "lucide-react";
import type { Block, DocTheme } from "../../lib/structedit.ts";
import { IconButton } from "../../components/IconButton.tsx";

/**
 * HTML 속성 패널(6.0 V2, D-55). 고른 요소의 인라인 style만 setStyle로 바꾼다. 칸에는 원본 style 값이 보이고,
 * 비어 있으면 지금 화면에 그려진 값(getComputedStyle)을 흐리게 보여 준다. 값을 비우고 확정하면 그 속성을 지운다.
 * 허용 밖 값은 서버가 거부하고 고칠 방법을 알린다(위쪽 알림 줄).
 * 색은 색 고르기 창(react-colorful)에서 고르고, 문서 :root의 색 토큰은 창 안 목록으로 고른다. 직접 고른 색(hex)은 다크 모드를 따라 바뀌지 않으므로 다크 모드가 있는 문서에서는 안내한다.
 */

export const GENERIC = ["sans-serif", "serif", "monospace", "system-ui"];
/** 글꼴 이름 → CSS 값(일반 계열은 그대로, 나머지는 작은따옴표) */
export const fontValue = (name: string) => (GENERIC.includes(name) ? name : `'${name}'`);
const firstFont = (stack: string) => stack.split(",")[0]?.trim().replace(/^["']|["']$/g, "") ?? "";

type Apply = (set: Record<string, string>, unset: string[], summary: string) => void;

export function HtmlStylePanel({ b, el, theme, busy, apply }: { b: Block; el: HTMLElement | null; theme: DocTheme; busy: boolean; apply: Apply }) {
  const st = b.style;
  const cs = el ? el.ownerDocument.defaultView!.getComputedStyle(el) : null;
  const shown = (p: string) => cs?.getPropertyValue(p) ?? "";
  const commit = (prop: string, v: string) => {
    const value = v.trim();
    if (value === (st[prop] ?? "")) return;
    if (value) apply({ [prop]: value }, [], "서식");
    else apply({}, [prop], "서식 지움");
  };
  const textual = !["img", "table", "tr", "hr"].includes(b.tag);
  const font = st["font-family"] ? firstFont(st["font-family"]) : "";

  return (
    <section className="space-y-2" aria-label="서식">
      <h3 className="text-xs font-semibold text-muted">서식 <span className="font-normal">· 이 요소의 style</span></h3>
      {textual && (
        <>
          <label className="flex items-center gap-2 text-xs">
            <span className="w-14 shrink-0 text-muted">글꼴</span>
            <select aria-label="서식 글꼴" disabled={busy} value={font} className="min-w-0 flex-1 rounded border border-line bg-surface px-1 py-0.5"
              onChange={(e) => commit("font-family", e.target.value ? fontValue(e.target.value) : "")}>
              <option value="">{`기본 (${firstFont(shown("font-family")) || "문서"})`}</option>
              {theme.fonts.map((f) => <option key={f} value={f}>{f}</option>)}
              {GENERIC.map((f) => <option key={f} value={f}>{f}</option>)}
              {font && ![...theme.fonts, ...GENERIC].includes(font) && <option value={font} disabled>{font}</option>}
            </select>
          </label>
          <Field label="크기" prop="font-size" value={st["font-size"]} hint={shown("font-size")} busy={busy} onCommit={commit}
            list={["12px", "14px", "16px", "18px", "20px", "24px", "28px", "32px", "1rem", "1.25rem", "1.5rem", "2rem"]} />
          <label className="flex items-center gap-2 text-xs">
            <span className="w-14 shrink-0 text-muted">굵기</span>
            <select aria-label="서식 굵기" disabled={busy} value={st["font-weight"] ?? ""} className="min-w-0 flex-1 rounded border border-line bg-surface px-1 py-0.5"
              onChange={(e) => commit("font-weight", e.target.value)}>
              <option value="">{`기본 (${shown("font-weight")})`}</option>
              {["400", "500", "600", "700", "800"].map((w) => <option key={w} value={w}>{w}</option>)}
            </select>
          </label>
          <ColorField label="글자색" prop="color" value={st.color} theme={theme} busy={busy} onCommit={commit} />
          <Field label="줄 간격" prop="line-height" value={st["line-height"]} hint={shown("line-height")} busy={busy} onCommit={commit} list={["1.3", "1.5", "1.7", "2"]} />
          <div className="flex items-center gap-2 text-xs">
            <span className="w-14 shrink-0 text-muted">정렬</span>
            <span className="flex gap-0.5" role="group" aria-label="글자 정렬">
              {([["left", AlignLeft, "왼쪽 정렬"], ["center", AlignCenter, "가운데 정렬"], ["right", AlignRight, "오른쪽 정렬"], ["justify", AlignJustify, "양쪽 정렬"]] as const).map(([v, icon, label]) => (
                <IconButton key={v} icon={icon} label={label} size={16} disabled={busy} active={st["text-align"] === v}
                  onClick={() => commit("text-align", st["text-align"] === v ? "" : v)} />
              ))}
            </span>
          </div>
        </>
      )}
      <Field label="너비" prop="width" value={st.width} hint={shown("width")} busy={busy} onCommit={commit} list={["100%", "80%", "50%", "auto"]} />
      <Field label="높이" prop="height" value={st.height} hint={shown("height")} busy={busy} onCommit={commit} list={["auto"]} />
      <Field label="안쪽 여백" prop="padding" value={st.padding} hint={shown("padding")} busy={busy} onCommit={commit} />
      <Field label="바깥 여백" prop="margin" value={st.margin} hint={shown("margin")} busy={busy} onCommit={commit} list={["0", "0 auto", "1rem 0"]} />
      <ColorField label="배경" prop="background-color" value={st["background-color"] ?? st.background} theme={theme} busy={busy}
        onCommit={(p, v) => (st.background && !st["background-color"] ? commit("background", v) : commit(p, v))} />
      <Field label="테두리" prop="border" value={st.border} hint={shown("border")} busy={busy} onCommit={commit} list={["1px solid #d0d4da", "none"]} />
      <Field label="모서리" prop="border-radius" value={st["border-radius"]} hint={shown("border-radius")} busy={busy} onCommit={commit} list={["0", "4px", "8px"]} />
    </section>
  );
}

/** 글자 칸: Enter·바깥 누르기로 확정, Esc로 원래 값 */
function Field({ label, prop, value, hint, busy, onCommit, list }: {
  label: string; prop: string; value: string | undefined; hint: string; busy: boolean; onCommit: (prop: string, v: string) => void; list?: string[];
}) {
  const [v, setV] = useState(value ?? "");
  useEffect(() => setV(value ?? ""), [value]);
  const id = `style-${prop}`;
  return (
    <label className="flex items-center gap-2 text-xs">
      <span className="w-14 shrink-0 text-muted">{label}</span>
      <input aria-label={`서식 ${label}`} value={v} placeholder={hint} disabled={busy} list={list ? id : undefined}
        className="min-w-0 flex-1 rounded border border-line bg-surface px-1.5 py-0.5 font-mono placeholder:text-muted/70"
        onChange={(e) => setV(e.target.value)}
        onBlur={() => onCommit(prop, v)}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return;
          if (e.key === "Enter") { e.preventDefault(); onCommit(prop, v); }
          if (e.key === "Escape") setV(value ?? "");
        }} />
      {list && <datalist id={id}>{list.map((x) => <option key={x} value={x} />)}</datalist>}
    </label>
  );
}

/**
 * 색 칸: 견본 하나를 누르면 색 고르기 창(react-colorful)이 열린다. 창에서 고른 색(hex)은 「적용」으로 한 번만 저장하고,
 * 문서 색(:root 토큰)은 목록에서 고르면 바로 var(--이름)으로 저장한다. 지우기는 그 속성을 없앤다.
 */
function ColorField({ label, prop, value, theme, busy, onCommit }: {
  label: string; prop: string; value: string | undefined; theme: DocTheme; busy: boolean; onCommit: (prop: string, v: string) => void;
}) {
  const hex = value && !value.startsWith("var(");
  const [open, setOpen] = useState(false);
  const [pick, setPick] = useState("#000000");
  const box = useRef<HTMLDivElement>(null);
  const token = value?.startsWith("var(") ? theme.tokens.find((t) => `var(${t.name})` === value) : undefined;
  const shownColor = token?.value ?? value;
  useEffect(() => {
    if (!open) return;
    setPick(hex && /^#[0-9a-f]{6}$/i.test(value!) ? value! : "#000000");
    const away = (e: PointerEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    window.addEventListener("pointerdown", away);
    return () => window.removeEventListener("pointerdown", away);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const done = (v: string) => { setOpen(false); onCommit(prop, v); };
  return (
    <div className="space-y-1 text-xs">
      <div ref={box} className="relative flex items-center gap-2" onKeyDown={(e) => { if (e.key === "Escape" && open) { e.stopPropagation(); setOpen(false); } }}>
        <span className="w-14 shrink-0 text-muted">{label}</span>
        <button type="button" disabled={busy} aria-label={`서식 ${label} 고르기`} aria-expanded={open} data-tip={`${label} 고르기`} onClick={() => setOpen((o) => !o)}
          className="size-5 shrink-0 rounded border border-line" style={{ background: shownColor || "transparent" }} />
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted">{value || "기본"}</span>
        {value && <button type="button" disabled={busy} className="px-1 text-[11px] text-muted underline" onClick={() => onCommit(prop, "")}>지우기</button>}
        {open && (
          <div role="dialog" aria-label={`${label} 고르기`} className="absolute top-7 left-16 z-20 w-52 space-y-2 rounded-md border border-line bg-surface p-2 shadow-sm">
            <HexColorPicker color={pick} onChange={setPick} style={{ width: "100%", height: 140 }} />
            <div className="flex items-center gap-1">
              <span className="text-muted">#</span>
              <HexColorInput color={pick} onChange={setPick} aria-label={`서식 ${label} hex`} className="min-w-0 flex-1 rounded border border-line bg-surface px-1 py-0.5 font-mono" />
              <button type="button" disabled={busy} className="rounded bg-accent px-2 py-0.5 font-medium text-surface" onClick={() => done(pick)}>적용</button>
            </div>
            {theme.tokens.length > 0 && (
              <select aria-label={`서식 ${label} 문서 색`} disabled={busy} value={token ? value : ""} className="w-full rounded border border-line bg-surface px-1 py-0.5"
                onChange={(e) => { if (e.target.value) done(e.target.value); }}>
                <option value="">문서 색 (다크 모드를 따라감)</option>
                {theme.tokens.map((t) => <option key={t.name} value={`var(${t.name})`}>{`${t.name} ${t.value}`}</option>)}
              </select>
            )}
          </div>
        )}
      </div>
      {hex && theme.dark && <p className="pl-16 text-[11px] text-med">직접 고른 색은 다크 모드에서 바뀌지 않습니다. 문서 색을 쓰면 다크 모드를 따라갑니다.</p>}
    </div>
  );
}
