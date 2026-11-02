import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseDocument } from "htmlparser2";
import type { ChildNode, Element } from "domhandler";
import { sanitizeSvg, scopeSvg, svgSize, SvgError, tidySvgEdit } from "../src/svg.ts";

/** 6.0 V4: SVG 소독·크기·인라인 범위·svgedit 정리. 공격 18건·정상 4개는 V0 스파이크 2 세트(test/fixtures/svg). 케이스 목록은 spec/TESTING.md 2.9 */

const dir = join(import.meta.dirname, "fixtures/svg");
const read = (sub: string) => readdirSync(join(dir, sub)).filter((f) => f.endsWith(".svg")).sort().map((f) => ({ name: f, text: readFileSync(join(dir, sub, f), "utf8") }));
const BAD = new Set(["script", "iframe", "embed", "object", "animate", "set", "handler", "listener", "base", "meta", "link", "form", "img", "feImage"]);

/** 결과를 다시 읽어 위험한 요소·속성이 하나도 없는지 본다(글자 내용은 상관없다) */
function assertClean(svg: string, label: string) {
  const doc = parseDocument(svg, { xmlMode: true });
  const walk = (n: ChildNode) => {
    if (n.type !== "tag") return;
    const el = n as Element;
    assert.ok(!BAD.has(el.name) && !el.name.includes(":"), `${label}: <${el.name}> 남음`);
    for (const [k, v] of Object.entries(el.attribs)) {
      assert.ok(!/^on/i.test(k), `${label}: ${k} 남음`);
      const s = v.replace(/[\s\u0000-\u001f]/g, "").toLowerCase();
      assert.ok(!s.includes("javascript:") && !s.includes("evil.test"), `${label}: ${k}="${v.slice(0, 60)}"`);
      if (/^(href|xlink:href)$/.test(k)) assert.ok(s.startsWith("#") || /^data:image\/(png|jpeg|gif|webp);base64,/.test(s) || /^https?:\/\//.test(s), `${label}: href ${v.slice(0, 60)}`);
      if (/url\(/.test(s) && k !== "content") assert.ok(!/url\((?!['"]?#)/.test(s), `${label}: 바깥 url() ${v.slice(0, 60)}`);
    }
    if (el.name === "style") {
      const css = el.children.map((c) => (c as { data?: string }).data ?? "").join("").toLowerCase();
      assert.ok(!/@import|url\((?!['"]?#)|javascript:|expression\(/.test(css), `${label}: <style> ${css.slice(0, 80)}`);
    }
    el.children.forEach(walk);
  };
  doc.children.forEach(walk);
}

describe("SVG 소독", () => {
  test("TC-VE-21 공격 18건: script·on*·javascript:·foreignObject 안 HTML·바깥 use/image/feImage·CSS url()/@import·animate href·data:svg·XXE·embed·처리 명령·mXSS·엔티티 숨김이 모두 지워지고, 이름공간 접두어 루트는 거부", () => {
    const bad = read("bad");
    assert.equal(bad.length, 18);
    for (const f of bad) {
      if (f.name.startsWith("12-")) {
        assert.throws(() => sanitizeSvg(f.text), (e: unknown) => e instanceof SvgError && e.status === 400, f.name);
        continue;
      }
      const r = sanitizeSvg(f.text);
      assertClean(r.svg, f.name);
      assert.ok(r.removed.length > 0 || f.name.startsWith("10-") || f.name.startsWith("13-"), `${f.name}: 지운 것이 진단에 없음`);
    }
    // 두 번 소독해도 같다(안정)
    for (const f of bad.filter((x) => !x.name.startsWith("12-"))) {
      const once = sanitizeSvg(f.text).svg;
      assert.equal(sanitizeSvg(once).svg, once, f.name);
    }
  });

  test("TC-VE-22 정상 SVG 4개(draw.io xmlsvg·ERD·일러스트·HTML 인라인)는 요소·속성이 그대로이고 draw.io 루트 content를 남긴다. 크기는 width·height, 없으면 viewBox", () => {
    for (const f of read("good")) {
      const r = sanitizeSvg(f.text);
      assert.deepEqual(r.removed, [], `${f.name}: ${r.removed.join(",")}`);
      const count = (s: string) => (s.match(/<[A-Za-z][\w:-]*/g) ?? []).length;
      assert.equal(count(r.svg), count(f.text.replace(/<\?xml[^>]*>|<!DOCTYPE[^>]*>|<!--[\s\S]*?-->/g, "")), f.name);
      if (/\scontent="/.test(f.text.slice(0, 2000))) assert.ok(r.drawio && /^<svg[^>]*\scontent="/.test(r.svg), `${f.name}: content`);
    }
    assert.deepEqual(svgSize('<svg xmlns="http://www.w3.org/2000/svg" width="400px" height="200"/>'), { width: 400, height: 200 });
    assert.deepEqual(svgSize('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 60"/>'), { width: 120, height: 60 });
    assert.deepEqual(svgSize('<svg xmlns="http://www.w3.org/2000/svg" width="240" viewBox="0 0 120 60"/>'), { width: 240, height: 120 });
    assert.deepEqual(svgSize('<svg xmlns="http://www.w3.org/2000/svg" width="100%"/>'), { width: 300, height: 150 });
    assert.throws(() => sanitizeSvg("<html><body/></html>"), SvgError);
    assert.throws(() => sanitizeSvg(""), SvgError);
  });

  test("TC-VE-23 인라인 넣기 범위 좁히기: id·참조(#id, url(#id))에 접두어, 루트 id는 접두어, <style> 선택자 앞에 #접두어, @규칙 style은 지움", () => {
    const src = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" id="old" viewBox="0 0 10 10">
<defs><linearGradient id="g"><stop offset="0" stop-color="#000"/></linearGradient><path id="p" d="M0 0h1"/></defs>
<style>.st0{fill:url(#g)} #p, rect{stroke:red}</style>
<rect class="st0" width="5" height="5" fill="url(#g)"/><use xlink:href="#p"/></svg>`;
    const { svg } = scopeSvg(src, "s1");
    assert.match(svg, /^<svg[^>]* id="s1"/);
    assert.match(svg, /<linearGradient id="s1-g">/);
    assert.match(svg, /fill="url\(#s1-g\)"/);
    assert.match(svg, /xlink:href="#s1-p"/);
    assert.match(svg, /#s1 \.st0\{fill:url\(#s1-g\)\},?#s1 #s1-p,#s1 rect\{stroke:red\}/);
    const at = scopeSvg(`<svg xmlns="http://www.w3.org/2000/svg"><style>@media print{rect{fill:red}}</style><rect width="1" height="1"/></svg>`, "s2");
    assert.ok(at.removed.includes("style(@규칙·중첩)"));
    assert.doesNotMatch(at.svg, /@media/);
    assert.throws(() => scopeSvg(src, "Bad Prefix"), SvgError);
  });

  test("TC-VE-24 svgedit 출력 정리: viewBox 다시 넣기, Layer 1 묶음 풀기, 소수 좌표 반올림, xmlns:svg 지우기", () => {
    const out = tidySvgEdit(`<svg xmlns="http://www.w3.org/2000/svg" xmlns:svg="http://www.w3.org/2000/svg" width="400" height="200"><g class="layer"><title>Layer 1</title><rect id="r1" x="69.99999" y="50.000001" width="139.9999976" height="80" fill="#ff0000"/></g></svg>`);
    assert.equal(out, `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200" viewBox="0 0 400 200"><rect id="r1" x="70" y="50" width="140" height="80" fill="#ff0000"/></svg>`);
    assert.match(tidySvgEdit(`<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"/>`, { viewBox: "10 10 40 20" }), /viewBox="10 10 40 20"/);
  });
});

describe("HTML 인라인 SVG·svgAttr", () => {
  const DOC = `<!doctype html>
<html><head><title>t</title></head>
<body>
  <main>
    <section>
      <p>첫 문단</p>
    </section>
  </main>
</body></html>
`;
  const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" viewBox="0 0 200 100"><defs><linearGradient id="g"><stop offset="0" stop-color="#000"/></linearGradient></defs><rect id="box" width="100" height="50" fill="url(#g)"/><text x="10" y="80" fill="#333">안녕</text><script>alert(1)</script></svg>`;

  test("TC-VE-25 insert·place의 kind svg는 소독·범위 좁힘(svg1, svg2…) 뒤 넣고, 도형은 outline svg.shapes·사본 data-shape, svgAttr로 fill·stroke·글자를 바꾼다. 다른 바이트는 그대로", async () => {
    const { applyOp, markEids, outline } = await import("../src/structedit/html.ts");
    const p = outline(DOC).find((b) => b.tag === "p")!;
    const a = applyOp(DOC, { t: "insert", ref: p.eid, where: "after", node: { kind: "svg", svg: SVG } });
    assert.doesNotMatch(a, /<script|alert/);
    assert.match(a, /<figure><svg xmlns="http:\/\/www.w3.org\/2000\/svg" viewBox="0 0 200 100" id="svg1">/);
    assert.match(a, /fill="url\(#svg1-g\)"/);
    assert.equal(a.slice(0, a.indexOf("<figure>")), DOC.slice(0, DOC.indexOf("</p>") + 4) + "\n      ");
    const svgBlock = outline(a).find((b) => b.tag === "svg")!;
    assert.deepEqual(svgBlock.svg!.shapes.map((x) => [x.tag, x.fill, x.text]), [["rect", "url(#svg1-g)", null], ["text", "#333", "안녕"]]);
    const text = svgBlock.svg!.shapes[1];
    assert.match(markEids(a), new RegExp(`<text data-shape="${text.eid}"`));
    const b2 = applyOp(a, { t: "svgAttr", eid: text.eid, name: "text", value: "<바뀜>" });
    assert.match(b2, />&lt;바뀜&gt;<\/text>/);
    const rect = outline(b2).find((b) => b.tag === "svg")!.svg!.shapes[0];
    const c = applyOp(b2, { t: "svgAttr", eid: rect.eid, name: "fill", value: "var(--accent)" });
    assert.match(c, /<rect id="svg1-box" width="100" height="50" fill="var\(--accent\)"\/>/);
    assert.equal(c.length - b2.length, "var(--accent)".length - "url(#svg1-g)".length);
    assert.throws(() => applyOp(c, { t: "svgAttr", eid: rect.eid, name: "fill", value: "url(https://evil.test/x)" }), /fill 값이 맞지 않습니다/);
    assert.throws(() => applyOp(c, { t: "svgAttr", eid: rect.eid, name: "text", value: "x" }), /text·tspan/);
    // 두 번째 인라인 SVG는 svg2, 고정 위치로 넣기·복제
    const sec = outline(c).find((b) => b.tag === "section")!;
    const d = applyOp(c, { t: "place", base: sec.eid, node: { kind: "svg", svg: SVG }, box: { left: 10, top: 20, width: 30 } });
    assert.match(d, /<svg data-pin="" style="position:absolute;left:10%;top:20px;width:30%;margin:0" xmlns="http:\/\/www.w3.org\/2000\/svg" viewBox="0 0 200 100" id="svg2">/);
    const dup = applyOp(d, { t: "duplicate", eid: outline(d).filter((b) => b.tag === "svg")[1].eid });
    assert.match(dup, /id="svg3"/);
    assert.match(dup, /fill="url\(#svg3-g\)"/);
    assert.equal(outline(dup).filter((b) => b.tag === "svg").length, 3);
  });

  test("TC-VE-26 자산 검사(prepareAsset): SVG는 소독 결과를 저장하고 크기·지운 것·draw.io 여부를 준다. 루트가 svg가 아니면 400, UTF-8이 아니면 400", async () => {
    const { prepareAsset, WorkError } = await import("../src/work/index.ts");
    const r = prepareAsset("image/svg+xml", new TextEncoder().encode(SVG));
    assert.equal(r.width, 200); assert.equal(r.height, 100);
    assert.deepEqual(r.removed, ["script"]);
    assert.equal(r.drawio, false);
    assert.doesNotMatch(new TextDecoder().decode(r.data), /script/);
    assert.throws(() => prepareAsset("image/svg+xml", new TextEncoder().encode("<html/>")), (e: unknown) => e instanceof WorkError && e.status === 400);
    assert.throws(() => prepareAsset("image/svg+xml", Uint8Array.from([0x3c, 0xff, 0xfe])), (e: unknown) => e instanceof WorkError && e.status === 400);
    assert.throws(() => prepareAsset("text/html", new Uint8Array(4)), (e: unknown) => e instanceof WorkError && e.status === 400);
  });
});
