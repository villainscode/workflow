// Markdown 편집기(MarkFlow에서 가져온 코드) 단위 테스트. 화면 없이 미리보기 엔진, 툴바 서식, 이미지 업로드·검사를 확인한다.
import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { EditorSelection, EditorState, type TransactionSpec } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { parseMarkdown } from "../web/src/viewers/markdown-editor/parseMarkdown.ts";
import { applyToolbarAction } from "../web/src/viewers/markdown-editor/markdownActions.ts";
import { createCloudflareUploader, createTestImage } from "../web/src/viewers/markdown-editor/cloudflareUploader.ts";
import { validateImageFile } from "../web/src/viewers/markdown-editor/imageValidation.ts";
import { countWords } from "../web/src/viewers/markdown-editor/wordCount.ts";
import type { ToolbarAction } from "../web/src/viewers/markdown-editor/types.ts";

describe("미리보기 엔진(parseMarkdown)", () => {
  test("TC-MD-01 제목·굵게·기울임·취소선·코드·목록·할 일·인용·표·구분선을 HTML로 바꾼다(GFM)", () => {
    const html = parseMarkdown("# 제목\n\n**굵게** *기울임* ~~취소~~ `코드`\n\n- 가\n1. 나\n\n- [ ] 할 일\n\n> 인용\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\n---\n");
    for (const s of ["<h1>제목</h1>", "<strong>굵게</strong>", "<em>기울임</em>", "<del>취소</del>", "<code>코드</code>", "<ul>", "<ol>",
      'type="checkbox"', "<blockquote>", "<table>", "<hr>"]) assert.ok(html.includes(s), s);
  });

  test("TC-MD-02 줄바꿈 한 번은 <br>(remark-breaks), 빈 문서는 빈 문자열", () => {
    assert.match(parseMarkdown("줄1\n줄2"), /줄1<br>\s*줄2/);
    assert.equal(parseMarkdown("  \n"), "");
  });

  test("TC-MD-03 코드 블록은 언어가 있으면 highlight.js로 색칠하고, mermaid 블록은 그대로 둔다(화면이 다이어그램으로 바꿈)", () => {
    assert.match(parseMarkdown("```ts\nconst a = 1\n```"), /<code class="language-ts"><span class="hljs-keyword">const<\/span>/);
    assert.match(parseMarkdown("```mermaid\ngraph TD; A-->B\n```"), /<pre><code class="language-mermaid">graph TD; A-->B/);
  });

  test("TC-MD-04 수식($…$, $$…$$)은 KaTeX로 그린다", () => {
    assert.match(parseMarkdown("$x^2$"), /class="katex"/);
    assert.match(parseMarkdown("$$\nE=mc^2\n$$"), /class="katex-display"/);
  });

  test("TC-MD-05 상대 경로 이미지·링크는 버전 폴더 기준으로 풀고, 외부·절대·#은 그대로", () => {
    const html = parseMarkdown("![a](img/x.png) [b](../other.md) [c](/sdlc/m/d) [d](https://e.com) [e](#sec)", "/files/m/d/v0.1/");
    assert.ok(html.includes('src="/files/m/d/v0.1/img/x.png"'));
    assert.ok(html.includes('href="/files/m/d/other.md"'));
    assert.ok(html.includes('href="/sdlc/m/d"'));
    assert.ok(html.includes('href="https://e.com"'));
    assert.ok(html.includes('href="#sec"'));
  });

  test("TC-MD-06 링크는 새 탭(target=_blank, noopener), 문서 안 이동(#)은 그 자리에서", () => {
    const html = parseMarkdown("[d](https://e.com) [e](#sec)");
    assert.match(html, /<a href="https:\/\/e.com" target="_blank" rel="noopener noreferrer">d<\/a>/);
    assert.match(html, /<a href="#sec">e<\/a>/);
  });

  test("TC-MD-07 위험한 HTML(script, on* 속성, javascript: 주소)은 지우고, details·kbd 등은 남긴다", () => {
    const html = parseMarkdown('<script>alert(1)</script><img src="x.png" onerror="alert(1)">\n\n[x](javascript:alert(1))\n\n<details><summary>더보기</summary>내용</details> <kbd>Ctrl</kbd>');
    assert.ok(!html.includes("<script"));
    assert.ok(!html.includes("onerror"));
    assert.ok(!html.includes("javascript:"));
    assert.ok(html.includes("<details>") && html.includes("<summary>더보기</summary>") && html.includes("<kbd>Ctrl</kbd>"));
  });
});

/** 화면 없이 EditorState만으로 툴바 동작을 돌린다(markdownActions는 view.state·dispatch·focus만 쓴다) */
function run(doc: string, from: number, to: number, action: ToolbarAction) {
  let state = EditorState.create({ doc, selection: EditorSelection.single(from, to) });
  const view = {
    get state() { return state; },
    dispatch: (tr: TransactionSpec | ReturnType<EditorState["update"]>) => { state = ("state" in tr ? tr : state.update(tr)).state; },
    focus() {},
  } as unknown as EditorView;
  applyToolbarAction(view, action);
  const sel = state.selection.main;
  return { text: state.doc.toString(), selected: state.sliceDoc(sel.from, sel.to) };
}

describe("툴바 서식(markdownActions)", () => {
  test("TC-MD-08 선택한 글자를 감싼다(굵게·기울임·취소선·코드·수식), 선택이 없으면 자리표시 글자를 넣고 선택한다", () => {
    assert.deepEqual(run("가 나 다", 2, 3, { type: "bold" }), { text: "가 **나** 다", selected: "나" });
    assert.equal(run("나", 0, 1, { type: "italic" }).text, "*나*");
    assert.equal(run("나", 0, 1, { type: "strikethrough" }).text, "~~나~~");
    assert.equal(run("나", 0, 1, { type: "code" }).text, "`나`");
    assert.equal(run("x", 0, 1, { type: "math-inline" }).text, "$x$");
    assert.deepEqual(run("", 0, 0, { type: "bold" }), { text: "**굵은 글자**", selected: "굵은 글자" });
  });

  test("TC-MD-09 줄 앞에 붙인다(제목·목록·할 일·인용). 여러 줄이면 줄마다, 번호 목록은 1. 2. …", () => {
    assert.equal(run("제목", 0, 0, { type: "heading", level: 2 }).text, "## 제목");
    assert.equal(run("가\n나", 0, 3, { type: "ul" }).text, "- 가\n- 나");
    assert.equal(run("가\n나", 0, 3, { type: "ol" }).text, "1. 가\n2. 나");
    assert.equal(run("가", 0, 0, { type: "task" }).text, "- [ ] 가");
    assert.equal(run("가", 0, 0, { type: "blockquote" }).text, "> 가");
  });

  test("TC-MD-10 블록을 넣는다(코드 블록·수식 블록·표·구분선·링크·이미지 주소)", () => {
    assert.equal(run("코드", 0, 2, { type: "codeblock" }).text, "\n```\n코드\n```\n");
    assert.equal(run("", 0, 0, { type: "math-block" }).text, "\n$$\n수식\n$$\n");
    assert.match(run("", 0, 0, { type: "table" }).text, /\| 항목 1 \| 항목 2 \| 항목 3 \|\n\| --- \| --- \| --- \|/);
    assert.equal(run("", 0, 0, { type: "hr" }).text, "\n---\n");
    assert.equal(run("사이트", 0, 3, { type: "link" }).text, "[사이트](https://)");
    assert.equal(run("", 0, 0, { type: "image" }).text, "![대체 글자](https://)");
  });
});

describe("이미지 업로드(Cloudflare R2 Worker)", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });

  test("TC-MD-11 Worker의 /upload로 multipart(file)를 보내고 받은 공개 주소를 돌려준다(끝 / 정리)", async () => {
    let called: { url: string; body: FormData } | undefined;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      called = { url, body: init.body as FormData };
      return new Response(JSON.stringify({ success: true, url: "https://pub.r2.dev/images/1.png" }));
    }) as typeof fetch;
    assert.equal(await createCloudflareUploader("https://w.example.com//")(createTestImage()), "https://pub.r2.dev/images/1.png");
    assert.equal(called?.url, "https://w.example.com/upload");
    assert.equal((called?.body.get("file") as File).name, "test.png");
  });

  test("TC-MD-12 주소가 없거나, 응답이 실패·형식 오류면 오류를 낸다", async () => {
    await assert.rejects(createCloudflareUploader("")(createTestImage()), /업로드 서버 주소가 설정되지 않았습니다/);
    globalThis.fetch = (async () => new Response("bad", { status: 413 })) as typeof fetch;
    await assert.rejects(createCloudflareUploader("https://w")(createTestImage()), /업로드 실패 \(413\): bad/);
    globalThis.fetch = (async () => new Response(JSON.stringify({ success: false, error: "too big" }))) as typeof fetch;
    await assert.rejects(createCloudflareUploader("https://w")(createTestImage()), /too big/);
  });

  test("TC-MD-13 올리기 전 검사: png·jpeg·gif·webp·svg, 10MB 이하, 빈 파일 거부", () => {
    assert.equal(validateImageFile(new File(["x"], "a.png", { type: "image/png" })).valid, true);
    assert.match(validateImageFile(new File(["x"], "a.bmp", { type: "image/bmp" })).error!, /지원하지 않는 파일 형식/);
    assert.match(validateImageFile(new File([new Uint8Array(10 * 1024 * 1024 + 1)], "big.png", { type: "image/png" })).error!, /너무 큽니다/);
    assert.match(validateImageFile(new File([], "e.png", { type: "image/png" })).error!, /빈 파일/);
  });

  test("TC-MD-14 단어 수는 공백 기준(한국어·영어 섞여도)", () => {
    assert.equal(countWords("  "), 0);
    assert.equal(countWords("# 회의록\n\n리뷰 담당 hello"), 5);
  });
});
