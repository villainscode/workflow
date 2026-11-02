import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sanitizeSvg, scopeSvg, svgForEditor, tidySvgEdit } from "../src/svg.ts";
import { validateStyle } from "../src/slide/css.ts";
import { sanitizeInline as slideInline } from "../src/slide/parse.ts";
import { checkDocStyle } from "../src/structedit/docstyle.ts";
import {
  editorConfig, handleCallback, keepAlive, MAX_SESSION, openSession, readCapped, releaseSession, sessionLocked, signJwt, verifyCallback, verifyJwt,
  type OfficeSession, type OfficeSessions,
} from "../src/office.ts";
import { saveRevision, sha256Hex, workState, type DocStore, type Manifest } from "../src/work/index.ts";

/** 6.0 V6 보안 점검(2026-11-02)에서 찾은 문제의 재현 테스트. 케이스 목록은 spec/TESTING.md 2.11, 기록은 5절 */

describe("V6 보안 점검", () => {
  test("TC-SEC-01 (중간) SVG CSS의 image-set()·-webkit-image-set()·src()·cross-fade()·element()·paint()로 바깥 주소를 부르지 못한다(style 속성·<style>·foreignObject 안 style)", () => {
    const attacks = [
      `<svg xmlns="http://www.w3.org/2000/svg"><foreignObject width="10" height="10"><div xmlns="http://www.w3.org/1999/xhtml" style="background-image:image-set('https://evil.test/p.png' 1x)">a</div></foreignObject></svg>`,
      `<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1" style="cursor:image-set('https://evil.test/p.png' 1x),auto"/></svg>`,
      `<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1" style="list-style-image:src('https://evil.test/x')"/></svg>`,
      `<svg xmlns="http://www.w3.org/2000/svg"><style>rect{background:image-set("http://evil.test/a" 1x)}</style><rect width="1" height="1"/></svg>`,
      `<svg xmlns="http://www.w3.org/2000/svg"><style>rect{background:-webkit-image-set("//evil.test/a" 1x)}</style></svg>`,
      `<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1" style="mask-image:cross-fade(url(#a), 'https://evil.test/b' 50%)"/></svg>`,
      `<svg xmlns="http://www.w3.org/2000/svg"><style>@font-face{font-family:x;src:local(x),"https://evil.test/f.woff"}</style></svg>`,
      // 주석으로 함수 이름을 끊어도 주석을 지운 뒤 판정한다
      `<svg xmlns="http://www.w3.org/2000/svg"><style>rect{background:image/**/-set("https://evil.test/c" 1x)}</style></svg>`,
    ];
    for (const a of attacks) {
      const r = sanitizeSvg(a);
      assert.doesNotMatch(r.svg, /evil\.test/, `남음: ${r.svg}`);
      assert.ok(r.removed.length > 0, `진단 없음: ${a}`);
    }
    // 허용 함수(색·변형·#id 참조)와 따옴표 글꼴 이름은 그대로
    const ok = `<svg xmlns="http://www.w3.org/2000/svg"><style>.a{fill:rgb(1,2,3);transform:translate(2px,3px) rotate(4deg);font-family:"Noto Sans KR",sans-serif;clip-path:url(#c)}</style><rect width="1" height="1" style="fill:hsl(10 50% 50%);stroke:var(--line)"/></svg>`;
    const r = sanitizeSvg(ok);
    assert.deepEqual(r.removed, []);
    assert.match(r.svg, /translate\(2px,3px\) rotate\(4deg\)/);
    assert.match(r.svg, /fill:hsl\(10 50% 50%\);stroke:var\(--line\)/);
  });

  test("TC-SEC-02 (중간) font-family 검사가 지수 시간이 걸리지 않는다(32자 + 맞지 않는 글자 → 10ms 안에 거부, 덱·HTML·글자 span 모든 경로). 200자 넘는 값은 거부", () => {
    const evil = `${"a".repeat(32)}!`;
    for (const [label, run] of [
      ["validateStyle", () => validateStyle("font-family", evil)],
      ["checkDocStyle", () => checkDocStyle("font-family", evil)],
      ["slide span", () => slideInline(`<span style="font-family:${evil}">x</span>`, [])],
    ] as const) {
      const t0 = performance.now();
      run();
      assert.ok(performance.now() - t0 < 10, `${label}: ${(performance.now() - t0).toFixed(1)}ms`);
    }
    assert.ok(validateStyle("font-family", evil));
    assert.ok(validateStyle("font-family", `"${"가".repeat(250)}"`), "200자 넘는 값");
    for (const v of [`"Noto Sans KR", Pretendard, sans-serif`, `Inter Tight, Arial`, `'IBM Plex Sans KR',system-ui`, `serif`])
      assert.equal(validateStyle("font-family", v), null, v);
  });

  test("TC-SEC-04 (낮음) 인라인 SVG <style> 범위 좁히기: 주석으로 접두어를 삼키거나 중첩 규칙으로 문서 전체에 거는 CSS는 지운다", () => {
    for (const css of ["/*{}*/ body{background:red}", "body{x{c:d}background:red}", "a{b:c}} body{background:red}", `rect{content:"}"} body{background:red}`]) {
      const r = scopeSvg(`<svg xmlns="http://www.w3.org/2000/svg"><style>${css}</style><rect width="1" height="1"/></svg>`, "svg1");
      const style = /<style>([\s\S]*?)<\/style>|<style\/>/.exec(r.svg)?.[1] ?? "";
      // 남은 모든 규칙의 선택자는 #svg1로 시작해야 한다
      for (const m of style.matchAll(/([^{}]+)\{/g)) for (const sel of m[1].split(",")) assert.match(sel.trim(), /^#svg1(\s|$)/, `${css} → ${style}`);
      assert.doesNotMatch(style, /(^|})\s*body/, `${css} → ${style}`);
    }
    // 보통 규칙은 그대로 좁힌다
    assert.match(scopeSvg(`<svg xmlns="http://www.w3.org/2000/svg"><style>/* 색 */ .a, rect{fill:red}</style></svg>`, "svg1").svg, /#svg1 \.a,#svg1 rect\{fill:red\}/);
  });
});

describe("V6 보안 점검: svgedit", () => {
  test("TC-SEC-03 (중간) svgedit에 올리기 전 SVG를 소독하고 <style>을 편집 뿌리(#svgcontent) 아래로 좁힌다. 꺼내면 범위를 뗀다", () => {
    const evil = `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><style>body{position:fixed;inset:0} .st0{fill:red}</style>`
      + `<script>alert(1)</script><a href="javascript:alert(1)"><rect class="st0" width="5" height="5" onclick="x()"/></a></svg>`;
    const r = svgForEditor(evil);
    assert.doesNotMatch(r.svg, /script|javascript:|onclick/);
    assert.match(r.svg, /<style>#svgcontent body\{position:fixed;inset:0\}#svgcontent \.st0\{fill:red\}<\/style>/);
    assert.match(svgForEditor(`<svg xmlns="http://www.w3.org/2000/svg"><style>/*{}*/ body{x{a:b}}</style></svg>`).svg, /<style\/>/);
    // svgcanvas가 꺼낸 글(뿌리 svgcontent 그대로) → 범위를 떼서 원래 규칙으로
    assert.match(tidySvgEdit(`<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><style>#svgcontent .st0{fill:red}</style></svg>`), /<style>\.st0\{fill:red\}<\/style>/);
  });
});

// ---------- 오피스(낮음 7·8·9) ----------

const SECRET = "office-secret";
const docx = readFileSync(join(import.meta.dirname, "fixtures/struct.docx"));
async function setup() {
  const blobs = new Map<string, Uint8Array>();
  const revs = new Map<number, string>();
  let head: { rev: number; baseVersion: string } | null = null;
  let session: OfficeSession | null = null;
  const sessions: OfficeSessions = {
    get: async () => session,
    put: async (s) => { session = s; },
    remove: async (key) => { if (session?.key === key) session = null; },
  };
  const sha = await sha256Hex(docx);
  blobs.set(sha, docx);
  const v0: Manifest = { entry: "r.docx", files: [{ path: "r.docx", sha256: sha, size: docx.byteLength, mime: "application/octet-stream" }] };
  const store: DocStore = {
    currentVersion: "v0.0",
    head: async () => head,
    revision: async (rev) => (revs.has(rev) ? { id: rev, manifestSha: revs.get(rev)! } : null),
    version: async (v) => (v === "v0.0" ? v0 : null),
    getBlob: async (s) => blobs.get(s)!,
    putBlob: async (s, d) => { blobs.set(s, d); },
    hasBlob: async (s) => blobs.has(s),
    addRevision: async (r) => { revs.set(r.rev, r.manifestSha); head = { rev: r.rev, baseVersion: r.baseVersion }; },
    locked: () => sessionLocked(sessions),
  };
  return { store, sessions, getSession: () => session, setSession: (s: OfficeSession | null) => { session = s; } };
}
const edited = new Uint8Array([...docx, 9, 9]);
const opts = (key: string, now?: number) => ({ expectedKey: key, officeOrigin: "https://office.test", download: async () => edited, ...(now ? { now } : {}) });

describe("V6 보안 점검: 오피스", () => {
  test("TC-SEC-07 (낮음) 늦게 온 저장 콜백(세션이 끝났거나, 그 사이 다른 수정본이 쌓임)은 덮어쓰지 않고 거부를 알린다. 강제 저장(6) 뒤 닫힘(2)은 이어서 저장", async () => {
    // 세션이 만료된 뒤 다른 사람이 수정본을 쌓았다 → 늦은 status 2는 저장하지 않는다
    const a = await setup();
    const s = await openSession(a.store, a.sessions, { scope: "w1d2", mode: "edit", userId: 7 });
    const later = Date.now() + 16 * 60_000;
    a.setSession({ ...a.getSession()!, expiresAt: Date.now() - 1 });
    await saveRevision(a.store, { baseRev: 0, put: [{ path: "r.docx", data: new Uint8Array([1, 2, 3]) }], source: "human" });
    const r = await handleCallback(a.store, a.sessions, { key: s.key, status: 2, url: "https://office.test/f" }, opts(s.key, later));
    assert.equal(r.saved, undefined);
    assert.ok(r.rejected, "거부 이유");
    assert.equal((await workState(a.store)).rev, 1, "다른 사람 수정본이 head로 남는다");
    // 세션이 없어도(풀린 뒤) 거부
    const b = await setup();
    const sb = await openSession(b.store, b.sessions, { scope: "w1d2", mode: "edit", userId: 7 });
    b.setSession(null);
    assert.ok((await handleCallback(b.store, b.sessions, { key: sb.key, status: 2, url: "https://office.test/f" }, opts(sb.key))).rejected);
    // 강제 저장(6) → 닫힘(2)은 같은 세션이라 둘 다 저장된다
    const c = await setup();
    const sc = await openSession(c.store, c.sessions, { scope: "w1d2", mode: "edit", userId: 7 });
    assert.equal((await handleCallback(c.store, c.sessions, { key: sc.key, status: 6, url: "https://office.test/f" }, opts(sc.key))).saved?.rev, 1);
    const closed = await handleCallback(c.store, c.sessions, { key: sc.key, status: 2, url: "https://office.test/f" }, { ...opts(sc.key), download: async () => new Uint8Array([...edited, 1]) });
    assert.equal(closed.saved?.rev, 2);
    assert.equal(closed.rejected, undefined);
    // 다운로드 상한: content-length가 없어도 읽으며 센다
    const stream = () => new Response(new ReadableStream({ pull(ctl) { ctl.enqueue(new Uint8Array(4)); } }));
    await assert.rejects(readCapped(stream(), 10), /너무 큽니다/);
    assert.equal((await readCapped(new Response(new Uint8Array(8)), 10)).byteLength, 8);
  });

  test("TC-SEC-08 (낮음) 편집 세션은 최대 길이(MAX_SESSION)를 넘겨 연장하지 못하고, 잠금은 풀 수 있다(releaseSession)", async () => {
    const a = await setup();
    const s = await openSession(a.store, a.sessions, { scope: "w1d2", mode: "edit", userId: 7 });
    const start = a.getSession()!.startedAt;
    assert.equal(typeof start, "number");
    assert.equal(await keepAlive(a.sessions, s.key, start + 60_000), true);
    // 연장 시각이 최대 길이를 넘으면 거기서 끊는다
    a.setSession({ ...a.getSession()!, expiresAt: start + MAX_SESSION + 1000 });
    assert.equal(await keepAlive(a.sessions, s.key, start + MAX_SESSION + 1), false);
    assert.ok(a.getSession()!.expiresAt <= start + MAX_SESSION);
    // 공동 편집으로 다시 열어도 시작 시각은 그대로
    const b = await setup();
    await openSession(b.store, b.sessions, { scope: "w1d2", mode: "edit", userId: 7, now: 1000 });
    await openSession(b.store, b.sessions, { scope: "w1d2", mode: "edit", userId: 8, now: 2000 });
    assert.equal(b.getSession()!.startedAt, 1000);
    // 풀기
    assert.equal(await releaseSession(a.sessions), true);
    assert.equal(await sessionLocked(a.sessions), false);
    assert.equal(await releaseSession(a.sessions), false);
  });

  test("TC-SEC-09 (낮음) JWT는 만료(exp)가 있어야 받고, 편집 설정 JWT에는 exp를 넣는다", async () => {
    assert.equal(await verifyJwt(await signJwt({ a: 1 }, SECRET), SECRET), null, "exp 없음");
    const ok = await signJwt({ a: 1, exp: Math.floor(Date.now() / 1000) + 60 }, SECRET);
    assert.equal((await verifyJwt<{ a: number }>(ok, SECRET))?.a, 1);
    const body = { key: "k", status: 2, url: "https://office/x" };
    assert.equal(await verifyCallback({ ...body, token: await signJwt(body, SECRET) }, undefined, SECRET), null, "콜백도 exp 없으면 거부");
    const c = await editorConfig({ key: "k1", title: "t", entry: "a.docx", mode: "edit", fileUrl: "f", callbackUrl: "cb", user: { id: "1", name: "n" } }, SECRET);
    const p = await verifyJwt<{ exp: number; document: { key: string } }>(c.token, SECRET);
    assert.ok(p && p.exp * 1000 > Date.now());
    assert.equal(p.document.key, "k1");
  });
});
