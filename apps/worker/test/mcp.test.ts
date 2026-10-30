import { beforeAll, describe, expect, it } from "vitest";
import { exports } from "cloudflare:workers";
import { addMember, getJson, login, seed, useSession } from "./helpers.ts";

/** 원격 MCP(4.0 P6): OAuth(동적 등록 → 동의 화면에서 워크스페이스 고르기 → PKCE 토큰) 뒤 /mcp에서 로컬과 같은 도구 */

const O = "http://127.0.0.1:8787"; // APP_ORIGIN(테스트는 wrangler.jsonc 값). OAuth 자원 주소는 http면 loopback이어야 한다
const go = (path: string, init: RequestInit = {}) => exports.default.fetch(new Request(O + path, { redirect: "manual", ...init }));
const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** OAuth 전 과정을 거쳐 액세스 토큰을 받는다 */
async function connect(email: string, ws = "team") {
  const reg = await (await go("/oauth/register", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "Claude Code", redirect_uris: ["http://localhost:33418/callback"], token_endpoint_auth_method: "none" }) })).json<any>();
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  const q = new URLSearchParams({ response_type: "code", client_id: reg.client_id, redirect_uri: "http://localhost:33418/callback",
    code_challenge: challenge, code_challenge_method: "S256", state: "s1", scope: "mcp", resource: `${O}/mcp` });
  const { cookie } = await login(email);
  const page = await go(`/authorize?${q}`, { headers: { cookie } });
  expect(page.status).toBe(200);
  const html = await page.text();
  const handle = /name="handle" value="([^"]+)"/.exec(html)![1];
  const consentCookie = page.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  const form = new URLSearchParams({ handle, ws, decision: "approve" });
  const approved = await go(`/authorize?${q}`, { method: "POST", body: form, headers: { cookie: [cookie, consentCookie].filter(Boolean).join("; "), "content-type": "application/x-www-form-urlencoded", origin: O } });
  expect(approved.status).toBe(302);
  const code = new URL(approved.headers.get("location")!).searchParams.get("code")!;
  const tok = await (await go("/oauth/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: "http://localhost:33418/callback", client_id: reg.client_id, code_verifier: verifier, resource: `${O}/mcp` }) })).json<any>();
  expect(tok.access_token).toBeTruthy();
  return { html, token: tok.access_token as string };
}

let rpcId = 0;
async function rpc(token: string, method: string, params: object = {}) {
  const res = await go("/mcp", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }) });
  return { status: res.status, body: await res.json<any>().catch(() => null) };
}
const tool = async (token: string, name: string, args: object) => {
  await rpc(token, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
  const r = await rpc(token, "tools/call", { name, arguments: args });
  return { text: r.body.result.content[0].text as string, isError: !!r.body.result.isError };
};

beforeAll(async () => { await seed(); });

describe("원격 MCP", () => {
  it("TC-CF-41 토큰 없이 /mcp는 401(OAuth 안내), 동의 화면은 앱 이름·보낼 곳·내 워크스페이스를 보여 준다", async () => {
    const res = await go("/mcp", { method: "POST", body: "{}" });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toMatch(/Bearer/i);
    const { html } = await connect("owner@test.com");
    expect(html).toContain("Claude Code");
    expect(html).toContain("localhost");
    expect(html).toContain('value="team"');
  });

  it("TC-CF-42 도구 목록은 로컬과 같고(삭제 도구 없음), list_documents·get_text·edit_text가 그 사용자 권한으로 돈다(주소는 워크스페이스 아래)", async () => {
    const { token } = await connect("owner@test.com");
    await rpc(token, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
    const names = (await rpc(token, "tools/list")).body.result.tools.map((t: any) => t.name).sort();
    expect(names).toEqual(["asset_put", "create_menu", "deck_create", "deck_get", "doc_ops", "doc_structure", "edit_text", "find_documents", "focus_in_site", "get_document", "get_text", "list_documents", "release_document", "revision_list", "revision_restore", "save_markdown", "slide_patch", "slide_put", "upload_document", "upload_version"]);
    expect((await tool(token, "list_documents", {})).text).toContain(`${O}/team/sdlc/process/guide`);
    const t = await tool(token, "get_text", { ref: `${O}/team/sdlc/process/guide` });
    expect(t.text).toContain("둘째 판");
    const e = await tool(token, "edit_text", { ref: "sdlc/process/guide", changes: [{ find: "둘째 판", replace: "MCP 판" }] });
    expect(e.isError).toBe(false);
    expect(e.text).toContain("v0.2로 저장했습니다");
    const d = await tool(token, "get_document", { ref: "process/guide" });
    expect(d.text).toMatch(/v0\.2 \(최신\) · text-edit .*Claude Code:/);
  });

  it("TC-CF-43 upload_document는 파일 내용(글자·base64)으로 새 문서를 만들고, viewer로 연결하면 쓰기 도구는 권한 오류", async () => {
    const { token } = await connect("owner@test.com");
    const r = await tool(token, "upload_document", { menu: "notes", title: "MCP 문서", files: [{ path: "mcp.md", content: "# MCP" }, { path: "img/a.png", content: btoa("png"), encoding: "base64" }] });
    expect(r.isError).toBe(false);
    expect(r.text).toContain(`${O}/team/sdlc/notes/mcp`);
    await addMember("team", "viewer@test.com", "viewer");
    const v = await connect("viewer@test.com");
    const denied = await tool(v.token, "save_markdown", { ref: "notes/mcp", content: "# 바꿈" });
    expect(denied.isError).toBe(true);
    expect(denied.text).toContain("보기 권한만");
    expect((await tool(v.token, "find_documents", { query: "MCP" })).text).toContain("MCP 문서");
  });

  it("TC-CF-44 덱 도구: deck_create → deck_get(eid) → slide_patch(에이전트 수정본) → slide_put 형식 오류 진단 → asset_put", async () => {
    const { token } = await connect("owner@test.com");
    const c = await tool(token, "deck_create", { menu: "notes", title: "에이전트 덱", slug: "agent-deck", slides: [{ id: "cover", html: '<section id="cover"><h1>표지</h1></section>' }] });
    expect(c.isError).toBe(false);
    const g = await tool(token, "deck_get", { ref: "notes/agent-deck" });
    expect(g.text).toContain('<h1 data-eid="e1">표지</h1>');
    const p = await tool(token, "slide_patch", { ref: "notes/agent-deck", slideId: "cover", ops: [{ t: "setText", eid: "e1", html: "에이전트 표지" }] });
    expect(p.isError).toBe(false);
    expect(p.text).toMatch(/수정본 1/);
    useSession((await login("owner@test.com")).cookie);
    const revs = await getJson(`/api/w/team/docs/notes/agent-deck/revisions`);
    expect(revs.revisions[0]).toMatchObject({ source: "agent", summary: "Claude Code: 슬라이드 cover 연산 1개" });
    const bad = await tool(token, "slide_put", { ref: "notes/agent-deck", slideId: "two", html: '<section id="two"><div style="z-index:3">x</div></section>' });
    expect(bad.isError).toBe(true);
    expect(bad.text).toMatch(/1:\d+ \[css-prop\] 허용하지 않는 CSS 속성: z-index → z-index는 쓰지 않습니다/);
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const a = await tool(token, "asset_put", { base64: png, mime: "image/png" });
    expect(a.text).toMatch(/^asset:[0-9a-f]{64} \(1×1px\)$/);
  });

  it("TC-CF-46 doc_structure·doc_ops(에이전트 수정본), 잘못된 연산은 진단과 고칠 방법(→), revision_list·revision_restore", async () => {
    const { token } = await connect("owner@test.com");
    const st = await tool(token, "doc_structure", { ref: "process/guide" });
    expect(st.isError).toBe(false);
    const p = /^(e\d+) <p> /m.exec(st.text)!;
    expect(st.text).toMatch(/guide\.html \(html\) · rev 0/);
    const ok = await tool(token, "doc_ops", { ref: "process/guide", ops: [{ t: "insert", ref: p[1], where: "after", node: { kind: "table", rows: 2, cols: 2 } }] });
    expect(ok.isError).toBe(false);
    expect(ok.text).toMatch(/수정본 1로 저장했습니다/);
    // 지난 eid로 다시 보내면(그사이 위치가 바뀌지는 않았지만 rev가 지남) 409 + 고칠 방법
    const stale = await tool(token, "doc_ops", { ref: "process/guide", baseRev: 0, ops: [{ t: "remove", eid: p[1] }] });
    expect(stale.isError).toBe(true);
    expect(stale.text).toMatch(/→ doc_structure로 최신 eid·id와 rev를 다시 읽고/);
    const bad = await tool(token, "doc_ops", { ref: "process/guide", ops: [{ t: "tableRow", eid: p[1], at: 0, op: "add" }] });
    expect(bad.isError).toBe(true);
    expect(bad.text).toMatch(/→ 쓸 수 있는 연산: HTML 연산/);
    const list = await tool(token, "revision_list", { ref: "process/guide" });
    expect(list.text).toMatch(/^r1 \(지금\) · agent · owner@test\.com · .* · Claude Code: 구조 연산 1개$/m);
    const back = await tool(token, "revision_restore", { ref: "process/guide", rev: 0 });
    expect(back.text).toMatch(/기준 버전 내용으로 수정본 2를 만들었습니다/);
  });
});
