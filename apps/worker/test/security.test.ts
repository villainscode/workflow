import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { exports } from "cloudflare:workers";
import { strToU8, zipSync } from "fflate";
import { signJwt } from "@workflow/core/office";
import { officeForward } from "../src/office.ts";
import { addMember, BASE, getJson, json, login, seed, upload, useSession } from "./helpers.ts";

/** 6.0 V6 보안 점검(2026-11-02) 재현 테스트: 오피스 프록시 경로, 늦게 온 콜백, 잠금 풀기. 규칙은 core security.test.ts */

const W = "/api/w/team";
const SECRET = "test-office-secret";
const docx = (text: string) => zipSync({
  "[Content_Types].xml": strToU8('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'),
  "word/document.xml": strToU8(`<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`),
});
const server = (path: string, init: RequestInit = {}) => exports.default.fetch(new Request(BASE + path, { ...init, redirect: "manual" }));
const exp = () => Math.floor(Date.now() / 1000) + 300;

let D = "";
beforeEach(async () => {
  await seed();
  const up = await (await upload("team", { menu: "notes", title: "보고서" }, [["report.docx", docx("처음")]])).json<any>();
  D = `${W}/docs/notes/${up.doc}`;
});
afterEach(() => vi.restoreAllMocks());

describe("V6 보안 점검(Worker)", () => {
  it("TC-SEC-05 (낮음) 오피스 프록시는 편집기 경로만 넘기고(관리·명령·변환 API는 404), 쿠키·Authorization·클라이언트 X-Forwarded-*를 지운다", async () => {
    const req = (path: string, headers: Record<string, string> = {}) => new Request(`https://office.test${path}`, { headers });
    for (const p of ["/web-apps/apps/api/documents/api.js", "/9.0.3-1a2b3c/web-apps/apps/documenteditor/main/index.html", "/sdkjs/word/sdk-all.js",
      "/fonts/000", "/doc/k1/c/?EIO=4&transport=websocket", "/cache/files/data/k1/output.docx/output.docx", "/healthcheck"]) {
      expect(officeForward(req(p)), p).not.toBeNull();
    }
    for (const p of ["/coauthoring/CommandService.ashx", "/ConvertService.ashx", "/info/info.json", "/admin", "/example/", "/", "/web-apps/../admin", "/healthcheckx"]) {
      expect(officeForward(req(p)), p).toBeNull();
    }
    const f = officeForward(req("/web-apps/x.js", { cookie: "a=1", authorization: "Bearer x", "x-forwarded-host": "evil", "x-forwarded-for": "1.2.3.4", forwarded: "for=1", accept: "*/*" }))!;
    expect(f.headers.get("cookie")).toBeNull();
    expect(f.headers.get("authorization")).toBeNull();
    expect(f.headers.get("x-forwarded-for")).toBeNull();
    expect(f.headers.get("forwarded")).toBeNull();
    expect(f.headers.get("x-forwarded-host")).toBe("office.test");
    expect(f.headers.get("accept")).toBe("*/*");
  });

  it("TC-SEC-07 (낮음) 잠금을 푼 뒤 늦게 온 저장 콜백은 반영하지 않는다(error 0으로 답하고 활동에 office-reject). 저장 파일 다운로드는 content-length 없이도 상한", async () => {
    const s = await (await json("POST", `${D}/office/session`)).json<any>();
    const cb = new URL(s.config.editorConfig.callbackUrl);
    const send = async (body: object) => server(cb.pathname + cb.search, { method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${await signJwt({ payload: body, exp: exp() }, SECRET)}` }, body: JSON.stringify(body) });
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(docx("늦은 저장")));
    expect((await json("POST", `${D}/office/unlock`)).status).toBe(200);
    expect(await (await send({ key: s.key, status: 2, url: "https://office.test/cache/files/out.docx" })).json()).toEqual({ error: 0 });
    expect(spy).not.toHaveBeenCalled();
    expect((await getJson(`${D}/office`)).rev).toBe(0);
    const acts = await getJson(`${W}/activity`);
    expect(acts.map((a: any) => a.action)).toEqual(expect.arrayContaining(["office-unlock", "office-reject"]));
    // 다시 열어 저장: content-length 없는 큰 응답은 413
    const s2 = await (await json("POST", `${D}/office/session`)).json<any>();
    const cb2 = new URL(s2.config.editorConfig.callbackUrl);
    spy.mockImplementation(async () => new Response(new ReadableStream({
      pull(c) { c.enqueue(new Uint8Array(8 * 1024 * 1024)); },
    })));
    const big = await server(cb2.pathname + cb2.search, { method: "POST", headers: { "content-type": "application/json",
      authorization: `Bearer ${await signJwt({ payload: { key: s2.key, status: 2, url: "https://office.test/cache/files/big.docx" }, exp: exp() }, SECRET)}` }, body: "{}" });
    expect(big.status).toBe(413);
  });

  it("TC-SEC-08 (낮음) 오피스 잠금 풀기는 owner만(editor 403), 풀면 같은 문서의 쓰기가 다시 된다", async () => {
    await (await json("POST", `${D}/office/session`)).json<any>();
    await addMember("team", "editor@test.com", "editor");
    const owner = (await login("owner@test.com")).cookie;
    useSession((await login("editor@test.com")).cookie);
    expect((await json("POST", `${D}/office/unlock`)).status).toBe(403);
    expect((await json("POST", `${D}/revisions`, { baseRev: 0, put: [{ path: "memo.txt", text: "x" }] })).status).toBe(409);
    useSession(owner);
    expect(await (await json("POST", `${D}/office/unlock`)).json()).toEqual({ released: true });
    expect((await getJson(`${D}/office`)).active).toBe(false);
    expect((await json("POST", `${D}/revisions`, { baseRev: 0, put: [{ path: "memo.txt", text: "x" }] })).status).toBe(200);
  });
});
