// 오피스 편집기(6.0 VO, D-59) 로컬 API. 오피스 서버(docker ONLYOFFICE) 대신 같은 경로를 흉내 내는 작은 서버를 띄우고,
// 편집 설정(JWT)·파일 주소·콜백 → 수정본·작업본 잠금·버전으로 저장을 Worker(apps/worker/test/office.test.ts)와 같은 규칙으로 본다.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { signJwt, verifyJwt } from "@workflow/core/office";
import { call, freePort, makeWorkspace, startServer, upload, type TestServer } from "./helpers.ts";

const SECRET = "local-office-secret";
const docx = readFileSync(join(import.meta.dirname, "../../packages/core/test/fixtures/struct.docx"));
const saved = Buffer.concat([docx, Buffer.from("저장본")]);
const ws = makeWorkspace();
let srv: TestServer;
let fake: Server;
let OFFICE = "";
let U = "";
before(async () => {
  const port = await freePort();
  OFFICE = `http://127.0.0.1:${port}`;
  fake = createServer((req, res) => {
    if (req.url === "/healthcheck") return res.end("true");
    if (req.url === "/cache/out.docx") return res.end(saved);
    res.statusCode = 404; res.end();
  });
  await new Promise<void>((ok) => fake.listen(port, "127.0.0.1", ok));
  srv = await startServer(ws, { ONLYOFFICE_URL: OFFICE, ONLYOFFICE_JWT_SECRET: SECRET });
  U = srv.url;
});
after(async () => { await srv?.stop(); fake?.close(); ws.cleanup(); });

const local = (url: string) => url.replace(/^https?:\/\/[^/]+/, "");

describe("로컬 오피스 편집기(6.0 VO)", () => {
  test("TC-VO-10·14 설정·파일·콜백 → 수정본(office), 잠긴 동안 다른 쓰기(텍스트 편집·새 버전·정식 확정 포함) 409, 버전으로 저장하면 docs/에 새 버전", async () => {
    assert.deepEqual((await call(U, "GET", "/api/editor-config")).body, { drawio: null, office: true });
    assert.deepEqual((await call(U, "GET", "/api/office/status")).body, { enabled: true, ready: true });
    const up = await upload(U, { menu: "notes", title: "로컬 보고서", slug: "local-report" }, [["report.docx", docx]]);
    assert.equal(up.status, 200, JSON.stringify(up.body));
    const D = "/api/docs/notes/local-report";
    const s = (await call(U, "POST", `${D}/office/session`)).body;
    const { token, ...config } = s.config;
    const { exp, ...signed } = (await verifyJwt<Record<string, unknown>>(token, SECRET))!;
    assert.deepEqual(signed, config);
    assert.ok(Number(exp) * 1000 > Date.now());
    assert.equal(s.apiUrl, `${OFFICE}/web-apps/apps/api/documents/api.js`);
    // 오피스 서버가 받는 원본
    const file = await fetch(U + local(config.document.url));
    assert.equal(Buffer.compare(Buffer.from(await file.arrayBuffer()), docx), 0);
    // 잠금
    assert.equal((await call(U, "POST", `${D}/revisions`, { baseRev: 0, put: [{ path: "memo.txt", text: "x" }] })).status, 409);
    // TC-VO-14 텍스트 편집·새 버전 올리기·정식 확정도 409
    const text = await call(U, "POST", `${D}/text-edit`, { baseVersion: "v0.0", changes: [] });
    assert.equal(text.status, 409);
    assert.match(text.body.error, /오피스 편집기에서 편집 중/);
    assert.equal((await upload(U, { menu: "notes", doc: "local-report" }, [["report.docx", Buffer.from("다른 내용")]])).status, 409);
    assert.equal((await call(U, "POST", `${D}/release`, {})).status, 409);
    // 콜백: 위조는 403, 다른 출처 주소는 400, 맞으면 수정본
    const cb = local(config.editorConfig.callbackUrl);
    const send = async (body: object, secret = SECRET) => {
      const res = await fetch(U + cb, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${await signJwt({ payload: body, exp: Math.floor(Date.now() / 1000) + 300 }, secret)}` }, body: JSON.stringify(body) });
      return { status: res.status, body: await res.json() };
    };
    assert.equal((await send({ key: s.key, status: 2, url: `${OFFICE}/cache/out.docx` }, "bad")).status, 403);
    assert.equal((await send({ key: s.key, status: 2, url: "http://169.254.169.254/x" })).status, 400);
    assert.deepEqual((await send({ key: s.key, status: 2, url: `${OFFICE}/cache/out.docx` })).body, { error: 0 });
    assert.deepEqual((await call(U, "GET", `${D}/office`)).body, { active: false, key: null, rev: 1 });
    const revs = (await call(U, "GET", `${D}/revisions`)).body;
    assert.equal(revs.revisions[0].source, "office");
    const pub = await call(U, "POST", `${D}/publish`, { baseRev: 1, note: "오피스 편집" });
    assert.equal(pub.status, 200, JSON.stringify(pub.body));
    assert.equal(Buffer.compare(readFileSync(join(ws.docs, "notes", "local-report", pub.body.version, "report.docx")), saved), 0);
  });
});
