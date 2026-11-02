import { Container, getContainer } from "@cloudflare/containers";
import { Hono } from "hono";
import * as office from "@workflow/core/office";
import type { OfficeSessions } from "@workflow/core/office";
import { HttpError, type AppEnv, type Bindings, type User, type Workspace } from "./env.ts";
import { docStore } from "./revisions.ts";
import { getBlob } from "./blobs.ts";
import { liveStub } from "./live.ts";
import { noteUsage } from "./usage.ts";

/**
 * 오피스 편집 서버(6.0 VO, D-59). 규칙(JWT·세션 잠금·콜백 저장)은 packages/core/src/office.ts이고, 여기서는 Cloudflare 연결만 둔다.
 *   편집기 출처 OFFICE_ORIGIN(예: https://office.simplite.net) → 이 Worker가 받아 컨테이너(ONLYOFFICE Docs, apps/office)로 넘긴다(officeProxy).
 *     앱과 다른 출처라 앱 쿠키가 편집기로 가지 않는다. 넘길 때도 Cookie를 지운다. 공동 편집이 한 서버에 모이도록 컨테이너는 하나("main")다.
 *   화면  POST /api/w/:ws/docs/:menu/:doc/office/session  편집 설정(JWT) + 작업본 잠금, editor 이상
 *         GET  …/office/config?mode=view                    보기 설정(잠금 없음), viewer 이상
 *         POST …/office/keepalive, GET …/office              세션 연장·상태
 *         GET  /api/w/:ws/office/status                      편집 서버 준비 여부(콜드 스타트 동안 화면이 기다린다)
 *   오피스 서버  GET /api/office/file?t=, POST /api/office/callback?t=   세션 쿠키 없이 서명 토큰(SIGNING_KEY)으로
 * OFFICE 바인딩(컨테이너)이 없고 OFFICE_ORIGIN만 있으면(로컬 wrangler dev + docker) 편집 서버에 바로 간다.
 */

export class Office extends Container {
  defaultPort = 80;
  // 마지막 요청 뒤 30분이면 멈춘다(콜드 스타트는 화면이 진행 표시로 기다린다)
  sleepAfter = "30m";
  // 오피스 서버가 앱(APP_ORIGIN)에서 파일을 받고 콜백을 보낸다
  enableInternet = true;

  constructor(ctx: DurableObjectState<{}>, env: Cloudflare.Env) {
    super(ctx, env);
    this.envVars = { JWT_ENABLED: "true", JWT_SECRET: (env as unknown as Bindings).ONLYOFFICE_JWT_SECRET ?? "", JWT_HEADER: "Authorization", WOPI_ENABLED: "false" };
    // 변환 컨테이너(convert.ts)와 같은 이유로 start()에 이미지 이름을 넣어 준다
    const c = ctx.container;
    if (c) {
      const start = c.start.bind(c);
      c.start = (o) => start({ ...o, image: c.images.base } as ContainerStartupOptions);
    }
  }
}

const enabled = (env: Bindings) => !!env.OFFICE_ORIGIN && !!env.ONLYOFFICE_JWT_SECRET;
const officeHost = (env: Bindings) => (env.OFFICE_ORIGIN ? new URL(env.OFFICE_ORIGIN).host : "");
/** 오피스 서버가 앱에 닿는 주소(로컬 docker는 host.docker.internal). 비면 APP_ORIGIN */
const backend = (env: Bindings) => env.OFFICE_BACKEND_ORIGIN || env.APP_ORIGIN;

/** 편집기 출처로 온 요청이면 컨테이너로 넘긴다(index.ts가 앱보다 먼저 부른다) */
export function isOfficeRequest(request: Request, env: Bindings) {
  return !!env.OFFICE && !!officeHost(env) && new URL(request.url).host === officeHost(env);
}

export async function officeProxy(request: Request, env: Bindings): Promise<Response> {
  const url = new URL(request.url);
  const headers = new Headers(request.headers);
  headers.delete("cookie");
  headers.set("x-forwarded-proto", "https");
  headers.set("x-forwarded-host", url.host);
  return getContainer(env.OFFICE!, "main").fetch(new Request(`http://office${url.pathname}${url.search}`, {
    method: request.method, headers, body: request.body, redirect: "manual",
  }));
}

/** 편집 서버에 요청(컨테이너가 있으면 컨테이너, 없으면 OFFICE_ORIGIN) */
async function toOffice(env: Bindings, path: string, init?: RequestInit) {
  if (env.OFFICE) return getContainer(env.OFFICE, "main").fetch(new Request(`http://office${path}`, init));
  return fetch(`${env.OFFICE_ORIGIN}${path}`, init);
}

/** 문서 하나의 세션 저장소(D1 office_session) */
export function officeSessions(db: D1Database, docId: number): OfficeSessions {
  return {
    get: async () => {
      const r = await db.prepare("SELECT doc_key, rev, base_version, user_id, expires_at FROM office_session WHERE document_id = ?").bind(docId)
        .first<{ doc_key: string; rev: number; base_version: string; user_id: number | null; expires_at: number }>();
      return r ? { key: r.doc_key, rev: r.rev, baseVersion: r.base_version, userId: r.user_id, expiresAt: r.expires_at } : null;
    },
    put: async (s) => {
      await db.prepare(`INSERT INTO office_session (document_id, doc_key, rev, base_version, user_id, expires_at) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (document_id) DO UPDATE SET doc_key = excluded.doc_key, rev = excluded.rev, base_version = excluded.base_version,
        user_id = excluded.user_id, expires_at = excluded.expires_at`).bind(docId, s.key, s.rev, s.baseVersion, s.userId, s.expiresAt).run();
    },
    remove: async (key) => { await db.prepare("DELETE FROM office_session WHERE document_id = ? AND doc_key = ?").bind(docId, key).run(); },
  };
}

interface DocRow { id: number; title: string; current_version: string; slug: string; menu_slug: string }
const findDocRow = async (env: Bindings, wsId: number, menu: string, doc: string) => {
  const d = await env.DB.prepare(`SELECT d.id, d.title, d.current_version, d.slug, m.slug AS menu_slug FROM document d JOIN menu m ON m.id = d.menu_id
    WHERE d.workspace_id = ? AND m.slug = ? AND d.slug = ? AND d.deleted_at IS NULL`).bind(wsId, menu, doc).first<DocRow>();
  if (!d) throw new HttpError(404, "문서를 찾을 수 없습니다");
  return d;
};

async function sessionConfig(env: Bindings, ws: Workspace, user: User | null, menu: string, docSlug: string, mode: office.OfficeMode) {
  if (!enabled(env)) throw new HttpError(501, "오피스 편집기를 쓸 수 없는 환경입니다");
  const doc = await findDocRow(env, ws.id, menu, docSlug);
  const sessions = officeSessions(env.DB, doc.id);
  const before = mode === "edit" ? await sessions.get() : null;
  const s = await office.openSession(docStore(env, ws, doc, user), sessions, { scope: `w${ws.id}d${doc.id}`, mode, userId: user?.id ?? null });
  if (mode === "edit" && (!before || before.key !== s.key || before.expiresAt <= Date.now())) await noteUsage(env, ws.id, "office", `${menu}/${docSlug}`);
  const ticket = (use: "file" | "callback", ttl: number) => office.signTicket({ ws: ws.id, doc: doc.id, key: s.key, use }, env.SIGNING_KEY, ttl);
  const config = await office.editorConfig({
    key: s.key, title: `${doc.title}${s.entry.slice(s.entry.lastIndexOf("."))}`, entry: s.entry, mode,
    fileUrl: `${backend(env)}/api/office/file?t=${await ticket("file", 3600)}`,
    callbackUrl: mode === "edit" ? `${backend(env)}/api/office/callback?t=${await ticket("callback", 7 * 86400)}` : undefined,
    user: { id: String(user?.id ?? "anon"), name: user?.name || user?.email || "사용자" },
  }, env.ONLYOFFICE_JWT_SECRET!);
  return { apiUrl: `${env.OFFICE_ORIGIN}/web-apps/apps/api/documents/api.js`, key: s.key, rev: s.rev, config, keepAliveMs: office.KEEPALIVE };
}

/** 워크스페이스 안 화면 API(app.ts의 ws 라우터에 붙인다. 권한은 그쪽 미들웨어가 본다) */
export function officeRoutes(ws: Hono<AppEnv>) {
  ws.post("/docs/:menu/:doc/office/session", async (c) =>
    c.json(await sessionConfig(c.env, c.var.ws, c.var.user, c.req.param("menu"), c.req.param("doc"), "edit")));
  ws.get("/docs/:menu/:doc/office/config", async (c) =>
    c.json(await sessionConfig(c.env, c.var.ws, c.var.user, c.req.param("menu"), c.req.param("doc"), "view")));
  ws.post("/docs/:menu/:doc/office/keepalive", async (c) => {
    const { key } = await c.req.json<{ key: string }>();
    const doc = await findDocRow(c.env, c.var.ws.id, c.req.param("menu"), c.req.param("doc"));
    return c.json({ alive: await office.keepAlive(officeSessions(c.env.DB, doc.id), String(key)) });
  });
  ws.get("/docs/:menu/:doc/office", async (c) => {
    const doc = await findDocRow(c.env, c.var.ws.id, c.req.param("menu"), c.req.param("doc"));
    const s = await officeSessions(c.env.DB, doc.id).get();
    const head = await c.env.DB.prepare("SELECT rev FROM document_head WHERE document_id = ?").bind(doc.id).first<{ rev: number }>();
    return c.json({ active: !!s && s.expiresAt > Date.now(), key: s?.key ?? null, rev: head?.rev ?? 0 });
  });
  ws.get("/office/status", async (c) => {
    if (!enabled(c.env)) return c.json({ enabled: false, ready: false });
    try {
      const res = await toOffice(c.env, "/healthcheck", { signal: AbortSignal.timeout(5000) });
      return c.json({ enabled: true, ready: res.ok && (await res.text()).trim() === "true" });
    } catch {
      // 컨테이너가 깨어나는 중(포트가 아직 안 열림)
      return c.json({ enabled: true, ready: false });
    }
  });
}

/** 오피스 서버가 부르는 API(세션 쿠키 없음, 서명 토큰). app.ts가 /api/office에 붙인다 */
export const officeServer = new Hono<AppEnv>();

const ticketDoc = async (env: Bindings, t: office.OfficeTicket) => {
  const ws = await env.DB.prepare("SELECT id, slug, name FROM workspace WHERE id = ?").bind(Number(t.ws)).first<Workspace>();
  const doc = await env.DB.prepare(`SELECT d.id, d.title, d.current_version, d.slug, m.slug AS menu_slug, m.category_key AS category FROM document d
    JOIN menu m ON m.id = d.menu_id WHERE d.id = ? AND d.workspace_id = ? AND d.deleted_at IS NULL`).bind(Number(t.doc), Number(t.ws))
    .first<DocRow & { category: string }>();
  if (!ws || !doc) throw new HttpError(404, "문서를 찾을 수 없습니다");
  return { ws, doc };
};

officeServer.get("/file", async (c) => {
  const t = await office.readTicket(c.req.query("t") ?? "", c.env.SIGNING_KEY, "file");
  if (!t) throw new HttpError(403, "주소가 맞지 않거나 만료됐습니다");
  const { ws, doc } = await ticketDoc(c.env, t);
  const store = docStore(c.env, ws, doc);
  const s = await office.openSession(store, officeSessions(c.env.DB, doc.id), { scope: `w${ws.id}d${doc.id}`, mode: "view", userId: null });
  // 토큰을 만든 뒤 내용이 바뀌었으면(다른 키) 주지 않는다: 오피스 서버가 키와 다른 내용을 캐시하지 않게
  if (s.key !== t.key) throw new HttpError(409, "문서 내용이 바뀌었습니다. 편집기를 다시 여세요");
  return new Response(await getBlob(c.env.BLOBS, ws.id, s.sha256), { headers: { "content-type": "application/octet-stream", "cache-control": "no-store" } });
});

officeServer.post("/callback", async (c) => {
  const t = await office.readTicket(c.req.query("t") ?? "", c.env.SIGNING_KEY, "callback");
  if (!t) throw new HttpError(403, "주소가 맞지 않거나 만료됐습니다");
  const body = await c.req.json<office.CallbackBody>().catch(() => ({}) as office.CallbackBody);
  const cb = await office.verifyCallback(body, c.req.header("authorization"), c.env.ONLYOFFICE_JWT_SECRET ?? "");
  if (!cb) throw new HttpError(403, "콜백 서명이 맞지 않습니다");
  const { ws, doc } = await ticketDoc(c.env, t);
  const sessions = officeSessions(c.env.DB, doc.id);
  const owner = (await sessions.get())?.userId ?? null;
  const user = owner ? await c.env.DB.prepare("SELECT id, email, name, picture FROM app_user WHERE id = ?").bind(owner).first<User>() : null;
  const r = await office.handleCallback(docStore(c.env, ws, doc, user), sessions, cb, {
    expectedKey: t.key, officeOrigin: c.env.OFFICE_ORIGIN ?? "",
    download: async (url) => {
      const u = new URL(url);
      const res = await toOffice(c.env, `${u.pathname}${u.search}`);
      if (!res.ok) throw new HttpError(502, `저장 파일을 받지 못했습니다(${res.status})`);
      if (Number(res.headers.get("content-length") ?? 0) > office.MAX_OFFICE_FILE) throw new HttpError(413, "저장 파일이 너무 큽니다");
      return new Uint8Array(await res.arrayBuffer());
    },
  });
  if (r.saved?.changed) {
    const event = { type: "changed", reason: "revision", by: undefined, userId: user?.id, category: doc.category, menu: doc.menu_slug, doc: doc.slug, title: doc.title, rev: r.saved.rev };
    await Promise.all([
      liveStub(c.env, ws.id).broadcast(event),
      c.env.DB.prepare("INSERT INTO activity (workspace_id, user_id, agent, action, target, version, at) VALUES (?, ?, NULL, 'office-save', ?, NULL, ?)")
        .bind(ws.id, user?.id ?? null, `${doc.menu_slug}/${doc.slug}`, new Date().toISOString()).run(),
    ]).catch((e) => console.error("오피스 저장 알림 실패", e));
  }
  // 오피스 서버는 error: 0이 아니면 다시 보낸다
  return c.json({ error: 0 });
});
