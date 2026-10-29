import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { sha256Hex } from "./blobs.ts";
import { HttpError, type AppEnv, type Bindings, type Role, type User } from "./env.ts";

/**
 * 로그인(4.0 P4). Google 로그인(OIDC 인가 코드 + PKCE)만 쓴다. 초대받은 사람만 들어오고, SUPERADMIN_EMAILS는 예외다.
 * 세션은 무작위 토큰을 HttpOnly 쿠키에 두고 D1에는 그 sha256만 저장한다. 30일 유효.
 */

const SESSION_DAYS = 30;
const GOOGLE_AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";

/** https면 __Host- 접두어(Secure·Path=/·Domain 없음을 브라우저가 강제), 로컬 http는 그냥 이름 */
const cookieName = (c: Context, name: string) => (new URL(c.req.url).protocol === "https:" ? `__Host-${name}` : name);
const secure = (c: Context) => new URL(c.req.url).protocol === "https:";

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export const randomToken = () => b64url(crypto.getRandomValues(new Uint8Array(32)));
const now = () => new Date().toISOString();

export const superadmins = (env: Bindings) =>
  new Set((env.SUPERADMIN_EMAILS ?? "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean));

/**
 * Worker 안에서 원격 MCP(mcp.ts)가 앱 API를 그 사용자로 부를 때 쓰는 머리글(x-wf-internal). <사용자 id>.<만료 초>.<서명>
 * SIGNING_KEY로 서명하고 60초만 유효하다. 밖에서 만들 수 없으므로 브라우저 요청과 같은 권한 검사를 그대로 거친다
 */
export async function internalToken(key: string, userId: number): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + 60;
  return `${userId}.${exp}.${await hmac(key, `${userId}.${exp}`)}`;
}
async function hmac(key: string, msg: string) {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(msg))));
}
async function internalUser(c: Context<AppEnv>, header: string): Promise<User | null> {
  const m = /^(\d+)\.(\d+)\.([\w-]+)$/.exec(header);
  if (!m || Number(m[2]) < Date.now() / 1000) return null;
  if ((await hmac(c.env.SIGNING_KEY, `${m[1]}.${m[2]}`)) !== m[3]) return null;
  return c.env.DB.prepare("SELECT id, email, name, picture FROM app_user WHERE id = ?").bind(Number(m[1])).first<User>();
}

/** 쿠키의 세션(또는 원격 MCP의 내부 머리글)으로 사용자. 없거나 만료면 null */
export async function currentUser(c: Context<AppEnv>): Promise<User | null> {
  const internal = c.req.header("x-wf-internal");
  if (internal) return internalUser(c, internal);
  const token = getCookie(c, cookieName(c, "wf_session"));
  if (!token) return null;
  return c.env.DB.prepare(`SELECT u.id, u.email, u.name, u.picture FROM session s JOIN app_user u ON u.id = s.user_id
    WHERE s.id = ? AND s.expires_at > ?`).bind(await sha256Hex(new TextEncoder().encode(token)), now()).first<User>();
}

async function startSession(c: Context<AppEnv>, userId: number) {
  const token = randomToken();
  const expires = new Date(Date.now() + SESSION_DAYS * 86400_000);
  await c.env.DB.prepare("INSERT INTO session (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
    .bind(await sha256Hex(new TextEncoder().encode(token)), userId, now(), expires.toISOString()).run();
  setCookie(c, cookieName(c, "wf_session"), token, { path: "/", httpOnly: true, secure: secure(c), sameSite: "Lax", expires });
}

/** 워크스페이스에서의 역할. 멤버가 아니면 null */
export async function roleIn(db: D1Database, wsId: number, userId: number): Promise<Role | null> {
  return (await db.prepare("SELECT role FROM member WHERE workspace_id = ? AND user_id = ?").bind(wsId, userId).first<{ role: Role }>())?.role ?? null;
}

/** 초대 수락: 쓰지 않았고 만료 전이며(이메일 지정이면 같은 이메일) → 멤버로 넣는다. 이미 멤버면 더 높은 역할만 반영 */
export async function acceptInvite(db: D1Database, token: string, user: User): Promise<string> {
  const id = await sha256Hex(new TextEncoder().encode(token));
  const inv = await db.prepare(`SELECT i.*, w.slug FROM invite i JOIN workspace w ON w.id = i.workspace_id
    WHERE i.id = ? AND i.used_at IS NULL AND i.expires_at > ?`).bind(id, now())
    .first<{ id: string; workspace_id: number; role: Role; email: string | null; slug: string }>();
  if (!inv) throw new HttpError(410, "초대 링크가 만료되었거나 이미 사용되었습니다. 초대한 사람에게 새 링크를 받으세요");
  if (inv.email && inv.email.toLowerCase() !== user.email.toLowerCase()) {
    throw new HttpError(403, `이 초대는 ${inv.email} 계정용입니다. 그 계정으로 로그인하세요`);
  }
  const rank = { viewer: 0, editor: 1, owner: 2 } as const;
  const current = await roleIn(db, inv.workspace_id, user.id);
  await db.batch([
    current === null
      ? db.prepare("INSERT INTO member (workspace_id, user_id, role, created_at) VALUES (?, ?, ?, ?)").bind(inv.workspace_id, user.id, inv.role, now())
      : db.prepare("UPDATE member SET role = ? WHERE workspace_id = ? AND user_id = ?")
        .bind(rank[inv.role] > rank[current] ? inv.role : current, inv.workspace_id, user.id),
    db.prepare("UPDATE invite SET used_by = ?, used_at = ? WHERE id = ?").bind(user.id, now(), inv.id),
  ]);
  return inv.slug;
}

/** 로그인 결과(Google 프로필)로 사용자를 찾거나 만든다. 처음 오는 사람은 초대나 SUPERADMIN이어야 한다 */
async function loginUser(env: Bindings, profile: { sub: string; email: string; name?: string; picture?: string }, invited: boolean): Promise<User> {
  const db = env.DB;
  const email = profile.email.toLowerCase();
  const found = await db.prepare("SELECT id FROM app_user WHERE google_sub = ? OR email = ?").bind(profile.sub, email).first<{ id: number }>();
  if (!found && !invited && !superadmins(env).has(email)) {
    throw new HttpError(403, "초대받은 사람만 들어올 수 있습니다. 워크스페이스 관리자에게 초대 링크를 받으세요");
  }
  const row = found
    ? await db.prepare("UPDATE app_user SET google_sub = ?, email = ?, name = ?, picture = ?, last_login_at = ? WHERE id = ? RETURNING id, email, name, picture")
      .bind(profile.sub, email, profile.name ?? null, profile.picture ?? null, now(), found.id).first<User>()
    : await db.prepare("INSERT INTO app_user (email, name, picture, google_sub, created_at, last_login_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING id, email, name, picture")
      .bind(email, profile.name ?? null, profile.picture ?? null, profile.sub, now(), now()).first<User>();
  return row!;
}

/** 로그인 뒤 갈 곳: 같은 사이트 안 경로만(다른 사이트로 보내는 열린 리디렉션을 막는다) */
const safeNext = (next: string | undefined) => (next && /^\/(?!\/)[^\\]*$/.test(next) ? next : "/");

/** 로그인 실패를 화면으로 보여 준다(API가 아니라 브라우저가 직접 오는 경로라 JSON 대신 간단한 HTML) */
const errorPage = (c: Context, status: number, message: string) => c.html(`<!doctype html><html lang="ko"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>로그인할 수 없습니다</title>
<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 16px;line-height:1.6">
<h1 style="font-size:1.25rem">로그인할 수 없습니다</h1><p>${message.replace(/[<&>]/g, (ch) => `&#${ch.charCodeAt(0)};`)}</p><p><a href="/">처음으로</a></p></body></html>`, status as 403);

export const auth = new Hono<AppEnv>();

/** Google 로그인 시작. ?next=로 돌아갈 경로, 초대 링크로 왔으면 invite 쿠키가 있다 */
auth.get("/google", async (c) => {
  if (!c.env.GOOGLE_CLIENT_ID) return errorPage(c, 500, "Google 로그인이 설정되지 않았습니다(GOOGLE_CLIENT_ID)");
  const state = randomToken();
  const verifier = randomToken();
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  const opts = { path: "/api/auth", httpOnly: true, secure: secure(c), sameSite: "Lax" as const, maxAge: 600 };
  setCookie(c, "wf_oauth", JSON.stringify({ state, verifier, next: safeNext(c.req.query("next")) }), opts);
  const url = new URL(GOOGLE_AUTH);
  url.search = new URLSearchParams({
    client_id: c.env.GOOGLE_CLIENT_ID, redirect_uri: `${new URL(c.req.url).origin}/api/auth/google/callback`, response_type: "code",
    scope: "openid email profile", state, code_challenge: challenge, code_challenge_method: "S256", prompt: "select_account",
  }).toString();
  return c.redirect(url.toString());
});

auth.get("/google/callback", async (c) => {
  let saved: { state: string; verifier: string; next: string };
  try { saved = JSON.parse(getCookie(c, "wf_oauth") ?? ""); } catch { return errorPage(c, 400, "로그인 시간이 지났습니다. 다시 로그인하세요"); }
  deleteCookie(c, "wf_oauth", { path: "/api/auth" });
  if (!saved?.state || c.req.query("state") !== saved.state) return errorPage(c, 400, "로그인 요청이 올바르지 않습니다. 다시 로그인하세요");
  if (c.req.query("error") || !c.req.query("code")) return errorPage(c, 400, "Google 로그인을 취소했습니다");

  // 토큰 교환(서버 ↔ Google 직접 TLS). 이 응답의 id_token은 Google에서 바로 받은 것이라 서명 검사 없이 내용(aud·iss·이메일 확인)만 본다(OIDC Core 3.1.3.7)
  const res = await fetch(GOOGLE_TOKEN, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code: c.req.query("code")!, client_id: c.env.GOOGLE_CLIENT_ID, client_secret: c.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: `${new URL(c.req.url).origin}/api/auth/google/callback`, grant_type: "authorization_code", code_verifier: saved.verifier,
    }),
  });
  if (!res.ok) {
    // 원인을 로그로 남긴다(Google의 오류 코드만, 비밀값은 남기지 않는다). invalid_client면 GOOGLE_CLIENT_ID·SECRET이 틀리거나 비었다
    const err = await res.json<{ error?: string; error_description?: string }>().catch(() => ({} as { error?: string; error_description?: string }));
    console.error("Google 토큰 교환 실패", res.status, err.error, err.error_description);
    return errorPage(c, 502, `Google 로그인 확인에 실패했습니다(${err.error ?? res.status}). 다시 시도하세요`);
  }
  const { id_token } = await res.json<{ id_token?: string }>();
  let claims: { iss?: string; aud?: string; sub?: string; email?: string; email_verified?: boolean; name?: string; picture?: string; exp?: number };
  try {
    claims = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(id_token!.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")), (ch) => ch.charCodeAt(0))));
  } catch { return errorPage(c, 502, "Google 응답을 읽지 못했습니다"); }
  if (!["https://accounts.google.com", "accounts.google.com"].includes(claims.iss ?? "") || claims.aud !== c.env.GOOGLE_CLIENT_ID
    || !claims.sub || !claims.email || claims.email_verified !== true || (claims.exp ?? 0) * 1000 < Date.now()) {
    return errorPage(c, 403, "확인된 Google 계정이 아닙니다");
  }
  return finishLogin(c, { sub: claims.sub, email: claims.email, name: claims.name, picture: claims.picture }, saved.next);
});

/** 로그인 마무리: 사용자 만들기·찾기 → 초대 수락 → 세션 → 돌아갈 곳 */
async function finishLogin(c: Context<AppEnv>, profile: { sub: string; email: string; name?: string; picture?: string }, next: string) {
  const invite = getCookie(c, "wf_invite");
  try {
    const user = await loginUser(c.env, profile, !!invite);
    let to = next;
    if (invite) {
      deleteCookie(c, "wf_invite", { path: "/" });
      to = `/${await acceptInvite(c.env.DB, invite, user)}/`;
    }
    await startSession(c, user.id);
    return c.redirect(to);
  } catch (e) {
    if (e instanceof HttpError) return errorPage(c, e.status, e.message);
    throw e;
  }
}

/** 개발용 로그인(DEV_LOGIN=1일 때만). 로컬 wrangler dev와 테스트에서 Google 없이 로그인한다 */
auth.post("/dev-login", async (c) => {
  if (c.env.DEV_LOGIN !== "1") return c.json({ error: "없는 API입니다" }, 404);
  const { email, next } = await c.req.json<{ email: string; next?: string }>();
  const res = await finishLogin(c, { sub: `dev:${email.toLowerCase()}`, email, name: email.split("@")[0] }, safeNext(next));
  return res;
});

auth.post("/logout", async (c) => {
  const name = cookieName(c, "wf_session");
  const token = getCookie(c, name);
  if (token) await c.env.DB.prepare("DELETE FROM session WHERE id = ?").bind(await sha256Hex(new TextEncoder().encode(token))).run();
  deleteCookie(c, name, { path: "/", secure: secure(c) });
  return c.json({ ok: true });
});

/** 초대 링크(/api/invites/<토큰>): 로그인돼 있으면 바로 수락, 아니면 토큰을 쿠키에 두고 Google 로그인으로 */
export const inviteLink = async (c: Context<AppEnv>) => {
  const token = c.req.param("token")!;
  const user = await currentUser(c);
  if (user) {
    try { return c.redirect(`/${await acceptInvite(c.env.DB, token, user)}/`); }
    catch (e) { if (e instanceof HttpError) return errorPage(c, e.status, e.message); throw e; }
  }
  setCookie(c, "wf_invite", token, { path: "/", httpOnly: true, secure: secure(c), sameSite: "Lax", maxAge: 1800 });
  return c.redirect(c.env.DEV_LOGIN === "1" && !c.env.GOOGLE_CLIENT_ID ? "/?login=dev" : "/api/auth/google");
};
