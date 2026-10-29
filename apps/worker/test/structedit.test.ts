import { beforeEach, describe, expect, it } from "vitest";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { call, getJson, json, seed, upload } from "./helpers.ts";

/** 5.0 M3·M5: 구조 편집 연산을 수정본으로 저장(HTML 원본 패치, OOXML 직접 편집 D-47 C) */

const W = "/api/w/team";
const D = `${W}/docs/process/guide`;
const pathOf = (url: string) => new URL(url).pathname;
const ops = (doc: string, baseRev: number, list: unknown[], headers: Record<string, string> = {}) =>
  call(`${doc}/revisions`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ baseRev, ops: list }) });
const PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
const putAsset = async () => {
  const form = new FormData();
  form.append("file", new File([PNG], "a.png", { type: "image/png" }));
  return (await call(`${W}/assets`, { method: "POST", body: form })).json<any>();
};
const workText = async (doc: string, path: string) => {
  const w = await getJson(`${doc}/work`);
  return call(pathOf(w.files.find((f: any) => f.path === path).url));
};

/** 최소 PPTX: 슬라이드 하나에 2×2 표와 그림 하나 */
const R = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const cell = (t: string) => `<a:tc><a:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="ko-KR"/><a:t>${t}</a:t></a:r></a:p></a:txBody><a:tcPr/></a:tc>`;
const pptx = () => zipSync({
  "[Content_Types].xml": strToU8('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="png" ContentType="image/png"/></Types>'),
  "ppt/presentation.xml": strToU8(`<?xml version="1.0"?><p:presentation ${R}><p:sldIdLst><p:sldId id="256" r:id="rId2"/></p:sldIdLst></p:presentation>`),
  "ppt/_rels/presentation.xml.rels": strToU8('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId2" Type="slide" Target="slides/slide1.xml"/></Relationships>'),
  "ppt/slides/slide1.xml": strToU8(`<?xml version="1.0"?><p:sld ${R}><p:cSld><p:spTree>`
    + `<p:graphicFrame><p:xfrm><a:off x="0" y="0"/><a:ext cx="4000000" cy="740000"/></p:xfrm><a:graphic><a:graphicData><a:tbl><a:tblGrid><a:gridCol w="2000000"/><a:gridCol w="2000000"/></a:tblGrid>`
    + `<a:tr h="370000">${cell("머리1")}${cell("머리2")}</a:tr><a:tr h="370000">${cell("값1")}${cell("값2")}</a:tr></a:tbl></a:graphicData></a:graphic></p:graphicFrame>`
    + `<p:pic><p:blipFill><a:blip r:embed="rId3"/></p:blipFill><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="2000000" cy="1000000"/></a:xfrm></p:spPr></p:pic>`
    + `</p:spTree></p:cSld></p:sld>`),
  "ppt/slides/_rels/slide1.xml.rels": strToU8('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId3" Type="image" Target="../media/image1.png"/></Relationships>'),
  "ppt/media/image1.png": PNG.slice(),
});

beforeEach(async () => { await seed(); });

describe("구조 편집", () => {
  it("TC-ED-25 HTML 구조 목록·편집 사본(data-eid, 작업본 <base>, 스크립트 막는 CSP), 연산 저장은 수정본 하나·메모 자동", async () => {
    const s = await getJson(`${D}/work/structure`);
    expect([s.kind, s.rev, s.entry]).toEqual(["html", 0, "guide.html"]);
    const p = s.blocks.find((b: any) => b.tag === "p");
    expect(p).toBeTruthy();
    const view = await call(`${D}/work/edit-view`);
    expect(view.headers.get("content-security-policy")).toBe("sandbox allow-same-origin");
    const html = await view.text();
    expect(html).toContain(`data-eid="${p.eid}"`);
    expect(html).toMatch(/<base href="http:\/\/app\.test\/c\/[\w.-]+\/process\/guide\/v0\.1\/">/);

    const r = await (await ops(D, 0, [{ t: "setText", eid: p.eid, html: "구조 <b>편집</b><script>x</script>" }])).json<any>();
    expect(r).toMatchObject({ rev: 1, changed: true });
    expect(await (await workText(D, "guide.html")).text()).toContain("구조 <b>편집</b>");
    expect(await (await workText(D, "guide.html")).text()).not.toContain("<script>");
    const h = await getJson(`${D}/revisions`);
    expect([h.revisions[0].source, h.revisions[0].summary]).toEqual(["human", "글자 1"]);
    // 편집 사본은 이제 작업본(r1)을 기준으로 한다
    expect(await (await call(`${D}/work/edit-view`)).text()).toMatch(/\/process\/guide\/r1\/">/);
    // 2.0 편집 사본도 같은 CSP
    expect((await call(`${D}/edit-view`)).headers.get("content-security-policy")).toBe("sandbox allow-same-origin");
  });

  it("TC-ED-26 HTML 그림에 asset:<sha>를 주면 대표 파일 옆 assets/에 연결하고 상대 경로로 바꾼다. 없는 자산·기준 rev 다름·잘못된 연산은 거부", async () => {
    const a = await putAsset();
    const p = (await getJson(`${D}/work/structure`)).blocks.find((b: any) => b.tag === "p");
    const r = await (await ops(D, 0, [{ t: "insert", ref: p.eid, where: "after", node: { kind: "image", src: a.asset, alt: "점" } }], { "x-workflow-agent": "claude-code" })).json<any>();
    expect(r.rev).toBe(1);
    const rel = `assets/${a.sha256.slice(0, 16)}.png`;
    expect(await (await workText(D, "guide.html")).text()).toContain(`src="${rel}"`);
    const img = await workText(D, rel);
    expect([img.status, img.headers.get("content-type")]).toEqual([200, "image/png"]);
    expect((await getJson(`${D}/revisions`)).revisions[0].source).toBe("agent");

    expect((await ops(D, 1, [{ t: "insert", ref: p.eid, where: "after", node: { kind: "image", src: `asset:${"0".repeat(64)}` } }])).status).toBe(400);
    expect((await ops(D, 0, [{ t: "remove", eid: p.eid }])).status).toBe(409);
    expect((await ops(D, 1, [{ t: "remove", eid: "e999999" }])).status).toBe(409);
    expect((await ops(D, 1, [])).status).toBe(400);
    expect((await json("POST", `${D}/revisions`, { baseRev: 1, ops: [{ t: "remove", eid: p.eid }], put: [] })).status).toBe(400);
    // Markdown 문서는 구조 편집 대상이 아니다
    expect((await call(`${W}/docs/notes/memo/work/structure`)).status).toBe(400);
  });

  it("TC-ED-27 PPTX: 구조 목록, 표 행 넣기·그림 교체(asset)를 한 수정본으로, 버전으로 올리면 새 버전 파일에 반영", async () => {
    const up = await (await upload("team", { menu: "notes", title: "발표" }, [["deck.pptx", pptx()]])).json<any>();
    const P = `${W}/docs/notes/${up.doc}`;
    const s = await getJson(`${P}/work/structure`);
    expect(s.kind).toBe("pptx");
    expect(s.tables.map((t: any) => [t.where, t.rows, t.cols, t.header])).toEqual([["슬라이드 1", 2, 2, ["머리1", "머리2"]]]);
    expect(s.images.map((i: any) => i.media)).toEqual(["ppt/media/image1.png"]);

    const gif = await (async () => {
      const g = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 4, 0, 1, 0, 0x80, 0, 0, 0, 0, 0, 255, 255, 255, 0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 2, 0x44, 1, 0, 0x3b]);
      const form = new FormData();
      form.append("file", new File([g], "b.gif", { type: "image/gif" }));
      return (await call(`${W}/assets`, { method: "POST", body: form })).json<any>();
    })();
    const r = await (await ops(P, 0, [
      { t: "tableRow", table: s.tables[0].id, at: 2, op: "add" },
      { t: "replaceImage", image: s.images[0].id, asset: gif.asset },
    ])).json<any>();
    expect(r).toMatchObject({ rev: 1, changed: true });
    expect((await getJson(`${P}/revisions`)).revisions[0].summary).toBe("표 행 1, 그림 교체 1");
    const after = await getJson(`${P}/work/structure`);
    expect(after.tables[0].rows).toBe(3);
    expect(after.images[0].mime).toBe("image/gif");

    const pub = await (await json("POST", `${P}/publish`, { baseRev: 1, note: "표·그림" })).json<any>();
    const v = await getJson(P);
    expect(v.currentVersion).toBe(pub.version);
    const file = v.versions.find((x: any) => x.version === pub.version).files.find((f: any) => f.path === "deck.pptx");
    const z = unzipSync(new Uint8Array(await (await call(pathOf(file.url))).arrayBuffer()));
    expect((strFromU8(z["ppt/slides/slide1.xml"]).match(/<a:tr /g) ?? []).length).toBe(3);
    expect(strFromU8(z["ppt/slides/slide1.xml"])).toMatch(/<a:ext cx="4000000" cy="1110000"\/>/);
    expect(strFromU8(z["[Content_Types].xml"])).toContain('Extension="gif"');
    // 병합 없는 표의 마지막 행까지 빼려 하면 400
    const t = after.tables[0].id;
    await ops(P, 1, [{ t: "tableRow", table: t, at: 0, op: "remove" }, { t: "tableRow", table: t, at: 0, op: "remove" }]);
    expect((await ops(P, 2, [{ t: "tableRow", table: t, at: 0, op: "remove" }])).status).toBe(400);
  });
});
