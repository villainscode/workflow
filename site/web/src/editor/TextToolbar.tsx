import { useState } from "react";
import { useEditorState, type Editor } from "@tiptap/react";
import { Bold, Italic, Link, Link2Off, Underline } from "lucide-react";
import { IconButton } from "../components/IconButton.tsx";

/**
 * 글자 도구 막대(6.0 4.1). 고른 글자에 굵게·기울임·밑줄·색·링크·글꼴·크기를 건다. 문서 종류와 무관하고, 쓸 글꼴·크기·색 목록은 부르는 쪽이 준다.
 * 막대는 data-text-toolbar로 표시한다. 편집기는 포커스가 막대로 옮겨 갈 때 글자 편집을 끝내지 않는다(TextEditor onBlur).
 * 버튼은 mousedown 기본 동작을 막아 편집기 포커스와 선택을 그대로 둔다. 목록·입력칸은 고른 뒤 편집기로 포커스를 돌린다.
 */

export interface FontOption { label: string; value: string }

/** 브라우저가 읽어 들인 rgb() 색을 견본과 비교할 수 있게 #rrggbb로 */
const hexOf = (c: string) => {
  const m = /^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/.exec(c);
  return m ? `#${m.slice(1).map((n) => Number(n).toString(16).padStart(2, "0")).join("")}` : c;
};

export function TextToolbar({ editor, fonts, sizes, palette, onLeave }: {
  editor: Editor;
  fonts: FontOption[];
  sizes: string[];
  palette: string[];
  /** 막대의 목록·입력칸에서 편집기도 막대도 아닌 곳으로 포커스가 나갔을 때(글자 편집 끝내기) */
  onLeave: () => void;
}) {
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
  const [linkOpen, setLinkOpen] = useState(false);
  const [href, setHref] = useState("");
  const [linkError, setLinkError] = useState("");
  const chain = () => editor.chain().focus();
  const keep = (e: React.MouseEvent) => e.preventDefault();
  const onBlur = (e: React.FocusEvent) => {
    const to = e.relatedTarget as Element | null;
    if (!to?.closest("[data-text-toolbar], .ProseMirror")) onLeave();
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
        <IconButton icon={Bold} label="굵게 (⌘B)" size={16} active={st.bold} onClick={() => chain().toggleBold().run()} />
        <IconButton icon={Italic} label="기울임 (⌘I)" size={16} active={st.italic} onClick={() => chain().toggleItalic().run()} />
        <IconButton icon={Underline} label="밑줄 (⌘U)" size={16} active={st.underline} onClick={() => chain().toggleUnderline().run()} />
      </span>
      <span className="mx-1 h-5 w-px bg-line" aria-hidden />
      <label className="flex items-center gap-1 text-muted">글꼴
        <select aria-label="글꼴" value={font ?? "__other"} className="rounded border border-line bg-surface px-1 py-0.5 text-xs text-fg"
          onChange={(e) => { const v = e.target.value; if (v) chain().setFontFamily(v).run(); else chain().unsetFontFamily().run(); }}>
          <option value="">기본</option>
          {fonts.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
          {!fontKnown && <option value="__other" disabled>{st.fontFamily}</option>}
        </select>
      </label>
      <label className="flex items-center gap-1 text-muted">크기
        <select aria-label="글자 크기" value={st.fontSize} className="rounded border border-line bg-surface px-1 py-0.5 font-mono text-xs text-fg"
          onChange={(e) => { const v = e.target.value; if (v) chain().setFontSize(v).run(); else chain().unsetFontSize().run(); }}>
          <option value="">기본</option>
          {sizeOptions.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      </label>
      <span className="mx-1 h-5 w-px bg-line" aria-hidden />
      <span onMouseDown={keep} className="flex items-center gap-0.5" role="group" aria-label="글자색">
        {palette.map((c) => (
          <button key={c} type="button" aria-label={`글자색 ${c}`} data-tip={c} onClick={() => chain().setColor(c).run()}
            className={`size-5 rounded border ${st.color.toLowerCase() === c.toLowerCase() ? "border-accent ring-2 ring-accent" : "border-line"}`} style={{ background: c }} />
        ))}
        {st.color && <button type="button" className="px-1 text-[11px] text-muted underline" onClick={() => chain().unsetColor().run()}>기본색</button>}
      </span>
      <input type="color" aria-label="글자색 직접 고르기" value={/^#[0-9a-f]{6}$/i.test(st.color) ? st.color : "#000000"}
        className="h-5 w-7 cursor-pointer rounded border border-line bg-surface" onChange={(e) => chain().setColor(e.target.value).run()} />
      <span className="mx-1 h-5 w-px bg-line" aria-hidden />
      <span onMouseDown={keep} className="flex items-center gap-0.5">
        <IconButton icon={Link} label="링크 (https)" size={16} active={st.link || linkOpen}
          onClick={() => { setHref((editor.getAttributes("link") as { href?: string }).href ?? "https://"); setLinkError(""); setLinkOpen((v) => !v); }} />
        {st.link && <IconButton icon={Link2Off} label="링크 빼기" size={16} onClick={() => chain().extendMarkRange("link").unsetLink().run()} />}
      </span>
      {linkOpen && (
        <form className="flex items-center gap-1" onSubmit={(e) => {
          e.preventDefault();
          if (!/^https:\/\/[^\s"<>]+$/.test(href)) { setLinkError("https:// 주소만 씁니다"); return; }
          chain().extendMarkRange("link").setLink({ href }).run();
          setLinkOpen(false);
        }}>
          <input aria-label="링크 주소" value={href} onChange={(e) => setHref(e.target.value)} autoFocus
            className="w-48 rounded border border-line bg-surface px-1.5 py-0.5 font-mono text-xs"
            onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); setLinkOpen(false); editor.commands.focus(); } }} />
          <button type="submit" className="rounded bg-accent px-2 py-0.5 text-xs text-surface">걸기</button>
          {linkError && <span role="alert" className="text-crit">{linkError}</span>}
        </form>
      )}
    </div>
  );
}
