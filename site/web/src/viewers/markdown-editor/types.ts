// MarkFlow 에디터의 타입에서 이 사이트가 쓰는 것만 남겼다.

export type EditorLayout = "split" | "editor" | "preview";

/** `[[` 자동완성 후보. 고르면 `[제목](path)` Markdown 링크가 들어간다 */
export interface WikiLinkItem {
  title: string;
  /** 사이트 문서 주소. 예: /sdlc/code-review-automation/review-gate */
  path: string;
  /** 후보 옆에 보이는 위치. 예: SDLC › 코드 리뷰 자동화 */
  detail?: string;
}

export type ToolbarAction =
  | { type: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6 }
  | { type: "bold" }
  | { type: "italic" }
  | { type: "strikethrough" }
  | { type: "code" }
  | { type: "codeblock"; lang?: string }
  | { type: "blockquote" }
  | { type: "ul" }
  | { type: "ol" }
  | { type: "task" }
  | { type: "link" }
  | { type: "image" }
  | { type: "table" }
  | { type: "hr" }
  | { type: "math-inline" }
  | { type: "math-block" };
