// MarkFlow 에디터의 원문 편집 창(CodeMirror 6). 사이트용으로 바꾼 점:
// - 밝은·어두운 테마는 사이트 다크 모드(useDark)를 따르고, 밝은 테마 바탕은 사이트 토큰을 쓴다.
// - `[[` 자동완성은 사이트 문서 목록으로 후보를 만들고, 고르면 `[제목](/대분류/메뉴/문서)` 링크를 넣는다.
// - 이미지 끌어 놓기·붙여넣기는 CodeMirror가 파일 내용을 글자로 넣지 않게만 막고, 올리기는 MarkdownEditor가 한다.

import { forwardRef, useCallback, useEffect, useRef } from "react";
import { EditorView, keymap, placeholder as placeholderExt } from "@codemirror/view";
import { EditorState, Compartment, Prec } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { autocompletion, type CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { oneDark } from "@codemirror/theme-one-dark";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import type { WikiLinkItem } from "./types.ts";

// ─── 밝은 테마: 코드 색(MarkFlow 그대로) ───────────────────────────────────────

const lightHighlightStyle = HighlightStyle.define([
  // Markdown 구조
  { tag: tags.heading1, color: "#1e3a8a", fontWeight: "bold", fontSize: "1.4em" },
  { tag: tags.heading2, color: "#1e40af", fontWeight: "bold", fontSize: "1.2em" },
  { tag: tags.heading3, color: "#2563eb", fontWeight: "bold", fontSize: "1.1em" },
  { tag: tags.heading, color: "#1e40af", fontWeight: "bold" },
  { tag: tags.strong, color: "#b91c1c", fontWeight: "bold" },
  { tag: tags.emphasis, color: "#0d9488", fontStyle: "italic" },
  { tag: tags.strikethrough, color: "#9ca3af", textDecoration: "line-through" },
  { tag: tags.link, color: "#2563eb", textDecoration: "underline" },
  { tag: tags.url, color: "#7c3aed" },
  { tag: tags.monospace, color: "#7c3aed", backgroundColor: "#f5f3ff" },
  { tag: tags.quote, color: "#6b7280", fontStyle: "italic" },
  { tag: tags.list, color: "#d97706" },
  { tag: tags.contentSeparator, color: "#d1d5db" },
  // 기호(# 표시, ``` 울타리, ** 등)
  { tag: tags.processingInstruction, color: "#9ca3af" },
  { tag: tags.meta, color: "#9ca3af" },
  { tag: tags.labelName, color: "#2563eb" },
  // 코드 블록 안 언어 토큰
  { tag: tags.keyword, color: "#7c3aed" },
  { tag: tags.controlKeyword, color: "#7c3aed", fontWeight: "600" },
  { tag: tags.moduleKeyword, color: "#7c3aed" },
  { tag: tags.operatorKeyword, color: "#7c3aed" },
  { tag: tags.string, color: "#059669" },
  { tag: tags.number, color: "#d97706" },
  { tag: tags.bool, color: "#d97706" },
  { tag: tags.null, color: "#d97706" },
  { tag: tags.comment, color: "#9ca3af", fontStyle: "italic" },
  { tag: tags.lineComment, color: "#9ca3af", fontStyle: "italic" },
  { tag: tags.blockComment, color: "#9ca3af", fontStyle: "italic" },
  { tag: tags.variableName, color: "#0284c7" },
  { tag: tags.definition(tags.variableName), color: "#1d4ed8" },
  { tag: tags.typeName, color: "#0d9488" },
  { tag: tags.className, color: "#b45309" },
  { tag: tags.propertyName, color: "#b91c1c" },
  { tag: tags.definition(tags.propertyName), color: "#b91c1c" },
  { tag: tags.function(tags.variableName), color: "#1d4ed8" },
  { tag: tags.operator, color: "#6b7280" },
  { tag: tags.punctuation, color: "#6b7280" },
  { tag: tags.bracket, color: "#6b7280" },
  { tag: tags.angleBracket, color: "#6b7280" },
  { tag: tags.squareBracket, color: "#6b7280" },
  { tag: tags.paren, color: "#6b7280" },
  { tag: tags.brace, color: "#6b7280" },
  { tag: tags.regexp, color: "#b91c1c" },
  { tag: tags.tagName, color: "#b91c1c" },
  { tag: tags.attributeName, color: "#d97706" },
  { tag: tags.attributeValue, color: "#059669" },
  { tag: tags.atom, color: "#d97706" },
  { tag: tags.self, color: "#7c3aed" },
  { tag: tags.special(tags.variableName), color: "#b45309" },
]);

// 편집 창 바탕·여백. 바탕과 줄 번호 색은 사이트 토큰
const baseTheme = EditorView.theme({
  "&": { height: "100%", fontSize: "13px" },
  ".cm-scroller": { fontFamily: "var(--font-mono)" },
  ".cm-content": { padding: "12px 16px" },
  ".cm-line": { padding: "0" },
  ".cm-tooltip-autocomplete ul li": { padding: "2px 8px" },
  ".cm-completionDetail": { marginLeft: "0.75em", fontStyle: "normal", opacity: "0.65" },
});
const lightTheme = [
  EditorView.theme({
    "&": { backgroundColor: "var(--surface)", color: "var(--fg)" },
    ".cm-content": { caretColor: "var(--accent)" },
    ".cm-cursor": { borderLeftColor: "var(--accent)" },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": { backgroundColor: "#bfdbfe" },
    ".cm-activeLine": { backgroundColor: "#f0f9ff" },
    ".cm-placeholder": { color: "var(--muted)" },
  }, { dark: false }),
  syntaxHighlighting(lightHighlightStyle),
];
// oneDark에 사이트 다크 바탕을 덮어쓴다
const darkTheme = [oneDark, Prec.highest(EditorView.theme({ "&": { backgroundColor: "var(--surface)" }, ".cm-gutters": { backgroundColor: "var(--surface)" } }, { dark: true }))];

// 읽기 전용이면 고칠 수도, 커서를 둘 수도 없게 한다
const lockExt = (readOnly: boolean) => [EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)];

// ─── `[[` 문서 링크 자동완성 ───────────────────────────────────────────────────

function wikiLinkCompletion(search: (query: string) => WikiLinkItem[] | Promise<WikiLinkItem[]>) {
  return async (context: CompletionContext): Promise<CompletionResult | null> => {
    const line = context.state.doc.lineAt(context.pos);
    const before = line.text.slice(0, context.pos - line.from);
    const match = /\[\[([^\]]*)$/.exec(before);
    if (!match) return null;
    const items = await search(match[1] ?? "");
    if (!items.length) return null;
    return {
      from: line.from + match.index,   // `[[`부터 바꾼다
      filter: false,                   // 후보는 search가 이미 골랐다
      options: items.map((item) => ({
        label: item.title,
        detail: item.detail,
        type: "text",
        apply: `[${item.title}](${item.path})`,
      })),
    };
  };
}

// ─── 컴포넌트 ─────────────────────────────────────────────────────────────────

export interface EditorPaneProps {
  value: string;
  onChange: (value: string) => void;
  dark: boolean;
  placeholder?: string;
  readOnly?: boolean;
  /** 커서·선택이 바뀌었을 때(미리보기 위치 맞춤, 상태 표시줄) */
  onCursor?: (view: EditorView) => void;
  onWikiLinkSearch?: (query: string) => WikiLinkItem[] | Promise<WikiLinkItem[]>;
  autoFocus?: boolean;
}

export const EditorPane = forwardRef<EditorView | null, EditorPaneProps>(function EditorPane(
  { value, onChange, dark, placeholder, readOnly = false, onCursor, onWikiLinkSearch, autoFocus }, ref,
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const external = useRef(false);
  // 입력할 때마다 같은 값이 되돌아오므로, 마지막으로 내보낸 값과 같으면 문서를 다시 넣지 않는다
  const lastEmitted = useRef<string>(value);
  // 처음 만든 편집기가 늘 최신 콜백을 부르도록
  const cb = useRef({ onChange, onCursor, onWikiLinkSearch });
  cb.current = { onChange, onCursor, onWikiLinkSearch };
  const theme = useRef(new Compartment()).current;
  const editable = useRef(new Compartment()).current;

  const setRef = useCallback((view: EditorView | null) => {
    viewRef.current = view;
    if (typeof ref === "function") ref(view);
    else if (ref) ref.current = view;
  }, [ref]);

  // 편집기는 한 번만 만든다
  useEffect(() => {
    const view = new EditorView({
      state: EditorState.create({
        doc: value,
        extensions: [
          markdown({ base: markdownLanguage, codeLanguages: languages }),
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
          EditorView.lineWrapping,
          baseTheme,
          theme.of(dark ? darkTheme : lightTheme),
          editable.of(lockExt(readOnly)),
          placeholderExt(placeholder ?? "Markdown을 입력하세요…"),
          autocompletion({
            override: [wikiLinkCompletion((q) => cb.current.onWikiLinkSearch?.(q) ?? [])],
            activateOnTyping: true,
          }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged && !external.current) {
              const next = update.state.doc.toString();
              lastEmitted.current = next;
              cb.current.onChange(next);
            }
            if (update.docChanged || update.selectionSet) cb.current.onCursor?.(update.view);
          }),
          EditorView.domEventHandlers({
            drop(event) {
              if (![...(event.dataTransfer?.files ?? [])].some((f) => f.type.startsWith("image/"))) return false;
              event.preventDefault();
              return true;
            },
            paste(event) {
              if (![...(event.clipboardData?.items ?? [])].some((i) => i.type.startsWith("image/"))) return false;
              event.preventDefault();
              return true;
            },
          }),
        ],
      }),
      parent: containerRef.current!,
    });
    setRef(view);
    if (autoFocus && !readOnly) {
      view.dispatch({ selection: { anchor: view.state.doc.length } });
      view.focus();
    }
    return () => { view.destroy(); setRef(null); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 밖에서 값을 바꾼 경우(임시 보관 불러오기 등)만 문서를 바꾼다
  useEffect(() => {
    if (value === lastEmitted.current) return;
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    lastEmitted.current = value;
    if (current === value) return;
    external.current = true;
    view.dispatch({ changes: { from: 0, to: current.length, insert: value } });
    external.current = false;
  }, [value]);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: theme.reconfigure(dark ? darkTheme : lightTheme) });
  }, [dark, theme]);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: editable.reconfigure(lockExt(readOnly)) });
  }, [readOnly, editable]);

  return <div ref={containerRef} className="h-full overflow-auto" aria-label="Markdown 원문 편집" />;
});
