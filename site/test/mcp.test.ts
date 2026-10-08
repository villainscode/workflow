// 3.1 workflow-docs MCP 서버. Claude Code와 같은 방식(stdio)으로 띄우고, 임시 docs로 띄운 사이트 서버에 연결한다.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { parse } from "yaml";
import { freePort, makeWorkspace, openEvents, readText, SITE, startServer, TSX, upload, type TestServer } from "./helpers.ts";

const WEB = "http://localhost:5173";
const ws = makeWorkspace();
let srv: TestServer;
let client: Client;

async function connect(api: string) {
  const c = new Client({ name: "mcp-test", version: "0.0.1" });
  await c.connect(new StdioClientTransport({
    command: process.execPath, args: [TSX, join(SITE, "mcp/server.ts")], cwd: ws.root, stderr: "ignore",
    env: { ...process.env as Record<string, string>, WORKFLOW_API: api, WORKFLOW_WEB: WEB, WORKFLOW_ROOT: ws.root },
  }));
  return c;
}
const tool = async (name: string, args: Record<string, unknown>, c = client) => {
  const r = (await c.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
  return { text: r.content.map((x) => x.text).join("\n"), error: !!r.isError };
};
const ok = async (name: string, args: Record<string, unknown>) => {
  const r = await tool(name, args);
  assert.equal(r.error, false, r.text);
  return r.text;
};
const fail = async (name: string, args: Record<string, unknown>, re: RegExp) => {
  const r = await tool(name, args);
  assert.equal(r.error, true, `오류여야 함: ${r.text}`);
  assert.match(r.text, re);
};
const meta = (menu: string, doc: string) => parse(readText(join(ws.docs, menu, doc, "meta.yaml")));

before(async () => {
  srv = await startServer(ws);
  client = await connect(srv.url);
  // 아티팩트를 Artifact 도구로 저장한 상황: 임시 이름의 HTML 파일
  mkdirSync(join(ws.root, "tool-results"));
  writeFileSync(join(ws.root, "tool-results/artifact-1234.html"),
    "<!doctype html><html><head><title>t</title></head><body><h1>플랫폼팀 개발 환경</h1><p>런처가 런타임이다.</p><p>확장팩</p><p>확장팩 목록</p></body></html>");
  mkdirSync(join(ws.root, "out/bundle"), { recursive: true });
  writeFileSync(join(ws.root, "out/bundle/index.html"), "<p>묶음</p>");
  writeFileSync(join(ws.root, "out/bundle/app.css"), "p{}");
});
after(async () => { await client?.close(); await srv?.stop(); ws.cleanup(); });

describe("도구 구성", () => {
  test("TC-MCP-01 도구 11개(3.4 focus_in_site 포함), 삭제·휴지통 도구는 없다(D-24)", async () => {
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    assert.deepEqual(names, ["create_menu", "edit_text", "find_documents", "focus_in_site", "get_document", "get_text", "list_documents",
      "release_document", "save_markdown", "upload_document", "upload_version"]);
    assert.ok(!names.some((n) => /delete|trash|purge|remove/.test(n)));
  });

  test("TC-MCP-02 사이트 서버가 꺼져 있으면 실행 안내를 돌려준다", async () => {
    const dead = await connect(`http://127.0.0.1:${await freePort()}`);
    const r = await tool("list_documents", {}, dead);
    await dead.close();
    assert.equal(r.error, true);
    assert.match(r.text, /사이트 서버\(.+\)에 연결할 수 없습니다.*npm run dev/);
  });
});

describe("조회", () => {
  test("TC-MCP-03 list_documents: 트리·주소·버전(draft 표시)·대분류 필터", async () => {
    const all = await ok("list_documents", {});
    assert.match(all, /## SDLC \(key: sdlc\)/);
    assert.match(all, /- 메뉴 개발 프로세스 \(slug: process\)\n {4}• .+\n {4}- 메뉴 코드 리뷰 \(slug: review\)/);
    assert.match(all, /• 샘플 프로세스 가이드 — draft · draft · html · http:\/\/localhost:5173\/sdlc\/process\/guide/);
    assert.match(all, /## Agent \(key: agent\)\n {2}\(메뉴 없음\)/);
    const agent = await ok("list_documents", { category: "Agent" });
    assert.doesNotMatch(agent, /SDLC/);
  });

  test("TC-MCP-04 find_documents: 본문 검색 결과와 없음 안내", async () => {
    assert.match(await ok("find_documents", { query: "배포" }), /샘플 프로세스 가이드 \(sdlc › 개발 프로세스, draft, html, 본문 1곳\)/);
    assert.match(await ok("find_documents", { query: "없는말쀍" }), /맞는 문서가 없습니다/);
  });

  test("TC-MCP-05 get_document: 주소·경로·이름 경로·제목·부분 제목으로 지정", async () => {
    for (const ref of [`${WEB}/sdlc/process/guide`, "sdlc/process/guide", "process/guide", "SDLC > 개발 프로세스 > 샘플 프로세스 가이드", "샘플 프로세스 가이드", "프로세스 가이드"]) {
      const t = await ok("get_document", { ref });
      assert.match(t, /대분류\/메뉴\/문서: sdlc\/process\/guide/, ref);
    }
    const t = await ok("get_document", { ref: "process/guide" });
    assert.match(t, /텍스트 편집: 가능/);
    assert.match(t, /- draft \(최신\) · upload · 2026-10-01 · 최초 작성/);
    assert.match(await ok("get_document", { ref: "주간 회의록" }), /Markdown 전체 저장\(save_markdown\)/);
  });

  test("TC-MCP-06 여러 개가 맞으면 후보를, 없으면 검색 안내를 준다", async () => {
    await fail("get_document", { ref: "문서는없음" }, /문서를 찾을 수 없습니다.*find_documents/);
    await upload(srv.url, { menu: "notes", title: "중복 제목", slug: "dup-a" }, [["a.html", "<p>a</p>"]]);
    await upload(srv.url, { menu: "review", title: "중복 제목", slug: "dup-b" }, [["b.html", "<p>b</p>"]]);
    await fail("get_document", { ref: "중복 제목" }, /여러 개 맞습니다(?=[\s\S]*- sdlc\/notes\/dup-a)(?=[\s\S]*- sdlc\/review\/dup-b)/);
    assert.match(await ok("get_document", { ref: "SDLC > 코드 리뷰 > 중복 제목" }), /sdlc\/review\/dup-b/, "메뉴 이름으로 좁힘");
  });
});

describe("등록", () => {
  test("TC-MCP-07 create_menu: 대분류 이름·상위 메뉴 이름으로 만들고, 없는 대분류는 목록 안내", async () => {
    assert.match(await ok("create_menu", { category: "Agent", name: "온보딩", slug: "onboarding" }), /slug: onboarding/);
    assert.match(await ok("create_menu", { category: "agent", name: "도구", slug: "tools", parent: "온보딩" }), /Agent › 온보딩 아래/);
    await fail("create_menu", { category: "없음", name: "x" }, /대분류 "없음"이\(가\) 없습니다: SDLC\(sdlc\), Agent\(agent\)/);
  });

  test("TC-MCP-08 upload_document: 아티팩트 파일을 filename·origin과 함께 등록, 메모에 Claude Code:", async () => {
    const t = await ok("upload_document", {
      menu: "온보딩", title: "플랫폼팀 개발 환경", slug: "platform-env", filename: "platform-env.html",
      files: ["tool-results/artifact-1234.html"], origin: "https://claude.ai/artifact/abc",
    });
    assert.match(t, /Agent › 온보딩에 draft로 등록했습니다\(파일 1개\)\.\nhttp:\/\/localhost:5173\/agent\/onboarding\/platform-env/);
    const m = meta("onboarding", "platform-env");
    assert.equal(m.versions[0].entry, "platform-env.html");
    assert.equal(m.origin_url, "https://claude.ai/artifact/abc");
    assert.equal(m.versions[0].note, "Claude Code: 외부에서 가져옴: https://claude.ai/artifact/abc");
    assert.match(await ok("get_document", { ref: "agent/onboarding/platform-env" }), /출처: https:\/\/claude\.ai\/artifact\/abc/);
  });

  test("TC-MCP-09 upload_document: 폴더째 올리기, 잘못된 입력 거부", async () => {
    assert.match(await ok("upload_document", { menu: "tools", title: "묶음", slug: "bundle", files: ["out/bundle"] }), /파일 2개/);
    assert.equal(meta("tools", "bundle").versions[0].entry, "index.html");
    await fail("upload_document", { menu: "tools", title: "x", files: ["out/none.html"] }, /파일을 찾을 수 없습니다/);
    await fail("upload_document", { menu: "tools", title: "x", files: ["out/bundle"], filename: "a.html" }, /파일 1개를 올릴 때만/);
    await fail("upload_document", { menu: "tools", title: "x", files: ["tool-results/artifact-1234.html"], filename: "noext" }, /확장자가 필요/);
    await fail("upload_document", { menu: "없는메뉴", title: "x", files: ["tool-results/artifact-1234.html"] }, /메뉴 "없는메뉴".*list_documents/);
  });

  test("TC-MCP-10 upload_version: 다음 버전, 같은 내용은 서버 거부 메시지 전달", async () => {
    writeFileSync(join(ws.root, "out/guide.html"), "<p>새 내용</p>");
    assert.match(await ok("upload_version", { ref: "agent/tools/bundle", files: ["out/guide.html"], note: "갱신" }), /v0\.1로 올렸습니다/);
    assert.equal(meta("tools", "bundle").versions[1].note, "Claude Code: 갱신");
    await fail("upload_version", { ref: "agent/tools/bundle", files: ["out/guide.html"] }, /직전 버전\(v0\.1\)과 내용이 같아/);
  });
});

describe("텍스트 조회·편집", () => {
  const REF = "agent/onboarding/platform-env";

  test("TC-MCP-11 get_text: 전체·검색어·개수 제한", async () => {
    const t = await ok("get_text", { ref: REF });
    assert.match(t, /플랫폼팀 개발 환경 · html · platform-env\.html · draft \(최신, 편집 가능\) · 조각 4\/4개/);
    assert.match(t, /\[0\] h1: 플랫폼팀 개발 환경/);
    assert.match(await ok("get_text", { ref: REF, query: "확장팩" }), /조각 2\/4개/);
    assert.match(await ok("get_text", { ref: REF, limit: 1 }), /… 3개 더 있음/);
  });

  test("TC-MCP-12 get_text: 주소의 seg 범위와 앞뒤 문맥, 범위 표시(▶)", async () => {
    const t = await ok("get_text", { ref: `${WEB}/${REF}?seg=2`, context: 1 });
    assert.match(t, /조각 3\/4개/);
    assert.match(t, /▶ \[2\] p: 확장팩/);
    assert.match(t, /^\[1\] p:/m);
    assert.match(await ok("get_text", { ref: `${WEB}/${REF}?seg=1-2`, context: 0 }), /조각 2\/4개/);
  });

  test("TC-MCP-18 get_text: seg 목록 형식(3,10-12)도 해석한다(3.2)", async () => {
    const t = await ok("get_text", { ref: `${WEB}/${REF}?v=v0.0&seg=0,2-3`, context: 0 });
    assert.match(t, /조각 3\/4개/);
    assert.match(t, /▶ \[0\][\s\S]*▶ \[2\][\s\S]*▶ \[3\]/);
    assert.doesNotMatch(t, /\[1\]/);
  });

  test("TC-MCP-13 edit_text: 여러 곳이면 거부, 조각 id·찾아 바꾸기로 저장", async () => {
    await fail("edit_text", { ref: REF, changes: [{ find: "확장팩", replace: "확장 팩" }] }, /조각 2곳에 있습니다: \[2\] p, \[3\] p/);
    const t = await ok("edit_text", { ref: REF, changes: [{ segment: 1, text: "런처가 곧 런타임이다." }, { find: "개발 환경", replace: "개발 환경 안내" }], note: "문장 다듬기" });
    assert.match(t, /2곳을 고쳐 v0\.1로 저장했습니다/);
    assert.match(t, /\[1\] p: 「런처가 런타임이다\.」 → 「런처가 곧 런타임이다\.」/);
    const m = meta("onboarding", "platform-env");
    assert.equal(m.versions[1].source, "text-edit");
    assert.equal(m.versions[1].note, "Claude Code: 문장 다듬기");
    assert.match(readText(join(ws.docs, "onboarding/platform-env/v0.1/platform-env.html")), /<h1>플랫폼팀 개발 환경 안내<\/h1><p>런처가 곧 런타임이다\.<\/p>/);
  });

  test("TC-MCP-14 edit_text: all: true로 여러 곳, 바뀐 것 없음, 잘못된 지정", async () => {
    assert.match(await ok("edit_text", { ref: REF, changes: [{ find: "확장팩", replace: "확장 팩", all: true }] }), /2곳을 고쳐 v0\.2로/);
    assert.match(await ok("edit_text", { ref: REF, changes: [{ segment: 0, text: "플랫폼팀 개발 환경 안내" }] }), /바뀐 글자가 없습니다/);
    await fail("edit_text", { ref: REF, changes: [{ segment: 99, text: "x" }] }, /조각 99이\(가\) 없습니다/);
    await fail("edit_text", { ref: REF, changes: [{ segment: 0 }] }, /text\(새 글자\)가 필요/);
    await fail("edit_text", { ref: REF, changes: [{ find: "없는 글자", replace: "x" }] }, /든 조각이 없습니다/);
    await fail("edit_text", { ref: REF, changes: [{}] }, /segment\+text 또는 find\+replace/);
  });

  test("TC-MCP-15 edit_text: 이전 버전 주소로는 고칠 수 없다", async () => {
    await fail("edit_text", { ref: `${WEB}/${REF}?v=v0.0`, changes: [{ segment: 0, text: "x" }] }, /draft은\(는\) 이전 버전입니다.*최신 버전\(v0\.2\)/);
    assert.match(await ok("get_text", { ref: `${WEB}/${REF}?v=v0.0` }), /draft \(이전 버전: 편집은 최신 버전에서만\)/);
  });

  test("TC-MCP-16 save_markdown: Markdown 새 버전, HTML 문서는 서버가 거부", async () => {
    assert.match(await ok("save_markdown", { ref: "주간 회의록", content: "# 회의록\n\n- MCP로 수정\n", note: "안건 추가" }), /v0\.1로 저장했습니다/);
    assert.equal(readText(join(ws.docs, "notes/minutes/v0.1/minutes.md")), "# 회의록\n\n- MCP로 수정\n");
    assert.equal(meta("notes", "minutes").versions[1].note, "Claude Code: 안건 추가");
    await fail("save_markdown", { ref: "process/guide", content: "x" }, /Markdown 문서만/);
  });
});

describe("SVG", () => {
  test("TC-MCP-21 SVG 문서도 get_text·edit_text로 고치고, 넘칠 수 있으면 주의를 함께 알린다", async () => {
    assert.match(await ok("upload_document", { menu: "tools", title: "ERD 그림", slug: "erd", files: [join(SITE, "scripts/fixtures/sample-drawio.svg")] }), /draft로 등록/);
    assert.match(await ok("get_document", { ref: "agent/tools/erd" }), /텍스트 편집: 가능/);
    assert.match(await ok("get_text", { ref: "agent/tools/erd", query: "tokens 모듈" }), /\[0\] s-0-0-tokens: tokens 모듈/);
    const t = await ok("edit_text", { ref: "agent/tools/erd", changes: [{ find: "iframe 로그인의", replace: "아주 긴 설명 ".repeat(12) + "iframe 로그인의" }] });
    assert.match(t, /v0\.1로 저장했습니다/);
    assert.match(t, /주의: \[\d+\].*넘칠 수 있습니다/);
  });
});

describe("실시간 표시(3.4)", () => {
  test("TC-MCP-19 쓰기 도구의 변경 알림에는 by: claude-code와 바뀐 조각이 담긴다", async () => {
    const sse = await openEvents(srv.url);
    await ok("edit_text", { ref: "agent/onboarding/platform-env", changes: [{ segment: 3, text: "확장 팩 목록 (알림 시험)" }] });
    const e = await sse.next((x) => x.reason === "text-edit");
    assert.equal(e.by, "claude-code");
    assert.deepEqual(e.segs, [3]);
    assert.equal(e.title, "플랫폼팀 개발 환경");
    sse.close();
  });

  test("TC-MCP-20 focus_in_site: 열린 화면이 있으면 옮기고, 없으면 주소를 안내한다", async () => {
    assert.match(await ok("focus_in_site", { ref: `${WEB}/agent/onboarding/platform-env?seg=2-3` }), /열린 사이트 화면이 없습니다[\s\S]*seg=2-3/);
    const sse = await openEvents(srv.url);
    await new Promise((r) => setTimeout(r, 100));
    assert.match(await ok("focus_in_site", { ref: `${WEB}/agent/onboarding/platform-env?v=v0.1&seg=1` }), /열린 사이트 화면 1개를 옮겼습니다/);
    const e = await sse.next((x) => x.type === "focus");
    assert.deepEqual([e.category, e.menu, e.doc, e.version, e.seg, e.by], ["agent", "onboarding", "platform-env", "v0.1", "1", "claude-code"]);
    sse.close();
  });
});

describe("정식 확정", () => {
  test("TC-MCP-17 release_document: v1.0 approved, 메모에 Claude Code:, 두 번째는 거부", async () => {
    assert.match(await ok("release_document", { ref: "agent/onboarding/platform-env" }), /v0\.3 → v1\.0\(approved\)로 확정했습니다/);
    const m = meta("onboarding", "platform-env");
    assert.equal(m.status, "approved");
    assert.equal(m.versions.at(-1).note, "Claude Code: 정식 버전으로 확정 (v0.3 → v1.0)");
    await fail("release_document", { ref: "agent/onboarding/platform-env" }, /이미 정식 버전입니다/);
  });
});
