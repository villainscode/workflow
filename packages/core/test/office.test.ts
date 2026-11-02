import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  editorConfig, handleCallback, keepAlive, MAX_OFFICE_FILE, officeKey, openSession, readTicket, sessionLocked, signJwt, signTicket, verifyCallback, verifyJwt,
  SESSION_TTL, type OfficeSession, type OfficeSessions,
} from "../src/office.ts";
import { saveRevision, sha256Hex, workState, type DocStore, type Manifest } from "../src/work/index.ts";

/** 6.0 VO: 오피스 편집 서버 연결 규칙(JWT·세션 잠금·콜백 저장). 케이스 목록은 spec/TESTING.md 2.9 */

const SECRET = "office-secret";
const docx = readFileSync(join(import.meta.dirname, "fixtures/struct.docx"));

/** 메모리 저장소 하나(문서 하나) + 세션 */
async function setup(entry = "report.docx") {
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
  const v0: Manifest = { entry, files: [{ path: entry, sha256: sha, size: docx.byteLength, mime: "application/octet-stream" }] };
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
  return { store, sessions, blobs, getSession: () => session };
}

describe("오피스 편집 서버(6.0 VO)", () => {
  test("TC-VO-01 JWT: 서명·검사 왕복, 다른 비밀값·내용 바꿈·만료·alg 바꿈은 거부. 토큰은 쓰임새(file·callback)가 맞아야 한다", async () => {
    const t = await signJwt({ a: 1 }, SECRET);
    assert.deepEqual(await verifyJwt(t, SECRET), { a: 1 });
    assert.equal(await verifyJwt(t, "other"), null);
    const [h, , s] = t.split(".");
    const forged = `${h}.${Buffer.from(JSON.stringify({ a: 2 })).toString("base64url")}.${s}`;
    assert.equal(await verifyJwt(forged, SECRET), null);
    const none = `${Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url")}.${t.split(".")[1]}.`;
    assert.equal(await verifyJwt(none, SECRET), null);
    const old = await signTicket({ ws: 1, doc: 2, key: "k", use: "file" }, SECRET, 60, Date.now() - 120_000);
    assert.equal(await readTicket(old, SECRET, "file"), null);
    const ok = await signTicket({ ws: 1, doc: 2, key: "k", use: "file" }, SECRET, 60);
    assert.equal((await readTicket(ok, SECRET, "file"))?.key, "k");
    assert.equal(await readTicket(ok, SECRET, "callback"), null);
  });

  test("TC-VO-02 세션: 편집으로 열면 잠금, 같은 내용은 같은 키(공동 편집), 잠긴 동안 다른 쓰기·버전으로 저장은 409, 연장·만료", async () => {
    const { store, sessions, getSession } = await setup();
    const a = await openSession(store, sessions, { scope: "w1d2", mode: "edit", userId: 7 });
    assert.equal(a.key, officeKey("w1d2", "v0.0", 0));
    assert.equal((await openSession(store, sessions, { scope: "w1d2", mode: "edit", userId: 8 })).key, a.key);
    assert.equal(getSession()!.userId, 7, "처음 연 사람이 세션 주인으로 남는다");
    await assert.rejects(saveRevision(store, { baseRev: 0, put: [{ path: "x.txt", data: new Uint8Array([1]) }], source: "human" }), /오피스 편집기에서 편집 중/);
    assert.equal(await keepAlive(sessions, a.key), true);
    assert.equal(await keepAlive(sessions, "other"), false);
    // 만료되면 잠금이 풀린다
    assert.equal(await sessionLocked(sessions, Date.now() + SESSION_TTL + 1), false);
    // view는 세션을 만들지 않는다
    const b = await setup();
    await openSession(b.store, b.sessions, { scope: "w1d2", mode: "view", userId: 1 });
    assert.equal(b.getSession(), null);
    const h = await setup("a.html");
    await assert.rejects(openSession(h.store, h.sessions, { scope: "s", mode: "edit", userId: 1 }), /DOCX·PPTX·XLSX/);
  });

  test("TC-VO-03 편집 설정: documentType·키·파일 주소·콜백(편집일 때만)·한국어, token은 설정 전체의 JWT", async () => {
    const c = await editorConfig({ key: "k1", title: "보고서", entry: "a/report.docx", mode: "edit", fileUrl: "https://app/f", callbackUrl: "https://app/cb", user: { id: "7", name: "주인" } }, SECRET);
    assert.equal(c.documentType, "word");
    assert.equal(c.document.fileType, "docx");
    assert.equal(c.editorConfig.callbackUrl, "https://app/cb");
    assert.equal(c.editorConfig.lang, "ko");
    const { token, ...rest } = c;
    assert.deepEqual(await verifyJwt(token, SECRET), rest);
    const v = await editorConfig({ key: "k1", title: "t", entry: "s.pptx", mode: "view", fileUrl: "f", callbackUrl: "cb", user: { id: "1", name: "n" } }, SECRET);
    assert.equal(v.documentType, "slide");
    assert.equal("callbackUrl" in v.editorConfig, false);
    assert.equal(v.document.permissions.edit, false);
  });

  test("TC-VO-04 콜백 검사: 본문 token·Authorization Bearer({payload}) 둘 다 받고, 위조는 null", async () => {
    const body = { key: "k", status: 2, url: "https://office/x" };
    assert.deepEqual(await verifyCallback({ ...body, token: await signJwt(body, SECRET) }, undefined, SECRET), body);
    assert.deepEqual(await verifyCallback(body, `Bearer ${await signJwt({ payload: body }, SECRET)}`, SECRET), body);
    assert.equal(await verifyCallback({ ...body, token: await signJwt(body, "bad") }, undefined, SECRET), null);
    assert.equal(await verifyCallback(body, undefined, SECRET), null);
  });

  test("TC-VO-05 콜백 저장: status 2는 받은 파일로 대표 파일을 바꾼 수정본(source office)을 쌓고 잠금을 푼다. 다른 키·다른 출처 주소·너무 큰 파일은 거부, 4는 저장 없이 닫힘", async () => {
    const { store, sessions, getSession } = await setup();
    const s = await openSession(store, sessions, { scope: "w1d2", mode: "edit", userId: 7 });
    const edited = new Uint8Array([...docx, 1, 2, 3]);
    const opts = { expectedKey: s.key, officeOrigin: "https://office.test", download: async () => edited };
    await assert.rejects(handleCallback(store, sessions, { key: "other", status: 2, url: "https://office.test/f" }, opts), /문서 키/);
    await assert.rejects(handleCallback(store, sessions, { key: s.key, status: 2, url: "https://evil.test/f" }, opts), /오피스 서버가 아닙니다/);
    await assert.rejects(handleCallback(store, sessions, { key: s.key, status: 2, url: "https://office.test/f" },
      { ...opts, download: async () => new Uint8Array(MAX_OFFICE_FILE + 1) }), /MB를 넘습니다/);
    assert.equal((await handleCallback(store, sessions, { key: s.key, status: 1 }, opts)).closed, false);
    const r = await handleCallback(store, sessions, { key: s.key, status: 2, url: "https://office.test/f", users: ["7"] }, opts);
    assert.equal(r.saved?.rev, 1);
    assert.equal(r.closed, true);
    assert.equal(getSession(), null, "닫히면 잠금이 풀린다");
    const st = await workState(store);
    assert.equal(st.manifest.files[0].size, edited.byteLength);
    // 저장 뒤 다시 열면 새 키
    const again = await openSession(store, sessions, { scope: "w1d2", mode: "edit", userId: 7 });
    assert.notEqual(again.key, s.key);
    const closed = await handleCallback(store, sessions, { key: again.key, status: 4 }, { ...opts, expectedKey: again.key });
    assert.equal(closed.saved, undefined);
    assert.equal(getSession(), null);
  });
});
