import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { applyOps, checkDeck, parseSlide, renderDeckHtml, renderSlideHtml, serializeSlide, SLIDE_BASE_CSS, SlideError, slidePath, type Slide, type SlideOp } from "../src/slide/index.ts";

/** 5.0 M4: 슬라이드 형식(명세 docs/slide-editor-spec.html 03·04·07절). 케이스 목록은 spec/TESTING.md 2.8 */

const A = "asset:" + "a".repeat(64);
export const SAMPLE = `<section id="team" style="background:#f7f7f4;padding:128px;display:flex;flex-direction:column;gap:48px">
  <h2 style="font-size:64px;font-weight:700;color:#1c2026">팀 <b>소개</b></h2>
  <p>설명 <a href="https://example.com">링크</a>와 <span style="color:#0e6b57">색</span><br>둘째 줄</p>
  <ul><li>하나</li><li>둘</li></ul>
  <table style="font-size:24px">
    <tr><th style="width:30%">이름</th><th style="width:70%">역할</th></tr>
    <tr><td style="padding:8px">가</td><td style="padding:8px">나</td></tr>
  </table>
  <img src="${A}" alt="콘솔 화면" style="position:absolute;left:896px;top:292px;width:896px;height:525px;object-fit:contain">
  <aside>발표자 노트</aside>
</section>`;

const parse = (html: string) => {
  const r = parseSlide(html);
  assert.deepEqual(r.diagnostics, [], JSON.stringify(r.diagnostics));
  return r.slide!;
};
const eidOf = (s: Slide, tag: string, n = 0) => {
  const out: string[] = [];
  const walk = (e: Slide["root"]) => { if (e.tag === tag) out.push(e.eid); e.children.forEach((c) => c.kind === "el" && walk(c)); };
  walk(s.root);
  return out[n];
};

describe("슬라이드 형식", () => {
  test("TC-ED-28 파싱·직렬화: eid를 붙이고(한 번 붙으면 그대로), tbody는 건너뛰고, 노트는 aside, 왕복 안정", () => {
    const s = parse(SAMPLE);
    assert.equal(s.id, "team");
    assert.equal(s.root.eid, "team");
    assert.equal(s.notes, "발표자 노트");
    const out = serializeSlide(s);
    assert.match(out, /^<section id="team" data-eid="team" style="background:#f7f7f4;padding:128px;/);
    assert.match(out, /<h2 data-eid="e1" style="font-size:64px;font-weight:700;color:#1c2026">팀 <b>소개<\/b><\/h2>/);
    assert.doesNotMatch(out, /tbody/);
    assert.match(out, /<img data-eid="e\d+" src="asset:a{64}" alt="콘솔 화면" style="position:absolute;/);
    assert.match(out, /  <aside>발표자 노트<\/aside>\n<\/section>\n$/);
    // 왕복: 다시 읽어 다시 쓰면 같고, eid는 그대로
    assert.equal(serializeSlide(parse(out)), out);
    // 새 요소에만 다음 번호
    const added = parse(out.replace("<ul ", '<p>새 문단</p>\n  <ul '));
    assert.equal(eidOf(added, "h2"), "e1");
    assert.equal(eidOf(added, "p", 1), `e${Math.max(...[...out.matchAll(/data-eid="e(\d+)"/g)].map((m) => Number(m[1]))) + 1}`);
  });

  test("TC-ED-29 검증: 허용 밖 태그·속성·CSS마다 진단 하나(줄·칸, fix)", () => {
    const bad = `<section id="s1">
  <p style="margin-top:24px;z-index:2">a</p>
  <div onclick="x()" style="font-size:2em;background:url(x.png)">b</div>
  <script>alert(1)</script>
  <p>c <a href="http://x.com">d</a> <span style="font-size:40px">e</span> <em>f</em></p>
  <img src="https://x.com/a.png" alt="">
</section>`;
    const r = parseSlide(bad);
    const codes = r.diagnostics.map((d) => `${d.line}:${d.code}`);
    assert.deepEqual(codes, ["2:css-prop", "2:css-prop", "3:attr", "3:css-value", "3:css-value", "4:tag", "5:link", "5:inline-style", "5:tag", "6:src"]);
    assert.match(r.diagnostics[0].fix!, /gap이나 padding/);
    assert.match(r.diagnostics[1].fix!, /문서 순서/);
    assert.match(r.diagnostics[3].fix!, /px·%/);
    assert.match(r.diagnostics[8].fix!, /b·i·u/);
    assert.equal(parseSlide("<div>x</div>").diagnostics[0].code, "root");
    assert.equal(parseSlide('<section id="Bad Id"></section>').diagnostics[0].code, "id");
    assert.equal(parseSlide('<section id="a"><p data-eid="x">1</p><p data-eid="x">2</p></section>').diagnostics[0].code, "eid-dup");
  });

  test("TC-ED-30 연산마다 적용 후 역연산을 적용하면 원본과 같다", () => {
    const s = parse(SAMPLE);
    const base = serializeSlide(s);
    const table = eidOf(s, "table"), img = eidOf(s, "img"), h2 = eidOf(s, "h2"), ul = eidOf(s, "ul");
    const cases: SlideOp[][] = [
      [{ t: "setText", eid: h2, html: "새 <i>제목</i>" }],
      [{ t: "setText", eid: h2, html: "" }],
      [{ t: "setStyle", eid: h2, set: { "font-size": "80px", "text-align": "center" }, unset: ["color"] }],
      [{ t: "setAttr", eid: img, name: "alt", value: "새 설명" }],
      [{ t: "setAttr", eid: img, name: "src", value: "asset:" + "b".repeat(64) }],
      [{ t: "insert", parent: "team", index: 1, html: '<p style="font-size:32px">넣은 <b>문단</b></p>' }],
      [{ t: "remove", eid: ul }],
      [{ t: "remove", eid: table }],
      [{ t: "move", eid: img, parent: "team", index: 0 }],
      [{ t: "move", eid: h2, parent: "team", index: 99 }],
      [{ t: "toPinned", eid: h2, box: { left: 128, top: 128.4, width: 800, height: 90 } }],
      [{ t: "tableCols", eid: table, widths: [1, 3] }],
      [{ t: "tableRow", eid: table, at: 1, op: "add" }],
      [{ t: "tableRow", eid: table, at: 2, op: "add" }],
      [{ t: "tableRow", eid: table, at: 0, op: "remove" }],
      [{ t: "tableCol", eid: table, at: 1, op: "add" }],
      [{ t: "tableCol", eid: table, at: 2, op: "add" }],
      [{ t: "tableCol", eid: table, at: 0, op: "remove" }],
      [{ t: "setNotes", text: "새 노트" }],
      // 여러 연산 묶음
      [{ t: "tableCol", eid: table, at: 1, op: "add" }, { t: "tableRow", eid: table, at: 1, op: "add" }, { t: "setText", eid: h2, html: "묶음" }, { t: "remove", eid: ul }],
    ];
    for (const ops of cases) {
      const r = applyOps(s, ops);
      assert.notEqual(serializeSlide(r.slide), base, JSON.stringify(ops));
      assert.equal(serializeSlide(applyOps(r.slide, r.inverse).slide), base, JSON.stringify(ops));
      // 바뀐 결과도 형식에 맞는다(다시 읽으면 진단 없음)
      assert.deepEqual(parseSlide(serializeSlide(r.slide)).diagnostics, [], JSON.stringify(ops));
    }
    assert.equal(serializeSlide(s), base, "원본은 바뀌지 않는다");
  });

  test("TC-ED-31 표: 열 너비는 합 100%, 열을 넣으면 똑같이 나누고, 새 행은 본문 칸 스타일을 잇는다", () => {
    const s = parse(SAMPLE);
    const table = eidOf(s, "table");
    const widths = (x: Slide) => [...serializeSlide(x).matchAll(/<th data-eid="[^"]+" style="[^"]*width:([\d.]+)%/g)].map((m) => Number(m[1]));
    const w = applyOps(s, [{ t: "tableCols", eid: table, widths: [1, 2] }]).slide;
    assert.deepEqual(widths(w), [33.3, 66.7]);
    const c = applyOps(s, [{ t: "tableCol", eid: table, at: 2, op: "add" }]).slide;
    assert.deepEqual(widths(c), [33.3, 33.3, 33.4]);
    const r = applyOps(s, [{ t: "tableRow", eid: table, at: 2, op: "add" }]).slide;
    assert.match(serializeSlide(r), /<tr data-eid="e\d+">\n\s+<td data-eid="e\d+" style="padding:8px"><\/td>\n\s+<td data-eid="e\d+" style="padding:8px"><\/td>/);
    const err = (ops: SlideOp[]) => { try { applyOps(s, ops); return 0; } catch (e) { assert.ok(e instanceof SlideError); return e.status; } };
    assert.equal(err([{ t: "tableCols", eid: table, widths: [1] }]), 400);
    assert.equal(err([{ t: "tableRow", eid: "e999", at: 0, op: "add" }]), 409);
    assert.equal(err([{ t: "setStyle", eid: table, set: { margin: "4px" } }]), 400);
    assert.equal(err([{ t: "setText", eid: table, html: "x" }]), 400);
    assert.equal(err([{ t: "setText", eid: eidOf(s, "h2"), html: "<script>x</script>" }]), 400);
    assert.equal(err([{ t: "setAttr", eid: eidOf(s, "img"), name: "src", value: "https://x/a.png" }]), 400);
    assert.equal(err([{ t: "insert", parent: "team", index: 0, html: "<p>a</p><p>b</p>" }]), 400);
    assert.equal(err([{ t: "move", eid: table, parent: eidOf(s, "td"), index: 0 }]), 400);
  });

  test("TC-ED-32 덱 검사: deck.json과 order의 슬라이드 파일이 모두 있고 형식에 맞아야 하며, 저장본은 eid가 붙은 직렬화 형식", () => {
    const deck = { v: 1, title: "팀 소개", order: ["team", "cover"], palette: ["#1c2026"],
      faces: { plex: { family: "IBM Plex Sans KR", href: "https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+KR" } } };
    const ok = checkDeck(new Map([["deck.json", JSON.stringify(deck)], [slidePath("team"), SAMPLE], [slidePath("cover"), '<section id="cover"><h1>표지</h1></section>']]));
    assert.deepEqual(ok.diagnostics, []);
    assert.equal(ok.index!.title, "팀 소개");
    assert.match(ok.slides.get("slides/cover.html")!, /<h1 data-eid="e1">표지<\/h1>/);
    const bad = checkDeck(new Map([["deck.json", JSON.stringify({ ...deck, faces: { x: { family: "X", href: "https://evil.com/x.css" } } })],
      [slidePath("team"), SAMPLE.replace('id="team"', 'id="other"')]]));
    assert.deepEqual(bad.diagnostics.map((d) => `${d.file}:${d.code}`), ["deck.json:font"]);
    const bad2 = checkDeck(new Map([["deck.json", JSON.stringify(deck)], [slidePath("team"), SAMPLE.replace('id="team"', 'id="other"')]]));
    assert.deepEqual(bad2.diagnostics.map((d) => `${d.file}:${d.code}`), ["slides/team.html:id", "slides/cover.html:missing"]);
    assert.equal(checkDeck(new Map([["deck.json", "{"]])).diagnostics[0].code, "json");
  });

  test("TC-ED-42 정적 HTML(인쇄·미리보기): 화면 렌더러와 같은 모양(.slide-root, 표 안 tbody, 링크 새 탭), 그림은 주소로·없으면 자리 표시, 덱 글꼴·1920×1080 쪽", () => {
    const s = parse(SAMPLE);
    const html = renderSlideHtml(s, (sha) => `https://files.example/c/t/_asset/${sha}`);
    assert.match(html, /^<div class="slide-root" style="background:#f7f7f4;padding:128px;/);
    assert.match(html, /<table style="font-size:24px"><tbody><tr><th style="width:30%">이름<\/th>/);
    assert.match(html, /<a target="_blank" rel="noopener noreferrer" href="https:\/\/example\.com">링크<\/a>/);
    assert.match(html, /<img src="https:\/\/files\.example\/c\/t\/_asset\/a{64}" alt="콘솔 화면" style="position:absolute;/);
    assert.doesNotMatch(html, /data-eid|<aside|발표자 노트/);
    assert.match(renderSlideHtml(s, () => null), /<div class="slide-img-missing" role="img" aria-label="콘솔 화면"/);
    const doc = renderDeckHtml({ v: 1, title: "팀 <소개>", order: ["team"], faces: { p: { family: "Pretendard", href: "https://fonts.googleapis.com/css2?family=X" } } }, [s], () => null);
    assert.match(doc, /<title>팀 &lt;소개&gt;<\/title>/);
    assert.match(doc, /@page\{size:1920px 1080px;margin:0\}/);
    assert.match(doc, /<link rel="stylesheet" href="https:\/\/fonts\.googleapis\.com\/css2\?family=X">/);
    assert.match(doc, /font-family:"Pretendard"/);
    assert.ok(doc.includes(SLIDE_BASE_CSS));
    assert.match(doc, /<section class="slide-page" data-slide="team"><div class="slide-root"/);
  });

  test("TC-ED-43 보안: 덱 글꼴 이름(faces.family)에 태그·CSS를 넣으면 진단, 인쇄 HTML은 글꼴 이름을 늘 이스케이프, 프로토타입 키 CSS는 진단(예외 아님)", () => {
    const evil = { v: 1, title: "x", order: ["a"], faces: { f: { family: "x</style><script>fetch('http://169.254.169.254/')</script><style>", href: "https://fonts.googleapis.com/css2?family=X" } } };
    assert.equal(checkDeck(new Map([["deck.json", JSON.stringify(evil)], [slidePath("a"), '<section id="a"></section>']])).diagnostics[0].code, "font");
    const nl = { ...evil, faces: { f: { family: "X;}body{background:red", href: evil.faces.f.href } } };
    assert.equal(checkDeck(new Map([["deck.json", JSON.stringify(nl)], [slidePath("a"), '<section id="a"></section>']])).diagnostics[0].code, "font");
    // 검증을 거치지 않은 색인이 와도 렌더러가 막는다
    const html = renderDeckHtml(evil as never, [parse('<section id="a"></section>')], () => null);
    assert.doesNotMatch(html, /<script|<\/style><script/);
    assert.deepEqual(parseSlide('<section id="a"><p style="constructor:x;__proto__:y">a</p></section>').diagnostics.map((d) => d.code), ["css-prop", "css-prop"]);
  });
});
