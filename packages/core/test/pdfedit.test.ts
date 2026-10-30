import { before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { decodePDFRawStream, PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream, StandardFonts, type PDFRef } from "pdf-lib";
import { applyPdfOps, listPdfFields, loadHbSubset, PdfEditError, subsetFont, type HbSubset, type PdfOp } from "../src/pdfedit/index.ts";

/** 5.0 M6: PDF 편집(덧그리기·페이지·양식, 한글 부분 글꼴). 케이스 목록은 spec/TESTING.md 2.8 */

const here = resolve(import.meta.dirname);
const FONT = new Uint8Array(readFileSync(join(here, "../../../site/web/public/fonts/NanumGothic-Regular.ttf")));
const WASM = readFileSync(join(createRequire(import.meta.url).resolve("harfbuzzjs").replace(/index\.mjs$/, ""), "harfbuzz-subset.wasm"));
let hb: HbSubset;
before(async () => { hb = await loadHbSubset(WASM); });
const font = async (text: string) => subsetFont(hb, FONT, text);

/** 크기가 다른 3쪽(순서 확인용) + 양식(글자·체크·목록) */
async function sample() {
  const doc = await PDFDocument.create();
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  for (const [w, h] of [[600, 800], [610, 800], [620, 800]]) {
    const p = doc.addPage([w, h]);
    p.drawText(`page ${w}`, { x: 50, y: 700, size: 20, font: helv });
  }
  const form = doc.getForm();
  form.createTextField("name").addToPage(doc.getPage(0), { x: 50, y: 600, width: 200, height: 24 });
  form.createCheckBox("agree").addToPage(doc.getPage(0), { x: 50, y: 560, width: 16, height: 16 });
  const dd = form.createDropdown("team");
  dd.addOptions(["platform", "app"]);
  dd.addToPage(doc.getPage(0), { x: 50, y: 520, width: 120, height: 24 });
  return doc.save();
}
const widths = async (b: Uint8Array) => (await PDFDocument.load(b)).getPages().map((p) => p.getWidth());
/** 그 쪽 내용 스트림(압축 풀어) 글자로 */
function pageContent(doc: PDFDocument, i: number): string {
  const c = doc.getPage(i).node.Contents();
  const refs = c instanceof PDFArray ? c.asArray() : [c];
  return refs.map((r) => {
    const s = doc.context.lookup(r as PDFRef);
    return s instanceof PDFRawStream ? new TextDecoder("latin1").decode(decodePDFRawStream(s).decode()) : "";
  }).join("\n");
}

describe("PDF 편집", () => {
  test("TC-ED-38 부분 글꼴: 쓴 글자만 남겨 작고(원본 2MB → 수백 KB 이하), 한글 글상자를 그린 PDF에 그 글꼴 하나만 들어간다", async () => {
    const sub = await font("한글 글상자");
    assert.ok(sub.length < FONT.length / 10, `${sub.length}`);
    const out = await applyPdfOps(await sample(), [{ t: "text", page: 0, x: 50, y: 750, size: 18, text: "한글 글상자\n둘째 줄", color: "#0e6b57" }], { font });
    assert.ok(out.length < 60_000, `${out.length}`);
    const doc = await PDFDocument.load(out);
    const fonts = doc.context.enumerateIndirectObjects().filter(([, o]) => (o as { get?: (k: PDFName) => unknown }).get?.(PDFName.of("FontFile2")));
    assert.equal(fonts.length, 1);
    await assert.rejects(applyPdfOps(await sample(), [{ t: "text", page: 0, x: 0, y: 0, size: 12, text: "가" }]), /글꼴이 필요합니다/);
  });

  test("TC-ED-39 덧그리기(글상자·그림·형광펜·펜)는 그 쪽 내용에 더해지고, 회전된 쪽은 회전만큼 돌려 그린다", async () => {
    const png = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
    const base = await sample();
    const ops: PdfOp[] = [
      { t: "rotate", page: 1, by: 90 },
      { t: "text", page: 1, x: 100, y: 100, size: 12, text: "돌린 쪽" },
      { t: "image", page: 0, x: 300, y: 700, width: 100, height: 50, data: png, mime: "image/png" },
      { t: "rect", page: 0, x: 40, y: 720, width: 200, height: 30 },
      { t: "ink", page: 0, strokes: [[[10, 10], [20, 30], [40, 35]], [[100, 100]]], width: 3 },
    ];
    const out = await applyPdfOps(base, ops, { font });
    const doc = await PDFDocument.load(out);
    assert.equal(doc.getPage(1).getRotation().angle, 90);
    const p0 = pageContent(doc, 0), p1 = pageContent(doc, 1);
    assert.match(p0, /\/Image-?\w* Do/, "그림");
    assert.match(p0, /1 0 0 1 40 690 cm[\s\S]*?h\s+f/, "형광펜 사각형(화면 왼쪽 위 720 → 아래 꼭짓점 690)");
    assert.match(p0, / l\s/, "펜 선");
    assert.match(p1, /Tj/, "돌린 쪽 글상자");
    // 90도 돌린 쪽의 글자는 반시계 90도 회전 행렬(cos≈0, sin=1)로 그린다
    assert.match(p1, /[\d.e-]+ 1 -1 [\d.e-]+ [\d.]+ [\d.]+ (cm|Tm)/);
    // 형광펜은 곱하기 섞기(아래 글자가 비친다)
    const gs = doc.getPage(0).node.Resources()!.lookup(PDFName.of("ExtGState"), PDFDict);
    assert.ok(gs.values().some((v) => String((doc.context.lookup(v) as PDFDict).get(PDFName.of("BM"))) === "/Multiply"));
  });

  test("TC-ED-40 페이지: 회전(누적)·지우기·옮기기·다른 PDF 끼워 넣기, 범위 밖은 400, 마지막 쪽은 못 지운다", async () => {
    const base = await sample();
    assert.deepEqual(await widths(base), [600, 610, 620]);
    const moved = await applyPdfOps(base, [{ t: "movePage", from: 2, to: 0 }]);
    assert.deepEqual(await widths(moved), [620, 600, 610]);
    const del = await applyPdfOps(base, [{ t: "deletePage", page: 1 }]);
    assert.deepEqual(await widths(del), [600, 620]);
    const other = await PDFDocument.create();
    other.addPage([300, 300]); other.addPage([301, 300]);
    const ins = await applyPdfOps(base, [{ t: "insertPdf", at: 1, data: await other.save() }]);
    assert.deepEqual(await widths(ins), [600, 300, 301, 610, 620]);
    const rot = await applyPdfOps(base, [{ t: "rotate", page: 0, by: -90 }, { t: "rotate", page: 0, by: 180 }]);
    assert.equal((await PDFDocument.load(rot)).getPage(0).getRotation().angle, 90);
    const status = async (ops: PdfOp[], b = base) => { try { await applyPdfOps(b, ops); return 0; } catch (e) { assert.ok(e instanceof PdfEditError, String(e)); return e.status; } };
    assert.equal(await status([{ t: "deletePage", page: 3 }]), 400);
    assert.equal(await status([{ t: "movePage", from: 0, to: 5 }]), 400);
    assert.equal(await status([{ t: "rotate", page: 0, by: 45 as 90 }]), 400);
    assert.equal(await status([{ t: "insertPdf", at: 0, data: new TextEncoder().encode("not pdf") }]), 400);
    const one = await applyPdfOps(base, [{ t: "deletePage", page: 0 }, { t: "deletePage", page: 0 }]);
    assert.equal(await status([{ t: "deletePage", page: 0 }], one), 400);
    assert.equal(await applyPdfOps(base, []), base);
  });

  test("TC-ED-41 양식: 칸 목록, 한글 글자·체크·목록 채우기(우리 글꼴로 칸 모양), 없는 칸은 400", async () => {
    const base = await sample();
    assert.deepEqual((await listPdfFields(base)).map((f) => [f.name, f.type, f.value]), [["name", "text", ""], ["agree", "checkbox", false], ["team", "dropdown", null]]);
    const out = await applyPdfOps(base, [{ t: "fill", values: { name: "홍길동(예시)", agree: true, team: "app" } }], { font });
    assert.deepEqual((await listPdfFields(out)).map((f) => f.value), ["홍길동(예시)", true, "app"]);
    await assert.rejects(applyPdfOps(base, [{ t: "fill", values: { nope: "x" } }], { font }), /양식 칸이 없습니다: nope/);
  });
});
