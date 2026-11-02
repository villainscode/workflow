import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { applyOp, markEids, outline, PIN_RULE, StructEditError, type HtmlOp } from "../src/structedit/html.ts";

/** 6.0 V3: HTML 자유 배치(toPinned·place·unpin, D-54). 케이스 목록은 spec/TESTING.md 2.9 */

const DOC = `<!doctype html>
<html><head><title>t</title></head>
<body>
  <main>
    <section class="s1">
      <h2>제목</h2>
      <p style="color: red;">첫 문단</p>
      <ul><li>항목</li></ul>
      <table><tr><td><p>칸 안</p></td></tr></table>
    </section>
    <section class="s2">
      <p>둘째 섹션</p>
    </section>
  </main>
</body></html>
`;
const first = (html: string, tag: string, n = 0) => outline(html).filter((b) => b.tag === tag)[n];
const box = { left: 10, top: 40, width: 30 };

describe("HTML 자유 배치", () => {
  test("TC-VE-14 toPinned: 요소는 position·left %·top px·width %·data-pin(원래 style), 섹션은 relative·min-height·data-pin-box, head에 좁은 화면 규칙 한 번. 다시 옮기면 위치만, unpin하면 원본 바이트", () => {
    const p = first(DOC, "p");
    assert.equal(p.pinBase, first(DOC, "section").eid);
    const out = applyOp(DOC, { t: "toPinned", eid: p.eid, box, minHeight: 180.2 });
    assert.match(out, /<p data-pin="color: red;" style="color:red;position:absolute;left:10%;top:40px;width:30%;margin:0">첫 문단<\/p>/);
    assert.match(out, /<section data-pin-box="" style="position:relative;min-height:181px" class="s1">/);
    assert.equal(out.split(PIN_RULE).length, 2);
    assert.ok(out.indexOf(PIN_RULE) < out.indexOf("</head>"));
    // 둘째 섹션은 그대로
    assert.ok(out.includes('<section class="s2">\n      <p>둘째 섹션</p>'));
    const pinned = first(out, "p");
    assert.equal(pinned.pinned, true);
    // 다시 옮기기: 위치만 바뀌고 원래 style(data-pin)·규칙은 그대로. 오른쪽 끝이 100%를 넘지 않게 left를 줄인다
    const moved = applyOp(out, { t: "toPinned", eid: pinned.eid, box: { left: 90, top: 12.4, width: 30 } });
    assert.match(moved, /<p data-pin="color: red;" style="color:red;position:absolute;left:70%;top:12px;width:30%;margin:0">/);
    assert.match(moved, /min-height:181px/);
    assert.equal(moved.split(PIN_RULE).length, 2);
    assert.equal(applyOp(moved, { t: "unpin", eid: first(moved, "p").eid }), DOC);
  });

  test("TC-VE-15 place: 섹션 끝에 고정 그림·글상자. 지우거나 흐름으로 되돌리면 섹션 style·규칙도 정리, 기준이 아닌 곳·글자 블록 안에는 넣지 않는다", () => {
    const s1 = first(DOC, "section");
    const img = applyOp(DOC, { t: "place", base: s1.eid, node: { kind: "image", src: "assets/a.png", alt: "그림" }, box: { left: 50, top: 10, width: 20 }, minHeight: 300 });
    assert.match(img, /<\/table>\n {6}<img src="assets\/a.png" alt="그림" data-pin="" style="position:absolute;left:50%;top:10px;width:20%;margin:0">\n {4}<\/section>/);
    const placed = outline(img).find((b) => b.tag === "img")!;
    assert.equal(placed.pinned, true);
    assert.equal(applyOp(img, { t: "remove", eid: placed.eid }), DOC);
    const tb = applyOp(DOC, { t: "place", base: first(DOC, "section", 1).eid, node: { kind: "textbox", text: "새 <글상자>" }, box });
    assert.match(tb, /<p data-pin="" style="[^"]+">새 &lt;글상자&gt;<\/p>/);
    // 흐름으로 되돌리면 style이 없는 문단이 남고, 섹션·규칙은 원래대로
    const back = applyOp(tb, { t: "unpin", eid: outline(tb).filter((b) => b.tag === "p").at(-1)!.eid });
    assert.equal(back, DOC.replace("<p>둘째 섹션</p>", "<p>둘째 섹션</p>\n      <p>새 &lt;글상자&gt;</p>"));
    assert.throws(() => applyOp(DOC, { t: "place", base: first(DOC, "p").eid, node: { kind: "textbox" }, box }), (e: StructEditError) => e.status === 409 || e.status === 400);
    assert.throws(() => applyOp(DOC, { t: "place", base: "e99999", node: { kind: "textbox" }, box }), (e: StructEditError) => e.status === 409);
    assert.throws(() => applyOp(DOC, { t: "place", base: s1.eid, node: { kind: "image", src: "javascript:x" }, box }), StructEditError);
  });

  test("TC-VE-16 고정할 수 없는 것과 잘못된 값: 표 안 요소·목록 항목·표 자체·섹션 자체는 400, 너비 0·100 초과·top 음수는 400, 고정 요소를 다른 섹션으로 옮기기는 400", () => {
    const bad = (op: HtmlOp) => assert.throws(() => applyOp(DOC, op), (e: StructEditError) => e.status === 400, JSON.stringify(op));
    const inCell = outline(DOC).filter((b) => b.tag === "p")[1];
    assert.equal(inCell.pinBase, null);
    bad({ t: "toPinned", eid: inCell.eid, box });
    bad({ t: "toPinned", eid: first(DOC, "li").eid, box });
    bad({ t: "toPinned", eid: first(DOC, "td").eid, box });
    bad({ t: "toPinned", eid: first(DOC, "table").eid, box });
    bad({ t: "toPinned", eid: first(DOC, "section").eid, box });
    bad({ t: "toPinned", eid: first(DOC, "p").eid, box: { left: 0, top: 0, width: 0 } });
    bad({ t: "toPinned", eid: first(DOC, "p").eid, box: { left: 0, top: 0, width: 120 } });
    bad({ t: "toPinned", eid: first(DOC, "p").eid, box: { left: 0, top: -5, width: 20 } });
    bad({ t: "toPinned", eid: first(DOC, "p").eid, box: { left: 0, top: 0, width: 20 }, minHeight: -1 });
    bad({ t: "unpin", eid: first(DOC, "p").eid });
    const out = applyOp(DOC, { t: "toPinned", eid: first(DOC, "p").eid, box });
    assert.throws(() => applyOp(out, { t: "move", eid: first(out, "p").eid, ref: outline(out).filter((b) => b.tag === "p").at(-1)!.eid, where: "after" }), (e: StructEditError) => e.status === 400);
    // 같은 섹션 안 앞뒤(그리는 순서)는 된다
    assert.doesNotThrow(() => applyOp(out, { t: "move", eid: first(out, "p").eid, ref: first(out, "h2").eid, where: "before" }));
  });

  test("TC-VE-17 기준 섹션 판별: section이 없으면 본문 뿌리(main·body, 감싸개 하나면 그 안) 바로 아래 블록, 뿌리 바로 아래 요소는 뿌리. head·body 태그를 생략한 문서도 규칙을 head 끝에 넣는다", () => {
    const flat = `<html><head><style>a{}</style></head><body><div class="page"><h1>t</h1><div class="card"><p>a</p></div><p>b</p></div></body></html>`;
    const card = outline(flat).find((b) => b.tag === "div" && b.depth === 1)!;
    const [a, b] = outline(flat).filter((x) => x.tag === "p");
    assert.equal(a.pinBase, card.eid);
    const page = outline(flat).find((x) => x.tag === "div" && x.depth === 0)!;
    assert.equal(b.pinBase, page.eid);
    assert.match(markEids(flat), /<div data-eid="(e\d+)" data-base="\1" data-root class="page">/);
    const outB = applyOp(flat, { t: "toPinned", eid: b.eid, box });
    assert.ok(outB.includes(`<div data-pin-box="" style="position:relative;min-height:40px" class="page">`), outB);
    const bare = `<!doctype html><meta charset="utf-8"><title>x</title><style>p{}</style><main><section><p>a</p></section></main>`;
    const outBare = applyOp(bare, { t: "toPinned", eid: first(bare, "p").eid, box });
    assert.ok(outBare.includes(`<style>p{}</style>${PIN_RULE}<main>`), outBare);
    assert.equal(applyOp(outBare, { t: "unpin", eid: first(outBare, "p").eid }), bare);
  });

  test("TC-VE-18 리포 실제 HTML 문서: 고정할 수 있는 블록마다 toPinned → unpin 왕복이 원본과 같고, 고정하면 바뀌는 곳은 기준 섹션·그 요소의 시작 태그와 head 규칙뿐", () => {
    const root = resolve(import.meta.dirname, "../../../docs");
    const files: string[] = [];
    const walk = (d: string) => readdirSync(d).forEach((n) => {
      if (n.startsWith(".") || n.startsWith("_")) return;
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p); else if (/\.html?$/.test(n)) files.push(p);
    });
    walk(root);
    let pins = 0;
    const tagEnd = (h: string, at: number) => h.indexOf(">", at) + 1;
    for (const f of files) {
      const html = readFileSync(f, "utf8");
      if (html.includes("data-pin")) continue;
      // 문서마다 고정할 수 있는 앞쪽 12개(큰 문서도 빠르게)
      for (const b of outline(html).filter((x) => x.pinBase && !x.pinned).slice(0, 12)) {
        pins++;
        const out = applyOp(html, { t: "toPinned", eid: b.eid, box: { left: 5, top: 20, width: 40 }, minHeight: 100 });
        assert.equal(applyOp(out, { t: "unpin", eid: outline(out).find((x) => x.pinned)!.eid }), html, `${f} ${b.eid} 왕복`);
        const o = out.replace(PIN_RULE, "");
        const bs = Number(b.pinBase!.slice(1)), es = Number(b.eid.slice(1));
        assert.equal(o.slice(0, bs), html.slice(0, bs), `${f} ${b.eid} 섹션 앞`);
        const be = tagEnd(html, bs), be2 = tagEnd(o, bs);
        assert.equal(o.slice(be2, be2 + (es - be)), html.slice(be, es), `${f} ${b.eid} 섹션 시작 태그 ~ 요소`);
        const es2 = be2 + (es - be);
        assert.equal(o.slice(tagEnd(o, es2)), html.slice(tagEnd(html, es)), `${f} ${b.eid} 요소 뒤`);
      }
    }
    assert.ok(pins > 50, `리포 문서에 고정할 수 있는 블록이 있어야 한다(${pins})`);
  });
});
