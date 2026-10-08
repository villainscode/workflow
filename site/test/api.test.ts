// 사이트 API(1.x·2.0) 통합 테스트. 임시 docs 폴더로 서버를 따로 띄우고, 응답과 함께 원본 파일(meta.yaml·버전 폴더)을 확인한다.
// 같은 파일 안의 테스트는 순서대로 돌고 앞 테스트가 만든 문서를 이어서 쓴다.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { zipSync, strToU8 } from "fflate";
import { parse } from "yaml";
import { addFixtureDoc, call, makeWorkspace, readText, startServer, upload, waitFor, type TestServer } from "./helpers.ts";

const ws = makeWorkspace();
addFixtureDoc(ws.docs, "process", "sheet", "sample.xlsx", "xlsx");
addFixtureDoc(ws.docs, "process", "word", "sample.docx", "docx");
let srv: TestServer;
let U = "";
before(async () => { srv = await startServer(ws); U = srv.url; });
after(async () => { await srv?.stop(); ws.cleanup(); });

const meta = (menu: string, doc: string) => parse(readText(join(ws.docs, menu, doc, "meta.yaml")));
const doc = async (menu: string, d: string) => (await call(U, "GET", `/api/docs/${menu}/${d}`)).body;
const hasSoffice = (() => { try { execFileSync("which", ["soffice"], { stdio: "ignore" }); return true; } catch { return false; } })();

describe("조회", () => {
  test("TC-API-01 트리: 대분류 순서 → 메뉴(하위 포함) → 문서", async () => {
    const { status, body } = await call(U, "GET", "/api/tree");
    assert.equal(status, 200);
    assert.deepEqual(body.categories.map((c: any) => c.key), ["sdlc", "agent"]);
    const process = body.categories[0].menus[0];
    assert.equal(process.slug, "process");
    assert.equal(process.menus[0].slug, "review", "하위 메뉴");
    assert.deepEqual(process.documents.map((d: any) => d.slug).sort(), ["guide", "sheet", "word"]);
    assert.deepEqual(body.warnings, []);
  });

  test("TC-API-02 문서 정보: 버전·파일·대표 파일·URL, 없는 문서는 404", async () => {
    const d = await doc("process", "guide");
    assert.equal(d.title, "샘플 프로세스 가이드");
    assert.equal(d.currentVersion, "v0.0");
    const files = d.versions[0].files;
    assert.equal(files.find((f: any) => f.isEntry).url, "/files/process/guide/v0.0/guide.html");
    assert.equal(files.length, 2);
    assert.match(files[0].sha256, /^[0-9a-f]{64}$/);
    assert.equal((await call(U, "GET", "/api/docs/process/nope")).status, 404);
  });

  test("TC-API-03 원본 파일 제공: 대표 파일과 상대 경로 리소스", async () => {
    const html = await fetch(`${U}/files/process/guide/v0.0/guide.html`);
    assert.equal(html.status, 200);
    assert.match(await html.text(), /샘플 프로세스 문서/);
    assert.equal(await (await fetch(`${U}/files/process/guide/v0.0/style.css`)).text(), "body{color:black}");
  });
});

describe("업로드", () => {
  test("TC-UP-01 새 문서: v0.0(draft)·kind·출처를 meta.yaml에 쓰고 목록에 보인다", async () => {
    const r = await upload(U, { menu: "notes", title: "새 HTML 문서", origin: "https://claude.ai/artifact/abc" }, [["New Doc.html", "<h1>안녕</h1>"]]);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { menu: "notes", doc: "new-doc", version: "v0.0", category: "sdlc", created: true });
    const m = meta("notes", "new-doc");
    assert.equal(m.kind, "html");
    assert.equal(m.status, "draft");
    assert.equal(m.current, "v0.0");
    assert.equal(m.origin_url, "https://claude.ai/artifact/abc");
    assert.equal(m.versions[0].source, "upload");
    assert.ok(existsSync(join(ws.docs, "notes/new-doc/v0.0/New Doc.html")));
    assert.equal((await doc("notes", "new-doc")).originUrl, "https://claude.ai/artifact/abc");
  });

  test("TC-UP-02 같은 slug가 있으면 -2를 붙이고, 직접 준 slug를 검사한다", async () => {
    const r = await upload(U, { menu: "notes", title: "같은 이름" }, [["new-doc.html", "<p>다른 내용</p>"]]);
    assert.equal(r.body.doc, "new-doc-2");
    const bad = await upload(U, { menu: "notes", title: "잘못된 slug", slug: "Bad Slug" }, [["a.html", "x"]]);
    assert.equal(bad.status, 400);
  });

  test("TC-UP-03 형식별 kind: md→markdown, png→image, pdf, xlsx, drawio, 그 밖은 code", async () => {
    const cases: [string, string][] = [["a.md", "markdown"], ["b.png", "image"], ["c.pdf", "pdf"], ["d.xlsx", "xlsx"], ["e.drawio", "drawio"], ["f.ts", "code"]];
    for (const [file, kind] of cases) {
      const r = await upload(U, { menu: "notes", title: `kind ${file}`, slug: `kind-${kind}` }, [[file, `내용 ${file}`]]);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(meta("notes", r.body.doc).kind, kind, file);
    }
  });

  test("TC-UP-04 폴더째 올리면 공통 최상위 폴더를 떼고, 대표 파일은 index.html → 첫 HTML 순서", async () => {
    const r = await upload(U, { menu: "notes", title: "폴더 문서", slug: "folder-doc" }, [
      ["site/img/a.png", "png"], ["site/about.html", "<p>소개</p>"], ["site/index.html", "<p>첫 화면</p>"],
    ]);
    assert.equal(r.status, 200);
    const m = meta("notes", "folder-doc");
    assert.equal(m.versions[0].entry, "index.html");
    assert.ok(existsSync(join(ws.docs, "notes/folder-doc/v0.0/img/a.png")), "최상위 site/를 뗌");
  });

  test("TC-UP-05 상위 경로(..)와 숨김 파일은 버린다", async () => {
    const r = await upload(U, { menu: "notes", title: "경로 검사", slug: "path-check" }, [
      ["../../escape.html", "<p>탈출</p>"], [".secret", "비밀"], ["ok/.hidden/x.txt", "숨김"], ["main.html", "<p>정상</p>"],
    ]);
    assert.equal(r.status, 200);
    const files = readdirSync(join(ws.docs, "notes/path-check/v0.0"), { recursive: true }).map(String);
    assert.deepEqual(files, ["main.html"]);
    assert.ok(!existsSync(join(ws.root, "escape.html")));
  });

  test("TC-UP-06 zip 하나는 풀어서 쓴다(__MACOSX 제외)", async () => {
    const zip = zipSync({ "pkg/index.html": strToU8("<p>zip</p>"), "pkg/data.json": strToU8("{}"), "__MACOSX/pkg/._index.html": strToU8("x") });
    const r = await upload(U, { menu: "notes", title: "압축 문서", slug: "zipped" }, [["pkg.zip", zip]]);
    assert.equal(r.status, 200);
    assert.deepEqual(readdirSync(join(ws.docs, "notes/zipped/v0.0")).sort(), ["data.json", "index.html"]);
    assert.equal(meta("notes", "zipped").versions[0].entry, "index.html");
  });

  test("TC-UP-07 새 버전: 다음 번호 자동(v0.1), 직접 지정, 메모·출처 갱신", async () => {
    const r = await upload(U, { menu: "notes", doc: "new-doc", note: "둘째" }, [["New Doc.html", "<h1>안녕 2</h1>"]]);
    assert.equal(r.body.version, "v0.1");
    assert.equal(r.body.created, false);
    const r2 = await upload(U, { menu: "notes", doc: "new-doc", version: "v0.5" }, [["New Doc.html", "<h1>안녕 3</h1>"]]);
    assert.equal(r2.body.version, "v0.5");
    const m = meta("notes", "new-doc");
    assert.equal(m.current, "v0.5");
    assert.deepEqual(m.versions.map((v: any) => v.version), ["v0.0", "v0.1", "v0.5"]);
    assert.equal(m.versions[1].note, "둘째");
    assert.ok(existsSync(join(ws.docs, "notes/new-doc/v0.0/New Doc.html")), "이전 버전 폴더는 그대로");
  });

  test("TC-UP-08 직전 버전과 같은 내용·이미 있는 버전·잘못된 번호는 거부", async () => {
    const same = await upload(U, { menu: "notes", doc: "new-doc" }, [["New Doc.html", "<h1>안녕 3</h1>"]]);
    assert.equal(same.status, 409);
    assert.match(same.body.error, /직전 버전\(v0\.5\)과 내용이 같아/);
    assert.equal((await upload(U, { menu: "notes", doc: "new-doc", version: "v0.1" }, [["x.html", "다름"]])).status, 409);
    assert.equal((await upload(U, { menu: "notes", doc: "new-doc", version: "1.0" }, [["x.html", "다름"]])).status, 400);
  });

  test("TC-UP-09 없는 메뉴·없는 문서·제목 없음·파일 없음·없는 대표 파일은 거부", async () => {
    assert.equal((await upload(U, { menu: "ghost", title: "x" }, [["a.html", "x"]])).status, 400);
    assert.equal((await upload(U, { menu: "notes", doc: "ghost" }, [["a.html", "x"]])).status, 404);
    assert.equal((await upload(U, { menu: "notes" }, [["a.html", "x"]])).status, 400);
    assert.equal((await upload(U, { menu: "notes", title: "숨김만" }, [[".x", "x"]])).status, 400);
    assert.equal((await upload(U, { menu: "notes", title: "대표", entry: "none.html" }, [["a.html", "x"]])).status, 400);
  });
});

describe("Markdown 편집", () => {
  test("TC-MD-01 저장하면 source: edit 새 버전이 생기고 대표 .md만 바뀐다", async () => {
    const r = await call(U, "POST", "/api/docs/notes/minutes/edit", { baseVersion: "v0.0", content: "# 회의록\n\n- 바뀜\n", note: "수정" });
    assert.equal(r.status, 200);
    assert.equal(r.body.version, "v0.1");
    assert.equal(readText(join(ws.docs, "notes/minutes/v0.1/minutes.md")), "# 회의록\n\n- 바뀜\n");
    assert.equal(readText(join(ws.docs, "notes/minutes/v0.0/minutes.md")), "# 회의록\n\n- 리뷰 담당 정하기\n");
    assert.equal(meta("notes", "minutes").versions[1].source, "edit");
  });

  test("TC-MD-02 기준 버전이 최신이 아니면 409, Markdown이 아니면 400", async () => {
    assert.equal((await call(U, "POST", "/api/docs/notes/minutes/edit", { baseVersion: "v0.0", content: "x" })).status, 409);
    assert.equal((await call(U, "POST", "/api/docs/process/guide/edit", { baseVersion: "v0.0", content: "x" })).status, 400);
    assert.equal((await call(U, "POST", "/api/docs/notes/ghost/edit", { baseVersion: "v0.0", content: "x" })).status, 404);
  });
});

describe("텍스트 편집 API(2.0)", () => {
  let segs: any[] = [];
  test("TC-TEAPI-01 조각 목록: HTML은 조각, Markdown은 400", async () => {
    const r = await call(U, "GET", "/api/docs/process/guide/segments");
    assert.equal(r.status, 200);
    assert.equal(r.body.format, "html");
    assert.equal(r.body.version, "v0.0");
    segs = r.body.segments;
    assert.ok(segs.some((s) => s.text === "D7"));
    assert.equal((await call(U, "GET", "/api/docs/notes/minutes/segments")).status, 400);
    const x = await call(U, "GET", "/api/docs/process/sheet/segments");
    assert.equal(x.body.format, "xlsx");
  });

  test("TC-TEAPI-02 편집 화면용 사본: data-seg·<base>가 들어간 HTML, 저장하지 않음", async () => {
    const res = await fetch(`${U}/api/docs/process/guide/edit-view`);
    assert.equal(res.headers.get("cache-control"), "no-store");
    const html = await res.text();
    assert.match(html, /<base href="\/files\/process\/guide\/v0\.0\/">/);
    assert.match(html, /<span data-seg="\d+">D7<\/span>/);
    assert.equal((await call(U, "GET", "/api/docs/process/word/edit-view")).status, 400, "HTML만");
  });

  test("TC-TEAPI-03 미리보기는 바뀐 파일을 돌려주고 새 버전을 만들지 않는다", async () => {
    const d7 = segs.find((s) => s.text === "D7");
    const res = await fetch(`${U}/api/docs/process/guide/text-preview`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseVersion: "v0.0", changes: [{ id: d7.id, hash: d7.hash, text: "D8" }] }),
    });
    assert.match(await res.text(), /<strong>D8<\/strong>/);
    assert.equal(meta("process", "guide").versions.length, 1);
  });

  test("TC-TEAPI-04 DOCX 미리보기를 PDF로 변환한다", { skip: !hasSoffice && "LibreOffice 없음", timeout: 180_000 }, async () => {
    const s = (await call(U, "GET", "/api/docs/process/word/segments")).body.segments[0];
    const res = await fetch(`${U}/api/docs/process/word/text-preview?to=pdf`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseVersion: "v0.0", changes: [{ id: s.id, hash: s.hash, text: "미리보기" }] }),
    });
    assert.equal(res.headers.get("content-type"), "application/pdf");
    assert.equal(Buffer.from(await res.arrayBuffer()).subarray(0, 4).toString(), "%PDF");
  });

  test("TC-TEAPI-05 저장: source: text-edit 새 버전, 다른 파일은 그대로 복사", async () => {
    const d7 = segs.find((s) => s.text === "D7");
    const r = await call(U, "POST", "/api/docs/process/guide/text-edit", { baseVersion: "v0.0", changes: [{ id: d7.id, hash: d7.hash, text: "D8" }], note: "리뷰일 변경" });
    assert.equal(r.status, 200);
    assert.equal(r.body.version, "v0.1");
    assert.equal(r.body.changed, 1);
    assert.match(readText(join(ws.docs, "process/guide/v0.1/guide.html")), /<strong>D8<\/strong>/);
    assert.equal(readText(join(ws.docs, "process/guide/v0.1/style.css")), "body{color:black}");
    assert.equal(meta("process", "guide").versions[1].source, "text-edit");
  });

  test("TC-TEAPI-06 이전 버전 기준·해시 불일치·바뀐 것 없음은 409, 줄바꿈 금지는 400", async () => {
    const d7 = segs.find((s) => s.text === "D7");
    assert.equal((await call(U, "POST", "/api/docs/process/guide/text-edit", { baseVersion: "v0.0", changes: [{ id: d7.id, hash: d7.hash, text: "D9" }] })).status, 409);
    const cur = (await call(U, "GET", "/api/docs/process/guide/segments")).body.segments;
    const d8 = cur.find((s: any) => s.text === "D8");
    assert.equal((await call(U, "POST", "/api/docs/process/guide/text-edit", { baseVersion: "v0.1", changes: [{ id: d8.id, hash: "bad", text: "D9" }] })).status, 409);
    assert.equal((await call(U, "POST", "/api/docs/process/guide/text-edit", { baseVersion: "v0.1", changes: [{ id: d8.id, hash: d8.hash, text: "D8" }] })).status, 409);
    assert.equal((await call(U, "POST", "/api/docs/process/guide/text-edit", { baseVersion: "v0.1", changes: [{ id: d8.id, hash: d8.hash, text: "줄\n바꿈" }] })).status, 400);
  });

  test("TC-TEAPI-07 이전 버전의 조각도 읽을 수 있다(?v=)", async () => {
    const old = await call(U, "GET", "/api/docs/process/guide/segments?v=v0.0");
    assert.equal(old.body.version, "v0.0");
    assert.ok(old.body.segments.some((s: any) => s.text === "D7"));
    assert.equal((await call(U, "GET", "/api/docs/process/guide/segments?v=v9.9")).status, 404);
  });

  test("TC-TEAPI-08 XLSX 셀 저장", async () => {
    const s = (await call(U, "GET", "/api/docs/process/sheet/segments")).body.segments[0];
    const r = await call(U, "POST", "/api/docs/process/sheet/text-edit", { baseVersion: "v0.0", changes: [{ id: s.id, hash: s.hash, text: "셀 수정" }] });
    assert.equal(r.status, 200);
    const after = (await call(U, "GET", "/api/docs/process/sheet/segments")).body.segments;
    assert.equal(after[s.id].text, "셀 수정");
  });
});

describe("정식 버전 확정", () => {
  test("TC-REL-01 draft → v1.0 approved: 현재 폴더를 복사하고 이전 폴더는 그대로", async () => {
    const r = await call(U, "POST", "/api/docs/process/guide/release", { note: "확정 메모" });
    assert.deepEqual(r.body, { menu: "process", doc: "guide", from: "v0.1", version: "v1.0" });
    const m = meta("process", "guide");
    assert.equal(m.status, "approved");
    assert.equal(m.current, "v1.0");
    assert.equal(m.versions.at(-1).source, "release");
    assert.equal(m.versions.at(-1).note, "확정 메모");
    assert.equal(readText(join(ws.docs, "process/guide/v1.0/guide.html")), readText(join(ws.docs, "process/guide/v0.1/guide.html")));
    assert.ok(existsSync(join(ws.docs, "process/guide/v0.0")));
  });

  test("TC-REL-02 이미 approved면 409", async () => {
    assert.equal((await call(U, "POST", "/api/docs/process/guide/release", {})).status, 409);
  });

  test("TC-REL-03 정식 문서에 새 버전(v1.1)이 생겨도 상태는 approved 그대로(D-15)", async () => {
    const r = await upload(U, { menu: "process", doc: "guide" }, [["guide.html", "<p>정식 이후 수정</p>"]]);
    assert.equal(r.body.version, "v1.1");
    assert.equal(meta("process", "guide").status, "approved");
  });

  test("TC-REL-04 review로 바꾼 뒤 확정하면 v2.0, 메모가 없으면 기본 메모", async () => {
    assert.equal((await call(U, "PATCH", "/api/docs/process/guide", { status: "review" })).status, 200);
    const r = await call(U, "POST", "/api/docs/process/guide/release");
    assert.equal(r.body.version, "v2.0");
    assert.equal(meta("process", "guide").versions.at(-1).note, "v1.1 버전을 정식 버전으로 확정");
  });
});

describe("관리: 메뉴·대분류·문서", () => {
  test("TC-MNG-01 메뉴 만들기: 최상위·하위, slug 검사, 중복 409", async () => {
    assert.deepEqual((await call(U, "POST", "/api/menus", { category: "agent", name: "에이전트 가이드", slug: "agent-guide" })).body, { category: "agent", slug: "agent-guide" });
    assert.deepEqual((await call(U, "POST", "/api/menus", { category: "sdlc", name: "하위", slug: "sub-menu", parent: "agent-guide" })).body, { category: "agent", slug: "sub-menu" }, "상위 메뉴의 대분류를 따름");
    assert.equal((await call(U, "POST", "/api/menus", { category: "agent", name: "중복", slug: "notes" })).status, 409);
    assert.equal((await call(U, "POST", "/api/menus", { category: "agent", name: "잘못", slug: "_x" })).status, 400);
    assert.equal((await call(U, "POST", "/api/menus", { category: "ghost", name: "없는 대분류", slug: "zz" })).status, 404);
    const tree = (await call(U, "GET", "/api/tree")).body;
    assert.equal(tree.categories[1].menus[0].menus[0].slug, "sub-menu");
  });

  test("TC-MNG-02 메뉴 이름 변경·순서 이동", async () => {
    await call(U, "PATCH", "/api/menus/notes", { name: "회의 기록" });
    await call(U, "POST", "/api/menus/notes/move", { category: "sdlc", index: 0 });
    const sdlc = (await call(U, "GET", "/api/tree")).body.categories[0];
    assert.equal(sdlc.menus[0].slug, "notes");
    assert.equal(sdlc.menus[0].name, "회의 기록");
    assert.equal((await call(U, "POST", "/api/menus/agent-guide/move", { category: "agent", parent: "sub-menu" })).status, 400, "자기 하위로는 못 옮김");
  });

  test("TC-MNG-03 메뉴를 다른 대분류로 옮기면 문서 meta.yaml의 category도 바뀌고 폴더는 그대로", async () => {
    await call(U, "POST", "/api/menus/notes/move", { category: "agent" });
    assert.equal(meta("notes", "minutes").category, "agent");
    assert.ok(existsSync(join(ws.docs, "notes/minutes")));
    await call(U, "POST", "/api/menus/notes/move", { category: "sdlc" });
    assert.equal(meta("notes", "minutes").category, "sdlc");
  });

  test("TC-MNG-04 메뉴 삭제: 문서·하위 메뉴가 있으면 409, 비어 있으면 삭제", async () => {
    assert.equal((await call(U, "DELETE", "/api/menus/notes")).status, 409);
    assert.equal((await call(U, "DELETE", "/api/menus/agent-guide")).status, 409);
    assert.equal((await call(U, "DELETE", "/api/menus/sub-menu")).status, 200);
    assert.equal((await call(U, "DELETE", "/api/menus/agent-guide")).status, 200);
    assert.doesNotMatch(readText(join(ws.docs, "_site/menus.yaml")), /agent-guide/);
  });

  test("TC-MNG-05 대분류: 추가·이름 변경·순서·삭제 규칙", async () => {
    assert.deepEqual((await call(U, "POST", "/api/categories", { name: "Image", key: "image" })).body, { key: "image" });
    assert.equal((await call(U, "POST", "/api/categories", { name: "중복", key: "image" })).status, 409);
    await call(U, "PATCH", "/api/categories/image", { name: "이미지", index: 0 });
    let cats = (await call(U, "GET", "/api/tree")).body.categories;
    assert.deepEqual(cats.map((c: any) => [c.key, c.name])[0], ["image", "이미지"]);
    assert.equal((await call(U, "DELETE", "/api/categories/sdlc")).status, 409, "메뉴가 있으면 못 지움");
    assert.equal((await call(U, "DELETE", "/api/categories/image")).status, 200);
    cats = (await call(U, "GET", "/api/tree")).body.categories;
    assert.deepEqual(cats.map((c: any) => c.key), ["sdlc", "agent"]);
    assert.match(readText(join(ws.docs, "_site/categories.yaml")), /^# 상단 메뉴 주석\n/);
  });

  test("TC-MNG-06 문서 제목·상태 변경, 잘못된 상태는 400", async () => {
    await call(U, "PATCH", "/api/docs/notes/minutes", { title: "주간 회의록(수정)", status: "review" });
    assert.equal(meta("notes", "minutes").title, "주간 회의록(수정)");
    assert.equal(meta("notes", "minutes").status, "review");
    assert.match(readText(join(ws.docs, "notes/minutes/meta.yaml")), /^# 문서 주석\n/, "주석 유지");
    assert.equal((await call(U, "PATCH", "/api/docs/notes/minutes", { status: "done" })).status, 400);
    assert.equal((await call(U, "PATCH", "/api/docs/notes/minutes", { title: " " })).status, 400);
  });

  test("TC-MNG-07 문서를 다른 메뉴로 옮기면 폴더가 옮겨지고, 같은 slug가 있으면 -2", async () => {
    await upload(U, { menu: "review", title: "충돌용", slug: "minutes" }, [["m.md", "# x"]]);
    const r = await call(U, "POST", "/api/docs/notes/minutes/move", { menu: "review" });
    assert.deepEqual(r.body, { menu: "review", doc: "minutes-2", category: "sdlc" });
    assert.ok(!existsSync(join(ws.docs, "notes/minutes")));
    assert.equal(meta("review", "minutes-2").menu, "review");
    await call(U, "POST", "/api/docs/review/minutes-2/move", { menu: "notes" });
  });
});

describe("휴지통", () => {
  let id = "";
  test("TC-TR-01 휴지통으로 옮기면 목록에서 사라지고 _trash에 남는다", async () => {
    id = (await call(U, "DELETE", "/api/docs/notes/zipped")).body.id;
    assert.match(id, /^\d{14}--notes--zipped$/);
    assert.ok(existsSync(join(ws.docs, "_trash", id, "meta.yaml")));
    assert.equal((await call(U, "GET", "/api/docs/notes/zipped")).status, 404);
    const list = (await call(U, "GET", "/api/trash")).body;
    assert.equal(list[0].title, "압축 문서");
  });

  test("TC-TR-02 원래 메뉴가 없으면 409, 메뉴를 고르면 그 메뉴로 복원", async () => {
    await call(U, "POST", "/api/menus", { category: "agent", name: "임시", slug: "tmp-menu" });
    const id2 = (await call(U, "DELETE", "/api/docs/notes/path-check")).body.id;
    // 원래 메뉴가 없어진 상황: 휴지통 항목 이름의 메뉴를 바꿔 흉내 낸다
    const moved = id2.replace("--notes--", "--gone-menu--");
    execFileSync("mv", [join(ws.docs, "_trash", id2), join(ws.docs, "_trash", moved)]);
    assert.equal((await call(U, "POST", `/api/trash/${moved}/restore`, {})).status, 409);
    const r = await call(U, "POST", `/api/trash/${moved}/restore`, { menu: "tmp-menu" });
    assert.deepEqual(r.body, { menu: "tmp-menu", doc: "path-check", category: "agent" });
    assert.equal(meta("tmp-menu", "path-check").category, "agent");
  });

  test("TC-TR-03 원래 메뉴로 복원, 영구 삭제", async () => {
    assert.deepEqual((await call(U, "POST", `/api/trash/${id}/restore`, {})).body, { menu: "notes", doc: "zipped", category: "sdlc" });
    const id3 = (await call(U, "DELETE", "/api/docs/notes/zipped")).body.id;
    assert.equal((await call(U, "DELETE", `/api/trash/${id3}`)).status, 200);
    assert.ok(!existsSync(join(ws.docs, "_trash")), "비면 _trash 폴더도 지움");
    assert.equal((await call(U, "DELETE", `/api/trash/${id3}`)).status, 404);
  });
});

describe("검색", () => {
  test("TC-SRCH-01 한국어 두 글자·조사 붙은 말도 본문에서 찾고, 스니펫·횟수를 준다", async () => {
    await upload(U, { menu: "notes", title: "배포 절차", slug: "deploy" }, [["d.html", "<p>정기 배포는 D14에 한다. 배포 전 QA를 마친다.</p>"]]);
    const r = (await call(U, "GET", `/api/search?q=${encodeURIComponent("배포")}`)).body;
    const g = r.find((x: any) => x.slug === "deploy");
    assert.ok(g, "본문에 '배포'가 있는 문서");
    assert.equal(g.matches, 2);
    assert.ok(g.inTitle);
    assert.match(g.snippet, /배포/);
    const r2 = (await call(U, "GET", `/api/search?q=${encodeURIComponent("리뷰는")}`)).body;
    assert.equal(r2.length, 0, "최신 버전 본문만 색인(정식 이후 내용엔 없음)");
  });

  test("TC-SRCH-02 제목에 맞은 문서가 먼저, 대분류·형식 필터, 빈 검색어는 []", async () => {
    const r = (await call(U, "GET", `/api/search?q=${encodeURIComponent("문서")}`)).body;
    assert.ok(r.length >= 2);
    const firstBody = r.findIndex((x: any) => !x.inTitle);
    assert.ok(firstBody === -1 || r.slice(firstBody).every((x: any) => !x.inTitle));
    const md = (await call(U, "GET", `/api/search?q=${encodeURIComponent("문서")}&kind=markdown`)).body;
    assert.ok(md.every((x: any) => x.kind === "markdown"));
    assert.deepEqual((await call(U, "GET", `/api/search?q=${encodeURIComponent("문서")}&category=agent`)).body.map((x: any) => x.category).filter((c: string) => c !== "agent"), []);
    assert.deepEqual((await call(U, "GET", "/api/search?q=")).body, []);
  });

  test("TC-SRCH-03 HTML의 script·style 글자는 검색되지 않고, 메뉴 이름으로도 찾는다", async () => {
    await upload(U, { menu: "notes", title: "스크립트 포함", slug: "with-script" }, [["s.html", "<style>.zzstyle{}</style><script>var zzscript=1</script><p>보이는 글자</p>"]]);
    assert.deepEqual((await call(U, "GET", "/api/search?q=zzscript")).body, []);
    assert.deepEqual((await call(U, "GET", "/api/search?q=zzstyle")).body, []);
    const byMenu = (await call(U, "GET", `/api/search?q=${encodeURIComponent("회의 기록")}`)).body;
    assert.ok(byMenu.some((x: any) => x.menuName === "회의 기록"));
  });
});

describe("실시간 반영", () => {
  test("TC-LIVE-01 변경하면 SSE로 changed 이벤트를 보낸다", async () => {
    const ctrl = new AbortController();
    const res = await fetch(`${U}/api/events`, { signal: ctrl.signal });
    const reader = res.body!.getReader();
    let buf = "";
    const got = (async () => {
      while (!buf.includes("data:")) { const { value, done } = await reader.read(); if (done) break; buf += new TextDecoder().decode(value); }
      return buf;
    })();
    await call(U, "POST", "/api/reindex");
    const text = await Promise.race([got, new Promise<string>((_, no) => setTimeout(() => no(new Error("SSE 시간 초과")), 5000))]);
    ctrl.abort();
    assert.match(text, /data: \{"type":"changed","reason":"manual"\}/);
  });

  test("TC-LIVE-02 사이트 밖에서 docs/를 고쳐도 감시가 다시 색인한다", async () => {
    const p = join(ws.docs, "notes/new-doc/meta.yaml");
    writeFileSync(p, readText(p).replace("title: 새 HTML 문서", "title: 밖에서 바꾼 제목"));
    await waitFor(async () => (await doc("notes", "new-doc")).title === "밖에서 바꾼 제목", 10_000, "감시 반영");
  });

  test("TC-LIVE-03 reindex는 경고 목록을 돌려준다", async () => {
    writeFileSync(join(ws.docs, "_site/menus.yaml"), readText(join(ws.docs, "_site/menus.yaml")).replace("menus:\n", "menus:\n  ghost:\n    - slug: lost\n      name: 고아\n"));
    const r = (await call(U, "POST", "/api/reindex")).body;
    assert.ok(r.warnings.some((w: string) => w.includes("'ghost'")));
    assert.ok((await call(U, "GET", "/api/tree")).body.warnings.length > 0);
  });
});

describe("변환", () => {
  test("TC-CONV-01 지원하지 않는 대상·없는 파일·docs 밖 경로는 거부", async () => {
    assert.equal((await call(U, "GET", "/api/convert/png/process/word/v0.0/sample.docx")).status, 400);
    assert.equal((await call(U, "GET", "/api/convert/pdf/process/word/v0.0/none.docx")).status, 404);
    assert.equal((await call(U, "GET", "/api/convert/pdf/..%2F..%2Fetc%2Fpasswd.docx")).status, 404);
    assert.equal((await call(U, "GET", "/api/convert/pdf/notes/minutes-2/v0.0/minutes.md")).status, 400);
  });

  test("TC-CONV-02 DOCX → PDF 변환, 같은 내용은 캐시", { skip: !hasSoffice && "LibreOffice 없음", timeout: 180_000 }, async () => {
    const res = await fetch(`${U}/api/convert/pdf/process/word/v0.0/sample.docx`);
    assert.equal(res.status, 200);
    assert.equal(Buffer.from(await res.arrayBuffer()).subarray(0, 4).toString(), "%PDF");
    assert.ok(readdirSync(join(ws.data, "cache")).some((f) => f.endsWith(".pdf")));
    const t = Date.now();
    await (await fetch(`${U}/api/convert/pdf/process/word/v0.0/sample.docx`)).arrayBuffer();
    assert.ok(Date.now() - t < 1000, "두 번째는 캐시");
  });
});

describe("파일 무결성", () => {
  test("TC-INT-01 업로드한 파일의 sha256이 색인과 같다", async () => {
    const d = await doc("process", "word");
    const f = d.versions[0].files[0];
    const { createHash } = await import("node:crypto");
    assert.equal(f.sha256, createHash("sha256").update(readFileSync(join(ws.root, f.path))).digest("hex"));
  });
});
