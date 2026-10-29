import { Hono } from "hono";
import { AuthorizationError, CimdFetchError, type AuthRequest } from "@cloudflare/workers-oauth-provider";
import { currentUser, roleIn } from "./auth.ts";
import type { AppEnv } from "./env.ts";

/**
 * Claude Code 연결 동의 화면(/authorize, 4.0 P6). 로그인하지 않았으면 Google 로그인으로 보냈다가 돌아온다.
 * 연결할 워크스페이스를 고르게 하고, 승인하면 OAuth 토큰의 props에 사용자·워크스페이스를 담는다.
 */
type Helpers = {
  parseAuthRequest(r: Request): Promise<AuthRequest>;
  describeConsent(r: AuthRequest): Promise<{ clientName: string; clientDomain?: string; redirectHost: string; redirectIsLoopback: boolean; scope: string[] }>;
  beginConsent(r: AuthRequest): Promise<{ handle: string; headers: Headers }>;
  approveConsent(req: Request, handle: string, opts: { scope: string[] }): Promise<{ request: AuthRequest; headers: Headers }>;
  denyConsent(req: Request, handle: string): Promise<{ headers: Headers }>;
  completeAuthorization(o: { request: AuthRequest; userId: string; metadata: object; scope: string[]; props: object }): Promise<{ redirectTo: string }>;
};
const oauth = (env: AppEnv["Bindings"]) => (env as unknown as { OAUTH_PROVIDER: Helpers }).OAUTH_PROVIDER;
const esc = (v: string) => v.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

const page = (title: string, body: string) => `<!doctype html><html lang="ko"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<body style="font-family:system-ui,sans-serif;max-width:34rem;margin:12vh auto;padding:0 16px;line-height:1.6">${body}</body></html>`;

export const consent = new Hono<AppEnv>();

consent.get("/authorize", async (c) => {
  const user = await currentUser(c);
  if (!user) return c.redirect(`/api/auth/google?next=${encodeURIComponent(c.req.path + "?" + new URL(c.req.url).searchParams)}`);
  try {
    const req = await oauth(c.env).parseAuthRequest(c.req.raw);
    const d = await oauth(c.env).describeConsent(req);
    const { results } = await c.env.DB.prepare(`SELECT w.slug, w.name, m.role FROM member m JOIN workspace w ON w.id = m.workspace_id
      WHERE m.user_id = ? ORDER BY w.name`).bind(user.id).all<{ slug: string; name: string; role: string }>();
    if (!results.length) return c.html(page("연결할 수 없습니다", "<h1>연결할 워크스페이스가 없습니다</h1><p>먼저 워크스페이스에 초대받으세요.</p>"), 403);
    const begin = await oauth(c.env).beginConsent(req);
    const html = page("Claude Code 연결", `<h1 style="font-size:1.3rem">${esc(d.clientName)}을(를) 연결할까요?</h1>
<p>${d.clientDomain ? `게시: <b>${esc(d.clientDomain)}</b>. ` : "스스로 등록한 앱이라 이름은 확인되지 않았습니다. "}토큰은 <b>${esc(d.redirectHost)}</b>로 갑니다.</p>
${d.redirectIsLoopback ? "<p><b>내 컴퓨터의 앱(Claude Code 등)으로 보냅니다.</b> 방금 직접 연결을 시작한 경우에만 허용하세요.</p>" : ""}
<p>${esc(user.email)} 계정으로, 고른 워크스페이스의 문서를 이 앱이 읽고 고칠 수 있게 됩니다(권한은 내 역할과 같습니다. 삭제 도구는 없습니다).</p>
<form method="post">
  <input type="hidden" name="handle" value="${esc(begin.handle)}">
  <label>워크스페이스 <select name="ws">${results.map((w) => `<option value="${esc(w.slug)}">${esc(w.name)} (${esc(w.role)})</option>`).join("")}</select></label>
  <p><button name="decision" value="approve">허용</button> <button name="decision" value="deny">거부</button></p>
</form>`);
    begin.headers.set("content-type", "text/html; charset=utf-8");
    return new Response(html, { headers: begin.headers });
  } catch (e) {
    return authError(e);
  }
});

consent.post("/authorize", async (c) => {
  const user = await currentUser(c);
  if (!user) return c.html(page("로그인하세요", "<p>로그인 세션이 없습니다. 다시 연결을 시작하세요.</p>"), 401);
  try {
    const form = await c.req.formData();
    const handle = String(form.get("handle"));
    if (form.get("decision") !== "approve") {
      const denied = await oauth(c.env).denyConsent(c.req.raw, handle);
      return new Response(null, { status: 302, headers: denied.headers });
    }
    const slug = String(form.get("ws") ?? "");
    const ws = await c.env.DB.prepare("SELECT id FROM workspace WHERE slug = ?").bind(slug).first<{ id: number }>();
    if (!ws || !(await roleIn(c.env.DB, ws.id, user.id))) return c.html(page("연결할 수 없습니다", "<p>그 워크스페이스의 멤버가 아닙니다.</p>"), 403);
    const approved = await oauth(c.env).approveConsent(c.req.raw, handle, { scope: ["mcp"] });
    const { redirectTo } = await oauth(c.env).completeAuthorization({
      request: approved.request, userId: String(user.id), metadata: { ws: slug }, scope: approved.request.scope,
      props: { userId: user.id, email: user.email, ws: slug },
    });
    approved.headers.set("location", redirectTo);
    return new Response(null, { status: 302, headers: approved.headers });
  } catch (e) {
    return authError(e);
  }
});

function authError(e: unknown): Response {
  if (e instanceof AuthorizationError && (e as AuthorizationError & { redirectTo?: string }).redirectTo) {
    return Response.redirect((e as AuthorizationError & { redirectTo: string }).redirectTo, 302);
  }
  if (e instanceof AuthorizationError || e instanceof CimdFetchError) {
    const msg = e instanceof AuthorizationError ? (e as AuthorizationError & { description?: string }).description ?? e.message : "앱을 확인하지 못했습니다";
    return new Response(page("연결할 수 없습니다", `<p>${esc(msg)}</p>`), { status: 400, headers: { "content-type": "text/html; charset=utf-8" } });
  }
  throw e;
}
