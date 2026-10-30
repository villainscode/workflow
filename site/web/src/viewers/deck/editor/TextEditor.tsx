import { useEffect, useRef } from "react";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import Document from "@tiptap/extension-document";
import Paragraph from "@tiptap/extension-paragraph";
import Text from "@tiptap/extension-text";
import Bold from "@tiptap/extension-bold";
import Italic from "@tiptap/extension-italic";
import Underline from "@tiptap/extension-underline";
import Link from "@tiptap/extension-link";
import HardBreak from "@tiptap/extension-hard-break";
import { Color, TextStyle } from "@tiptap/extension-text-style";

/**
 * 슬라이드 글자 편집(명세 06절). Tiptap(ProseMirror)으로 한글 조합 입력을 안정적으로 받는다.
 * 확장은 문단 하나 + 굵게·기울임·밑줄·링크·글자색·줄바꿈(Shift+Enter)만. 형식에 맞게 굵게는 <b>, 기울임은 <i>로 쓴다.
 * Tiptap 자체 기록(History)은 넣지 않고 앱 되돌리기만 쓴다. Enter·Esc·바깥 클릭은 확정(명세 06절, 취소는 ⌘Z), Tab·Shift+Tab은 표의 다음·이전 칸.
 */

const B = Bold.extend({ renderHTML: ({ HTMLAttributes }) => ["b", HTMLAttributes, 0] });
const I = Italic.extend({ renderHTML: ({ HTMLAttributes }) => ["i", HTMLAttributes, 0] });
const OneParagraph = Document.extend({ content: "paragraph" });
const L = Link.configure({ openOnClick: false, autolink: false, protocols: [], HTMLAttributes: { target: null, rel: null, class: null }, isAllowedUri: (url) => /^https:\/\//.test(url) });

/** Tiptap HTML(<p>…</p>) → 슬라이드 글자 조각. 색 span의 "color: x" 공백은 형식대로 붙인다 */
export const toSlideHtml = (html: string) => html.replace(/^<p>/, "").replace(/<\/p>$/, "").replace(/style="color: ?([^";]+);?"/g, 'style="color:$1"');

export function TextEditor({ html, onDone, onTab }: {
  html: string;
  onDone: (html: string | null) => void;
  onTab?: (back: boolean, html: string) => void;
}) {
  const done = useRef(false);
  const ref = useRef<Editor | null>(null);
  const current = () => toSlideHtml(ref.current?.getHTML() ?? `<p>${html}</p>`);
  const finish = (value: string | null) => { if (done.current) return; done.current = true; onDone(value); };
  const editor = useEditor({
    extensions: [OneParagraph, Paragraph, Text, B, I, Underline, L, HardBreak, TextStyle, Color],
    content: `<p>${html}</p>`,
    immediatelyRender: true,
    autofocus: "end",
    editorProps: {
      attributes: { class: "slide-text-editor", "aria-label": "슬라이드 글자 편집" },
      handleKeyDown: (_view, e) => {
        if (e.isComposing || e.keyCode === 229) return false;
        if (e.key === "Escape" || (e.key === "Enter" && !e.shiftKey)) { e.preventDefault(); finish(current()); return true; }
        if (e.key === "Tab" && onTab) { e.preventDefault(); done.current = true; onTab(e.shiftKey, current()); return true; }
        return false;
      },
    },
    onBlur: ({ editor: ed }) => finish(toSlideHtml(ed.getHTML())),
  });
  useEffect(() => {
    ref.current = editor;
    // 편집기 DOM이 붙은 다음 프레임에 커서를 끝에 둔다(마운트 순간에는 포커스가 들어가지 않을 때가 있다)
    const id = requestAnimationFrame(() => { if (!editor?.isFocused) editor?.commands.focus("end"); });
    return () => cancelAnimationFrame(id);
  }, [editor]);
  return <EditorContent editor={editor} className="contents" />;
}
