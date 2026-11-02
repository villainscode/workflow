// 6.0 V6 보안 점검(2026-11-02) 로컬 서버 재현 테스트: Host·Origin 검사, 티켓 키 분리, 오피스 잠금 풀기, SVG 자산 CSP.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { signTicket } from "@workflow/core/office";
import { SVG_ASSET_CSP } from "@workflow/core/svg";
import { call, makeWorkspace, startServer, upload, type TestServer } from "./helpers.ts";

const SECRET = "local-office-secret";
const docx = readFileSync(join(import.meta.dirname, "../../packages/core/test/fixtures/struct.docx"));
const ws = makeWorkspace();
let srv: TestServer;
before(async () => { srv = await startServer(ws, { ONLYOFFICE_URL: "http://127.0.0.1:9", ONLYOFFICE_JWT_SECRET: SECRET }); });
after(async () => { await srv?.stop(); ws.cleanup(); });

/** Host 헤더를 마음대로 정해 보낸다(fetch는 Host를 바꿀 수 없다) */
const raw = (path: string, o: { method?: string; host?: string; origin?: string; body?: string } = {}) => new Promise<number>((ok, fail) => {
  const headers: Record<string, string> = { host: o.host ?? `127.0.0.1:${srv.port}`, "content-type": "application/json" };
  if (o.origin) headers.origin = o.origin;
  const r = request({ host: "127.0.0.1", port: srv.port, path, method: o.method ?? "GET", headers }, (res) => { res.resume(); ok(res.statusCode!); });
  r.on("error", fail);
  r.end(o.body);
});

describe("V6 보안 점검(로컬 서버)", () => {
  test("TC-SEC-09 (낮음) Host는 루프백·docker 이름만(DNS 리바인딩), 상태를 바꾸는 요청은 Origin이 없거나 루프백만(다른 사이트·sandbox 문서 null은 403)", async () => {
    assert.equal(await raw("/api/tree"), 200);
    assert.equal(await raw("/api/tree", { host: `localhost:${srv.port}` }), 200);
    assert.equal(await raw("/api/tree", { host: "host.docker.internal:5174" }), 200);
    assert.equal(await raw("/api/tree", { host: "evil.test" }), 403);
    assert.equal(await raw("/api/tree", { host: `rebind.evil.test:${srv.port}` }), 403);
    // 쓰기: Origin 없음(MCP·CLI)·루프백 출처는 통과(본문 검사 400까지 간다), 다른 사이트·null은 403
    assert.equal(await raw("/api/reindex", { method: "POST", body: "{}" }), 200);
    assert.equal(await raw("/api/reindex", { method: "POST", origin: "http://127.0.0.1:8000", body: "{}" }), 200);
    assert.equal(await raw("/api/reindex", { method: "POST", origin: "http://localhost:8000", body: "{}" }), 200);
    assert.equal(await raw("/api/reindex", { method: "POST", origin: "https://evil.test", body: "{}" }), 403);
    assert.equal(await raw("/api/reindex", { method: "POST", origin: "null", body: "{}" }), 403);
    assert.equal(await raw("/api/assets", { method: "POST", origin: "http://localhost.evil.test", body: "{}" }), 403);
  });

  test("TC-SEC-09 (낮음) 파일·콜백 주소 토큰은 오피스 JWT 비밀값으로 서명한 것을 받지 않는다(키 분리)", async () => {
    assert.equal((await upload(srv.url, { menu: "notes", title: "보고서", slug: "sec-report" }, [["report.docx", docx]])).status, 200);
    const s = (await call(srv.url, "POST", "/api/docs/notes/sec-report/office/session")).body;
    const real = new URL(s.config.document.url).searchParams.get("t")!;
    assert.equal((await fetch(`${srv.url}/api/office/file?t=${real}`)).status, 200);
    const forged = await signTicket({ ws: "local", doc: "notes/sec-report", key: s.key, use: "file" }, SECRET, 600);
    assert.equal((await fetch(`${srv.url}/api/office/file?t=${forged}`)).status, 403);
  });

  test("TC-SEC-08 (낮음) 오피스 잠금 풀기: 풀면 쓰기가 다시 된다", async () => {
    const D = "/api/docs/notes/sec-report";
    await call(srv.url, "POST", `${D}/office/session`);
    assert.equal((await call(srv.url, "POST", `${D}/revisions`, { baseRev: 0, put: [{ path: "memo.txt", text: "x" }] })).status, 409);
    assert.deepEqual((await call(srv.url, "POST", `${D}/office/unlock`)).body, { released: true });
    assert.equal((await call(srv.url, "POST", `${D}/revisions`, { baseRev: 0, put: [{ path: "memo.txt", text: "x" }] })).status, 200);
  });

  test("TC-SEC-01 (중간) SVG 자산 응답 CSP는 바깥 그림·글꼴·연결을 막는다(default-src 'none', sandbox)", async () => {
    const fd = new FormData();
    fd.append("file", new Blob([`<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>`], { type: "image/svg+xml" }), "a.svg");
    const a = await (await fetch(`${srv.url}/api/assets`, { method: "POST", body: fd })).json() as { sha256: string };
    const res = await fetch(`${srv.url}/api/assets/${a.sha256}/raw`);
    assert.equal(res.headers.get("content-security-policy"), SVG_ASSET_CSP);
  });
});
