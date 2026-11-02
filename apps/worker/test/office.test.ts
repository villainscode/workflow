import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { exports } from "cloudflare:workers";
import { strToU8, zipSync } from "fflate";
import { signJwt, verifyJwt } from "@workflow/core/office";
import { addMember, BASE, call, getJson, json, login, seed, upload, useSession } from "./helpers.ts";

/** 6.0 VO: 오피스 편집 서버 연결(편집 설정 JWT, 파일·콜백 서명 토큰, 콜백 → 수정본, 작업본 잠금, SSRF 막기). 규칙은 core office.test.ts */

const W = "/api/w/team";
const SECRET = "test-office-secret";
const docx = (text: string) => zipSync({
  "[Content_Types].xml": strToU8('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'),
  "word/document.xml": strToU8(`<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`),
});
/** 오피스 서버처럼 부른다(쿠키·Origin 없이) */
const server = (path: string, init: RequestInit = {}) => exports.default.fetch(new Request(BASE + path, { ...init, redirect: "manual" }));
const ticketOf = (url: string) => new URL(url).searchParams.get("t")!;

let D = "";
beforeEach(async () => {
  await seed();
  const up = await (await upload("team", { menu: "notes", title: "보고서" }, [["report.docx", docx("처음")]])).json<any>();
  D = `${W}/docs/notes/${up.doc}`;
});
afterEach(() => vi.restoreAllMocks());

describe("오피스 편집기(6.0 VO)", () => {
  it("TC-VO-06 편집기 설정: editor-config에 office, 편집 설정은 JWT로 서명되고 파일·콜백 주소에 서명 토큰이 붙는다. 파일 주소로 원본을 받는다", async () => {
    expect(await getJson(`${W}/editor-config`)).toEqual({ drawio: null, office: true });
    const s = await (await json("POST", `${D}/office/session`)).json<any>();
    expect(s.apiUrl).toBe("https://office.test/web-apps/apps/api/documents/api.js");
    const { token, ...config } = s.config;
    expect(await verifyJwt(token, SECRET)).toEqual(config);
    expect(config.documentType).toBe("word");
    expect(config.editorConfig.mode).toBe("edit");
    expect(config.document.key).toBe(s.key);
    const file = await server(new URL(config.document.url).pathname + new URL(config.document.url).search);
    expect(file.status).toBe(200);
    expect(new Uint8Array(await file.arrayBuffer()).byteLength).toBeGreaterThan(100);
    // 토큰 없이·위조 토큰은 403
    expect((await server("/api/office/file?t=x")).status).toBe(403);
    expect((await server(`/api/office/callback?t=${ticketOf(config.document.url)}`, { method: "POST", body: "{}" })).status).toBe(403);
  });

  it("TC-VO-07 콜백: status 2면 오피스 서버에서 파일을 받아 수정본(office)으로 쌓고 잠금이 풀린다. 위조 JWT·다른 키·다른 출처 주소는 거부", async () => {
    const s = await (await json("POST", `${D}/office/session`)).json<any>();
    const cbPath = new URL(s.config.editorConfig.callbackUrl).pathname + new URL(s.config.editorConfig.callbackUrl).search;
    const send = async (body: object, secret = SECRET) =>
      server(cbPath, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${await signJwt({ payload: body }, secret)}` }, body: JSON.stringify(body) });
    const saved = docx("고침");
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      expect(String(input)).toBe("https://office.test/cache/files/out.docx");
      return new Response(saved);
    });
    expect((await send({ key: s.key, status: 2, url: "https://office.test/cache/files/out.docx" }, "wrong")).status).toBe(403);
    expect((await send({ key: "other", status: 2, url: "https://office.test/cache/files/out.docx" })).status).toBe(403);
    expect((await send({ key: s.key, status: 2, url: "https://169.254.169.254/latest" })).status).toBe(400);
    expect(spy).not.toHaveBeenCalled();
    // 편집 중(status 1)은 저장 없이 연장
    expect(await (await send({ key: s.key, status: 1, users: ["1"] })).json()).toEqual({ error: 0 });
    expect((await getJson(`${D}/office`)).active).toBe(true);
    expect(await (await send({ key: s.key, status: 2, url: "https://office.test/cache/files/out.docx", users: ["1"] })).json()).toEqual({ error: 0 });
    const st = await getJson(`${D}/office`);
    expect(st).toMatchObject({ active: false, rev: 1 });
    const revs = await getJson(`${D}/revisions`);
    expect(revs.revisions[0]).toMatchObject({ rev: 1, source: "office", author: "owner@test.com" });
    const work = await getJson(`${D}/work`);
    expect(work.files.find((f: any) => f.path === "report.docx").size).toBe(saved.byteLength);
  });

  it("TC-VO-08 잠금: 편집 세션 동안 같은 문서의 구조 편집·버전으로 저장은 409, 보기 설정은 잠그지 않는다. viewer는 편집 세션을 못 열고 보기만", async () => {
    await (await json("POST", `${D}/office/session`)).json<any>();
    const put = await json("POST", `${D}/revisions`, { baseRev: 0, put: [{ path: "memo.txt", text: "x" }] });
    expect(put.status).toBe(409);
    expect((await put.json<any>()).error).toContain("오피스 편집기에서 편집 중");
    expect((await json("POST", `${D}/publish`, { baseRev: 0 })).status).toBe(409);
    await addMember("team", "viewer@test.com", "viewer");
    useSession((await login("viewer@test.com")).cookie);
    expect((await json("POST", `${D}/office/session`)).status).toBe(403);
    const view = await (await call(`${D}/office/config`)).json<any>();
    expect(view.config.editorConfig.mode).toBe("view");
    expect(view.config.editorConfig.callbackUrl).toBeUndefined();
    expect(view.config.document.permissions.edit).toBe(false);
  });

  it("TC-VO-13 잠금: 편집 세션 동안 텍스트 편집·새 버전 올리기·정식 확정도 409(오피스 저장이 그 사이 바뀐 대표 파일을 덮어쓰지 않게)", async () => {
    await (await json("POST", `${D}/office/session`)).json<any>();
    const doc = D.split("/").pop()!;
    const text = await json("POST", `${D}/text-edit`, { baseVersion: "v0.0", changes: [] });
    expect(text.status).toBe(409);
    expect((await text.json<any>()).error).toContain("오피스 편집기에서 편집 중");
    expect((await upload("team", { menu: "notes", doc }, [["report.docx", docx("다른 내용")]])).status).toBe(409);
    expect((await json("POST", `${D}/release`, {})).status).toBe(409);
    expect((await getJson(D)).currentVersion).toBe("v0.0");
  });

  it("TC-VO-09 HTML 문서는 오피스 편집기로 열지 않는다(400), 준비 상태는 편집 서버 healthcheck", async () => {
    const up = await (await upload("team", { menu: "notes", title: "페이지" }, [["page.html", "<p>x</p>"]])).json<any>();
    expect((await json("POST", `${W}/docs/notes/${up.doc}/office/session`)).status).toBe(400);
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      expect(String(input)).toBe("https://office.test/healthcheck");
      return new Response("true");
    });
    expect(await getJson(`${W}/office/status`)).toEqual({ enabled: true, ready: true });
  });
});
