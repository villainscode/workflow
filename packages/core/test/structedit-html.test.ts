import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { applyOp, applyOps, docTheme, markEids, outline, sanitizeInline, StructEditError, type HtmlOp } from "../src/structedit/html.ts";

/** 5.0 M3: HTML 구조 편집(spec/REQUIREMENT-5.0.md 4.1). 케이스 목록은 spec/TESTING.md 2.8 */

const DOC = `<!doctype html>
<html><body>
  <main>
    <h2 class="t">제목</h2>
    <p>첫 문단 <b>굵게</b></p>
    <table class="grid">
      <thead>
        <tr><th>이름</th><th>값</th></tr>
      </thead>
      <tbody>
        <tr><td>a</td><td>1</td></tr>
        <tr><td>b</td><td>2</td></tr>
      </tbody>
    </table>
    <figure class="fig"><img src="img/a.png" alt="그림"></figure>
    <p>끝 문단</p>
  </main>
</body></html>
`;
const eid = (html: string, tag: string, n = 0) => outline(html).filter((b) => b.tag === tag)[n].eid;


describe("HTML 구조 편집", () => {
  test("TC-ED-11 요소 목록: 표 행·열 수, 그림 src·alt, 글자 편집 가능 여부. 편집 사본은 data-eid(와 <base>)만 더한다", () => {
    const o = outline(DOC);
    const t = o.find((b) => b.tag === "table")!;
    assert.deepEqual(t.table, { rows: 3, cols: 2, widths: null, merged: false });
    assert.deepEqual(o.find((b) => b.tag === "img")!.image, { src: "img/a.png", alt: "그림", width: null });
    assert.equal(o.find((b) => b.tag === "p")!.editable, true);
    const marked = markEids(DOC);
    assert.equal(marked.replace(/ data-eid="e\d+"/g, ""), DOC);
    // 편집 화면용 <base>: head가 있으면 그 안 처음, 없으면 맨 앞
    assert.equal(markEids(DOC, "https://f/x/").replace(/ data-eid="e\d+"/g, ""), `<base href="https://f/x/">${DOC}`);
    assert.match(markEids("<html><head><title>t</title></head><body><p>a</p></body></html>", "https://f/\"x"), /^<html><head><base href="https:\/\/f\/&quot;x"><title>/);
    assert.equal(applyOps(DOC, []), DOC);
  });

  test("TC-ED-12 표 행 넣기·빼기: 본문 행을 본떠 빈 칸, 넣고 빼면 원본 바이트와 같다", () => {
    const t = eid(DOC, "table");
    const added = applyOp(DOC, { t: "tableRow", eid: t, at: 3, op: "add" });
    assert.match(added, /<tr><td>b<\/td><td>2<\/td><\/tr>\n {8}<tr><td><\/td><td><\/td><\/tr>\n {6}<\/tbody>/);
    assert.deepEqual(outline(added).find((b) => b.tag === "table")!.table!.rows, 4);
    assert.equal(applyOp(added, { t: "tableRow", eid: eid(added, "table"), at: 3, op: "remove" }), DOC);
    // 머리글 바로 아래(본문 첫 행 자리)에 넣어도 본문 모양
    const first = applyOp(DOC, { t: "tableRow", eid: t, at: 1, op: "add" });
    assert.match(first, /<tbody>\n {8}<tr><td><\/td><td><\/td><\/tr>\n {8}<tr><td>a<\/td>/);
  });

  test("TC-ED-13 표 열 넣기·빼기와 열 너비: 열을 넣고 빼면 원본과 같고, 너비는 colgroup %(합 100)로만 쓴다", () => {
    const t = eid(DOC, "table");
    const added = applyOp(DOC, { t: "tableCol", eid: t, at: 1, op: "add" });
    assert.match(added, /<tr><th>이름<\/th><th><\/th><th>값<\/th><\/tr>/);
    assert.match(added, /<tr><td>a<\/td><td><\/td><td>1<\/td><\/tr>/);
    assert.equal(applyOp(added, { t: "tableCol", eid: eid(added, "table"), at: 1, op: "remove" }), DOC);
    const w = applyOp(DOC, { t: "tableCols", eid: t, widths: [30, 70] });
    // 새로 생긴 것은 colgroup 한 줄뿐: 그것을 빼면 원본과 같다
    assert.match(w, /<colgroup><col style="width:30%"><col style="width:70%"><\/colgroup>/);
    // 열 너비가 지켜지게 표에 table-layout:fixed를 함께 넣는다(6.0 4.2). 다시 바꿔도 한 번만
    assert.match(w, /<table style="table-layout:fixed" class="grid">/);
    assert.equal(w.replace(/\n[ \t]*<colgroup>.*?<\/colgroup>/, "").replace(' style="table-layout:fixed"', ""), DOC);
    const w2 = applyOp(w, { t: "tableCols", eid: eid(w, "table"), widths: [1, 3] });
    assert.match(w2, /<col style="width:25%"><col style="width:75%">/);
    assert.equal(w2.match(/table-layout/g)!.length, 1);
    // colgroup이 있으면 열을 넣을 때 너비를 비율대로 줄여 새 열에 나눠 준다
    const w3 = applyOp(w2, { t: "tableCol", eid: eid(w2, "table"), at: 2, op: "add" });
    assert.match(w3, /<col style="width:16\.67%"><col style="width:50%"><col style="width:33\.33%">/);
    assert.throws(() => applyOp(DOC, { t: "tableCols", eid: t, widths: [100] }), StructEditError);
  });

  test("TC-ED-14 글자 바꾸기: 인라인 마크만 남기고(script·위험한 링크 제거), 블록이 든 요소는 거부", () => {
    const p = eid(DOC, "p");
    const out = applyOp(DOC, { t: "setText", eid: p, html: '새 <i>글</i><script>x()</script><a href="javascript:alert(1)">나쁜</a> <a href="https://a.b">좋은</a>' });
    assert.match(out, /<p>새 <i>글<\/i>나쁜 <a href="https:\/\/a\.b">좋은<\/a><\/p>/);
    assert.equal(sanitizeInline("<div><b>x</b></div>"), "<b>x</b>");
    assert.throws(() => applyOp(DOC, { t: "setText", eid: eid(DOC, "table"), html: "x" }), StructEditError);
  });

  test("TC-ED-15 넣기: 표(문서의 표 class를 따름)·그림·문단·제목, 그림 주소는 상대 경로·https만", () => {
    const p = eid(DOC, "p");
    const t = applyOp(DOC, { t: "insert", ref: p, where: "after", node: { kind: "table", rows: 3, cols: 2 } });
    const tables = outline(t).filter((b) => b.tag === "table");
    assert.equal(tables.length, 2);
    assert.deepEqual(tables[0].table, { rows: 3, cols: 2, widths: [50, 50], merged: false });
    assert.match(t, /<table class="grid">\n {6}<colgroup>/);
    const img = applyOp(DOC, { t: "insert", ref: p, where: "before", node: { kind: "image", src: "assets/x.png", alt: "새 그림", width: 60 } });
    assert.match(img, /<figure class="fig"><img src="assets\/x\.png" alt="새 그림" style="width:60%"><\/figure>\n {4}<p>첫 문단/);
    for (const bad of ["javascript:x", "data:image/png;base64,AA", "/c/token/x.png", "../x.png"]) {
      assert.throws(() => applyOp(DOC, { t: "insert", ref: p, where: "after", node: { kind: "image", src: bad } }), StructEditError, bad);
    }
    const h = applyOp(DOC, { t: "insert", ref: p, where: "after", node: { kind: "heading", level: 2, text: "<새 절>" } });
    assert.match(h, /<h2 class="t">&lt;새 절&gt;<\/h2>/);
  });

  test("TC-ED-16 지우기·옮기기·그림 바꾸기·너비: 바뀐 곳 밖은 그대로, 자기 안으로 옮기기·행 직접 지우기는 거부", () => {
    const last = eid(DOC, "p", 1);
    const removed = applyOp(DOC, { t: "remove", eid: last });
    assert.equal(removed, DOC.replace("    <p>끝 문단</p>\n", ""));
    const moved = applyOp(DOC, { t: "move", eid: last, ref: eid(DOC, "h2"), where: "before" });
    assert.match(moved, /<main>\n {4}<p>끝 문단<\/p>\n {4}<h2 class="t">제목<\/h2>/);
    assert.equal(moved.length, DOC.length);
    const img = eid(DOC, "img");
    assert.match(applyOp(DOC, { t: "setAttr", eid: img, name: "src", value: "assets/b.png" }), /<img src="assets\/b\.png" alt="그림">/);
    assert.match(applyOp(DOC, { t: "setWidth", eid: img, percent: 40 }), /<img style="width:40%" src="img\/a\.png"|<img src="img\/a\.png" alt="그림" style="width:40%"|<img style="width:40%"/);
    assert.throws(() => applyOp(DOC, { t: "move", eid: eid(DOC, "table"), ref: eid(DOC, "td"), where: "before" }), StructEditError);
    assert.throws(() => applyOp(DOC, { t: "remove", eid: eid(DOC, "tr") }), StructEditError);
    assert.throws(() => applyOp(DOC, { t: "remove", eid: "e99999" }), StructEditError);
  });

  test("TC-ED-17 병합 칸이 있는 표는 행·열 편집을 거부하고 열 너비만 허용", () => {
    const merged = DOC.replace("<tr><td>a</td><td>1</td></tr>", '<tr><td colspan="2">a</td></tr>');
    const t = eid(merged, "table");
    assert.equal(outline(merged).find((b) => b.tag === "table")!.table!.merged, true);
    assert.throws(() => applyOp(merged, { t: "tableRow", eid: t, at: 1, op: "add" }), StructEditError);
    assert.throws(() => applyOp(merged, { t: "tableCol", eid: t, at: 1, op: "add" }), StructEditError);
    assert.doesNotThrow(() => applyOp(merged, { t: "tableCols", eid: t, widths: [40, 60] }));
  });

  test("TC-ED-18 리포 실제 HTML 문서: 모든 표에서 행 넣고 빼기·열 넣고 빼기 왕복이 원본과 같고, 열 너비를 바꿔도 그 표 밖 바이트는 그대로", () => {
    const root = resolve(import.meta.dirname, "../../../docs");
    const files: string[] = [];
    const walk = (d: string) => readdirSync(d).forEach((n) => {
      if (n.startsWith(".") || n.startsWith("_")) return;
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p); else if (/\.html?$/.test(n)) files.push(p);
    });
    walk(root);
    let tables = 0;
    for (const f of files) {
      const html = readFileSync(f, "utf8");
      for (const b of outline(html).filter((x) => x.tag === "table" && !x.table!.merged && x.table!.rows > 0)) {
        tables++;
        const rowsBack = applyOp(applyOp(html, { t: "tableRow", eid: b.eid, at: b.table!.rows, op: "add" }), { t: "tableRow", eid: b.eid, at: b.table!.rows, op: "remove" });
        assert.equal(rowsBack, html, `${f} ${b.eid} 행 왕복`);
        if (!b.table!.widths) {
          const colsBack = applyOp(applyOp(html, { t: "tableCol", eid: b.eid, at: 0, op: "add" }), { t: "tableCol", eid: b.eid, at: 0, op: "remove" });
          assert.equal(colsBack, html, `${f} ${b.eid} 열 왕복`);
        }
        const w = applyOp(html, { t: "tableCols", eid: b.eid, widths: Array(b.table!.cols).fill(1) });
        const start = Number(b.eid.slice(1));
        assert.equal(w.slice(0, start), html.slice(0, start), `${f} ${b.eid} 표 앞은 그대로`);
        // 표 시작 태그(table-layout)와 colgroup 말고는 그대로
        const tagEnd = html.indexOf(">", start) + 1;
        const wEnd = w.indexOf(">", start) + 1;
        if (!b.table!.widths) assert.equal(w.slice(wEnd).replace(/^\n?[ \t]*<colgroup>(<col style="width:[\d.]+%">)+<\/colgroup>/, ""), html.slice(tagEnd), `${f} ${b.eid} colgroup 말고는 그대로`);
      }
    }
    assert.ok(tables > 0, "리포 문서에 표가 있어야 한다");
  });

  test("TC-ED-44 보안: 글자 바꾸기의 링크는 http(s)·mailto·#·상대 경로만(제어 문자를 지운 뒤 검사, java\\tscript:·data:·vbscript: 제거), 그림 주소의 역슬래시 외부 주소 거부", () => {
    const out = sanitizeInline('<a href="java\tscript:alert(1)">x</a><a href="data:text/html,1">y</a><a href="vbscript:x">z</a><a href="https://ok.example/a">o</a><a href="docs/b.html">r</a><a href="mailto:a@b.c">m</a>');
    assert.doesNotMatch(out, /script:|data:/);
    assert.match(out, /href="https:\/\/ok\.example\/a"/);
    assert.match(out, /href="docs\/b\.html"/);
    assert.match(out, /href="mailto:a@b\.c"/);
    const t = eid(DOC, "img");
    assert.throws(() => applyOp(DOC, { t: "setAttr", eid: t, name: "src", value: "\\\\evil.com/x.png" }), StructEditError);
  });

  // ---------- 6.0 V2 속성 편집(spec/TESTING.md 2.9) ----------

  const THEMED = `<!doctype html>
<html><head>
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+KR:wght@400;700&amp;family=IBM+Plex+Mono&amp;display=swap" rel="stylesheet">
<style>
:root{--accent:#1f5fbf;--ink:rgb(20, 20, 20);--gap:12px;--font-sans:"IBM Plex Sans KR", sans-serif}
@font-face{font-family:"Local Serif";src:url(a.woff2)}
@media (prefers-color-scheme: dark){:root{--accent:#80a8f0}}
body{font-family:var(--font-sans)}
</style>
</head><body>
  <main>
    <h2 class="t" style="margin: 0 0 8px; color: #333">제목</h2>
    <p id="first">첫 문단</p>
    <table><tr style="height:20px"><td>a</td><td>b</td></tr></table>
  </main>
</body></html>
`;

  test("TC-VE-03 HTML setStyle: style 속성만 다시 쓴다(기존 순서 유지·같은 속성은 제자리·새 속성은 끝·빈 값이면 속성 지움), 허용 밖은 400(fix 포함), 토큰 색·em·rem·margin 허용", () => {
    const h2 = eid(THEMED, "h2"), p = eid(THEMED, "p");
    const a = applyOp(THEMED, { t: "setStyle", eid: h2, set: { color: "var(--accent)", "font-size": "1.5rem" } });
    assert.match(a, /<h2 class="t" style="margin:0 0 8px;color:var\(--accent\);font-size:1\.5rem">제목<\/h2>/);
    // 바뀐 곳은 그 시작 태그뿐
    const at = Number(h2.slice(1));
    assert.equal(a.slice(0, at), THEMED.slice(0, at));
    assert.equal(a.slice(a.indexOf(">제목")), THEMED.slice(THEMED.indexOf(">제목")));
    const b = applyOp(THEMED, { t: "setStyle", eid: p, set: { "font-family": '"IBM Plex Mono", monospace', margin: "0 auto", "line-height": "1.7" } });
    assert.match(b, /<p style="font-family:'IBM Plex Mono', monospace;margin:0 auto;line-height:1\.7" id="first">/);
    // 넣고 지우면 원본 그대로, 같은 값이면 바뀌지 않는다
    const back = applyOp(b, { t: "setStyle", eid: eid(b, "p"), unset: ["font-family", "margin", "line-height"] });
    assert.equal(back, THEMED);
    assert.equal(applyOp(a, { t: "setStyle", eid: eid(a, "h2"), set: { color: "var(--accent)" } }), a);
    for (const [k, v] of [["position", "absolute"], ["left", "10px"], ["box-shadow", "0 0 4px #000"], ["font-size", "2vw"], ["background", "url(x.png)"],
      ["color", "red !important"], ["margin", "1in"], ["font-family", "'Comic Sans MS'"], ["z-index", "3"]]) {
      assert.throws(() => applyOp(THEMED, { t: "setStyle", eid: p, set: { [k]: v } }), StructEditError, `${k}: ${v}`);
    }
    assert.throws(() => applyOp(THEMED, { t: "setStyle", eid: p, set: { "font-family": "'Comic Sans MS'" } }), /쓸 수 있는 글꼴: IBM Plex Sans KR/);
    assert.throws(() => applyOp(THEMED, { t: "setStyle", eid: p, set: { left: "1px" } }), /자유 배치/);
    assert.throws(() => applyOp(THEMED, { t: "setStyle", eid: h2, unset: ["position"] }), StructEditError);
    assert.throws(() => applyOp(THEMED, { t: "setStyle", eid: p }), StructEditError);
  });

  test("TC-VE-04 글자 일부 서식: span style은 글자색·글꼴·크기·굵기만 정해진 순서로 남기고(큰따옴표는 작은따옴표), 그 밖 선언·불러오지 않은 글꼴은 버린다", () => {
    assert.equal(sanitizeInline('<span style="font-size: 20px; color: rgb(31, 95, 191); background: red; position:absolute">a</span>'),
      '<span style="color:rgb(31, 95, 191);font-size:20px">a</span>');
    assert.equal(sanitizeInline('<span style="font-family: &quot;IBM Plex Mono&quot;; font-weight: 700">b</span>', ["IBM Plex Mono"]),
      '<span style="font-family:\'IBM Plex Mono\';font-weight:700">b</span>');
    assert.equal(sanitizeInline('<span style="font-family: Papyrus">c</span>', ["IBM Plex Mono"]), "<span>c</span>");
    assert.equal(sanitizeInline('<span style="color:var(--accent)" onclick="x()">d</span>'), '<span style="color:var(--accent)">d</span>');
    const p = eid(THEMED, "p");
    const out = applyOp(THEMED, { t: "setText", eid: p, html: '첫 <span style="font-family:\'IBM Plex Mono\';color:#c00">문단</span>' });
    assert.match(out, /<p id="first">첫 <span style="color:#c00;font-family:'IBM Plex Mono'">문단<\/span><\/p>/);
  });

  test("TC-VE-05 표: 행 높이(tableRowHeight, tr height px·지우기), 표 너비는 setStyle width, 범위 밖 높이는 400", () => {
    const tr = eid(THEMED, "tr");
    const h = applyOp(THEMED, { t: "tableRowHeight", eid: tr, height: 48.4 });
    assert.match(h, /<tr style="height:48px">/);
    assert.match(applyOp(h, { t: "tableRowHeight", eid: eid(h, "tr"), height: null }), /<tr><td>a/);
    assert.throws(() => applyOp(THEMED, { t: "tableRowHeight", eid: tr, height: 1 }), StructEditError);
    assert.throws(() => applyOp(THEMED, { t: "tableRowHeight", eid: eid(THEMED, "table"), height: 40 }), StructEditError);
    assert.match(applyOp(THEMED, { t: "setStyle", eid: eid(THEMED, "table"), set: { width: "80%" } }), /<table style="width:80%">/);
  });

  test("TC-VE-06 복제(duplicate): 바로 뒤에 같은 들여쓰기로 넣고 안의 id는 뺀다, 표 칸은 거부, 고를 수 있는 요소에 div가 들어간다", () => {
    const p = eid(THEMED, "p");
    const d = applyOp(THEMED, { t: "duplicate", eid: p });
    assert.match(d, /<p id="first">첫 문단<\/p>\n {4}<p>첫 문단<\/p>\n {4}<table>/);
    assert.equal(d.replace("\n    <p>첫 문단</p>", ""), THEMED);
    assert.throws(() => applyOp(THEMED, { t: "duplicate", eid: eid(THEMED, "td") }), StructEditError);
    const withDiv = THEMED.replace("<main>", '<main>\n    <div class="card"><p>카드</p></div>');
    const o = outline(withDiv);
    const div = o.find((x) => x.tag === "div")!;
    assert.equal(div.editable, false);
    assert.equal(o.find((x) => x.text === "카드" && x.tag === "p")!.parent, div.eid);
    assert.equal(o.find((x) => x.tag === "h2")!.style.color, "#333");
  });

  test("TC-VE-07 문서 견본: 글꼴은 Google Fonts 링크·@font-face·글꼴 변수에서(일반 계열 빼고 처음 나온 순서), 색은 :root 색 변수(처음 값)와 다크 모드 여부", () => {
    const t = docTheme(THEMED);
    assert.deepEqual(t.fonts, ["IBM Plex Sans KR", "IBM Plex Mono", "Local Serif"]);
    assert.deepEqual(t.tokens, [{ name: "--accent", value: "#1f5fbf" }, { name: "--ink", value: "rgb(20, 20, 20)" }]);
    assert.equal(t.dark, true);
    assert.deepEqual(docTheme("<p>x</p>"), { fonts: [], tokens: [], dark: false });
  });

  test("TC-VE-08 리포 실제 HTML 문서: 아무것도 안 바꾸면 바이트 동일, 모든 블록에 setStyle을 넣고 지우면 그 시작 태그 밖은 그대로(style이 없던 요소는 원본과 같다)", () => {
    const root = resolve(import.meta.dirname, "../../../docs");
    const files: string[] = [];
    const walk = (d: string) => readdirSync(d).forEach((n) => {
      if (n.startsWith(".") || n.startsWith("_")) return;
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p); else if (/\.html?$/.test(n)) files.push(p);
    });
    walk(root);
    let blocks = 0;
    for (const f of files) {
      const html = readFileSync(f, "utf8");
      assert.equal(applyOps(html, []), html, `${f} 빈 연산`);
      const list = outline(html);
      // 문서마다 앞쪽 40개 블록(큰 문서도 빠르게)
      for (const b of list.slice(0, 40)) {
        blocks++;
        const set = applyOp(html, { t: "setStyle", eid: b.eid, set: { color: "var(--x-test)" } });
        const start = Number(b.eid.slice(1));
        assert.equal(set.slice(0, start), html.slice(0, start), `${f} ${b.eid} 앞`);
        const back = applyOp(set, { t: "setStyle", eid: b.eid, unset: ["color"] });
        if (!Object.keys(b.style).length) assert.equal(back, html, `${f} ${b.eid} 왕복`);
        else assert.equal(back.slice(back.indexOf(">", start)), html.slice(html.indexOf(">", start)), `${f} ${b.eid} 시작 태그 뒤`);
      }
    }
    assert.ok(blocks > 100, "리포 문서에 블록이 있어야 한다");
  });
});
