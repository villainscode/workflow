import { Hono } from "hono";
import { randomToken, superadmins } from "./auth.ts";
import { sha256Hex } from "./blobs.ts";
import { HttpError, type AppEnv, type Role } from "./env.ts";

/** 워크스페이스 만들기(SUPERADMIN), 멤버 목록·역할·내보내기, 초대 링크(owner) — 4.0 P4 */

const ROLES = new Set<Role>(["owner", "editor", "viewer"]);
const INVITE_DAYS = 7;
const now = () => new Date().toISOString();

/** /api/w/:ws 아래(멤버·초대). 권한 검사는 index.ts의 워크스페이스 미들웨어가 한다 */
export const members = new Hono<AppEnv>();

members.get("/members", async (c) => {
  const { results } = await c.env.DB.prepare(`SELECT u.id, u.email, u.name, u.picture, m.role, m.created_at AS joinedAt FROM member m
    JOIN app_user u ON u.id = m.user_id WHERE m.workspace_id = ? ORDER BY m.created_at`).bind(c.var.ws.id).all();
  return c.json(results);
});

/** owner가 한 명만 남으면 그 사람을 내리거나 뺄 수 없다 */
async function guardLastOwner(db: D1Database, wsId: number, userId: number) {
  const owners = await db.prepare("SELECT user_id FROM member WHERE workspace_id = ? AND role = 'owner'").bind(wsId).all<{ user_id: number }>();
  if (owners.results.length === 1 && owners.results[0].user_id === userId) throw new HttpError(409, "owner는 한 명 이상 있어야 합니다");
}

members.patch("/members/:id", async (c) => {
  const { role } = await c.req.json<{ role: Role }>();
  if (!ROLES.has(role)) throw new HttpError(400, "역할은 owner, editor, viewer 중 하나입니다");
  const id = Number(c.req.param("id"));
  if (role !== "owner") await guardLastOwner(c.env.DB, c.var.ws.id, id);
  const r = await c.env.DB.prepare("UPDATE member SET role = ? WHERE workspace_id = ? AND user_id = ?").bind(role, c.var.ws.id, id).run();
  if (!r.meta.changes) throw new HttpError(404, "멤버가 아닙니다");
  return c.json({ ok: true });
});

members.delete("/members/:id", async (c) => {
  const id = Number(c.req.param("id"));
  await guardLastOwner(c.env.DB, c.var.ws.id, id);
  const r = await c.env.DB.prepare("DELETE FROM member WHERE workspace_id = ? AND user_id = ?").bind(c.var.ws.id, id).run();
  if (!r.meta.changes) throw new HttpError(404, "멤버가 아닙니다");
  return c.json({ ok: true });
});

/** 아직 쓰지 않은 초대 */
members.get("/invites", async (c) => {
  const { results } = await c.env.DB.prepare(`SELECT i.id, i.role, i.email, i.created_at AS createdAt, i.expires_at AS expiresAt, u.email AS createdBy
    FROM invite i LEFT JOIN app_user u ON u.id = i.created_by WHERE i.workspace_id = ? AND i.used_at IS NULL AND i.expires_at > ? ORDER BY i.created_at DESC`)
    .bind(c.var.ws.id, now()).all();
  return c.json(results);
});

/** 초대 링크 만들기. 링크(토큰)는 이 응답에서 한 번만 보여 준다(DB에는 해시만) */
members.post("/invites", async (c) => {
  const { role, email } = await c.req.json<{ role: Role; email?: string }>();
  if (!ROLES.has(role)) throw new HttpError(400, "역할은 owner, editor, viewer 중 하나입니다");
  const mail = email?.trim().toLowerCase() || null;
  if (mail && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(mail)) throw new HttpError(400, "이메일 형식이 아닙니다");
  const token = randomToken();
  const id = await sha256Hex(new TextEncoder().encode(token));
  const expires = new Date(Date.now() + INVITE_DAYS * 86400_000).toISOString();
  await c.env.DB.prepare("INSERT INTO invite (id, workspace_id, role, email, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(id, c.var.ws.id, role, mail, c.var.user!.id, now(), expires).run();
  return c.json({ id, url: `${new URL(c.req.url).origin}/api/invites/${token}`, role, email: mail, expiresAt: expires });
});

members.delete("/invites/:id", async (c) => {
  const r = await c.env.DB.prepare("DELETE FROM invite WHERE workspace_id = ? AND id = ? AND used_at IS NULL").bind(c.var.ws.id, c.req.param("id")).run();
  if (!r.meta.changes) throw new HttpError(404, "없는 초대입니다");
  return c.json({ ok: true });
});

/** 새 워크스페이스(SUPERADMIN만, 초대제 베타). 만든 사람이 owner. 기본 대분류 SDLC 하나 */
export async function createWorkspace(db: D1Database, env: { SUPERADMIN_EMAILS: string }, user: { id: number; email: string }, slug: string, name: string) {
  if (!superadmins(env as never).has(user.email.toLowerCase())) throw new HttpError(403, "워크스페이스는 관리자만 만들 수 있습니다");
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug ?? "") || ["api", "c", "i", "assets"].includes(slug)) {
    throw new HttpError(400, "워크스페이스 주소는 영문 소문자·숫자·-만 씁니다");
  }
  if (!name?.trim()) throw new HttpError(400, "워크스페이스 이름을 입력하세요");
  if (await db.prepare("SELECT 1 FROM workspace WHERE slug = ?").bind(slug).first()) throw new HttpError(409, `${slug}은(는) 이미 있는 주소입니다`);
  const ws = await db.prepare("INSERT INTO workspace (slug, name, created_at) VALUES (?, ?, ?) RETURNING id").bind(slug, name.trim(), now()).first<{ id: number }>();
  await db.batch([
    db.prepare("INSERT INTO member (workspace_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)").bind(ws!.id, user.id, now()),
    db.prepare("INSERT INTO top_menu (workspace_id, key, name, sort) VALUES (?, 'sdlc', 'SDLC', 0)").bind(ws!.id),
  ]);
  return { slug, name: name.trim() };
}
