import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import worker from "../src/index.ts";
import { contentToken, verifyContentToken } from "../src/token.ts";
import { admin, call, importDoc, seed, sessionCookie, sha256 } from "./helpers.ts";

interface Tree { categories: { key: string; name: string; menus: { slug: string; documents: { slug: string; parent: string | null }[]; menus: { slug: string }[] }[] }[] }
interface Detail { id: number; parentSlug: string | null; currentVersion: string; versions: { version: string; note: string | null; files: { path: string; isEntry: boolean; url: string }[] }[] }

describe("가져오기 API(P2)", () => {
  it("TC-CF-01 ADMIN_TOKEN 없이는 401", async () => {
    const res = await call("/api/admin/workspaces", { method: "POST", body: "{}" });
    expect(res.status).toBe(401);
  });

  it("TC-CF-02 blob은 내용 sha256이 주소와 같아야 하고, 없는 blob을 알려 주며, blob 없이 문서를 넣으면 409", async () => {
    await admin("POST", "/workspaces", { slug: "team", name: "팀" });
    const data = new TextEncoder().encode("hello");
    const sha = await sha256(data);
    const bad = await call(`/api/admin/w/team/blobs/${"0".repeat(64)}`, { method: "PUT", headers: { authorization: "Bearer test-admin" }, body: data });
    expect(bad.status).toBe(400);
    const missing = await (await admin("POST", "/w/team/blobs/missing", { shas: [sha] })).json<{ missing: string[] }>();
    expect(missing.missing).toEqual([sha]);
    await admin("POST", "/w/team/site", { categories: [{ key: "sdlc", name: "SDLC", menus: [{ slug: "m", name: "M" }] }] });
    const res = await admin("POST", "/w/team/docs", { menu: "m", slug: "d", title: "D", kind: "html", current: "v0.0",
      versions: [{ version: "v0.0", entry: "a.html", files: [{ path: "a.html", size: 5, sha256: sha }] }] });
    expect(res.status).toBe(409);
  });
});

describe("읽기 API(P2)", () => {
  it("TC-CF-03 트리: 대분류 순서, 하위 메뉴, 문서 순서(order 먼저, 나머지 제목순)와 하위 문서 parent", async () => {
    await seed();
    const t = await (await call("/api/w/team/tree")).json<Tree>();
    expect(t.categories.map((c) => c.key)).toEqual(["sdlc", "agent"]);
    const process = t.categories[0].menus[0];
    expect(process.slug).toBe("process");
    expect(process.menus.map((m) => m.slug)).toEqual(["notes"]);
    expect(process.documents.map((d) => [d.slug, d.parent])).toEqual([["guide", null], ["alpha", null], ["child", "guide"]]);
  });

  it("TC-CF-04 문서 상세: 버전·파일·대표 파일·상위 문서, 없는 문서 404, 다른 워크스페이스에서는 안 보인다", async () => {
    await seed();
    await seed("other");
    const d = await (await call("/api/w/team/docs/process/guide")).json<Detail>();
    expect(d.currentVersion).toBe("v0.1");
    expect(d.versions.map((v) => [v.version, v.note])).toEqual([["v0.0", null], ["v0.1", "그림 추가"]]);
    expect(d.versions[1].files.map((f) => [f.path, f.isEntry])).toEqual([["guide.html", true], ["img/a.png", false]]);
    const child = await (await call("/api/w/team/docs/process/child")).json<Detail>();
    expect(child.parentSlug).toBe("guide");
    expect((await call("/api/w/team/docs/process/nope")).status).toBe(404);
    expect((await call("/api/w/ghost/tree")).status).toBe(404);
    // 같은 slug라도 워크스페이스가 다르면 다른 문서다
    const other = await (await call("/api/w/other/docs/process/guide")).json<Detail>();
    expect(other.id).not.toBe(d.id);
  });
});

describe("사용자 콘텐츠(P2, 5.5)", () => {
  it("TC-CF-05 서명된 파일 주소: 본문·형식·sandbox CSP, HTML 안 상대 경로(같은 문서·다른 메뉴 문서·하위 문서 폴더)가 같은 토큰으로 열린다", async () => {
    await seed();
    const d = await (await call("/api/w/team/docs/process/guide")).json<Detail>();
    const url = new URL(d.versions[1].files[0].url);
    expect(url.pathname).toMatch(/^\/c\/\d+\.\d+\.[\w-]+\/process\/guide\/v0\.1\/guide\.html$/);
    const html = await call(url.pathname);
    expect(html.status).toBe(200);
    expect(html.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(html.headers.get("content-security-policy")).toMatch(/^sandbox allow-scripts/);
    expect(await html.text()).toContain("둘째 판");

    const dir = url.pathname.slice(0, url.pathname.lastIndexOf("/") + 1);
    const img = await call(dir + "img/a.png");
    expect(img.headers.get("content-type")).toBe("image/png");
    expect(img.headers.get("content-security-policy")).toBeNull();
    // ../../../notes/memo/v0.0/memo.md (다른 메뉴 문서)
    const memo = await call(new URL("../../../notes/memo/v0.0/memo.md", "http://x" + dir).pathname);
    expect(await memo.text()).toBe("# 메모");
    // 하위 문서는 상위 문서 폴더 안: process/guide/child/v0.0/child.html. 상위를 빼거나 틀리면 404
    const token = url.pathname.split("/")[2];
    expect((await call(`/c/${token}/process/guide/child/v0.0/child.html`)).status).toBe(200);
    expect((await call(`/c/${token}/process/child/v0.0/child.html`)).status).toBe(404);
    // 같은 내용이면 304
    expect((await call(url.pathname, { headers: { "if-none-match": html.headers.get("etag")! } })).status).toBe(304);
  });

  it("TC-CF-06 토큰 위조·만료는 403, 다른 워크스페이스 토큰으로는 이 워크스페이스 파일을 못 읽는다", async () => {
    await seed();
    // 테스트끼리 저장소를 나누지 않으므로 비워서 만든다
    const other = await (await admin("POST", "/workspaces", { slug: "other", name: "다른 팀", reset: true })).json<{ id: number }>();
    const d = await (await call("/api/w/team/docs/process/guide")).json<Detail>();
    const path = new URL(d.versions[0].files[0].url).pathname;
    const [, , token, ...rest] = path.split("/");
    const forged = token.replace(/.$/, (ch) => (ch === "A" ? "B" : "A"));
    expect((await call(`/c/${forged}/${rest.join("/")}`)).status).toBe(403);
    const otherToken = await contentToken(env.SIGNING_KEY, other.id);
    expect((await call(`/c/${otherToken}/${rest.join("/")}`)).status).toBe(404);
    const old = await contentToken(env.SIGNING_KEY, 1, Date.now() / 1000 - 3 * 86400);
    expect(await verifyContentToken(env.SIGNING_KEY, old)).toBeNull();
    expect(await verifyContentToken(env.SIGNING_KEY, await contentToken(env.SIGNING_KEY, 7))).toBe(7);
  });

  it("TC-CF-07 FILES_ORIGIN을 두면 콘텐츠 도메인은 /c/만, 앱 도메인은 /c/를 주지 않는다. 파일 주소는 콘텐츠 도메인", async () => {
    await seed();
    const split = { ...env, FILES_ORIGIN: "https://files.test" };
    const ctx = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
    const get = (url: string) => worker.fetch(new Request(url, { headers: { cookie: sessionCookie() } }), split, ctx);
    const d = await (await get("http://app.test/api/w/team/docs/process/guide")).json<Detail>();
    const fileUrl = d.versions[1].files[0].url;
    expect(fileUrl.startsWith("https://files.test/c/")).toBe(true);
    expect((await get(fileUrl)).status).toBe(200);
    expect((await get(fileUrl.replace("https://files.test", "http://app.test"))).status).toBe(404);
    expect((await get("https://files.test/api/w/team/tree")).status).toBe(404);
    // 앱 화면이 fetch로 읽을 수 있게 앱 출처(APP_ORIGIN)에만 CORS를 연다
    const withOrigin = (o: string) => worker.fetch(new Request(fileUrl, { headers: { origin: o } }), split, ctx);
    expect((await withOrigin(env.APP_ORIGIN)).headers.get("access-control-allow-origin")).toBe(env.APP_ORIGIN);
    expect((await withOrigin("https://evil.example")).headers.get("access-control-allow-origin")).toBeNull();
  });

  it("TC-CF-08 같은 내용 파일은 R2에 한 번만(내용 주소 저장)", async () => {
    await seed();
    const ws = await env.DB.prepare("SELECT id FROM workspace WHERE slug = 'team'").first<{ id: number }>();
    await importDoc("team", { menu: "notes", slug: "dup", title: "중복", versions: [
      { version: "v0.0", entry: "memo.md", files: [{ path: "memo.md", body: "# 메모" }] }] });
    const sha = await sha256(new TextEncoder().encode("# 메모"));
    const listed = await env.BLOBS.list({ prefix: `ws/${ws!.id}/blobs/` });
    expect(listed.objects.filter((o) => o.key.endsWith(sha)).length).toBe(1);
    const refs = await env.DB.prepare("SELECT COUNT(*) AS n FROM version_file WHERE sha256 = ?").bind(sha).first<{ n: number }>();
    expect(refs!.n).toBeGreaterThanOrEqual(2);
  });
});
