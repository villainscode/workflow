import { beforeEach, describe, expect, it } from "vitest";
import { addMember, call, getJson, json, login, seed, upload, useSession } from "./helpers.ts";

/** 5.0 M4: 슬라이드 덱(kind: deck) 업로드 검증과 편집 API(수정본 저장, rev 다시 적용) */

const W = "/api/w/team";
const DECK = { v: 1, title: "팀 소개", order: ["cover", "team"], palette: ["#1c2026"] };
const COVER = '<section id="cover" style="padding:128px"><h1>표지</h1><p>부제</p></section>';
const TEAM = '<section id="team" style="display:flex;flex-direction:column;gap:48px"><h2>팀</h2><table><tr><th>이름</th><th>역할</th></tr><tr><td>가</td><td>나</td></tr></table></section>';
const files = (deck: object = DECK, cover = COVER, team = TEAM): [string, string][] =>
  [["deck.json", JSON.stringify(deck)], ["slides/cover.html", cover], ["slides/team.html", team]];

let D = "";
const patch = (sid: string, baseRev: number, ops: unknown[], headers: Record<string, string> = {}) =>
  call(`${D}/deck/slides/${sid}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ baseRev, ops }) });

beforeEach(async () => {
  await seed();
  const r = await (await upload("team", { menu: "notes", title: "덱", slug: "intro-deck" }, files())).json<any>();
  D = `${W}/docs/notes/${r.doc}`;
});

describe("슬라이드 덱", () => {
  it("TC-ED-33 덱 업로드: kind deck, 대표 파일 deck.json, 슬라이드는 eid가 붙은 형식으로 저장. 형식 오류는 400(파일:줄:칸 진단)", async () => {
    const d = await getJson(D);
    expect([d.kind, d.versions[0].files.find((f: any) => f.isEntry).path]).toEqual(["deck", "deck.json"]);
    const cover = d.versions[0].files.find((f: any) => f.path === "slides/cover.html");
    expect(await (await call(new URL(cover.url).pathname)).text()).toBe('<section id="cover" data-eid="cover" style="padding:128px">\n  <h1 data-eid="e1">표지</h1>\n  <p data-eid="e2">부제</p>\n</section>\n');
    const bad = await upload("team", { menu: "notes", title: "나쁜 덱" }, files(DECK, '<section id="cover"><p style="margin:4px">x</p><script>1</script></section>'));
    expect(bad.status).toBe(400);
    const msg = (await bad.json<any>()).error;
    expect(msg).toMatch(/^덱 형식 오류 2건/);
    expect(msg).toMatch(/slides\/cover\.html:1:\d+ \[css-prop\] .*margin.*→ margin은 쓰지 않습니다/);
    expect((await upload("team", { menu: "notes", title: "빠진 덱" }, files().slice(0, 2))).status).toBe(400);
  });

  it("TC-ED-34 슬라이드 연산 → 수정본(그 슬라이드 파일만 새 blob), 역연산을 적용하면 원래 내용, 형식 위반은 저장하지 않음", async () => {
    const before = await getJson(`${D}/deck`);
    expect([before.rev, before.index.order, before.slides.length]).toEqual([0, ["cover", "team"], 2]);
    const r = await (await patch("cover", 0, [{ t: "setText", eid: "e1", html: "새 <b>표지</b>" }, { t: "setStyle", eid: "e2", set: { color: "#0e6b57" } }])).json<any>();
    expect(r).toMatchObject({ rev: 1, changed: true, rebased: false, slide: "cover" });
    expect(r.html).toContain('<h1 data-eid="e1">새 <b>표지</b></h1>');
    const work = await getJson(`${D}/work`);
    const sha = (w: any, p: string) => w.files.find((f: any) => f.path === p).sha256;
    const v = (await getJson(D)).versions[0];
    expect(sha(work, "slides/team.html")).toBe(v.files.find((f: any) => f.path === "slides/team.html").sha256);
    expect(sha(work, "slides/cover.html")).not.toBe(v.files.find((f: any) => f.path === "slides/cover.html").sha256);
    const back = await (await patch("cover", 1, r.inverse)).json<any>();
    expect(back.html).toBe(before.slides[0].html);
    // 형식 위반: 400, 수정본 그대로
    const bad = await patch("cover", 2, [{ t: "setStyle", eid: "e1", set: { "z-index": "3" } }]);
    expect(bad.status).toBe(400);
    expect((await bad.json<any>()).error).toMatch(/\[css-prop\].*z-index/);
    expect((await getJson(`${D}/deck`)).rev).toBe(2);
    expect((await patch("nope", 2, [{ t: "setNotes", text: "x" }])).status).toBe(404);
  });

  it("TC-ED-35 rev 충돌: 기준이 지났어도 대상 요소가 있으면 최신본에 다시 적용해 저장, 지워진 요소면 409", async () => {
    await patch("cover", 0, [{ t: "setText", eid: "e1", html: "A가 고침" }]);                       // rev 1(다른 사람)
    const r = await (await patch("cover", 0, [{ t: "setText", eid: "e2", html: "B가 고침" }])).json<any>(); // B는 rev 0 기준
    expect(r).toMatchObject({ rev: 2, rebased: true });
    expect(r.html).toContain("A가 고침");
    expect(r.html).toContain("B가 고침");
    await patch("cover", 2, [{ t: "remove", eid: "e2" }]);                                          // rev 3: e2 지움
    const c = await patch("cover", 2, [{ t: "setText", eid: "e2", html: "늦은 수정" }]);
    expect(c.status).toBe(409);
    expect((await c.json<any>()).error).toMatch(/e2.*없습니다/);
  });

  it("TC-ED-36 슬라이드 통째 쓰기(새 id면 순서에 추가), 색인 고치기(순서·제목, 빠진 슬라이드 파일은 지움), 에이전트 출처, viewer 403", async () => {
    const add = await (await json("PUT", `${D}/deck/slides/end`, { baseRev: 0, html: '<section id="end"><h1>끝</h1></section>', index: 1 })).json<any>();
    expect(add).toMatchObject({ rev: 1, added: true });
    expect((await getJson(`${D}/deck`)).index.order).toEqual(["cover", "end", "team"]);
    expect((await json("PUT", `${D}/deck/slides/x`, { baseRev: 1, html: '<section id="y"></section>' })).status).toBe(400);
    const p = await call(`${D}/deck`, { method: "PATCH", headers: { "content-type": "application/json", "x-workflow-agent": "claude-code" },
      body: JSON.stringify({ baseRev: 1, index: { title: "새 제목", order: ["team", "end"] } }) });
    expect(p.status).toBe(200);
    const deck = await getJson(`${D}/deck`);
    expect([deck.index.title, deck.index.order]).toEqual(["새 제목", ["team", "end"]]);
    expect((await getJson(`${D}/work`)).files.map((f: any) => f.path).sort()).toEqual(["deck.json", "slides/end.html", "slides/team.html"]);
    expect((await getJson(`${D}/revisions`)).revisions[0]).toMatchObject({ source: "agent", summary: "슬라이드 cover 지움" });
    expect((await json("PATCH", `${D}/deck`, { baseRev: 2, index: { order: ["team", "zzz"] } })).status).toBe(400);
    // 버전으로 올리면 새 버전 파일 목록이 그대로
    const pub = await (await json("POST", `${D}/publish`, { baseRev: 2 })).json<any>();
    expect(pub.version).toBe("v0.1");
    await addMember("team", "v@test.com", "viewer");
    useSession((await login("v@test.com")).cookie);
    expect((await getJson(`${D}/deck`)).rev).toBe(2);
    expect((await patch("team", 2, [{ t: "setNotes", text: "x" }])).status).toBe(403);
  });

  it("TC-ED-37 덱이 아닌 문서는 덱 API가 400", async () => {
    expect((await call(`${W}/docs/process/guide/deck`)).status).toBe(400);
  });
});
