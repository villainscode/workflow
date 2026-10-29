// 2.0 텍스트 편집 어댑터(HTML·DOCX·PPTX·XLSX). scripts/textedit-check.ts의 검사를 테스트로 옮기고 형식별 규칙을 더했다.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strFromU8, unzipSync } from "fflate";
import { adapterFor, EditError, type Segment } from "@workflow/core/textedit";
import { wrapForEdit } from "@workflow/core/textedit/html";
import { splitLines, svgAdapter, visualWidth, wrapSvgForEdit } from "@workflow/core/textedit/svg";
import { FIXTURES, HTML_DOC } from "./helpers.ts";

const same = (a: Uint8Array, b: Uint8Array) => Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;
const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);
const rejects = (fn: () => unknown, status: number) =>
  assert.throws(fn, (e: unknown) => e instanceof EditError && e.status === status);
const XML_BAD_ENTITY = /&(?!(amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);)/i;
const hasSoffice = (() => { try { execFileSync("which", ["soffice"], { stdio: "ignore" }); return true; } catch { return false; } })();

const SAMPLES: [string, Uint8Array][] = [
  ["inline.html", enc(HTML_DOC)],
  ...["sample.docx", "sample-rich.docx", "sample.pptx", "sample-slides.pptx", "sample.xlsx", "sample-shared.xlsx", "sample-drawio.svg", "sample-plain.svg"]
    .map((f): [string, Uint8Array] => [f, new Uint8Array(readFileSync(join(FIXTURES, f)))]),
];

// 모든 형식에 공통인 규칙
for (const [name, data] of SAMPLES) {
  describe(`TC-TE-공통 ${name}`, () => {
    const { format, adapter } = adapterFor(name)!;
    const segs = adapter.extract(data);
    const target = segs.find((s) => !s.multiline && s.text.length > 2) ?? segs[0];

    test("TC-TE-01 조각을 뽑는다(id는 0부터 순서대로)", () => {
      assert.ok(segs.length > 0);
      segs.forEach((s, i) => assert.equal(s.id, i));
      assert.deepEqual(adapter.extract(data).map((s) => s.hash), segs.map((s) => s.hash), "다시 뽑아도 같은 결과");
    });

    test("TC-TE-02 바꾼 것 없이 저장하면 원본과 바이트 동일", () => {
      assert.ok(same(adapter.apply(data, []).data, data));
      const r = adapter.apply(data, segs.map((s) => ({ id: s.id, hash: s.hash, text: s.text })));
      assert.equal(r.changed, 0);
      assert.ok(same(r.data, data));
    });

    test("TC-TE-03 조각 하나만 바꾸면 그 조각만 바뀐다(특수 문자 포함)", () => {
      const newText = `수정 <확인> & "검사" ${target.text}`;
      const r = adapter.apply(data, [{ id: target.id, hash: target.hash, text: newText }]);
      const after = adapter.extract(r.data);
      assert.equal(r.changed, 1);
      assert.equal(after.length, segs.length);
      assert.equal(after[target.id].text, newText);
      assert.ok(after.every((s: Segment, i) => i === target.id || s.text === segs[i].text), "나머지 조각 그대로");
      if (format === "svg") {
        assert.doesNotMatch(dec(r.data), XML_BAD_ENTITY, "XML에 없는 엔티티가 생기지 않음");
      } else if (format === "html") {
        const a = dec(data), b = dec(r.data);
        let p = 0; while (a[p] === b[p]) p++;
        let q = 0; while (q < a.length - p && a[a.length - 1 - q] === b[b.length - 1 - q]) q++;
        assert.ok(a.length - p - q <= target.text.length + 20, `바뀐 구간이 조각 근처뿐 (${a.length - p - q}자)`);
      } else {
        const z1 = unzipSync(data), z2 = unzipSync(r.data);
        const diff = Object.keys(z1).filter((k) => strFromU8(z1[k]) !== strFromU8(z2[k] ?? new Uint8Array()));
        assert.equal(Object.keys(z2).length, Object.keys(z1).length, "zip 파트 수 그대로");
        assert.equal(diff.length, 1, `바뀐 파트 하나뿐: ${diff.join(", ")}`);
      }
    });

    test("TC-TE-04 원래 글자 해시가 다르거나 없는 조각이면 409", () => {
      rejects(() => adapter.apply(data, [{ id: target.id, hash: "0000", text: "x" }]), 409);
      rejects(() => adapter.apply(data, [{ id: 99999, hash: "x", text: "x" }]), 409);
    });

    test("TC-TE-05 줄바꿈이 허용되지 않은 조각에 줄바꿈이면 400", () => {
      rejects(() => adapter.apply(data, [{ id: target.id, hash: target.hash, text: "줄\n바꿈" }]), 400);
    });

    test("TC-TE-06 고친 파일을 LibreOffice가 연다(PDF 변환)", { skip: format === "html" || format === "svg" || !hasSoffice ? "HTML·SVG이거나 LibreOffice 없음" : false, timeout: 180_000 }, () => {
      const work = mkdtempSync(join(tmpdir(), "textedit-"));
      const out = join(work, `edited.${format}`);
      writeFileSync(out, adapter.apply(data, [{ id: target.id, hash: target.hash, text: "열기 검사" }]).data);
      execFileSync("soffice", [`-env:UserInstallation=file://${work}/lo`, "--headless", "--convert-to", "pdf", "--outdir", work, out], { stdio: "ignore", timeout: 170_000 });
      assert.ok(existsSync(join(work, "edited.pdf")));
    });
  });
}

describe("TC-TE-HTML HTML 규칙", () => {
  const { adapter } = adapterFor("x.html")!;
  const data = enc(HTML_DOC);
  const segs = adapter.extract(data);
  const find = (t: string) => segs.find((s) => s.text === t)!;

  test("TC-TE-HTML-01 head·script 글자는 조각이 아니고, 태그로 나뉜 글자는 따로 조각이 된다", () => {
    assert.ok(!segs.some((s) => s.text.includes("스크립트") || s.text === "샘플 문서"));
    assert.ok(find("코드 리뷰는") && find("D7") && find("에 처음 한다."));
    assert.equal(find("D7").group, "strong");
  });

  test("TC-TE-HTML-02 앞뒤 공백(들여쓰기)은 편집 구간 밖에 남고, &nbsp;·엔티티는 지킨다", () => {
    const s = segs.find((x) => x.text.startsWith("배포는"))!;
    assert.equal(s.text, "배포는 D14에 한다. & 기호와  공백을 지킨다.");
    const out = dec(adapter.apply(data, [{ id: s.id, hash: s.hash, text: s.text.replace("D14", "D15") }]).data);
    assert.match(out, /\n  <p>배포는 D15에 한다\. &amp; 기호와 &nbsp;공백을 지킨다\.<\/p>\n/);
  });

  test("TC-TE-HTML-03 pre 안은 줄바꿈을 허용한다", () => {
    const s = segs.find((x) => x.multiline)!;
    assert.equal(s.group, "pre");
    const out = dec(adapter.apply(data, [{ id: s.id, hash: s.hash, text: "하나\n둘\n셋" }]).data);
    assert.match(out, /<pre>하나\n둘\n셋<\/pre>/);
  });

  test("TC-TE-HTML-04 SVG 글자는 svg 표시가 붙는다", () => {
    assert.equal(find("게이트 판정").svg, true);
    assert.equal(find("그림 설명").svg, true);
  });

  test("TC-TE-HTML-05 편집용 사본: 조각을 data-seg로 감싸고 <base>를 넣는다(SVG는 tspan, title은 감싸지 않음)", () => {
    const view = wrapForEdit(data, "/files/m/d/v0.0/");
    assert.match(view, /<head><base href="\/files\/m\/d\/v0\.0\/">/);
    assert.match(view, new RegExp(`<span data-seg="${find("D7").id}">D7</span>`));
    assert.match(view, new RegExp(`<tspan data-seg="${find("게이트 판정").id}">게이트 판정</tspan>`));
    assert.doesNotMatch(view, new RegExp(`data-seg="${find("그림 설명").id}"`));
  });
});

describe("TC-TE-OOXML DOCX·PPTX·XLSX 규칙", () => {
  test("TC-TE-DOCX-01 DOCX 조각에 영역·문단 묶음과 서식 힌트(fmt)가 있다", () => {
    const segs = adapterFor("x.docx")!.adapter.extract(new Uint8Array(readFileSync(join(FIXTURES, "sample-rich.docx"))));
    assert.ok(segs.every((s) => s.group.length > 0));
    assert.ok(segs.some((s) => s.fmt), "굵게·기울임·밑줄 힌트가 있는 조각");
  });

  test("TC-TE-PPTX-01 PPTX 묶음은 발표 순서의 슬라이드 번호를 쓴다", () => {
    const segs = adapterFor("x.pptx")!.adapter.extract(new Uint8Array(readFileSync(join(FIXTURES, "sample-slides.pptx"))));
    const nums = segs.map((s) => Number(/(\d+)/.exec(s.group)?.[1])).filter((n) => !Number.isNaN(n));
    assert.ok(nums.length > 0);
    assert.deepEqual(nums, [...nums].sort((a, b) => a - b), "슬라이드 번호 순서대로 뽑힘");
  });

  test("TC-TE-XLSX-01 여러 셀이 함께 쓰는 문자열은 고친 셀만 바뀐다", () => {
    const { adapter } = adapterFor("x.xlsx")!;
    const data = new Uint8Array(readFileSync(join(FIXTURES, "sample-shared.xlsx")));
    const segs = adapter.extract(data);
    const shared = segs.filter((s) => s.text === "완료");
    assert.ok(shared.length >= 2, "같은 글자 셀이 2곳 이상인 샘플");
    const after = adapter.extract(adapter.apply(data, [{ id: shared[0].id, hash: shared[0].hash, text: "끝남" }]).data);
    assert.equal(after[shared[0].id].text, "끝남");
    shared.slice(1).forEach((s) => assert.equal(after[s.id].text, "완료"));
  });

  test("TC-TE-XLSX-02 원래 줄바꿈이 있던 셀은 줄바꿈을 허용한다", () => {
    const { adapter } = adapterFor("x.xlsx")!;
    for (const f of ["sample.xlsx", "sample-shared.xlsx"]) {
      const data = new Uint8Array(readFileSync(join(FIXTURES, f)));
      const mr = adapter.extract(data).find((s) => s.multiline);
      if (!mr) continue;
      const r = adapter.apply(data, [{ id: mr.id, hash: mr.hash, text: "첫 줄\n둘째 줄" }]);
      assert.equal(adapter.extract(r.data)[mr.id].text, "첫 줄\n둘째 줄");
      return;
    }
    assert.fail("줄바꿈 셀이 있는 샘플이 없습니다");
  });

  test("TC-TE-07 지원하지 않는 형식은 어댑터가 없다", () => {
    assert.equal(adapterFor("a.md"), null);
    assert.equal(adapterFor("a.pdf"), null);
    assert.equal(adapterFor("A.HTML")?.format, "html", "확장자 대소문자 무시");
  });
});

describe("TC-TE-SVG SVG 규칙", () => {
  const drawio = new Uint8Array(readFileSync(join(FIXTURES, "sample-drawio.svg")));
  const plain = new Uint8Array(readFileSync(join(FIXTURES, "sample-plain.svg")));
  const dsegs = svgAdapter.extract(drawio);
  const psegs = svgAdapter.extract(plain);
  const tspans = (xml: string, from: number) => {
    const i = xml.indexOf("<text", from);
    return [...xml.slice(i, xml.indexOf("</text>", i)).matchAll(/<tspan[^>]*>([^<]*)<\/tspan>/g)].map((m) => m[1]);
  };

  test("TC-TE-SVG-01 draw.io SVG는 HTML 글자만 조각이 되고(예비 글자 제외), 묶음 이름은 칸 id다", () => {
    assert.equal(dsegs.filter((s) => s.text === "tokens 모듈").length, 1, "같은 글자가 두 벌 있어도 조각은 하나");
    assert.equal(dsegs[0].group, "s-0-0-tokens");
    assert.ok(dsegs.every((s) => !s.svg));
  });

  test("TC-TE-SVG-02 HTML 글자를 고치면 예비 글자(<text>)도 원래 줄 수에 맞춰 나눠 바뀐다", () => {
    const desc = dsegs.find((s) => s.text.startsWith("iframe 로그인의"))!;
    const xml0 = dec(drawio);
    const before = tspans(xml0, xml0.indexOf("iframe 로그인의"));
    assert.equal(before.length, 3, "auth_codes 예비 글자는 3줄(제목 1 + 설명 2)");
    const text = "iframe 로그인에서 한 번만 쓰는 코드(60초)와 비밀번호 단계용 표(10분)";
    const xml = dec(svgAdapter.apply(drawio, [{ id: desc.id, hash: desc.hash, text }]).data);
    const after = tspans(xml, xml.indexOf("iframe 로그인에서"));
    assert.equal(after.length, 3, "줄 수 그대로");
    assert.equal(after[0], "auth_codes", "바꾸지 않은 줄(제목)은 그대로");
    assert.equal(after.slice(1).join(" ").replace(/\s+/g, " "), text, "나머지 줄을 이으면 새 글자");
    assert.ok(after[1].length > after[2].length, "원래처럼 첫 줄이 길고 둘째 줄이 짧다(원래 줄 길이 비율)");
    assert.equal(svgAdapter.extract(new TextEncoder().encode(xml))[desc.id].text, text);
  });

  test("TC-TE-SVG-03 특수 문자와 줄바꿈 없는 공백(U+00A0)을 XML 방식으로 쓴다(&nbsp; 없음)", () => {
    const t = dsegs.find((s) => s.text.includes("\u00a0"))!;
    const xml = dec(svgAdapter.apply(drawio, [{ id: t.id, hash: t.hash, text: t.text + "\u00a0& <확인>" }]).data);
    assert.doesNotMatch(xml, XML_BAD_ENTITY);
    assert.ok(xml.includes("&amp; &lt;확인&gt;"));
  });

  test("TC-TE-SVG-04 글자가 원래 줄보다 눈에 띄게 길어지면 경고, 비슷하면 경고 없음", () => {
    const desc = dsegs.find((s) => s.text.startsWith("iframe 로그인의"))!;
    const long = svgAdapter.apply(drawio, [{ id: desc.id, hash: desc.hash, text: "아주 긴 설명 ".repeat(20) }]);
    assert.equal(long.warnings?.length, 1);
    assert.match(long.warnings![0], new RegExp(`^\\[${desc.id}\\].*넘칠 수 있습니다`));
    const short = svgAdapter.apply(drawio, [{ id: desc.id, hash: desc.hash, text: "iframe 로그인의 1회용 코드(60초) · 비밀번호 단계용 표(9분)" }]);
    assert.deepEqual(short.warnings, []);
  });

  test("TC-TE-SVG-05 일반 SVG: <text>·<tspan> 글자가 조각(svg 표시), title·desc·style은 제외, 길어지면 경고", () => {
    assert.deepEqual(psegs.map((s) => s.text), ["빌드 & 배포", "첫 줄", "둘째 줄 R&D", "게이트 판정"]);
    assert.ok(psegs.every((s) => s.svg));
    const s = psegs[2];
    const r = svgAdapter.apply(plain, [{ id: s.id, hash: s.hash, text: "둘째 줄 R&D 그리고 훨씬 더 긴 글자" }]);
    assert.match(dec(r.data), /<tspan x="20" dy="16">둘째 줄 R&amp;D 그리고 훨씬 더 긴 글자<\/tspan>/);
    assert.equal(r.warnings?.length, 1);
  });

  test("TC-TE-SVG-06 편집용 사본: HTML 글자는 <span data-seg>, SVG 글자는 <tspan data-seg>, XML로 유효", () => {
    const v1 = wrapSvgForEdit(drawio);
    assert.ok(v1.includes(`<span data-seg="0">tokens 모듈</span>`));
    assert.doesNotMatch(v1, XML_BAD_ENTITY);
    const v2 = wrapSvgForEdit(plain);
    assert.ok(v2.includes(`<tspan data-seg="0">빌드 &amp; 배포</tspan>`));
    assert.ok(!v2.includes("data-seg=\"4\""), "title·desc는 감싸지 않음");
  });

  test("TC-TE-SVG-07 줄 나누기: 줄 수 고정, 원래 폭 비율, 공백에서 끊으면 공백은 버림", () => {
    assert.deepEqual(splitLines("가나다", 1, [10]), ["가나다"]);
    const out = splitLines("하나 둘 셋 넷 다섯 여섯", 2, [10, 10]);
    assert.equal(out.length, 2);
    assert.equal(out.join(" "), "하나 둘 셋 넷 다섯 여섯");
    assert.equal(splitLines("ab", 3, [1, 1, 1]).length, 3, "글자가 짧아도 줄 수는 그대로(빈 줄 허용)");
    assert.equal(visualWidth("가a"), 3);
  });
});
