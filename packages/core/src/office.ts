import { saveRevision, workState, WorkError, type DocStore, type Saved } from "./work/index.ts";

/**
 * 오피스 편집 서버 연결(6.0 VO, D-59). ONLYOFFICE Docs(커뮤니티판, 고치지 않은 이미지)를 iframe으로 열고, 저장 콜백으로 받은 파일을
 * 작업본 수정본 한 건(파일 통째, source: office)으로 쌓는다. Worker(Containers)와 로컬 사이트(docker)가 같은 규칙을 쓴다.
 *
 * - 편집 설정(config)은 서버가 만들어 JWT(HS256, 오피스 서버와 나눈 비밀값)로 서명한다. 화면은 받은 그대로 DocsAPI에 넘긴다.
 * - 문서 키는 작업 상태(기준 버전·rev)에서 나온다. 같은 내용을 여는 사람은 같은 키라 오피스 서버의 공동 편집으로 묶이고,
 *   저장으로 rev가 바뀌면 다음에는 새 키가 된다(오피스 서버가 옛 내용을 캐시에서 주지 않게).
 * - 편집 세션이 열려 있는 동안 그 문서의 다른 쓰기(구조 편집·덱·되돌리기·버전으로 저장)는 409다(작업본 잠금, DocStore.locked).
 *   수정본 층을 거치지 않는 텍스트 편집·Markdown 저장·새 버전 올리기·정식 확정도 409다(Worker write.ts, 로컬 server/index.ts의 needUnlocked).
 *   세션은 화면이 5분마다 연장하고(15분 만료), 오피스 서버가 닫힘(status 2·4)을 알리면 풀린다.
 * - 파일 내려주기·콜백 주소에는 짧게 서명한 토큰을 붙인다(오피스 서버는 세션 쿠키가 없다).
 * - 콜백이 가리키는 저장 파일 주소는 오피스 서버 출처만 받는다(SSRF 막기). 크기 상한 MAX_OFFICE_FILE.
 */

export const OFFICE_EXT = /\.(docx|pptx|xlsx)$/i;
export const MAX_OFFICE_FILE = 64 * 1024 * 1024;
/** 세션 만료(화면이 KEEPALIVE마다 연장한다) */
export const SESSION_TTL = 15 * 60_000;
export const KEEPALIVE = 5 * 60_000;

export type OfficeMode = "edit" | "view";
export interface OfficeSession { key: string; rev: number; baseVersion: string; userId: number | null; expiresAt: number }
/** 문서 하나의 편집 세션 저장소(Worker: D1 office_session, 로컬: work.db office_session) */
export interface OfficeSessions {
  get(): Promise<OfficeSession | null>;
  put(s: OfficeSession): Promise<void>;
  remove(key: string): Promise<void>;
}

const enc = new TextEncoder();
const dec = new TextDecoder();
const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4)), (c) => c.charCodeAt(0));
const hmacKey = (secret: string, use: "sign" | "verify") => crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [use]);

/** JWT(HS256) 서명 */
export async function signJwt(payload: object, secret: string): Promise<string> {
  const head = b64url(enc.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const body = b64url(enc.encode(JSON.stringify(payload)));
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(secret, "sign"), enc.encode(`${head}.${body}`)));
  return `${head}.${body}.${b64url(sig)}`;
}

/** JWT(HS256) 검사. 서명이 맞고 만료(exp)가 지나지 않았으면 내용, 아니면 null */
export async function verifyJwt<T = Record<string, unknown>>(token: string, secret: string, now = Date.now()): Promise<T | null> {
  const parts = token.split(".");
  if (parts.length !== 3 || !secret) return null;
  try {
    const head = JSON.parse(dec.decode(fromB64url(parts[0]))) as { alg?: string };
    if (head.alg !== "HS256") return null;
    // subtle.verify는 비교 시간이 값에 따라 달라지지 않는다
    const ok = await crypto.subtle.verify("HMAC", await hmacKey(secret, "verify"), fromB64url(parts[2]) as Uint8Array<ArrayBuffer>, enc.encode(`${parts[0]}.${parts[1]}`));
    if (!ok) return null;
    const body = JSON.parse(dec.decode(fromB64url(parts[1]))) as T & { exp?: number };
    if (typeof body.exp === "number" && body.exp * 1000 < now) return null;
    return body;
  } catch {
    return null;
  }
}

/** 파일 내려주기·콜백 주소의 토큰 내용 */
export interface OfficeTicket { ws: number | string; doc: number | string; key: string; use: "file" | "callback"; exp: number }

export async function signTicket(t: Omit<OfficeTicket, "exp">, secret: string, ttlSec: number, now = Date.now()) {
  return signJwt({ ...t, exp: Math.floor(now / 1000) + ttlSec }, secret);
}
export async function readTicket(token: string, secret: string, use: OfficeTicket["use"], now = Date.now()) {
  const t = await verifyJwt<OfficeTicket>(token, secret, now);
  return t && t.use === use && typeof t.key === "string" ? t : null;
}

export const officeKind = (entry: string) =>
  /\.docx$/i.test(entry) ? "word" : /\.pptx$/i.test(entry) ? "slide" : /\.xlsx$/i.test(entry) ? "cell" : null;

/** 문서 키: 오피스 서버가 허용하는 글자(영문·숫자·.-_)만, 128자 안 */
export const officeKey = (scope: string, baseVersion: string, rev: number) =>
  `${scope}-${baseVersion}-r${rev}`.replace(/[^0-9A-Za-z._-]/g, "_").slice(0, 128);

/**
 * 편집 세션 열기. 열린 세션이 지금 작업 상태(기준 버전·rev)와 같으면 그 키를 함께 쓰고(공동 편집), 아니면 새로 연다.
 * view는 세션(잠금)을 만들지 않는다.
 */
export async function openSession(store: DocStore, sessions: OfficeSessions, o: { scope: string; mode: OfficeMode; userId: number | null; now?: number }) {
  const now = o.now ?? Date.now();
  const st = await workState(store);
  if (!officeKind(st.manifest.entry)) throw new WorkError(400, "오피스 편집기는 DOCX·PPTX·XLSX 문서만 엽니다");
  const entry = st.manifest.files.find((f) => f.path === st.manifest.entry)!;
  const key = officeKey(o.scope, st.baseVersion, st.rev);
  if (o.mode === "edit") {
    const cur = await sessions.get();
    const live = cur && cur.expiresAt > now;
    if (live && cur.key !== key) throw new WorkError(409, "오피스 편집기에서 다른 내용을 편집하고 있습니다. 잠시 뒤 다시 여세요");
    await sessions.put({ key, rev: st.rev, baseVersion: st.baseVersion, userId: live ? cur.userId : o.userId, expiresAt: now + SESSION_TTL });
  }
  return { key, rev: st.rev, baseVersion: st.baseVersion, entry: entry.path, sha256: entry.sha256, size: entry.size };
}

/** 화면이 열어 둔 세션을 연장한다. 이미 닫혔거나 다른 세션이면 false */
export async function keepAlive(sessions: OfficeSessions, key: string, now = Date.now()) {
  const cur = await sessions.get();
  if (!cur || cur.key !== key || cur.expiresAt <= now) return false;
  await sessions.put({ ...cur, expiresAt: now + SESSION_TTL });
  return true;
}

/** 작업본이 잠겼는지(오피스 편집 세션이 살아 있는지). DocStore.locked에서 부른다 */
export async function sessionLocked(sessions: OfficeSessions, now = Date.now()) {
  const cur = await sessions.get();
  return !!cur && cur.expiresAt > now;
}

export interface ConfigInput {
  key: string; title: string; entry: string; mode: OfficeMode;
  fileUrl: string; callbackUrl?: string;
  user: { id: string; name: string };
}

/** DocsAPI.DocEditor 설정. token은 설정 전체의 JWT(오피스 서버가 JWT_ENABLED일 때 검사한다) */
export async function editorConfig(c: ConfigInput, secret: string) {
  const ext = c.entry.slice(c.entry.lastIndexOf(".") + 1).toLowerCase();
  const edit = c.mode === "edit";
  const config = {
    documentType: officeKind(c.entry),
    document: {
      fileType: ext, key: c.key, title: c.title, url: c.fileUrl,
      permissions: { edit, comment: edit, download: true, print: true, review: edit },
    },
    editorConfig: {
      mode: c.mode, lang: "ko", region: "ko-KR", user: c.user,
      ...(edit && c.callbackUrl ? { callbackUrl: c.callbackUrl } : {}),
      // 닫기 버튼(onRequestClose)을 보이고, 자동 저장은 오피스 서버 안에서만(파일은 닫을 때 한 번 콜백으로 온다)
      customization: { autosave: true, forcesave: false, compactHeader: true, close: { visible: true, text: "닫기" }, uiTheme: "default-light" },
    },
  };
  return { ...config, token: await signJwt(config, secret) };
}

/** 오피스 서버 콜백 본문(필요한 칸만) */
export interface CallbackBody { key?: string; status?: number; url?: string; users?: string[]; token?: string }

/**
 * 콜백 검사: 본문 token(JWT_IN_BODY) 또는 Authorization: Bearer(기본, 내용은 { payload }) 중 하나가 맞아야 한다.
 * 검사한 내용(서명된 쪽)을 돌려준다. 맞지 않으면 null
 */
export async function verifyCallback(body: CallbackBody, authorization: string | undefined, secret: string): Promise<CallbackBody | null> {
  if (body.token) {
    const p = await verifyJwt<CallbackBody>(body.token, secret);
    if (p) return p;
  }
  const bearer = /^Bearer\s+(.+)$/i.exec(authorization ?? "")?.[1];
  if (bearer) {
    const p = await verifyJwt<{ payload?: CallbackBody }>(bearer, secret);
    if (p?.payload) return p.payload;
  }
  return null;
}

export interface CallbackResult { status: number; saved?: Saved; closed: boolean }

/**
 * 콜백 처리(서명 검사는 끝난 내용). status 1 편집 중(세션 연장), 2 저장할 파일 있음(닫힘), 4 바뀐 것 없이 닫힘,
 * 6 강제 저장(편집은 계속), 3·7 저장 오류. 2·6이면 파일을 받아 작업본 대표 파일을 통째로 바꾼 수정본을 쌓는다.
 * download는 오피스 서버 출처 검사를 통과한 주소만 받는다(호출 쪽이 출처 대신 컨테이너로 보내도 된다).
 */
export async function handleCallback(store: DocStore, sessions: OfficeSessions, cb: CallbackBody, o: {
  expectedKey: string; officeOrigin: string; download: (url: string) => Promise<Uint8Array>; now?: number;
}): Promise<CallbackResult> {
  const now = o.now ?? Date.now();
  if (cb.key !== o.expectedKey) throw new WorkError(403, "문서 키가 맞지 않습니다");
  const status = Number(cb.status);
  const cur = await sessions.get();
  const mine = !!cur && cur.key === cb.key;
  if (status === 1) {
    if (mine) await sessions.put({ ...cur!, expiresAt: now + SESSION_TTL });
    return { status, closed: false };
  }
  let saved: Saved | undefined;
  if (status === 2 || status === 6) {
    const url = String(cb.url ?? "");
    if (!sameOrigin(url, o.officeOrigin)) throw new WorkError(400, "저장 파일 주소가 오피스 서버가 아닙니다");
    const data = await o.download(url);
    if (data.byteLength === 0 || data.byteLength > MAX_OFFICE_FILE) throw new WorkError(413, `저장 파일이 비었거나 ${MAX_OFFICE_FILE / 1024 / 1024}MB를 넘습니다`);
    const st = await workState(store);
    // 세션이 연 내용 위에서 저장한다. 그 사이 다른 쓰기는 잠금으로 막혔다(세션이 만료돼 끼어든 쓰기가 있으면 그 위에 덮는다)
    saved = await saveRevision(store, {
      baseRev: st.rev, put: [{ path: st.manifest.entry, data }], source: "office",
      summary: `오피스 편집기에서 저장${cb.users?.length ? `(${cb.users.length}명)` : ""}`,
    });
  }
  const closed = status === 2 || status === 4;
  if (closed && mine) await sessions.remove(cb.key!);
  return { status, saved, closed };
}

function sameOrigin(url: string, origin: string) {
  try {
    return new URL(url).origin === new URL(origin).origin;
  } catch {
    return false;
  }
}
