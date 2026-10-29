import { beforeAll, describe, expect, it } from "vitest";
import { exports } from "cloudflare:workers";
import { addMember, login, seed } from "./helpers.ts";

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
    expect(names).toEqual(["create_menu", "edit_text", "find_documents", "focus_in_site", "get_document", "get_text", "list_documents", "release_document", "save_markdown", "upload_document", "upload_version"]);
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
});
