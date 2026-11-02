import { useState } from "react";
import { useEditorState, type Editor } from "@tiptap/react";
import { Bold, Italic, Link, Link2Off, Underline } from "lucide-react";
import { IconButton } from "../components/IconButton.tsx";

/**
 * 글자 도구 막대(6.0 4.1). 고른 글자에 굵게·기울임·밑줄·색·링크·글꼴·크기를 건다. 문서 종류와 무관하고, 쓸 글꼴·크기·색 목록은 부르는 쪽이 준다.
 * 막대는 data-text-toolbar로 표시한다. 편집기는 포커스가 막대로 옮겨 갈 때 글자 편집을 끝내지 않는다(TextEditor onBlur).
 * 버튼은 mousedown 기본 동작을 막아 편집기 포커스와 선택을 그대로 둔다. 목록·입력칸은 고른 뒤 편집기로 포커스를 돌린다.
 * 막대 자체(TextToolbarView)는 편집기와 무관하게 상태(TextState)와 명령(TextCommands)만 받는다.
 * 덱은 Tiptap(TextToolbar), HTML 문서는 편집 사본 iframe의 contenteditable(viewers/structedit/inlineText.ts)이 명령을 댄다.
 */

export interface FontOption { label: string; value: string }

/** 브라우저가 읽어 들인 rgb() 색을 견본과 비교할 수 있게 #rrggbb로 */
const hexOf = (c: string) => {
  const m = /^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/.exec(c);
  return m ? `#${m.slice(1).map((n) => Number(n).toString(16).padStart(2, "0")).join("")}` : c;
};

export interface TextState { bold: boolean; italic: boolean; underline: boolean; link: boolean; color: string; fontFamily: string; fontSize: string }
export interface TextCommands {
  toggleBold(): void; toggleItalic(): void; toggleUnderline(): void;
  /** null이면 지운다 */
  setFontFamily(v: string | null): void; setFontSize(v: string | null): void; setColor(v: string | null): void;
  linkHref(): string; setLink(href: string): void; unsetLink(): void;
  focus(): void;
}
interface ViewProps {
  fonts: FontOption[];
  sizes: string[];
  /** 색 견본. label이 있으면 툴팁에 쓴다(문서 토큰 이름) */
  palette: (string | { value: string; label: string; swatch?: string })[];
  /** 막대의 목록·입력칸에서 편집기도 막대도 아닌 곳으로 포커스가 나갔을 때(글자 편집 끝내기) */
  onLeave: () => void;
  /** 포커스가 옮겨 간 곳이 편집기인가(막대를 떠나도 편집을 이어 갈 곳) */
  isEditor?: (el: Element) => boolean;
  /** 막대 끝에 붙일 안내(예: 다크 모드 경고) */
  note?: string;
}

/** Tiptap 편집기(덱 글자 편집)용 */
export function TextToolbar({ editor, ...rest }: ViewProps & { editor: Editor }) {
  const st = useEditorState({
    editor,
    selector: ({ editor: e }) => {
      const ts = e.getAttributes("textStyle") as { color?: string; fontFamily?: string; fontSize?: string };
      return {
        bold: e.isActive("bold"), italic: e.isActive("italic"), underline: e.isActive("underline"), link: e.isActive("link"),
        color: hexOf(ts.color ?? ""), fontFamily: ts.fontFamily ?? "", fontSize: ts.fontSize ?? "",
      };
    },
  });
  const chain = () => editor.chain().focus();
  const cmd: TextCommands = {
    toggleBold: () => chain().toggleBold().run(), toggleItalic: () => chain().toggleItalic().run(), toggleUnderline: () => chain().toggleUnderline().run(),
    setFontFamily: (v) => (v ? chain().setFontFamily(v).run() : chain().unsetFontFamily().run()),
    setFontSize: (v) => (v ? chain().setFontSize(v).run() : chain().unsetFontSize().run()),
    setColor: (v) => (v ? chain().setColor(v).run() : chain().unsetColor().run()),
    linkHref: () => (editor.getAttributes("link") as { href?: string }).href ?? "",
    setLink: (href) => chain().extendMarkRange("link").setLink({ href }).run(),
    unsetLink: () => chain().extendMarkRange("link").unsetLink().run(),
    focus: () => editor.commands.focus(),
  };
  return <TextToolbarView state={st} cmd={cmd} isEditor={(el) => !!el.closest(".ProseMirror")} {...rest} />;
}

export function TextToolbarView({ state: st, cmd, fonts, sizes, palette, onLeave, isEditor, note }: ViewProps & { state: TextState; cmd: TextCommands }) {
  const [linkOpen, setLinkOpen] = useState(false);
  const [href, setHref] = useState("");
  const [linkError, setLinkError] = useState("");
  const keep = (e: React.MouseEvent) => e.preventDefault();
  const onBlur = (e: React.FocusEvent) => {
    const to = e.relatedTarget as Element | null;
    if (!to?.closest("[data-text-toolbar]") && !(to && isEditor?.(to))) onLeave();
  };
  const sizeOptions = st.fontSize && !sizes.includes(st.fontSize) ? [st.fontSize, ...sizes] : sizes;
  // 브라우저는 따옴표를 붙이거나 떼서 돌려주므로 따옴표 없이 비교한다
  const bare = (v: string) => v.replace(/["']/g, "");
  const font = st.fontFamily ? fonts.find((f) => bare(f.value) === bare(st.fontFamily))?.value : "";
  const fontKnown = font !== undefined;

  return (
    <div data-text-toolbar role="toolbar" aria-label="글자 서식" onBlur={onBlur}
      className="flex flex-wrap items-center gap-1 border-b border-line bg-surface px-2 py-1 text-xs">
      <span onMouseDown={keep} className="flex items-center gap-0.5">
        <IconButton icon={Bold} label="굵게 (⌘B)" size={16} active={st.bold} onClick={cmd.toggleBold} />
        <IconButton icon={Italic} label="기울임 (⌘I)" size={16} active={st.italic} onClick={cmd.toggleItalic} />
        <IconButton icon={Underline} label="밑줄 (⌘U)" size={16} active={st.underline} onClick={cmd.toggleUnderline} />
      </span>
      <span className="mx-1 h-5 w-px bg-line" aria-hidden />
      <label className="flex items-center gap-1 text-muted">글꼴
        <select aria-label="글꼴" value={font ?? "__other"} className="rounded border border-line bg-surface px-1 py-0.5 text-xs text-fg"
          onChange={(e) => cmd.setFontFamily(e.target.value || null)}>
          <option value="">기본</option>
          {fonts.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
          {!fontKnown && <option value="__other" disabled>{st.fontFamily}</option>}
        </select>
      </label>
      <label className="flex items-center gap-1 text-muted">크기
        <select aria-label="글자 크기" value={st.fontSize} className="rounded border border-line bg-surface px-1 py-0.5 font-mono text-xs text-fg"
          onChange={(e) => cmd.setFontSize(e.target.value || null)}>
          <option value="">기본</option>
          {sizeOptions.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      </label>
      <span className="mx-1 h-5 w-px bg-line" aria-hidden />
      <span onMouseDown={keep} className="flex items-center gap-0.5" role="group" aria-label="글자색">
        {palette.map((p) => {
          const c = typeof p === "string" ? { value: p, label: p, swatch: p } : p;
          return (
            <button key={c.value} type="button" aria-label={`글자색 ${c.label}`} data-tip={c.label} onClick={() => cmd.setColor(c.value)}
              className={`size-5 rounded border ${st.color.toLowerCase() === c.value.toLowerCase() ? "border-accent ring-2 ring-accent" : "border-line"}`} style={{ background: c.swatch ?? c.value }} />
          );
        })}
        {st.color && <button type="button" className="px-1 text-[11px] text-muted underline" onClick={() => cmd.setColor(null)}>기본색</button>}
      </span>
      <input type="color" aria-label="글자색 직접 고르기" value={/^#[0-9a-f]{6}$/i.test(st.color) ? st.color : "#000000"}
        className="h-5 w-7 cursor-pointer rounded border border-line bg-surface" onChange={(e) => cmd.setColor(e.target.value)} />
      <span className="mx-1 h-5 w-px bg-line" aria-hidden />
      <span onMouseDown={keep} className="flex items-center gap-0.5">
        <IconButton icon={Link} label="링크 (https)" size={16} active={st.link || linkOpen}
          onClick={() => { setHref(cmd.linkHref() || "https://"); setLinkError(""); setLinkOpen((v) => !v); }} />
        {st.link && <IconButton icon={Link2Off} label="링크 빼기" size={16} onClick={cmd.unsetLink} />}
      </span>
      {linkOpen && (
        <form className="flex items-center gap-1" onSubmit={(e) => {
          e.preventDefault();
          if (!/^https:\/\/[^\s"<>]+$/.test(href)) { setLinkError("https:// 주소만 씁니다"); return; }
          cmd.setLink(href);
          setLinkOpen(false);
        }}>
          <input aria-label="링크 주소" value={href} onChange={(e) => setHref(e.target.value)} autoFocus
            className="w-48 rounded border border-line bg-surface px-1.5 py-0.5 font-mono text-xs"
            onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); setLinkOpen(false); cmd.focus(); } }} />
          <button type="submit" className="rounded bg-accent px-2 py-0.5 text-xs text-surface">걸기</button>
          {linkError && <span role="alert" className="text-crit">{linkError}</span>}
        </form>
      )}
      {note && <span className="ml-1 text-[11px] text-muted">{note}</span>}
    </div>
  );
}
