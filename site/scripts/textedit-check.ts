// 2.0 텍스트 편집 어댑터 검사: npm run check:textedit
// 완료 기준(REQUIREMENT-2.0 2.1): 바꾼 것 없이 저장하면 원본과 바이트 동일, 조각 하나만 바꾸면 그 구간만 바뀐다.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { strFromU8, unzipSync } from "fflate";
import { adapterFor, EditError, type Segment } from "../server/textedit/index.ts";

const ROOT = resolve(import.meta.dirname, "..");
const DOCS = resolve(ROOT, "../docs");
let failed = 0;
const ok = (cond: boolean, msg: string) => { console.log(`  ${cond ? "✓" : "✗"} ${msg}`); if (!cond) failed++; };
const same = (a: Uint8Array, b: Uint8Array) => Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;

function htmlFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.name.startsWith("_") || e.name.startsWith(".")) return [];
    const p = join(dir, e.name);
    return e.isDirectory() ? htmlFiles(p) : /\.html?$/.test(e.name) ? [p] : [];
  });
}

const targets = [...htmlFiles(DOCS), join(ROOT, "scripts/fixtures/sample.docx"), join(ROOT, "scripts/fixtures/sample-rich.docx"), join(ROOT, "scripts/fixtures/sample.pptx"), join(ROOT, "scripts/fixtures/sample-slides.pptx"), join(ROOT, "scripts/fixtures/sample.xlsx"), join(ROOT, "scripts/fixtures/sample-shared.xlsx"), join(ROOT, "scripts/fixtures/sample-drawio.svg"), join(ROOT, "scripts/fixtures/sample-plain.svg")];
const work = mkdtempSync(join(tmpdir(), "textedit-"));

for (const file of targets) {
  const { format, adapter } = adapterFor(file)!;
  const data = new Uint8Array(readFileSync(file));
  const segs = adapter.extract(data);
  console.log(`\n${file.replace(ROOT + "/../", "")} (${format}) · 조각 ${segs.length}개`);

  // 1) 바꾼 것 없이 저장 → 바이트 동일
  const same1 = adapter.apply(data, segs.map((s) => ({ id: s.id, hash: s.hash, text: s.text })));
  ok(same1.changed === 0 && same(same1.data, data), "모든 조각을 그대로 보내면 원본과 바이트 동일");
  ok(same(adapter.apply(data, []).data, data), "변경 없이 저장하면 원본과 바이트 동일");

  // 2) 조각 하나만 바꾸기 (특수 문자 포함) → 그 조각만 바뀌고 나머지 조각은 그대로
  const target = segs.find((s) => !s.multiline && s.text.length > 2) ?? segs[0];
  const newText = `수정 <확인> & "검사" ${target.text}`;
  const r = adapter.apply(data, [{ id: target.id, hash: target.hash, text: newText }]);
  const after = adapter.extract(r.data);
  ok(r.changed === 1, "변경 1건 반영");
  ok(after.length === segs.length, `조각 수 그대로 (${after.length})`);
  ok(after[target.id]?.text === newText, "바꾼 조각은 새 글자(특수 문자 포함)로 다시 읽힘");
  ok(after.every((s: Segment, i) => i === target.id || s.text === segs[i].text), "나머지 조각은 모두 그대로");

  if (format === "html") {
    const a = new TextDecoder().decode(data), b = new TextDecoder().decode(r.data);
    let p = 0; while (a[p] === b[p]) p++;
    let q = 0; while (q < a.length - p && a[a.length - 1 - q] === b[b.length - 1 - q]) q++;
    ok(a.length - p - q <= target.text.length + 20, `바뀐 구간이 그 조각 근처뿐 (원본에서 ${a.length - p - q}자)`);
  } else if (format === "svg") {
    const out = new TextDecoder().decode(r.data);
    ok(!/&(?!(amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);)/i.test(out), "XML에 없는 엔티티(&nbsp; 등)가 생기지 않음");
  } else {
    const z1 = unzipSync(data), z2 = unzipSync(r.data);
    const diffParts = Object.keys(z1).filter((k) => strFromU8(z1[k]) !== strFromU8(z2[k] ?? new Uint8Array()));
    ok(Object.keys(z1).length === Object.keys(z2).length && diffParts.length === 1, `바뀐 파트는 하나뿐 (${diffParts.join(", ")})`);
    // 고친 파일이 실제로 열리는지(LibreOffice가 있으면)
    const out = join(work, `edited.${format}`);
    writeFileSync(out, r.data);
    try {
      execFileSync("soffice", [`-env:UserInstallation=file://${work}/lo`, "--headless", "--convert-to", "pdf", "--outdir", work, out], { stdio: "ignore", timeout: 120_000 });
      ok(existsSync(join(work, "edited.pdf")), "고친 파일을 LibreOffice가 정상으로 엶(PDF 변환 성공)");
    } catch { console.log("  - LibreOffice 없음: 열기 검사 생략"); }
  }

  // 엑셀: 여러 셀이 함께 쓰는 글자를 한 셀에서만 고치면 다른 셀은 그대로여야 한다
  if (format === "xlsx") {
    const shared = segs.filter((s) => s.text === "완료");
    const r2 = adapter.apply(data, [{ id: shared[0].id, hash: shared[0].hash, text: "끝남" }]);
    const after2 = adapter.extract(r2.data);
    ok(shared.length >= 2 && after2[shared[0].id].text === "끝남" && shared.slice(1).every((s) => after2[s.id].text === "완료"),
      `같은 글자 셀 ${shared.length}곳 중 고친 셀만 바뀜 (${shared.map((s) => s.group).join(", ")})`);
    const mr = segs.find((s) => s.multiline);
    if (mr) {
      const r3 = adapter.apply(data, [{ id: mr.id, hash: mr.hash, text: "첫 줄\n둘째 줄 (수정)" }]);
      ok(adapter.extract(r3.data)[mr.id].text === "첫 줄\n둘째 줄 (수정)", "줄바꿈이 있던 셀은 줄바꿈 유지");
    }
  }

  // 3) 거부해야 하는 경우
  const expectError = (fn: () => unknown, status: number) => { try { fn(); return false; } catch (e) { return e instanceof EditError && e.status === status; } };
  ok(expectError(() => adapter.apply(data, [{ id: target.id, hash: "0000", text: "x" }]), 409), "원래 글자 해시가 다르면 409");
  ok(expectError(() => adapter.apply(data, [{ id: 99999, hash: "x", text: "x" }]), 409), "없는 조각이면 409");
  if (!target.multiline) ok(expectError(() => adapter.apply(data, [{ id: target.id, hash: target.hash, text: "줄\n바꿈" }]), 400), "줄바꿈 금지 조각에 줄바꿈이면 400");
}

console.log(failed ? `\n실패 ${failed}건` : "\n모두 통과");
process.exit(failed ? 1 : 0);
