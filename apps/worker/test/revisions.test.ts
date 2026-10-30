import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { addMember, call, getJson, json, login, seed, upload, useSession } from "./helpers.ts";

/** 5.0 M1: 수정본(작업본 저장·이력·되돌리기·버전으로 올리기)과 편집기 이미지 자산 */

const W = "/api/w/team";
const D = `${W}/docs/process/guide`;
const save = (baseRev: number, put: { path: string; text?: string; base64?: string }[], extra: object = {}, headers: Record<string, string> = {}) =>
  call(`${D}/revisions`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ baseRev, put, ...extra }) });
const pathOf = (url: string) => new URL(url).pathname;
const wsId = async () => (await env.DB.prepare("SELECT id FROM workspace WHERE slug = 'team'").first<{ id: number }>())!.id;
// 1x1 PNG
const PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));

beforeEach(async () => { await seed(); });

describe("수정본", () => {
  it("TC-ED-01 작업본 열기: 수정본이 없으면 지금 버전 파일(rev 0)에서 시작한다", async () => {
    const w = await getJson(`${D}/work`);
    expect([w.baseVersion, w.rev, w.fromRevision, w.entry]).toEqual(["v0.1", 0, false, "guide.html"]);
    expect(w.files.map((f: any) => f.path)).toEqual(["guide.html", "img/a.png"]);
    expect(pathOf(w.files[0].url)).toMatch(/\/process\/guide\/v0\.1\/guide\.html$/);
  });

  it("TC-ED-02 저장하면 수정본이 쌓이고(rev 1), 바꾸지 않은 파일은 같은 blob, 작업본 주소(/r1/)에서 HTML 상대 경로가 풀린다", async () => {
    const before = await getJson(`${D}/work`);
    const r = await (await save(0, [{ path: "guide.html", text: '<p>수정본 1</p><img src="img/a.png">' }], { summary: "문단 고침" })).json<any>();
    expect(r).toMatchObject({ rev: 1, baseVersion: "v0.1", changed: true });
    const w = await getJson(`${D}/work`);
    expect([w.rev, w.fromRevision]).toEqual([1, true]);
    const img = w.files.find((f: any) => f.path === "img/a.png");
    expect(img.sha256).toBe(before.files.find((f: any) => f.path === "img/a.png").sha256);
    const html = w.files.find((f: any) => f.path === "guide.html");
    expect(pathOf(html.url)).toMatch(/\/process\/guide\/r1\/guide\.html$/);
    expect(await (await call(pathOf(html.url))).text()).toBe('<p>수정본 1</p><img src="img/a.png">');
    const dir = pathOf(html.url).replace(/guide\.html$/, "");
    expect((await call(dir + "img/a.png")).headers.get("content-type")).toBe("image/png");
    // 버전은 그대로다(수정본은 버전이 아니다)
    expect((await getJson(D)).currentVersion).toBe("v0.1");
  });

  it("TC-ED-03 기준 rev가 지금과 다르면 409, 바뀐 것이 없으면 수정본을 만들지 않는다, 잘못된 경로·없는 대표 파일은 400", async () => {
    await save(0, [{ path: "guide.html", text: "a" }]);
    expect((await save(0, [{ path: "guide.html", text: "b" }])).status).toBe(409);
    expect(await (await save(1, [{ path: "guide.html", text: "a" }])).json()).toMatchObject({ rev: 1, changed: false });
    expect((await save(1, [{ path: "../x.html", text: "x" }])).status).toBe(400);
    expect((await save(1, [], { remove: ["guide.html"] })).status).toBe(400);
  });

  it("TC-ED-04 이력: 최신 먼저, 작성자·출처(사람·에이전트)·메모, 작업본 rev", async () => {
    await save(0, [{ path: "guide.html", text: "사람" }], { summary: "사람이 고침" });
    await save(1, [{ path: "guide.html", text: "에이전트" }], { summary: "에이전트가 고침" }, { "x-workflow-agent": "claude-code" });
    const h = await getJson(`${D}/revisions`);
    expect(h.head).toBe(2);
    expect(h.revisions.map((r: any) => [r.rev, r.source, r.summary, r.author])).toEqual([
      [2, "agent", "에이전트가 고침", "owner@test.com"], [1, "human", "사람이 고침", "owner@test.com"]]);
    const r1 = await getJson(`${D}/revisions/1`);
    expect(await (await call(pathOf(r1.files.find((f: any) => f.path === "guide.html").url))).text()).toBe("사람");
  });

  it("TC-ED-05 되돌리기: 예전 수정본 내용으로 새 수정본을 만들고 과거는 그대로 둔다, rev 0은 기준 버전 파일", async () => {
    await save(0, [{ path: "guide.html", text: "하나" }]);
    await save(1, [{ path: "guide.html", text: "둘" }, { path: "new.css", text: "p{}" }]);
    const r = await (await json("POST", `${D}/revisions/1/restore`, { baseRev: 2 })).json<any>();
    expect(r.rev).toBe(3);
    const w = await getJson(`${D}/work`);
    expect(w.files.map((f: any) => f.path)).toEqual(["guide.html", "img/a.png"]);
    expect(await (await call(pathOf(w.files[0].url))).text()).toBe("하나");
    expect((await getJson(`${D}/revisions`)).revisions.map((x: any) => x.rev)).toEqual([3, 2, 1]);
    expect((await json("POST", `${D}/revisions/1/restore`, { baseRev: 2 })).status).toBe(409);
    // rev 0: 작업본이 기준으로 삼는 버전 파일로 되돌린다(편집 화면의 첫 되돌리기)
    const r0 = await (await json("POST", `${D}/revisions/0/restore`, { baseRev: 3 })).json<any>();
    expect(r0).toMatchObject({ rev: 4, changed: true });
    const w0 = await getJson(`${D}/work`);
    expect(await (await call(pathOf(w0.files[0].url))).text()).toBe((await (await call(pathOf((await getJson(D)).versions.find((v: any) => v.version === "v0.1").files.find((f: any) => f.path === "guide.html").url))).text()));
  });

  it("TC-ED-06 버전으로 올리기: 같은 blob을 가리키는 새 버전(R2 복사 없음), 이력에 올린 버전 표시. 다른 곳에서 새 버전이 생기면 작업본은 그 버전에서 다시 시작", async () => {
    await save(0, [{ path: "guide.html", text: "<p>버전으로</p>" }]);
    const count = async () => (await env.BLOBS.list({ prefix: `ws/${await wsId()}/blobs/` })).objects.length;
    const n0 = await count();
    const p = await (await json("POST", `${D}/publish`, { baseRev: 1, note: "편집 확정" })).json<any>();
    expect(p).toMatchObject({ version: "v0.2", rev: 1 });
    expect(await count()).toBe(n0);
    const d = await getJson(D);
    expect(d.currentVersion).toBe("v0.2");
    expect(d.versions.at(-1)).toMatchObject({ version: "v0.2", source: "revision", note: "편집 확정" });
    expect((await getJson(`${D}/revisions`)).revisions[0].publishedAs).toBe("v0.2");
    expect((await json("POST", `${D}/publish`, { baseRev: 1 })).status).toBe(409); // 같은 내용(직전 버전과 같음)
    // 업로드로 v0.3이 생기면 작업본은 v0.3 파일에서 다시(rev 번호는 이어짐)
    await upload("team", { menu: "process", doc: "guide" }, [["guide.html", "<p>업로드</p>"]]);
    const w = await getJson(`${D}/work`);
    expect([w.baseVersion, w.rev, w.fromRevision]).toEqual(["v0.3", 1, false]);
    expect((await (await save(1, [{ path: "guide.html", text: "v0.3 위 편집" }])).json<any>()).rev).toBe(2);
  });

  it("TC-ED-07 viewer는 저장·되돌리기·올리기를 못 하고(403) 읽기만, 저장하면 열린 화면에 revision 알림", async () => {
    await addMember("team", "v@test.com", "viewer");
    const owner = (await login("owner@test.com")).cookie;
    useSession((await login("v@test.com")).cookie);
    expect((await getJson(`${D}/work`)).rev).toBe(0);
    expect((await save(0, [{ path: "guide.html", text: "x" }])).status).toBe(403);
    expect((await json("POST", `${D}/publish`, { baseRev: 0 })).status).toBe(403);
    useSession(owner);
    const r = await save(0, [{ path: "guide.html", text: "x" }]);
    expect(r.status).toBe(200);
    const act = await getJson(`${W}/activity`);
    expect(act[0]).toMatchObject({ action: "revision", target: "process/guide" });
  });
});

describe("영구 삭제와 수정본", () => {
  it("TC-ED-10 수정본이 있는 문서도 영구 삭제되고, 그 문서만 쓰던 blob은 지우되 다른 문서 수정본이 쓰는 blob은 남긴다", async () => {
    const id = await wsId();
    await save(0, [{ path: "guide.html", text: "지울 문서만" }, { path: "shared.txt", text: "함께 씀" }]);
    await call(`${W}/docs/process/alpha/revisions`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseRev: 0, put: [{ path: "shared.txt", text: "함께 씀" }] }) });
    const own = (await getJson(`${D}/work`)).files.find((f: any) => f.path === "guide.html").sha256;
    const shared = (await getJson(`${D}/work`)).files.find((f: any) => f.path === "shared.txt").sha256;
    const { id: trashId } = await (await json("DELETE", D)).json<any>();
    expect((await json("DELETE", `${W}/trash/${trashId}`)).status).toBe(200);
    expect(await env.BLOBS.head(`ws/${id}/blobs/${own}`)).toBeNull();
    expect(await env.BLOBS.head(`ws/${id}/blobs/${shared}`)).not.toBeNull();
  });
});

describe("편집기 이미지 자산", () => {
  it("TC-ED-08 PNG를 올리면 asset:<sha>와 가로·세로, 같은 이미지는 한 번만, 서명 주소로 받는다. SVG·이미지가 아닌 것은 400", async () => {
    const up = async (data: Uint8Array | string, name: string, type: string) => {
      const form = new FormData();
      form.append("file", new File([data], name, { type }));
      return call(`${W}/assets`, { method: "POST", body: form });
    };
    const a = await (await up(PNG, "a.png", "image/png")).json<any>();
    expect(a).toMatchObject({ mime: "image/png", width: 1, height: 1 });
    expect(a.asset).toBe(`asset:${a.sha256}`);
    expect((await (await up(PNG, "b.png", "image/png")).json<any>()).sha256).toBe(a.sha256);
    expect((await up("<svg/>", "x.svg", "image/svg+xml")).status).toBe(400);
    expect((await up("not image", "x.png", "image/png")).status).toBe(400);
    const u = await getJson(`${W}/assets/${a.sha256}/url`);
    const img = await call(pathOf(u.url));
    expect([img.status, img.headers.get("content-type")]).toEqual([200, "image/png"]);
    expect((await call(`${W}/assets/${"0".repeat(64)}/url`)).status).toBe(404);
  });

  it("TC-ED-09 매일 정리: 30일 지난 수정본은 지우되 작업본·버전으로 올린 것은 남기고, 남은 수정본·자산이 쓰는 blob은 지우지 않는다", async () => {
    const { cleanup } = await import("../src/cleanup.ts");
    await save(0, [{ path: "guide.html", text: "rev1 old" }]);
    await json("POST", `${D}/publish`, { baseRev: 1 });                      // rev1 = v0.2로 올림
    await save(1, [{ path: "guide.html", text: "rev2 old" }]);                 // rev2: 지워질 것
    await save(2, [{ path: "guide.html", text: "rev3 head" }]);                // rev3: 작업본
    await env.DB.prepare("UPDATE document_revision SET created_at = '2020-01-01T00:00:00Z'").run();
    const form = new FormData();
    form.append("file", new File([PNG], "a.png", { type: "image/png" }));
    const asset = await (await call(`${W}/assets`, { method: "POST", body: form })).json<any>();
    const r = await cleanup(env, Date.now() + 2 * 86400_000);
    expect(r.revisions).toBe(1);
    expect((await getJson(`${D}/revisions`)).revisions.map((x: any) => x.rev)).toEqual([3, 1]);
    const w = await getJson(`${D}/work`);
    expect(await (await call(pathOf(w.files.find((f: any) => f.path === "guide.html").url))).text()).toBe("rev3 head");
    expect(await env.BLOBS.head(`ws/${await wsId()}/blobs/${asset.sha256}`)).not.toBeNull();
  });

  it("TC-CF-47 사용량(owner): 최근 기간 수정본(사람·에이전트·되돌림)·새 버전·저장 용량(중복 제외)·변환·렌더링 횟수, owner 아니면 403", async () => {
    const { noteUsage } = await import("../src/usage.ts");
    await save(0, [{ path: "guide.html", text: "사람" }]);
    await save(1, [{ path: "guide.html", text: "에이전트" }], {}, { "x-workflow-agent": "claude-code" });
    await json("POST", `${D}/revisions/1/restore`, { baseRev: 2 });
    await json("POST", `${D}/publish`, { baseRev: 3 });
    await noteUsage(env, await wsId(), "convert", "pptx");
    await noteUsage(env, await wsId(), "render", "notes/deck");
    await noteUsage(env, await wsId(), "render", "notes/deck#cover");
    const u = await getJson(`${W}/usage?days=30`);
    expect(u).toMatchObject({ days: 30, revisions: { total: 3, human: 1, agent: 1, restore: 1 }, conversions: 1, renders: 2 });
    expect(u.versions).toBeGreaterThanOrEqual(1);
    expect(u.storage.versionBytes).toBeGreaterThan(0);
    await addMember("team", "e@test.com", "editor");
    useSession((await login("e@test.com")).cookie);
    expect((await call(`${W}/usage`)).status).toBe(403);
  });

  it("TC-ED-47 매일 정리: 변환·렌더링 캐시(ws/<id>/cache/)는 30일이 지나면 지운다(필요하면 다시 만든다), 30일 안은 남긴다", async () => {
    const { cleanup } = await import("../src/cleanup.ts");
    const id = await wsId();
    await env.BLOBS.put(`ws/${id}/cache/deck-pdf/abc`, "pdf");
    await env.BLOBS.put(`ws/${id}/cache/pdf/def`, "pdf");
    expect((await cleanup(env, Date.now() + 2 * 86400_000)).caches).toBe(0);
    expect(await env.BLOBS.head(`ws/${id}/cache/deck-pdf/abc`)).not.toBeNull();
    expect((await cleanup(env, Date.now() + 31 * 86400_000)).caches).toBe(2);
    expect(await env.BLOBS.head(`ws/${id}/cache/pdf/def`)).toBeNull();
  });
});
