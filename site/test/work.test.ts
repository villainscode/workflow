// 로컬 사이트 편집(6.0 VL, D-58). 수정본 층·구조 편집·덱 편집·그림 자산·버전으로 저장을 Worker와 같은 API로 확인한다.
// 임시 docs 폴더로 서버를 따로 띄우고, 저장 뒤 docs/에 생긴 변화가 새 버전 폴더와 meta.yaml뿐인지 본다.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { parse } from "yaml";
import { call, makeWorkspace, readText, startServer, upload, type TestServer } from "./helpers.ts";
import { SVG_ASSET_CSP } from "@workflow/core/svg";

const ws = makeWorkspace();
let srv: TestServer;
let U = "";
before(async () => { srv = await startServer(ws); U = srv.url; });
after(async () => { await srv?.stop(); ws.cleanup(); });

const meta = (menu: string, doc: string) => parse(readText(join(ws.docs, menu, doc, "meta.yaml")));
/** docs/ 전체 파일과 내용 해시 */
function snapshot(): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string) => {
    for (const e of readdirSync(dir)) {
      const p = join(dir, e);
      if (statSync(p).isDirectory()) walk(p);
      else out.set(relative(ws.docs, p), createHash("sha256").update(readFileSync(p)).digest("hex"));
    }
  };
  walk(ws.docs);
  return out;
}
function diff(a: Map<string, string>, b: Map<string, string>) {
  const changed = [...b].filter(([p, h]) => a.get(p) !== h).map(([p]) => p);
  const removed = [...a.keys()].filter((p) => !b.has(p));
  return { changed: changed.sort(), removed };
}
const PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
async function putAsset() {
  const form = new FormData();
  form.append("file", new File([PNG], "dot.png", { type: "image/png" }));
  return (await fetch(U + "/api/assets", { method: "POST", body: form })).json() as Promise<{ asset: string; sha256: string; width: number }>;
}

describe("로컬 수정본(6.0 VL)", () => {
  test("TC-VE-10 HTML 구조 편집 → 수정본(docs/는 그대로) → 버전으로 저장하면 docs/ 변화는 새 버전 폴더와 meta.yaml뿐", async () => {
    const before = snapshot();
    const s = await call(U, "GET", "/api/docs/process/guide/work/structure");
    assert.equal(s.status, 200);
    assert.equal(s.body.rev, 0);
    const h1 = s.body.blocks.find((b: { tag: string }) => b.tag === "h1");
    const r1 = await call(U, "POST", "/api/docs/process/guide/revisions", { baseRev: 0, ops: [{ t: "setStyle", eid: h1.eid, set: { "font-size": "40px" } }] });
    assert.equal(r1.status, 200, JSON.stringify(r1.body));
    assert.deepEqual([r1.body.rev, r1.body.changed], [1, true]);
    // 수정본은 docs/ 밖(data/)에만 쌓인다
    assert.deepEqual(diff(before, snapshot()), { changed: [], removed: [] });
    // 기준 rev가 지난 저장은 409
    assert.equal((await call(U, "POST", "/api/docs/process/guide/revisions", { baseRev: 0, ops: [{ t: "remove", eid: h1.eid }] })).status, 409);
    // 작업본 파일과 편집 사본(상대 경로 CSS가 작업본 폴더에서 풀린다)
    const w = await call(U, "GET", "/api/docs/process/guide/work");
    assert.equal(w.body.fromRevision, true);
    const css = w.body.files.find((f: { path: string }) => f.path === "style.css");
    assert.equal((await fetch(U + css.url).then((r) => r.text())), "body{color:black}");
    const view = await fetch(U + "/api/docs/process/guide/work/edit-view").then((r) => r.text());
    assert.match(view, /<base href="\/api\/docs\/process\/guide\/work\/files\/r1\/">/);
    assert.match(view, /font-size:40px/);
    const p = await call(U, "POST", "/api/docs/process/guide/publish", { baseRev: 1, note: "제목 크게" });
    assert.equal(p.status, 200, JSON.stringify(p.body));
    assert.equal(p.body.version, "v0.1");
    const d = diff(before, snapshot());
    assert.deepEqual(d.removed, []);
    assert.deepEqual(d.changed, ["process/guide/meta.yaml", "process/guide/v0.1/guide.html", "process/guide/v0.1/style.css"]);
    const m = meta("process", "guide");
    assert.equal(m.current, "v0.1");
    assert.deepEqual([m.versions.at(-1).note, m.versions.at(-1).source], ["제목 크게", "revision"]);
    assert.match(readText(join(ws.docs, "process/guide/v0.1/guide.html")), /<h1 style="font-size:40px">샘플 프로세스 문서<\/h1>/);
    // 이력: 버전으로 올린 수정본 표시, 작업본은 새 버전을 기준으로 이어간다
    const list = await call(U, "GET", "/api/docs/process/guide/revisions");
    assert.equal(list.body.head, 1);
    assert.equal(list.body.revisions[0].publishedAs, "v0.1");
    assert.equal((await call(U, "POST", "/api/docs/process/guide/publish", { baseRev: 1 })).status, 409);
  });

  test("TC-VE-11 되돌리기와 수정본 파일: rev 0(기준 버전)·예전 수정본으로 새 수정본, 수정본 파일 목록", async () => {
    const s = await call(U, "GET", "/api/docs/process/guide/work/structure");
    const h1 = s.body.blocks.find((b: { tag: string }) => b.tag === "h1");
    const r2 = await call(U, "POST", "/api/docs/process/guide/revisions", { baseRev: 1, ops: [{ t: "setText", eid: h1.eid, html: "고친 제목" }] });
    assert.equal(r2.body.rev, 2);
    const back = await call(U, "POST", "/api/docs/process/guide/revisions/0/restore", { baseRev: 2 });
    assert.deepEqual([back.body.rev, back.body.changed], [3, true]);
    const files = await call(U, "GET", "/api/docs/process/guide/revisions/2");
    const entry = files.body.files.find((f: { path: string }) => f.path === "guide.html");
    assert.match(await fetch(U + entry.url).then((r) => r.text()), /고친 제목/);
    const list = await call(U, "GET", "/api/docs/process/guide/revisions");
    assert.deepEqual(list.body.revisions.map((r: { rev: number; source: string }) => [r.rev, r.source]), [[3, "restore"], [2, "human"], [1, "human"]]);
  });

  test("TC-VE-12 덱 편집: 슬라이드 연산·색인이 수정본, 그림 자산은 asset:<sha>, 버전으로 저장하면 가리킨 그림이 버전 폴더 assets/로 복사된다", async () => {
    const up = await upload(U, { menu: "notes", title: "로컬 덱", slug: "local-deck" }, [
      ["deck.json", JSON.stringify({ v: 1, title: "로컬 덱", order: ["cover"] })],
      ["slides/cover.html", '<section id="cover"><h1>표지</h1></section>'],
    ]);
    assert.equal(up.status, 200, JSON.stringify(up.body));
    const a = await putAsset();
    assert.match(a.asset, /^asset:[0-9a-f]{64}$/);
    assert.equal(a.width, 1);
    const url = await call(U, "GET", `/api/assets/${a.sha256}/url`);
    assert.equal((await fetch(U + url.body.url)).headers.get("content-type"), "image/png");
    const d = await call(U, "GET", "/api/docs/notes/local-deck/deck");
    assert.equal(d.body.rev, 0);
    const p = await call(U, "POST", "/api/docs/notes/local-deck/deck/slides/cover", { baseRev: 0, ops: [
      { t: "insert", parent: "cover", index: 1, html: `<img src="${a.asset}" alt="점" style="position:absolute;left:10px;top:10px;width:100px;height:100px">` },
    ] });
    assert.equal(p.status, 200, JSON.stringify(p.body));
    assert.equal(p.body.rev, 1);
    assert.ok(Array.isArray(p.body.inverse));
    // 형식 밖 연산은 진단
    const bad = await call(U, "POST", "/api/docs/notes/local-deck/deck/slides/cover", { baseRev: 1, ops: [{ t: "setStyle", eid: "e1", set: { margin: "8px" } }] });
    assert.equal(bad.status, 400);
    assert.match(bad.body.error, /margin/);
    const pub = await call(U, "POST", "/api/docs/notes/local-deck/publish", { baseRev: 1 });
    assert.equal(pub.status, 200, JSON.stringify(pub.body));
    const dir = join(ws.docs, "notes/local-deck", pub.body.version);
    assert.ok(existsSync(join(dir, `assets/${a.sha256.slice(0, 16)}.png`)));
    assert.match(readText(join(dir, "slides/cover.html")), new RegExp(a.asset));
  });

  test("TC-VE-13 그림 자산은 PNG·JPEG·WebP·GIF·SVG만(SVG가 아닌 글은 400), 없는 자산은 404", async () => {
    const form = new FormData();
    form.append("file", new File(["<html/>"], "x.svg", { type: "image/svg+xml" }));
    assert.equal((await fetch(U + "/api/assets", { method: "POST", body: form })).status, 400);
    const f2 = new FormData();
    f2.append("file", new File(["x"], "x.txt", { type: "text/plain" }));
    assert.equal((await fetch(U + "/api/assets", { method: "POST", body: f2 })).status, 400);
    assert.equal((await call(U, "GET", `/api/assets/${"0".repeat(64)}/url`)).status, 404);
  });

  test("TC-VE-28 로컬 SVG 자산: 소독해 저장(지운 것 진단), 앱 출처 raw는 sandbox CSP, HTML에 파일 참조로 넣고 버전으로 저장하면 버전 폴더 assets/에 SVG가 생긴다", async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40"><circle cx="20" cy="20" r="10" fill="#c00" onload="x()"/><script>x()</script></svg>';
    const form = new FormData();
    form.append("file", new File([svg], "c.svg", { type: "image/svg+xml" }));
    const a = await (await fetch(U + "/api/assets", { method: "POST", body: form })).json() as { asset: string; sha256: string; width: number; height: number; removed: string[] };
    assert.deepEqual([a.width, a.height, a.removed.sort()], [80, 40, ["@onload", "script"]]);
    const u = await call(U, "GET", `/api/assets/${a.sha256}/url`);
    const raw = await fetch(U + u.body.url);
    assert.deepEqual([raw.headers.get("content-type"), raw.headers.get("content-security-policy")], ["image/svg+xml", SVG_ASSET_CSP]);
    assert.doesNotMatch(await raw.text(), /script|onload/);
    const s = await call(U, "GET", "/api/docs/process/guide/work/structure");
    const h1 = s.body.blocks.find((b: { tag: string }) => b.tag === "h1");
    const r = await call(U, "POST", "/api/docs/process/guide/revisions", { baseRev: s.body.rev, ops: [{ t: "insert", ref: h1.eid, where: "after", node: { kind: "image", src: a.asset, alt: "원" } }] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const p = await call(U, "POST", "/api/docs/process/guide/publish", { baseRev: r.body.rev });
    assert.equal(p.status, 200, JSON.stringify(p.body));
    const rel = `assets/${a.sha256.slice(0, 16)}.svg`;
    assert.match(readText(join(ws.docs, `process/guide/${p.body.version}/guide.html`)), new RegExp(`<img src="${rel}" alt="원">`));
    assert.doesNotMatch(readText(join(ws.docs, `process/guide/${p.body.version}/${rel}`)), /script/);
  });
});
