import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { strFromU8, unzipSync, zipSync } from "fflate";
import { applyOoxmlOps, ooxmlStructure, type OoxmlOp } from "../src/structedit/ooxml.ts";
import { StructEditError } from "../src/structedit/html.ts";

/** 5.0 M5(D-47 C): DOCX·PPTX 표·그림, XLSX 열 너비 구조 편집. 케이스 목록은 spec/TESTING.md 2.8 */

const here = resolve(import.meta.dirname);
const fx = (n: string) => new Uint8Array(readFileSync(join(here, "fixtures", n)));
const site = (n: string) => new Uint8Array(readFileSync(join(here, "../../../site/scripts/fixtures", n)));
const part = (data: Uint8Array, p: string) => strFromU8(unzipSync(data)[p]);

/** 바뀌지 않아야 할 파트는 바이트가 같다 */
function sameExcept(a: Uint8Array, b: Uint8Array, changed: string[]) {
  const za = unzipSync(a), zb = unzipSync(b);
  for (const name of Object.keys(za)) {
    if (changed.includes(name)) continue;
    assert.deepEqual(zb[name], za[name], `${name}이(가) 바뀌었습니다`);
  }
}

/** 열고 닫는 태그 수가 맞는지(간단한 형식 검사) */
function balanced(xml: string, tags: string[]) {
  for (const t of tags) {
    const open = (xml.match(new RegExp(`<${t}[\\s>]`, "g")) ?? []).length;
    const close = (xml.match(new RegExp(`</${t}>`, "g")) ?? []).length;
    assert.equal(open, close, `${t} 열기 ${open} 닫기 ${close}`);
  }
}

const gif = (w: number, h: number) => new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, w & 255, w >> 8, h & 255, h >> 8, 0, 0, 0, 0x3b]);
const png = (w: number, h: number) => {
  const b = new Uint8Array(33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(b.buffer).setUint32(16, w);
  new DataView(b.buffer).setUint32(20, h);
  return b;
};

describe("OOXML 구조 편집", () => {
  test("TC-ED-19 구조 목록: DOCX 표·그림, PPTX 슬라이드 번호, XLSX 시트 열 너비", () => {
    const d = ooxmlStructure("docx", site("sample.docx"));
    assert.equal(d.tables.length, 1);
    assert.deepEqual([d.tables[0].rows > 1, d.tables[0].cols, d.tables[0].merged], [true, 2, false]);
    assert.equal(Math.round(d.tables[0].widths.reduce((a, b) => a + b, 0)), 100);
    assert.deepEqual(d.tables[0].header, ["일차", d.tables[0].header[1]]);

    const di = ooxmlStructure("docx", fx("struct.docx"));
    assert.equal(di.images.length, 1);
    assert.deepEqual([di.images[0].media, di.images[0].mime, di.images[0].cx], ["word/media/image1.png", "image/png", 1905000]);

    const p = ooxmlStructure("pptx", fx("struct.pptx"));
    assert.deepEqual(p.tables.map((t) => [t.where, t.rows, t.cols, t.header.join("|")]), [["슬라이드 1", 2, 3, "머리1|머리2|머리3"]]);
    assert.deepEqual(p.images.map((i) => i.where), ["슬라이드 1", "슬라이드 2"]);

    const x = ooxmlStructure("xlsx", site("sample.xlsx"));
    assert.ok(x.sheets.length >= 2);
    assert.equal(x.sheets[0].widths.length, 26);
  });

  test("TC-ED-20 DOCX 표 행·열 넣기·빼기와 열 너비: 전체 너비 유지, 서식 유지, 다른 파트 바이트 동일", () => {
    const src = site("sample.docx");
    const t = ooxmlStructure("docx", src).tables[0];
    const body = "word/document.xml";

    const addRow = applyOoxmlOps("docx", src, [{ t: "tableRow", table: t.id, at: 1, op: "add" }]);
    sameExcept(src, addRow, [body]);
    const s1 = ooxmlStructure("docx", addRow).tables[0];
    assert.equal(s1.rows, t.rows + 1);
    const x1 = part(addRow, body);
    balanced(x1, ["w:tbl", "w:tr", "w:tc", "w:p"]);
    // 새 행은 서식(테두리)을 잇고 글자는 비어 있다
    const rows = x1.match(/<w:tr>[\s\S]*?<\/w:tr>/g)!;
    assert.match(rows[1], /<w:tcBorders>/);
    assert.doesNotMatch(rows[1], /<w:t>/);

    const delRow = applyOoxmlOps("docx", addRow, [{ t: "tableRow", table: t.id, at: 1, op: "remove" }]);
    assert.equal(part(delRow, body), part(src, body));

    const addCol = applyOoxmlOps("docx", src, [{ t: "tableCol", table: t.id, at: 2, op: "add" }]);
    const s2 = ooxmlStructure("docx", addCol).tables[0];
    assert.equal(s2.cols, 3);
    const grid = (d: Uint8Array) => [...part(d, body).matchAll(/<w:gridCol w:w="(\d+)"/g)].map((m) => Number(m[1]));
    assert.equal(grid(addCol).reduce((a, b) => a + b, 0), grid(src).reduce((a, b) => a + b, 0));
    // 칸 너비(tcW)도 그리드와 맞는다
    const firstRow = part(addCol, body).match(/<w:tr>[\s\S]*?<\/w:tr>/)![0];
    assert.deepEqual([...firstRow.matchAll(/<w:tcW w:w="(\d+)"/g)].map((m) => Number(m[1])), grid(addCol));

    const delCol = applyOoxmlOps("docx", addCol, [{ t: "tableCol", table: t.id, at: 2, op: "remove" }]);
    assert.equal(ooxmlStructure("docx", delCol).tables[0].cols, 2);
    assert.equal(grid(delCol).reduce((a, b) => a + b, 0), grid(src).reduce((a, b) => a + b, 0));

    const widths = applyOoxmlOps("docx", src, [{ t: "tableCols", table: t.id, widths: [70, 30] }]);
    assert.deepEqual(ooxmlStructure("docx", widths).tables[0].widths.map(Math.round), [70, 30]);
    assert.equal(grid(widths).reduce((a, b) => a + b, 0), grid(src).reduce((a, b) => a + b, 0));
  });

  test("TC-ED-21 PPTX 표 행·열: 행을 넣고 빼면 표 틀 높이(cy)가 같이 바뀌고, 새 칸은 txBody를 가진다", () => {
    const src = fx("struct.pptx");
    const t = ooxmlStructure("pptx", src).tables[0];
    const sl = "ppt/slides/slide1.xml";
    const cy = (d: Uint8Array) => Number(part(d, sl).match(/<p:graphicFrame>[\s\S]*?<a:ext cx="\d+" cy="(\d+)"/)![1]);
    const rowH = Number(part(src, sl).match(/<a:tr h="(\d+)"/)![1]);

    const added = applyOoxmlOps("pptx", src, [{ t: "tableRow", table: t.id, at: 2, op: "add" }]);
    sameExcept(src, added, [sl]);
    assert.equal(ooxmlStructure("pptx", added).tables[0].rows, 3);
    assert.equal(cy(added), cy(src) + rowH);
    const x = part(added, sl);
    balanced(x, ["a:tbl", "a:tr", "a:tc", "a:txBody", "a:p"]);
    const last = x.match(/<a:tr\b[\s\S]*?<\/a:tr>/g)!.pop()!;
    assert.equal((last.match(/<a:tc>/g) ?? []).length, 3);
    assert.match(last, /<a:txBody><a:bodyPr\/>/);
    assert.doesNotMatch(last, /<a:t>/);

    const removed = applyOoxmlOps("pptx", added, [{ t: "tableRow", table: t.id, at: 2, op: "remove" }]);
    assert.equal(part(removed, sl), part(src, sl));

    const col = applyOoxmlOps("pptx", src, [{ t: "tableCol", table: t.id, at: 0, op: "add" }]);
    const s = ooxmlStructure("pptx", col).tables[0];
    assert.equal(s.cols, 4);
    assert.equal(s.header[0], "");
    assert.equal(s.header[1], "머리1");
  });

  test("TC-ED-22 그림 교체: 같은 형식은 미디어만, 다른 형식은 새 파트·관계·형식 등록, 가로 유지 세로는 비율", () => {
    const src = fx("struct.docx");
    const img = ooxmlStructure("docx", src).images[0];
    const body = "word/document.xml";

    const same = applyOoxmlOps("docx", src, [{ t: "replaceImage", image: img.id, data: png(100, 100), mime: "image/png" }]);
    sameExcept(src, same, [body, img.media]);
    assert.deepEqual(unzipSync(same)[img.media], png(100, 100));
    assert.match(part(same, body), /<wp:extent cx="1905000" cy="1905000"\/>/);

    const other = applyOoxmlOps("docx", src, [{ t: "replaceImage", image: img.id, data: gif(40, 10), mime: "image/gif" }]);
    const z = unzipSync(other);
    assert.deepEqual(z["word/media/edit-1.gif"], gif(40, 10));
    assert.ok(z[img.media], "원래 미디어는 그대로 남는다");
    assert.match(part(other, "word/_rels/document.xml.rels"), /Id="rIdEdit1"[^>]*Target="media\/edit-1\.gif"/);
    assert.match(part(other, "[Content_Types].xml"), /<Default Extension="gif" ContentType="image\/gif"\/>/);
    assert.match(part(other, body), /<a:blip r:embed="rIdEdit1"/);
    assert.match(part(other, body), /cy="476250"/);
    assert.equal(ooxmlStructure("docx", other).images[0].media, "word/media/edit-1.gif");

    // PPTX: 같은 미디어를 두 슬라이드가 함께 쓰면 고친 슬라이드만 새 파트를 가리킨다
    const p = fx("struct.pptx");
    const imgs = ooxmlStructure("pptx", p).images;
    assert.equal(imgs[0].media, imgs[1].media);
    const out = applyOoxmlOps("pptx", p, [{ t: "replaceImage", image: imgs[0].id, data: png(10, 10), mime: "image/png" }]);
    const after = ooxmlStructure("pptx", out).images;
    assert.notEqual(after[0].media, imgs[0].media);
    assert.equal(after[1].media, imgs[1].media);
    assert.deepEqual(unzipSync(out)[imgs[1].media], unzipSync(p)[imgs[1].media]);
  });

  test("TC-ED-23 XLSX 열 너비: 범위 col을 나눠 그 열만 바꾸고, cols가 없으면 sheetData 앞에 만든다", () => {
    const src = site("sample.xlsx");
    const sheet = ooxmlStructure("xlsx", src).sheets[0];
    const out = applyOoxmlOps("xlsx", src, [{ t: "colWidth", sheet: sheet.id, col: 2, width: 30 }]);
    sameExcept(src, out, [sheet.id]);
    const after = ooxmlStructure("xlsx", out).sheets[0].widths;
    assert.equal(after[2], 30);
    after.forEach((w, i) => { if (i !== 2) assert.equal(w, sheet.widths[i], `${i}열`); });
    const xml = part(out, sheet.id);
    assert.ok(xml.indexOf("<cols>") < xml.indexOf("<sheetData"));

    // 한 번 더(이제 cols가 있다): 범위 안 열을 다시 바꾸고, 다른 열을 하나 더
    const twice = applyOoxmlOps("xlsx", out, [{ t: "colWidth", sheet: sheet.id, col: 2, width: 12 }, { t: "colWidth", sheet: sheet.id, col: 0, width: 5 }]);
    const w2 = ooxmlStructure("xlsx", twice).sheets[0].widths;
    assert.deepEqual([w2[0], w2[2]], [5, 12]);
    assert.equal(w2[1], sheet.widths[1]);
  });

  test("TC-ED-24 거부: 병합 칸 표의 행·열, 마지막 행 빼기, 없는 표(409), 형식 밖 연산, 빈 연산은 원본 그대로", () => {
    const src = fx("struct.pptx");
    const t = ooxmlStructure("pptx", src).tables[0];
    const status = (ops: OoxmlOp[], kind: "docx" | "pptx" | "xlsx" = "pptx", data: Uint8Array = src) => {
      try { applyOoxmlOps(kind, data, ops); return 0; } catch (e) { assert.ok(e instanceof StructEditError, String(e)); return e.status; }
    };
    const one = applyOoxmlOps("pptx", src, [{ t: "tableRow", table: t.id, at: 1, op: "remove" }]);
    assert.equal(status([{ t: "tableRow", table: t.id, at: 0, op: "remove" }], "pptx", one), 400);
    assert.equal(status([{ t: "tableRow", table: "ppt/slides/slide1.xml#t9", at: 0, op: "add" }]), 409);
    assert.equal(status([{ t: "tableCols", table: t.id, widths: [1, 2] }]), 400);
    assert.equal(status([{ t: "colWidth", sheet: "ppt/slides/slide1.xml", col: 0, width: 3 }]), 400);
    assert.equal(status([{ t: "replaceImage", image: ooxmlStructure("pptx", src).images[0].id, data: new Uint8Array([1, 2, 3]), mime: "image/png" }]), 400);
    assert.equal(status([{ t: "replaceImage", image: ooxmlStructure("pptx", src).images[0].id, data: png(1, 1), mime: "image/svg+xml" }]), 400);
    assert.equal(applyOoxmlOps("pptx", src, []), src);

    // 병합: 첫 행 두 칸을 gridSpan으로 합친 표
    const sl = "ppt/slides/slide1.xml";
    const z = unzipSync(src);
    z[sl] = new TextEncoder().encode(strFromU8(z[sl]).replace("<a:tc>", '<a:tc gridSpan="2">'));
    const mergedDoc = zipSync(z);
    const s = ooxmlStructure("pptx", mergedDoc).tables[0];
    assert.equal(s.merged, true);
    assert.equal(status([{ t: "tableCol", table: s.id, at: 0, op: "add" }], "pptx", mergedDoc), 400);
    assert.equal(status([{ t: "tableRow", table: s.id, at: 0, op: "add" }], "pptx", mergedDoc), 400);
    assert.equal(status([{ t: "tableCols", table: s.id, widths: [50, 25, 25] }], "pptx", mergedDoc), 0);
  });

  test("TC-ED-45 보안: 풀면 64MB를 넘는 zip(압축 폭탄)은 413, 연산이 500개를 넘으면 400", () => {
    const z = unzipSync(fx("struct.pptx"));
    z["ppt/media/huge.bin"] = new Uint8Array(70 * 1024 * 1024);
    const bomb = zipSync(z, { level: 9 });
    assert.ok(bomb.length < 2 * 1024 * 1024, `${bomb.length}`);
    const code = (fn: () => unknown) => { try { fn(); return 0; } catch (e) { assert.ok(e instanceof StructEditError, String(e)); return e.status; } };
    assert.equal(code(() => ooxmlStructure("pptx", bomb)), 413);
    assert.equal(code(() => applyOoxmlOps("pptx", bomb, [{ t: "tableRow", table: "x", at: 0, op: "add" }])), 413);
    const t = ooxmlStructure("pptx", fx("struct.pptx")).tables[0];
    assert.equal(code(() => applyOoxmlOps("pptx", fx("struct.pptx"), Array(501).fill({ t: "tableCols", table: t.id, widths: [1, 1, 1] }))), 400);
  });
});
