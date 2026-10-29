import { describe, expect, it, beforeEach } from "vitest";
import { env } from "cloudflare:workers";
import { strToU8, zipSync } from "fflate";
import { addMember, call, getJson, json, login, seed, upload, useSession } from "./helpers.ts";

/** 로컬 site/test/api.test.ts의 케이스를 D1·R2 위에서 다시 확인한다(괄호 안이 원래 케이스 ID) */

const W = "/api/w/team";
const doc = (menu: string, d: string) => getJson(`${W}/docs/${menu}/${d}`);
const fileText = async (url: string) => (await call(new URL(url).pathname)).text();
const treeDocs = async (menu: string) => {
  const t = await getJson(`${W}/tree`);
  const all = t.categories.flatMap((c: any) => { const w = (ms: any[]): any[] => ms.flatMap((m) => [m, ...w(m.menus)]); return w(c.menus); });
  return all.find((m: any) => m.slug === menu)?.documents ?? [];
};

beforeEach(async () => { await seed(); });

describe("업로드", () => {
  it("TC-CF-10 (TC-UP-01·03) 새 문서: v0.0·kind·출처·작성 시각(서울 yyyy-MM-dd HH:mm:ss)", async () => {
    const res = await upload("team", { menu: "notes", title: "새 메모", origin: "https://claude.ai/artifact/x" }, [["new-memo.md", "# 새 메모"]]);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ menu: "notes", doc: "new-memo", version: "v0.0", category: "sdlc", created: true });
    const d = await doc("notes", "new-memo");
    expect([d.kind, d.status, d.currentVersion, d.originUrl]).toEqual(["markdown", "draft", "v0.0", "https://claude.ai/artifact/x"]);
    expect(d.versions[0].createdAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    for (const [name, kind] of [["a.png", "image"], ["b.pdf", "pdf"], ["c.xlsx", "xlsx"], ["d.drawio", "drawio"], ["e.ts", "code"]]) {
      await upload("team", { menu: "notes", title: name }, [[name, "x"]]);
      expect((await doc("notes", name.split(".")[0])).kind).toBe(kind);
    }
  });

  it("TC-CF-11 (TC-UP-02) 같은 slug면 -2, 직접 준 slug 검사", async () => {
    expect((await (await upload("team", { menu: "process", title: "가이드2", slug: "guide" }, [["a.html", "<p>a</p>"]])).json<any>()).doc).toBe("guide-2");
    expect((await upload("team", { menu: "process", title: "x", slug: "Bad Slug" }, [["a.html", "a"]])).status).toBe(400);
  });

  it("TC-CF-12 (TC-UP-04·05·06) 폴더 최상위 떼기, 대표 파일 고르기, .. ·숨김 파일 버리기, zip 풀기", async () => {
    await upload("team", { menu: "notes", title: "폴더" }, [["site/b.html", "b"], ["site/index.html", "i"], ["site/img/x.png", "p"], ["site/.DS_Store", "z"], ["../evil.html", "e"]]);
    const d = await doc("notes", "index");
    expect(d.versions[0].files.map((f: any) => [f.path, f.isEntry])).toEqual([["b.html", false], ["index.html", true], ["img/x.png", false]]);
    const zip = zipSync({ "pack/main.html": strToU8("<p>zip</p>"), "pack/s.css": strToU8("p{}"), "__MACOSX/pack/._main.html": strToU8("x") });
    await upload("team", { menu: "notes", title: "압축" }, [["pack.zip", zip]]);
    expect((await doc("notes", "main")).versions[0].files.map((f: any) => f.path)).toEqual(["main.html", "s.css"]);
  });

  it("TC-CF-13 (TC-UP-07·08·09) 새 버전 자동·지정, 같은 내용·있는 버전·잘못된 번호·없는 메뉴·문서·제목·파일·대표 파일 거부", async () => {
    const r = await (await upload("team", { menu: "notes", doc: "memo", note: "둘째" }, [["memo.md", "# 메모 2"]])).json<any>();
    expect(r.version).toBe("v0.1");
    expect((await upload("team", { menu: "notes", doc: "memo", version: "v0.5" }, [["memo.md", "# 메모 3"]])).status).toBe(200);
    expect((await doc("notes", "memo")).currentVersion).toBe("v0.5");
    expect((await upload("team", { menu: "notes", doc: "memo" }, [["memo.md", "# 메모 3"]])).status).toBe(409);
    expect((await upload("team", { menu: "notes", doc: "memo", version: "v0.5" }, [["memo.md", "# 4"]])).status).toBe(409);
    expect((await upload("team", { menu: "notes", doc: "memo", version: "1.0" }, [["memo.md", "# 4"]])).status).toBe(400);
    expect((await upload("team", { menu: "ghost", title: "x" }, [["a.md", "a"]])).status).toBe(400);
    expect((await upload("team", { menu: "notes", doc: "ghost" }, [["a.md", "a"]])).status).toBe(404);
    expect((await upload("team", { menu: "notes" }, [["a.md", "a"]])).status).toBe(400);
    expect((await upload("team", { menu: "notes", title: "x" }, [])).status).toBe(400);
    expect((await upload("team", { menu: "notes", title: "x", entry: "none.md" }, [["a.md", "a"]])).status).toBe(400);
  });

  it("TC-CF-14 (TC-INT-01) 올린 파일의 sha256과 R2 본문이 같다", async () => {
    await upload("team", { menu: "notes", title: "무결성" }, [["int.html", "<p>무결성</p>"]]);
    const f = (await doc("notes", "int")).versions[0].files[0];
    const body = new Uint8Array(await (await call(new URL(f.url).pathname)).arrayBuffer());
    const hex = [...new Uint8Array(await crypto.subtle.digest("SHA-256", body))].map((b) => b.toString(16).padStart(2, "0")).join("");
    expect(hex).toBe(f.sha256);
  });
});

describe("Markdown 편집·확정", () => {
  it("TC-CF-15 (TC-MD-01·02) 저장하면 source: edit 새 버전, 대표 .md만 바뀐다. 기준이 최신이 아니면 409, Markdown 아니면 400", async () => {
    await upload("team", { menu: "notes", doc: "memo" }, [["memo.md", "# 메모"], ["img.png", "png"]]);
    const before = await doc("notes", "memo");
    const r = await (await json("POST", `${W}/docs/notes/memo/edit`, { baseVersion: before.currentVersion, content: "# 고친 메모", note: "편집" })).json<any>();
    const d = await doc("notes", "memo");
    const v = d.versions.find((x: any) => x.version === r.version);
    expect(v.source).toBe("edit");
    expect(await fileText(v.files.find((f: any) => f.path === "memo.md").url)).toBe("# 고친 메모");
    expect(v.files.find((f: any) => f.path === "img.png").sha256).toBe(before.versions.at(-1).files.find((f: any) => f.path === "img.png").sha256);
    expect((await json("POST", `${W}/docs/notes/memo/edit`, { baseVersion: "v0.0", content: "x" })).status).toBe(409);
    expect((await json("POST", `${W}/docs/process/guide/edit`, { baseVersion: "v0.1", content: "x" })).status).toBe(400);
  });

  it("TC-CF-16 (TC-REL-01~04) draft → v1.0 approved(같은 blob), 이미 approved면 409, v1.1에도 approved, review → v2.0", async () => {
    const r = await (await json("POST", `${W}/docs/process/guide/release`)).json<any>();
    expect(r).toEqual({ menu: "process", doc: "guide", from: "v0.1", version: "v1.0" });
    const d = await doc("process", "guide");
    expect([d.status, d.currentVersion]).toEqual(["approved", "v1.0"]);
    const [v01, v10] = [d.versions.find((v: any) => v.version === "v0.1"), d.versions.find((v: any) => v.version === "v1.0")];
    expect(v10.files.map((f: any) => f.sha256)).toEqual(v01.files.map((f: any) => f.sha256));
    expect(v10.note).toBe("v0.1 버전을 정식 버전으로 확정");
    expect((await json("POST", `${W}/docs/process/guide/release`)).status).toBe(409);
    await upload("team", { menu: "process", doc: "guide" }, [["guide.html", "<p>셋째</p>"]]);
    expect([(await doc("process", "guide")).currentVersion, (await doc("process", "guide")).status]).toEqual(["v1.1", "approved"]);
    await json("PATCH", `${W}/docs/process/guide`, { status: "review" });
    expect((await (await json("POST", `${W}/docs/process/guide/release`, { note: "확정" })).json<any>()).version).toBe("v2.0");
  });
});

/** 최소 DOCX(본문 문단 두 개) */
const docx = () => zipSync({
  "[Content_Types].xml": strToU8('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'),
  "word/document.xml": strToU8('<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>첫 문단</w:t></w:r></w:p><w:p><w:r><w:t>둘째 문단</w:t></w:r></w:p></w:body></w:document>'),
});

describe("텍스트 편집 API(2.0)", () => {
  it("TC-CF-17 (TC-TEAPI-01·02·03·07) 조각 목록, Markdown은 400, 편집 사본(data-seg·콘텐츠 <base>), 미리보기는 새 버전을 만들지 않는다, ?v=", async () => {
    const s = await getJson(`${W}/docs/process/guide/segments`);
    expect(s.format).toBe("html");
    expect(s.segments.map((x: any) => x.text)).toContain("둘째 판");
    expect((await call(`${W}/docs/notes/memo/segments`)).status).toBe(400);
    const old = await getJson(`${W}/docs/process/guide/segments?v=v0.0`);
    expect(old.segments[0].text).toBe("첫 판");
    const view = await call(`${W}/docs/process/guide/edit-view`);
    const html = await view.text();
    expect(view.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(html).toContain("data-seg");
    expect(html).toMatch(/<base href="http:\/\/app\.test\/c\/[\w.-]+\/process\/guide\/v0\.1\/">/);
    const seg = s.segments.find((x: any) => x.text === "둘째 판");
    const prev = await call(`${W}/docs/process/guide/text-preview`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseVersion: "v0.1", changes: [{ id: seg.id, hash: seg.hash, text: "미리" }] }) });
    expect(await prev.text()).toContain("미리");
    expect((await doc("process", "guide")).versions.length).toBe(2);
    // HTML은 PDF로 바꾸지 않는다(변환은 Office 형식만, P7)
    expect((await json("POST", `${W}/docs/process/guide/text-preview?to=pdf`, { baseVersion: "v0.1", changes: [] })).status).toBe(400);
  });

  it("TC-CF-18 (TC-TEAPI-05·06) 저장: source: text-edit, 다른 파일은 같은 blob. 이전 기준·해시 불일치·바뀐 것 없음 409, 줄바꿈 400", async () => {
    const s = await getJson(`${W}/docs/process/guide/segments`);
    const seg = s.segments.find((x: any) => x.text === "둘째 판");
    const save = (changes: unknown, baseVersion = "v0.1") => json("POST", `${W}/docs/process/guide/text-edit`, { baseVersion, changes, note: "글자" });
    expect((await save([{ id: seg.id, hash: "bad", text: "x" }])).status).toBe(409);
    expect((await save([{ id: seg.id, hash: seg.hash, text: seg.text }])).status).toBe(409);
    expect((await save([{ id: seg.id, hash: seg.hash, text: "a\nb" }])).status).toBe(400);
    const r = await (await save([{ id: seg.id, hash: seg.hash, text: "고친 판" }])).json<any>();
    expect([r.version, r.changed]).toEqual(["v0.2", 1]);
    const d = await doc("process", "guide");
    const v = d.versions.at(-1);
    expect(v.source).toBe("text-edit");
    expect(await fileText(v.files[0].url)).toContain("고친 판");
    expect(v.files[1].sha256).toBe(d.versions[1].files[1].sha256);
    expect((await save([{ id: seg.id, hash: seg.hash, text: "x" }])).status).toBe(409);
  });

  it("TC-CF-19 (TC-TEAPI-08 상당) DOCX 문단 저장", async () => {
    await upload("team", { menu: "notes", title: "워드" }, [["word.docx", docx()]]);
    const s = await getJson(`${W}/docs/notes/word/segments`);
    expect(s.segments.map((x: any) => x.text)).toEqual(["첫 문단", "둘째 문단"]);
    const r = await json("POST", `${W}/docs/notes/word/text-edit`, { baseVersion: "v0.0", changes: [{ id: s.segments[1].id, hash: s.segments[1].hash, text: "바뀐 문단" }] });
    expect(r.status).toBe(200);
    expect((await getJson(`${W}/docs/notes/word/segments`)).segments[1].text).toBe("바뀐 문단");
  });
});

describe("변환(P7)", () => {
  it("TC-CF-44 PDF 변환: 결과는 원본 sha256으로 R2에 캐시되어 다시 변환하지 않고, 다른 워크스페이스 파일·Office가 아닌 형식·svg 대상은 거부", async () => {
    await upload("team", { menu: "notes", title: "변환 워드" }, [["conv.docx", docx()]]);
    const f = (await doc("notes", "conv")).versions[0].files[0];
    const wsId = (await env.DB.prepare("SELECT id FROM workspace WHERE slug = 'team'").first<{ id: number }>())!.id;
    await env.BLOBS.put(`ws/${wsId}/cache/pdf/${f.sha256}`, "%PDF-캐시");
    const hit = await call(`${W}/convert/pdf/${f.sha256}`);
    expect([hit.status, hit.headers.get("content-type"), await hit.text()]).toEqual([200, "application/pdf", "%PDF-캐시"]);
    expect((await call(`${W}/convert/pdf/${"0".repeat(64)}`)).status).toBe(404);
    expect((await call(`${W}/convert/svg/${f.sha256}`)).status).toBe(400);
    const html = (await doc("process", "guide")).versions[0].files[0];
    expect((await call(`${W}/convert/pdf/${html.sha256}`)).status).toBe(400);
  });
});

describe("내보내기(P8)", () => {
  it("TC-CF-45 워크스페이스 내보내기(owner): docs/ 모양 zip — categories·menus yaml, 하위 문서는 상위 폴더 안, 버전 파일 내용, 휴지통 문서는 빠짐. editor는 403", async () => {
    await json("DELETE", `${W}/docs/process/alpha`);
    const res = await call(`${W}/export`);
    expect(res.headers.get("content-type")).toBe("application/zip");
    const { unzipSync, strFromU8 } = await import("fflate");
    const files = unzipSync(new Uint8Array(await res.arrayBuffer()));
    const names = Object.keys(files).sort();
    expect(names).toContain("docs/_site/categories.yaml");
    expect(strFromU8(files["docs/_site/menus.yaml"])).toMatch(/sdlc:\n\s+- slug: process\n\s+name: 프로세스\n\s+menus:\n\s+- slug: notes/);
    expect(names).toContain("docs/process/guide/child/meta.yaml");
    expect(names.some((n) => n.startsWith("docs/process/alpha"))).toBe(false);
    const meta = strFromU8(files["docs/process/guide/meta.yaml"]);
    expect(meta).toMatch(/title: 가이드\ncategory: sdlc\nmenu: process\nkind: html\nstatus: draft\ncurrent: v0\.1\n/);
    expect(meta).toContain("order: 1");
    expect(strFromU8(files["docs/process/guide/v0.1/guide.html"])).toContain("둘째 판");
    expect([...files["docs/process/guide/v0.1/img/a.png"]]).toEqual([137, 80, 78, 71]);
    await addMember("team", "ed@test.com", "editor");
    useSession((await login("ed@test.com")).cookie);
    expect((await call(`${W}/export`)).status).toBe(403);
  });
});

describe("관리: 메뉴·대분류·문서", () => {
  it("TC-CF-20 (TC-MNG-01·02, TC-TREE-01) 메뉴 만들기(최상위·하위·자동 slug·중복), 이름 변경, 순서 이동", async () => {
    expect(await (await json("POST", `${W}/menus`, { category: "agent", name: "Build Deploy" })).json()).toEqual({ category: "agent", slug: "build-deploy" });
    const ko = await (await json("POST", `${W}/menus`, { category: "agent", name: "빌드" })).json<any>();
    expect(ko.slug).toMatch(/^folder-[a-z0-9]{1,6}$/);
    expect((await (await json("POST", `${W}/menus`, { category: "agent", name: "Build Deploy" })).json<any>()).slug).toBe("build-deploy-2");
    expect((await json("POST", `${W}/menus`, { category: "agent", name: "x", slug: "build-deploy" })).status).toBe(409);
    expect((await json("POST", `${W}/menus`, { category: "agent", name: "x", slug: "Bad" })).status).toBe(400);
    expect(await (await json("POST", `${W}/menus`, { category: "sdlc", name: "Sub", parent: "notes" })).json()).toEqual({ category: "sdlc", slug: "sub" });
    await json("PATCH", `${W}/menus/build-deploy`, { name: "빌드·배포" });
    await json("POST", `${W}/menus/build-deploy-2/move`, { category: "agent", index: 0 });
    const agent = (await getJson(`${W}/tree`)).categories[1];
    expect(agent.menus.map((m: any) => [m.slug, m.name])).toEqual([["build-deploy-2", "Build Deploy"], ["build-deploy", "빌드·배포"], [ko.slug, "빌드"]]);
  });

  it("TC-CF-21 (TC-MNG-03) 메뉴를 다른 대분류로(하위 메뉴 함께), 자기 하위로는 400", async () => {
    expect((await json("POST", `${W}/menus/process/move`, { category: "sdlc", parent: "notes" })).status).toBe(400);
    await json("POST", `${W}/menus/process/move`, { category: "agent" });
    const t = await getJson(`${W}/tree`);
    expect(t.categories[0].menus).toEqual([]);
    expect(t.categories[1].menus[0].slug).toBe("process");
    expect(t.categories[1].menus[0].menus[0].slug).toBe("notes");
    expect((await getJson(`${W}/search?q=둘째`))[0].category).toBe("agent");
  });

  it("TC-CF-22 (TC-MNG-04) 폴더 삭제: 안의 문서(하위 문서·하위 메뉴 문서)를 휴지통으로, 메뉴는 빠진다. 같은 slug를 새로 쓸 수 있다", async () => {
    const r = await (await json("DELETE", `${W}/menus/process`)).json<any>();
    expect(r.trashed).toBe(3); // guide(+child), alpha, notes/memo
    expect((await getJson(`${W}/tree`)).categories[0].menus).toEqual([]);
    const trash = await getJson(`${W}/trash`);
    expect(trash.map((t: any) => t.doc).sort()).toEqual(["alpha", "guide", "memo"]);
    await json("POST", `${W}/menus`, { category: "sdlc", name: "다시", slug: "process" });
    expect((await upload("team", { menu: "process", title: "같은 slug", slug: "guide" }, [["g.html", "g"]])).status).toBe(200);
    expect((await json("POST", `${W}/trash/${trash.find((t: any) => t.doc === "memo").id}/restore`)).status).toBe(409);
    const ok = await (await json("POST", `${W}/trash/${trash.find((t: any) => t.doc === "guide").id}/restore`, { menu: "process" })).json<any>();
    expect(ok.doc).toBe("guide-2");
    // 복원한 문서는 지우기 전 순서(order 1)를 지녀 순서 없는 새 문서보다 앞
    expect((await treeDocs("process")).map((d: any) => [d.slug, d.parent])).toEqual([["guide-2", null], ["guide", null], ["child", "guide-2"]]);
  });

  it("TC-CF-23 (TC-MNG-05) 대분류: 추가·이름·순서·삭제 규칙", async () => {
    expect(await (await json("POST", `${W}/categories`, { name: "Ops" })).json()).toEqual({ key: "ops" });
    expect((await json("POST", `${W}/categories`, { name: "Ops" })).status).toBe(409);
    expect((await json("POST", `${W}/categories`, { name: "운영" })).status).toBe(400);
    await json("PATCH", `${W}/categories/ops`, { name: "운영", index: 0 });
    expect((await getJson(`${W}/tree`)).categories.map((c: any) => [c.key, c.name])).toEqual([["ops", "운영"], ["sdlc", "SDLC"], ["agent", "Agent"]]);
    expect((await json("DELETE", `${W}/categories/sdlc`)).status).toBe(409);
    expect((await json("DELETE", `${W}/categories/ops`)).status).toBe(200);
    await json("DELETE", `${W}/categories/agent`);
    expect((await json("DELETE", `${W}/categories/sdlc`)).status).toBe(409);
  });

  it("TC-CF-24 (TC-MNG-06·08) 제목·상태·출처, 잘못된 값은 400. 제목은 검색에도 반영", async () => {
    await json("PATCH", `${W}/docs/process/guide`, { title: "새 제목", status: "review", origin: "https://example.com/a" });
    const d = await doc("process", "guide");
    expect([d.title, d.status, d.originUrl]).toEqual(["새 제목", "review", "https://example.com/a"]);
    await json("PATCH", `${W}/docs/process/guide`, { origin: "" });
    expect((await doc("process", "guide")).originUrl).toBeNull();
    expect((await json("PATCH", `${W}/docs/process/guide`, { status: "done" })).status).toBe(400);
    expect((await json("PATCH", `${W}/docs/process/guide`, { origin: "ftp://x" })).status).toBe(400);
    expect((await json("PATCH", `${W}/docs/process/guide`, { title: " " })).status).toBe(400);
    expect((await getJson(`${W}/search?q=새 제목`))[0].slug).toBe("guide");
  });

  it("TC-CF-25 (TC-MNG-07, TC-TREE-03·05) 문서를 다른 메뉴로(하위째, slug 겹치면 -2), 다른 문서 아래로, 자기 하위로는 400, 하위 slug 겹치면 409", async () => {
    expect((await json("POST", `${W}/docs/process/guide/move`, { menu: "process", parent: "child" })).status).toBe(400);
    await upload("team", { menu: "notes", title: "가이드", slug: "guide" }, [["g.md", "g"]]);
    const r = await (await json("POST", `${W}/docs/process/guide/move`, { menu: "notes" })).json<any>();
    expect(r).toEqual({ menu: "notes", doc: "guide-2", category: "sdlc" });
    expect((await treeDocs("notes")).map((d: any) => [d.slug, d.parent]).sort()).toEqual([["child", "guide-2"], ["guide", null], ["guide-2", null], ["memo", null]]);
    // 하위 문서 child가 process에 이미 있으면 409
    await upload("team", { menu: "process", title: "child", slug: "child" }, [["c.md", "c"]]);
    expect((await json("POST", `${W}/docs/notes/guide-2/move`, { menu: "process" })).status).toBe(409);
    await json("POST", `${W}/docs/notes/memo/move`, { menu: "notes", parent: "guide" });
    expect((await treeDocs("notes")).find((d: any) => d.slug === "memo").parent).toBe("guide");
    await json("POST", `${W}/docs/notes/memo/move`, { menu: "notes", parent: null });
    expect((await treeDocs("notes")).find((d: any) => d.slug === "memo").parent).toBeNull();
  });

  it("TC-CF-26 (TC-TREE-04) 같은 자리 순서: index로 옮기면 순서가 다시 쓰이고 트리가 그 순서", async () => {
    await json("POST", `${W}/docs/process/alpha/move`, { menu: "process", index: 0 });
    expect((await treeDocs("process")).filter((d: any) => !d.parent).map((d: any) => d.slug)).toEqual(["alpha", "guide"]);
    await json("POST", `${W}/docs/process/alpha/move`, { menu: "process", index: 5 });
    expect((await treeDocs("process")).filter((d: any) => !d.parent).map((d: any) => d.slug)).toEqual(["guide", "alpha"]);
  });
});

describe("휴지통·검색·이미지", () => {
  it("TC-CF-27 (TC-TR-01·03) 휴지통: 목록에서 사라지고(하위째), 원래 메뉴로 복원, 영구 삭제하면 아무도 안 쓰는 blob도 지운다", async () => {
    const { id } = await (await json("DELETE", `${W}/docs/process/guide`)).json<any>();
    expect((await treeDocs("process")).map((d: any) => d.slug)).toEqual(["alpha"]);
    expect((await call(`${W}/docs/process/child`)).status).toBe(404);
    const t = await getJson(`${W}/trash`);
    expect(t[0]).toMatchObject({ id, menu: "process", doc: "guide", title: "가이드" });
    expect(t[0].deletedAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    expect(await (await json("POST", `${W}/trash/${id}/restore`)).json()).toEqual({ menu: "process", doc: "guide", category: "sdlc" });
    // 순서는 지우기 전 그대로(guide는 order 1, alpha는 order 없음)
    expect((await treeDocs("process")).map((d: any) => d.slug)).toEqual(["guide", "alpha", "child"]);
    // 영구 삭제: guide만 쓰던 png blob은 지워지고, 다른 워크스페이스 것은 그대로
    const png = (await doc("process", "guide")).versions[1].files[1].sha256;
    const wsId = (await env.DB.prepare("SELECT id FROM workspace WHERE slug = 'team'").first<{ id: number }>())!.id;
    const { id: id2 } = await (await json("DELETE", `${W}/docs/process/guide`)).json<any>();
    expect((await json("DELETE", `${W}/trash/${id2}`)).status).toBe(200);
    expect(await getJson(`${W}/trash`)).toEqual([]);
    expect(await env.BLOBS.head(`ws/${wsId}/blobs/${png}`)).toBeNull();
    expect((await json("DELETE", `${W}/trash/${id2}`)).status).toBe(404);
  });

  it("TC-CF-28 (TC-SRCH-01·02·03) 한국어 두 글자·조사, 스니펫·횟수, 제목 먼저, 필터, 빈 검색어, script 글자 제외, 메뉴 이름", async () => {
    await upload("team", { menu: "notes", title: "리뷰 안내" }, [["r.html", "<p>리뷰를 한다. 리뷰 두 번.</p><script>var 숨은글자=1</script>"]]);
    await upload("team", { menu: "notes", title: "다른 글" }, [["o.md", "코드 리뷰는 매일 한다"]]);
    const hits = await getJson(`${W}/search?q=리뷰`);
    expect(hits.map((h: any) => h.slug)).toEqual(["r", "o"]);
    expect(hits[0]).toMatchObject({ inTitle: true, matches: 2, menuSlug: "notes", category: "sdlc" });
    expect(hits[1].snippet).toContain("코드 리뷰는");
    expect(await getJson(`${W}/search?q=리뷰를`)).toHaveLength(1);
    expect(await getJson(`${W}/search?q=숨은글자`)).toEqual([]);
    expect(await getJson(`${W}/search?q=리뷰&kind=markdown`)).toHaveLength(1);
    expect(await getJson(`${W}/search?q=리뷰&category=agent`)).toEqual([]);
    expect(await getJson(`${W}/search?q=`)).toEqual([]);
    expect((await getJson(`${W}/search?q=메모`)).map((h: any) => h.slug)).toContain("memo");
  });

  it("TC-CF-29 편집기 이미지: 올리면 /i/ 주소, 그 주소로 받는다. 이미지가 아니면 400", async () => {
    const form = new FormData();
    form.append("file", new File([new Uint8Array([137, 80, 78, 71])], "a.png", { type: "image/png" }));
    const r = await (await call(`${W}/images`, { method: "POST", body: form })).json<any>();
    expect(r.success).toBe(true);
    expect(r.url).toMatch(/^http:\/\/app\.test\/i\/\d+\/\d{14}-[0-9a-f-]+\.png$/);
    const img = await call(new URL(r.url).pathname);
    expect([img.status, img.headers.get("content-type")]).toEqual([200, "image/png"]);
    const bad = new FormData();
    bad.append("file", new File(["x"], "a.txt", { type: "text/plain" }));
    expect((await call(`${W}/images`, { method: "POST", body: bad })).status).toBe(400);
  });
});
