// MarkFlow 에디터의 Markdown → HTML 변환(remark + rehype). 사이트 미리보기·프레젠테이션이 모두 이 엔진을 쓴다.
// 사이트용으로 바꾼 점:
// - 상대 경로 이미지·링크를 문서 버전 폴더(baseUrl) 기준으로 푼다(rehypeResolveUrls).
// - 문서 안 이동 링크(#…)는 새 탭으로 열지 않는다.
// - mermaid 코드 블록은 그대로 두고 화면(MarkdownPreview)이 다이어그램으로 바꾼다.

import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import remarkMath from "remark-math";
import remarkRehype from "remark-rehype";
import rehypeHighlight from "rehype-highlight";
import rehypeKatex from "rehype-katex";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import rehypeStringify from "rehype-stringify";
import { deepmerge } from "deepmerge-ts";
import type { Root, Element } from "hast";
import { visit } from "unist-util-visit";

const ABSOLUTE = /^([a-z][a-z0-9+.-]*:|\/|#)/i;

/** 상대 경로 src·href를 baseUrl(예: /files/menu/doc/v0.1/) 기준 경로로 바꾼다 */
function rehypeResolveUrls() {
  return (tree: Root, file: { data: object }) => {
    const baseUrl = (file.data as { baseUrl?: string }).baseUrl;
    if (!baseUrl) return;
    visit(tree, "element", (node: Element) => {
      const key = node.tagName === "img" ? "src" : node.tagName === "a" ? "href" : null;
      const value = key && node.properties?.[key];
      if (typeof value !== "string" || !value || ABSOLUTE.test(value)) return;
      const url = new URL(value, "http://x" + baseUrl);
      node.properties[key!] = url.pathname + url.search + url.hash;
    });
  };
}

/** 링크는 새 탭으로 연다. 문서 안 이동(#…)만 그 자리에서 */
function rehypeExternalLinks() {
  return (tree: Root) => {
    visit(tree, "element", (node: Element) => {
      if (node.tagName !== "a" || !node.properties) return;
      if (String(node.properties.href ?? "").startsWith("#")) return;
      node.properties.target = "_blank";
      node.properties.rel = ["noopener", "noreferrer"];
    });
  };
}

// 코드 색칠(class)과 KaTeX가 만든 class·style을 허용한다
const sanitizeSchema = deepmerge(defaultSchema, {
  attributes: {
    code: ["className"],
    span: ["className", "style", "aria-hidden"],
    div: ["className", "style"],
    img: ["src", "alt", "title", "width", "height", "loading"],
    a: ["target", "rel"],
    td: ["align", "valign"],
    th: ["align", "valign"],
    details: ["className", "open"],
    summary: ["className"],
    "*": ["className", "id"],
  },
  tagNames: [
    // KaTeX MathML
    "math", "semantics", "mrow", "mi", "mo", "mn", "mfrac",
    "msqrt", "mroot", "msup", "msub", "msubsup", "annotation",
    "annotation-xml", "menclose", "mtext", "mspace", "mtable",
    "mtr", "mtd",
    // GitHub 방식 HTML 요소
    "details", "summary", "kbd", "samp", "var", "mark",
    "sup", "sub", "abbr", "ins", "del",
    "figure", "figcaption", "dl", "dt", "dd",
    "ruby", "rt", "rp",
  ],
} as typeof defaultSchema);

// 한 번 만들어 계속 쓴다
const processor = unified()
  .use(remarkParse)
  .use(remarkGfm)                       // 표, 할 일 목록, 취소선
  .use(remarkBreaks)                    // 줄바꿈 한 번을 <br>로 (GitHub 코멘트·Notion 방식)
  .use(remarkMath)                      // $…$, $$…$$ 수식
  .use(remarkRehype, { allowDangerousHtml: true })
  .use(rehypeHighlight, { detect: false }) // 언어를 적은 코드 블록만 색칠
  .use(rehypeKatex)
  .use(rehypeRaw)                       // 본문의 HTML을 노드로
  .use(rehypeResolveUrls)
  .use(rehypeExternalLinks)
  .use(rehypeSanitize, sanitizeSchema)  // XSS 방지
  .use(rehypeStringify);

/** Markdown → 안전한 HTML. 동기 처리라 입력할 때마다 미리보기에 쓸 수 있다 */
export function parseMarkdown(markdown: string, baseUrl?: string): string {
  if (!markdown.trim()) return "";
  try {
    return String(processor.processSync({ value: markdown, data: { baseUrl } }));
  } catch (e) {
    return `<p class="mf-parse-error">Markdown 변환 오류: ${String((e as Error).message).replace(/[<&]/g, (c) => (c === "<" ? "&lt;" : "&amp;"))}</p>`;
  }
}
