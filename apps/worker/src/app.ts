import { Hono, type Context } from "hono";
import { admin } from "./admin.ts";
import { consent } from "./consent.ts";
import { auth, currentUser, inviteLink, roleIn, superadmins } from "./auth.ts";
import { createWorkspace, members } from "./members.ts";
import { serveContent } from "./content.ts";
import type { Change } from "@workflow/core/textedit";
import { mimeOf } from "@workflow/core/mime";
import type { IncomingFile } from "@workflow/core/upload";
import { HttpError, type AppEnv, type Role } from "./env.ts";
import {
  addCategory, addMenu, deleteCategory, deleteMenu, listTrash, moveDoc, moveMenu, purgeDoc, renameMenu, restoreDoc, trashDoc,
  updateCategory, updateDoc,
} from "./manage.ts";
import { docDetail, docPath, findDoc, tree, workspaceBySlug } from "./repo.ts";
import { search } from "./search.ts";
import { sha256Hex } from "./blobs.ts";
import { toPdf } from "./convert.ts";
import { exportWorkspace } from "./export.ts";
import { getRevision, listRevisions, publish, restoreRevision, saveRevision, workState } from "./revisions.ts";
import { assetRow, putAsset } from "./assets.ts";
import { applyStructOps, readStructure, structEditView, type StructOp } from "./structedit.ts";
import { patchDeck, patchSlide, putSlide, readDeck } from "./deck.ts";
import { StructEditError } from "@workflow/core/structedit/html";
import { agentOf, liveStub, reasonOf } from "./live.ts";

import { contentToken } from "./token.ts";
import { editView, previewTextEdit, readSegments, release, saveEdit, saveTextEdit, upload } from "./write.ts";

/**
 * 문서 탐색 워크플로우 앱 Worker(REQUIREMENT-4.0). 한 Worker가 두 도메인을 받는다.
 *   앱    workflow.simplite.net        /api/*(이 파일), 그 밖은 화면 정적 파일(SPA, wrangler assets)
 *   콘텐츠 workflow-files.simplite.net  /c/*만(content.ts). FILES_ORIGIN이 비면(로컬) 앱과 같은 출처에서 /c/를 준다
 */
export const app = new Hono<AppEnv>();

app.onError((err, c) => {
  if (err instanceof HttpError || err instanceof StructEditError) return c.json({ error: err.message }, err.status as 400);
  console.error(err);
  return c.json({ error: err.message }, 500);
});

// 호스트로 앱과 콘텐츠를 나눈다. 콘텐츠 도메인에서는 /c/만, 앱 도메인에서는 /c/를 주지 않는다(같은 출처에서 사용자 HTML이 열리지 않게)
app.use("*", async (c, next) => {
  const files = c.env.FILES_ORIGIN ? new URL(c.env.FILES_ORIGIN).host : "";
  const onFiles = !!files && new URL(c.req.url).host === files;
  const isContent = c.req.path.startsWith("/c/") || c.req.path.startsWith("/i/");
  if (files && onFiles !== isContent) return c.text("Not Found", 404);
  await next();
});

app.get("/c/*", serveContent);

// Markdown 편집기 이미지(D-32). 문서에 주소가 영구히 남으므로 토큰 없이, 추측할 수 없는 이름으로 준다(예전 R2 공개 주소와 같은 방식)
app.get("/i/:ws/:name", async (c) => {
  const name = c.req.param("name");
  if (!/^[\w.-]+$/.test(name)) return c.text("Not Found", 404);
  const obj = await c.env.BLOBS.get(`ws/${c.req.param("ws")}/images/${name}`);
  if (!obj) return c.text("Not Found", 404);
  return new Response(obj.body, { headers: {
    "content-type": obj.httpMetadata?.contentType ?? mimeOf(name), "cache-control": "public, max-age=31536000, immutable",
    "x-content-type-options": "nosniff", "content-security-policy": "sandbox",
  } });
});

// 요청 위조(CSRF) 막기: 쿠키로 인증하는 API는 상태를 바꾸는 요청이 이 앱 화면에서 온 것만 받는다.
// 콘텐츠 도메인도 같은 사이트(simplite.net)라 SameSite 쿠키만으로는 막히지 않는다(5.5). 가져오기 API는 Bearer 토큰이라 제외
app.use("/api/*", async (c, next) => {
  const unsafe = !["GET", "HEAD", "OPTIONS"].includes(c.req.method);
  if (unsafe && !c.req.path.startsWith("/api/admin/") && c.req.header("origin") !== new URL(c.req.url).origin) {
    return c.json({ error: "허용되지 않은 요청입니다" }, 403);
  }
  await next();
});

// 요청 수 제한(4.0 P8, Workers Rate Limiting): 로그인은 IP마다 분당 20번, 상태를 바꾸는 워크스페이스 API는 IP마다 분당 120번
app.use("/api/*", async (c, next) => {
  // 운영에서는 Cloudflare가 늘 cf-connecting-ip를 넣는다. 없으면(로컬·테스트) 제한하지 않는다
  const ip = c.req.header("cf-connecting-ip");
  const limiter = !ip ? undefined : c.req.path.startsWith("/api/auth/") ? c.env.LIMIT_AUTH
    : c.req.method !== "GET" && c.req.path.startsWith("/api/w/") ? c.env.LIMIT_WRITE : undefined;
  if (limiter && ip && !(await limiter.limit({ key: ip })).success) return c.json({ error: "요청이 너무 많습니다. 잠시 뒤 다시 시도하세요" }, 429);
  await next();
});

app.route("/api/admin", admin);
app.route("/", consent);
app.route("/api/auth", auth);
app.get("/api/invites/:token", inviteLink);

app.get("/api/health", (c) => c.json({ ok: true }));

/** 로그인한 사람과 속한 워크스페이스. 로그인 전이면 user: null */
app.get("/api/me", async (c) => {
  const user = await currentUser(c);
  // devLogin: 로그인 화면이 개발용 이메일 로그인 칸을 보여 줄지(DEV_LOGIN=1, 로컬·테스트만)
  if (!user) return c.json({ user: null, workspaces: [], superadmin: false, ...(c.env.DEV_LOGIN === "1" ? { devLogin: true } : {}) });
  const { results } = await c.env.DB.prepare(`SELECT w.slug, w.name, m.role FROM member m JOIN workspace w ON w.id = m.workspace_id
    WHERE m.user_id = ? ORDER BY w.name`).bind(user.id).all();
  return c.json({ user, workspaces: results, superadmin: superadmins(c.env).has(user.email.toLowerCase()) });
});

app.post("/api/workspaces", async (c) => {
  const user = await currentUser(c);
  if (!user) throw new HttpError(401, "로그인하세요");
  const { slug, name } = await c.req.json<{ slug: string; name: string }>();
  return c.json(await createWorkspace(c.env.DB, c.env, user, slug, name));
});

const ws = new Hono<AppEnv>();
/**
 * 권한(5.9): 읽기는 viewer, 쓰기는 editor, 아래는 owner만.
 * 멤버가 아니면 워크스페이스가 있는지도 알려 주지 않고 404
 */
const OWNER_ONLY: [string, RegExp][] = [
  ["DELETE", /^\/menus\/[^/]+$/], ["DELETE", /^\/trash\/[^/]+$/], ["*", /^\/categories(\/|$)/], ["*", /^\/invites(\/|$)/],
  ["PATCH", /^\/members\//], ["DELETE", /^\/members\//], ["GET", /^\/export$/],
];
function needed(method: string, path: string): Role {
  if (OWNER_ONLY.some(([m, re]) => (m === "*" || m === method) && re.test(path))) return "owner";
  return method === "GET" || method === "HEAD" ? "viewer" : "editor";
}
const RANK: Record<Role, number> = { viewer: 0, editor: 1, owner: 2 };

ws.use("*", async (c, next) => {
  const user = await currentUser(c);
  if (!user) throw new HttpError(401, "로그인하세요");
  const found = await workspaceBySlug(c.env.DB, c.req.param("ws")!);
  const role = found ? await roleIn(c.env.DB, found.id, user.id) : null;
  if (!found || !role) throw new HttpError(404, "워크스페이스를 찾을 수 없습니다");
  const sub = c.req.path.slice(`/api/w/${c.req.param("ws")}`.length);
  const need = needed(c.req.method, sub);
  if (RANK[role] < RANK[need]) throw new HttpError(403, need === "owner" ? "워크스페이스 관리자(owner)만 할 수 있습니다" : "보기 권한만 있습니다");
  c.set("ws", found);
  c.set("user", user);
  c.set("role", role);
  await next();
  // 바뀌었으면 열린 화면들에 알리고 활동 기록을 남긴다. 응답 전에 끝낸다(DO 호출 하나와 D1 한 줄이라 짧고, 순서가 확실하다).
  // 알림이 실패해도 저장은 이미 끝났으므로 응답은 성공으로 둔다
  const reason = reasonOf(c.req.method, sub);
  if (reason && c.res.status < 300) await afterChange(c, reason, sub).catch((e) => console.error("변경 알림 실패", e));
});

/** 변경 알림(로컬 SSE와 같은 모양: by, 대분류·메뉴·문서·제목·버전·바뀐 조각)과 활동 기록 */
async function afterChange(c: Context<AppEnv>, reason: string, sub: string) {
  const body = await c.res.clone().json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
  const fromPath = /^\/docs\/([^/]+)\/([^/]+)/.exec(sub);
  const menu = (body.menu as string | undefined) ?? fromPath?.[1];
  const doc = (body.doc as string | undefined) ?? fromPath?.[2];
  const info = menu && doc
    ? await c.env.DB.prepare(`SELECT d.title, m.category_key AS category FROM document d JOIN menu m ON m.id = d.menu_id
        WHERE d.workspace_id = ? AND m.slug = ? AND d.slug = ? AND d.deleted_at IS NULL`).bind(c.var.ws.id, menu, doc).first<{ title: string; category: string }>()
    : null;
  const segs = reason === "text-edit" ? ((await c.req.json<{ changes?: { id: number }[] }>().catch(() => ({}) as { changes?: { id: number }[] })).changes ?? []).map((x) => x.id) : undefined;
  const event = {
    type: "changed", reason, by: agentOf(c), userId: c.var.user?.id, category: (body.category as string | undefined) ?? info?.category, menu, doc, title: info?.title,
    version: body.version as string | undefined, rev: body.rev as number | undefined, segs,
  };
  await Promise.all([
    liveStub(c.env, c.var.ws.id).broadcast(event),
    c.env.DB.prepare("INSERT INTO activity (workspace_id, user_id, agent, action, target, version, at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(c.var.ws.id, c.var.user?.id ?? null, event.by ?? null, reason, menu ? `${menu}${doc ? `/${doc}` : ""}` : sub, event.version ?? null, new Date().toISOString()).run(),
  ]);
}

/** 실시간 연결(WebSocket). 워크스페이스 DO로 넘긴다 */
ws.get("/live", async (c) => {
  if (c.req.header("upgrade")?.toLowerCase() !== "websocket") return c.json({ error: "WebSocket으로 연결하세요" }, 426);
  // 접속자 표시(5.0 M7)용으로 누구인지 DO에 넘긴다
  const u = c.var.user;
  const headers = new Headers(c.req.raw.headers);
  headers.set("x-live-user", JSON.stringify(u ? { id: u.id, email: u.email, name: u.name } : null));
  return liveStub(c.env, c.var.ws.id).fetch(new Request(c.req.raw, { headers }));
});

/** 열린 화면을 문서·버전·조각으로 옮긴다(3.4 focus_in_site). 받은 화면 수를 돌려준다 */
ws.post("/focus", async (c) => {
  const { menu, doc, version, seg } = await c.req.json<{ menu: string; doc: string; version?: string; seg?: string }>();
  const info = await c.env.DB.prepare(`SELECT d.title, m.category_key AS category FROM document d JOIN menu m ON m.id = d.menu_id
    WHERE d.workspace_id = ? AND m.slug = ? AND d.slug = ? AND d.deleted_at IS NULL`).bind(c.var.ws.id, menu ?? "", doc ?? "").first<{ title: string; category: string }>();
  if (!info) throw new HttpError(404, "문서를 찾을 수 없습니다");
  if (seg && !/^[\d,-]+$/.test(seg)) throw new HttpError(400, "seg는 12, 12-15, 3,10-12 형식입니다");
  const clients = await liveStub(c.env, c.var.ws.id).broadcast({ type: "focus", by: agentOf(c), category: info.category, menu, doc, title: info.title, version, seg });
  return c.json({ clients });
});

// ---------- 수정본(5.0 M1): 작업본 열기·저장·이력·되돌리기·버전으로 올리기 ----------
/** 작업본 주소: 수정본이면 /r<번호>/, 아니면 버전 폴더 */
async function workFileUrl(c: Context<AppEnv>, doc: { id: number; parent_id: number | null; slug: string; menu_slug: string }, folder: string) {
  const base = await contentBase(c);
  const dir = await docPath(c.env.DB, doc, doc.menu_slug);
  return (path: string) => `${base}/${encPath(dir)}/${folder}/${encPath(path)}`;
}

ws.get("/docs/:menu/:doc/work", async (c) => {
  const doc = await findDoc(c.env.DB, c.var.ws.id, c.req.param("menu"), c.req.param("doc"));
  const st = await workState(c.env, c.var.ws, doc);
  const url = await workFileUrl(c, doc, st.fromRevision ? `r${st.rev}` : st.baseVersion);
  return c.json({ baseVersion: st.baseVersion, rev: st.rev, fromRevision: st.fromRevision, entry: st.manifest.entry,
    files: st.manifest.files.map((f) => ({ ...f, url: url(f.path) })) });
});

/** 저장: { baseRev, put: [{ path, text | base64 }], remove?, entry?, summary? } 또는 구조 편집 { baseRev, ops, summary? } → 새 수정본 */
ws.post("/docs/:menu/:doc/revisions", async (c) => {
  const b = await c.req.json<{ baseRev: number; put?: { path: string; text?: string; base64?: string }[]; remove?: string[]; entry?: string; summary?: string; ops?: StructOp[] }>();
  if (typeof b.baseRev !== "number") throw new HttpError(400, "baseRev가 필요합니다");
  if (b.ops !== undefined) {
    if (b.put || b.remove || b.entry) throw new HttpError(400, "ops와 파일 교체(put·remove·entry)는 함께 보낼 수 없습니다");
    return c.json(await applyStructOps(c.env, c.var.ws, c.var.user, c.req.param("menu"), c.req.param("doc"), {
      baseRev: b.baseRev, ops: b.ops, summary: b.summary, source: agentOf(c) ? "agent" : "human",
    }));
  }
  const put = (b.put ?? []).map((f) => ({
    path: f.path,
    data: f.base64 !== undefined ? Uint8Array.from(atob(f.base64), (ch) => ch.charCodeAt(0)) : new TextEncoder().encode(f.text ?? ""),
  }));
  return c.json(await saveRevision(c.env, c.var.ws, c.var.user, c.req.param("menu"), c.req.param("doc"), {
    baseRev: b.baseRev, put, remove: b.remove, entry: b.entry, summary: b.summary, source: agentOf(c) ? "agent" : "human",
  }));
});

// 구조 편집(5.0 M3·M5): 작업본의 표·그림·블록 목록, HTML 편집 사본(data-eid, 스크립트 없이 sandbox="allow-same-origin"으로 연다)
ws.get("/docs/:menu/:doc/work/structure", async (c) =>
  c.json(await readStructure(c.env, c.var.ws, c.req.param("menu"), c.req.param("doc"))));
ws.get("/docs/:menu/:doc/work/edit-view", async (c) => {
  const view = await structEditView(c.env, c.var.ws, c.req.param("menu"), c.req.param("doc"),
    async (doc, folder, dir) => (await workFileUrl(c, doc, folder))(dir));
  return c.body(view.body, 200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-workflow-rev": String(view.rev),
    "content-security-policy": "sandbox allow-same-origin" });
});

// 작업본 미리보기 PDF(PPTX 구조 편집 화면). 변환 결과는 내용(sha)으로 캐시된다
ws.get("/docs/:menu/:doc/work/pdf", async (c) => {
  const doc = await findDoc(c.env.DB, c.var.ws.id, c.req.param("menu"), c.req.param("doc"));
  const st = await workState(c.env, c.var.ws, doc);
  const f = st.manifest.files.find((x) => x.path === st.manifest.entry)!;
  const pdf = await toPdf(c.env, c.var.ws.id, null, f.path.slice(f.path.lastIndexOf(".")), f.sha256);
  return new Response(pdf, { headers: { "content-type": "application/pdf", "cache-control": "no-store" } });
});

// 슬라이드 덱(5.0 M4): 작업본 읽기, 슬라이드 연산·통째 쓰기, 색인(순서·제목) 고치기. 모두 수정본으로 저장
ws.get("/docs/:menu/:doc/deck", async (c) => c.json(await readDeck(c.env, c.var.ws, c.req.param("menu"), c.req.param("doc"))));
ws.post("/docs/:menu/:doc/deck/slides/:sid", async (c) =>
  c.json(await patchSlide(c.env, c.var.ws, c.var.user, c.req.param("menu"), c.req.param("doc"), c.req.param("sid"), await c.req.json(), agentOf(c) ? "agent" : "human")));
ws.put("/docs/:menu/:doc/deck/slides/:sid", async (c) =>
  c.json(await putSlide(c.env, c.var.ws, c.var.user, c.req.param("menu"), c.req.param("doc"), c.req.param("sid"), await c.req.json(), agentOf(c) ? "agent" : "human")));
ws.patch("/docs/:menu/:doc/deck", async (c) =>
  c.json(await patchDeck(c.env, c.var.ws, c.var.user, c.req.param("menu"), c.req.param("doc"), await c.req.json(), agentOf(c) ? "agent" : "human")));

ws.get("/docs/:menu/:doc/revisions", async (c) => {
  const before = c.req.query("before");
  return c.json(await listRevisions(c.env, c.var.ws, c.req.param("menu"), c.req.param("doc"), before ? Number(before) : undefined));
});

ws.get("/docs/:menu/:doc/revisions/:rev", async (c) => {
  const r = await getRevision(c.env, c.var.ws, c.req.param("menu"), c.req.param("doc"), Number(c.req.param("rev")));
  const url = await workFileUrl(c, r.doc, `r${r.rev}`);
  return c.json({ rev: r.rev, baseVersion: r.baseVersion, source: r.source, summary: r.summary, createdAt: r.createdAt, entry: r.manifest.entry,
    files: r.manifest.files.map((f) => ({ ...f, url: url(f.path) })) });
});

ws.post("/docs/:menu/:doc/revisions/:rev/restore", async (c) => {
  const { baseRev } = await c.req.json<{ baseRev: number }>();
  return c.json(await restoreRevision(c.env, c.var.ws, c.var.user, c.req.param("menu"), c.req.param("doc"), Number(c.req.param("rev")), baseRev));
});

ws.post("/docs/:menu/:doc/publish", async (c) =>
  c.json(await publish(c.env, c.var.ws, c.req.param("menu"), c.req.param("doc"), await c.req.json())));

// ---------- 편집기 이미지 자산(5.0 M1) ----------
ws.post("/assets", async (c) => {
  const file = (await c.req.formData()).get("file");
  if (!file || typeof file === "string") throw new HttpError(400, "file 필드가 없습니다");
  return c.json(await putAsset(c.env, c.var.ws, c.var.user, file));
});
ws.get("/assets/:sha/url", async (c) => {
  const a = await assetRow(c.env.DB, c.var.ws.id, c.req.param("sha"));
  if (!a) throw new HttpError(404, "없는 이미지입니다");
  return c.json({ url: `${await contentBase(c)}/_asset/${a.sha256}`, width: a.width, height: a.height, mime: a.mime });
});

/** 워크스페이스 내보내기(owner): docs/ 모양 zip. 가져오기 CLI로 다시 넣을 수 있다 */
ws.get("/export", async (c) => new Response(exportWorkspace(c.env, c.var.ws), { headers: {
  "content-type": "application/zip", "cache-control": "no-store",
  "content-disposition": `attachment; filename="${c.var.ws.slug}-${new Date().toISOString().slice(0, 10)}.zip"`,
} }));

/** 최근 활동 100개 */
ws.get("/activity", async (c) => {
  const { results } = await c.env.DB.prepare(`SELECT a.id, a.action, a.target, a.version, a.agent, a.at, u.email FROM activity a
    LEFT JOIN app_user u ON u.id = a.user_id WHERE a.workspace_id = ? ORDER BY a.id DESC LIMIT 100`).bind(c.var.ws.id).all();
  return c.json(results);
});

ws.route("/", members);

ws.get("/tree", async (c) => c.json(await tree(c.env.DB, c.var.ws.id)));

/** 콘텐츠 주소 앞부분: <콘텐츠 출처>/c/<토큰> */
async function contentBase(c: { env: AppEnv["Bindings"]; req: { url: string }; var: { ws: { id: number } } }) {
  return `${c.env.FILES_ORIGIN || new URL(c.req.url).origin}/c/${await contentToken(c.env.SIGNING_KEY, c.var.ws.id)}`;
}
const encPath = (p: string) => p.split("/").map(encodeURIComponent).join("/");

ws.get("/docs/:menu/:doc", async (c) => {
  const base = await contentBase(c);
  return c.json(await docDetail(c.env.DB, c.var.ws.id, c.req.param("menu"), c.req.param("doc"),
    (docPath, version, path) => `${base}/${encPath(docPath)}/${version}/${encPath(path)}`));
});

/** 업로드. multipart 필드: menu, doc?, parent?, title?, slug?, version?, note?, entry?, origin?, paths(JSON, 파일 순서와 같은 상대 경로), files */
ws.post("/upload", async (c) => {
  const form = await c.req.formData();
  const field = (k: string) => (typeof form.get(k) === "string" ? (form.get(k) as string) || undefined : undefined);
  const paths: string[] = JSON.parse(field("paths") ?? "[]");
  const files: IncomingFile[] = await Promise.all(form.getAll("files").filter((f): f is File => typeof f !== "string")
    .map(async (f, i) => ({ path: paths[i] || f.name, data: new Uint8Array(await f.arrayBuffer()) })));
  return c.json(await upload(c.env, c.var.ws, {
    menu: field("menu") ?? "", doc: field("doc"), parent: field("parent"), title: field("title"), slug: field("slug"),
    version: field("version"), note: field("note"), entry: field("entry"), origin: field("origin"), files,
  }));
});

ws.post("/docs/:menu/:doc/edit", async (c) =>
  c.json(await saveEdit(c.env, c.var.ws, c.req.param("menu"), c.req.param("doc"), await c.req.json())));

// ---------- 관리 ----------
ws.post("/menus", async (c) => {
  const b = await c.req.json<{ category: string; name: string; slug?: string; parent?: string }>();
  return c.json(await addMenu(c.env.DB, c.var.ws, b.category, b.name, b.slug, b.parent));
});
ws.patch("/menus/:slug", async (c) => {
  await renameMenu(c.env.DB, c.var.ws, c.req.param("slug"), (await c.req.json<{ name: string }>()).name);
  return c.json({ ok: true });
});
ws.post("/menus/:slug/move", async (c) => {
  await moveMenu(c.env.DB, c.var.ws, c.req.param("slug"), await c.req.json());
  return c.json({ ok: true });
});
ws.delete("/menus/:slug", async (c) => c.json(await deleteMenu(c.env.DB, c.var.ws, c.req.param("slug"))));

ws.post("/categories", async (c) => {
  const b = await c.req.json<{ name: string; key?: string }>();
  return c.json(await addCategory(c.env.DB, c.var.ws, b.name, b.key));
});
ws.patch("/categories/:key", async (c) => {
  await updateCategory(c.env.DB, c.var.ws, c.req.param("key"), await c.req.json());
  return c.json({ ok: true });
});
ws.delete("/categories/:key", async (c) => {
  await deleteCategory(c.env.DB, c.var.ws, c.req.param("key"));
  return c.json({ ok: true });
});

ws.patch("/docs/:menu/:doc", async (c) => {
  await updateDoc(c.env.DB, c.var.ws, c.req.param("menu"), c.req.param("doc"), await c.req.json());
  return c.json({ ok: true });
});
ws.post("/docs/:menu/:doc/move", async (c) =>
  c.json(await moveDoc(c.env.DB, c.var.ws, c.req.param("menu"), c.req.param("doc"), await c.req.json())));
ws.delete("/docs/:menu/:doc", async (c) => c.json(await trashDoc(c.env.DB, c.var.ws, c.req.param("menu"), c.req.param("doc"))));

// ---------- 텍스트 편집(2.0) ----------
ws.get("/docs/:menu/:doc/segments", async (c) =>
  c.json(await readSegments(c.env, c.var.ws, c.req.param("menu"), c.req.param("doc"), c.req.query("v"))));

// HTML·SVG 편집 화면용 사본. 화면은 앱 출처에서 스크립트 없이(sandbox="allow-same-origin") 열고, 리소스는 <base>로 콘텐츠 도메인에서 읽는다
ws.get("/docs/:menu/:doc/edit-view", async (c) => {
  const base = await contentBase(c);
  const view = await editView(c.env, c.var.ws, c.req.param("menu"), c.req.param("doc"), c.req.query("v"), async (docId, version, dir) => {
    const d = await c.env.DB.prepare("SELECT d.id, d.slug, d.parent_id, m.slug AS menu FROM document d JOIN menu m ON m.id = d.menu_id WHERE d.id = ?")
      .bind(docId).first<{ id: number; slug: string; parent_id: number | null; menu: string }>();
    return `${base}/${encPath(await docPath(c.env.DB, d!, d!.menu))}/${version}/${encPath(dir)}`;
  });
  return c.body(view.body, 200, {
    "content-type": view.type === "svg" ? "image/svg+xml; charset=utf-8" : "text/html; charset=utf-8", "cache-control": "no-store",
    // 앱 출처라 주소를 직접 열어도 문서 스크립트가 돌지 않게 한다(화면은 같은 출처로 DOM을 고쳐야 해서 allow-same-origin만)
    "content-security-policy": "sandbox allow-same-origin",
  });
});

// 저장하지 않은 미리보기: 바뀐 조각을 반영한 대표 파일. ?to=pdf면 변환 컨테이너로 PDF(PPTX 편집 미리보기)
ws.post("/docs/:menu/:doc/text-preview", async (c) => {
  const r = await previewTextEdit(c.env, c.var.ws, c.req.param("menu"), c.req.param("doc"), await c.req.json());
  if (c.req.query("to") === "pdf") {
    const ext = r.entry.slice(r.entry.lastIndexOf("."));
    const pdf = await toPdf(c.env, c.var.ws.id, r.data, ext, await sha256Hex(r.data));
    return new Response(pdf, { headers: { "content-type": "application/pdf", "cache-control": "no-store" } });
  }
  return new Response(r.data, { headers: { "content-type": mimeOf(r.entry), "cache-control": "no-store" } });
});

// 변환 결과(PDF). 파일은 sha256으로 가리키고, 이 워크스페이스 문서의 파일이어야 한다. 결과는 내용이 같으면 영원히 같다
ws.get("/convert/:to/:sha", async (c) => {
  if (c.req.param("to") !== "pdf") return c.json({ error: "pdf만 지원합니다(draw.io는 화면의 draw.io 뷰어로 봅니다)" }, 400);
  const sha = c.req.param("sha");
  const f = await c.env.DB.prepare(`SELECT f.path FROM version_file f JOIN document_version v ON v.id = f.version_id JOIN document d ON d.id = v.document_id
    WHERE d.workspace_id = ? AND f.sha256 = ? LIMIT 1`).bind(c.var.ws.id, sha).first<{ path: string }>();
  if (!f) throw new HttpError(404, "파일을 찾을 수 없습니다");
  const pdf = await toPdf(c.env, c.var.ws.id, null, f.path.slice(f.path.lastIndexOf(".")), sha);
  return new Response(pdf, { headers: { "content-type": "application/pdf", "cache-control": "private, max-age=31536000, immutable" } });
});
ws.post("/docs/:menu/:doc/text-edit", async (c) =>
  c.json(await saveTextEdit(c.env, c.var.ws, c.req.param("menu"), c.req.param("doc"), await c.req.json<{ baseVersion: string; changes: Change[]; note?: string }>())));

ws.post("/docs/:menu/:doc/release", async (c) => {
  const body = await c.req.json<{ note?: string }>().catch(() => ({} as { note?: string }));
  return c.json(await release(c.env, c.var.ws, c.req.param("menu"), c.req.param("doc"), body.note));
});

// ---------- 휴지통·검색 ----------
ws.get("/trash", async (c) => c.json(await listTrash(c.env.DB, c.var.ws)));
ws.post("/trash/:id/restore", async (c) => {
  const body = await c.req.json<{ menu?: string }>().catch(() => ({} as { menu?: string }));
  return c.json(await restoreDoc(c.env, c.var.ws, c.req.param("id"), body.menu));
});
ws.delete("/trash/:id", async (c) => {
  await purgeDoc(c.env, c.var.ws, c.req.param("id"));
  return c.json({ ok: true });
});
ws.get("/search", async (c) => c.json(await search(c.env.DB, c.var.ws, c.req.query("q") ?? "", c.req.query("category"), c.req.query("kind"))));

// ---------- Markdown 편집기 이미지(D-32) ----------
const IMAGE_TYPES: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "image/svg+xml": "svg" };
ws.post("/images", async (c) => {
  const file = (await c.req.formData()).get("file");
  if (!file || typeof file === "string") return c.json({ success: false, error: "file 필드가 없습니다" }, 400);
  const ext = IMAGE_TYPES[file.type];
  if (!ext) return c.json({ success: false, error: "png·jpg·gif·webp·svg만 올릴 수 있습니다" }, 400);
  if (file.size > 10 * 1024 * 1024) return c.json({ success: false, error: "10MB 이하만 올릴 수 있습니다" }, 413);
  const name = `${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}-${crypto.randomUUID()}.${ext}`;
  await c.env.BLOBS.put(`ws/${c.var.ws.id}/images/${name}`, await file.arrayBuffer(), { httpMetadata: { contentType: file.type } });
  return c.json({ success: true, url: `${c.env.FILES_ORIGIN || new URL(c.req.url).origin}/i/${c.var.ws.id}/${name}` });
});

app.route("/api/w/:ws", ws);

app.all("/api/*", (c) => c.json({ error: "없는 API입니다" }, 404));

