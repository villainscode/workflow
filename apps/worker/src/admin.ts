import { Hono } from "hono";
import { mimeOf } from "@workflow/core/mime";
import { blobKey, HttpError, type AppEnv } from "./env.ts";
import { workspaceBySlug } from "./repo.ts";

/**
 * 가져오기 API(P2). 리포 docs/를 워크스페이스로 옮기는 CLI(packages/cli)가 쓴다. Bearer ADMIN_TOKEN이 있어야 한다.
 * 순서: POST /workspaces(만들기·비우기) → POST /w/:ws/site(대분류·메뉴) → POST /w/:ws/blobs/missing → PUT /w/:ws/blobs/:sha → POST /w/:ws/docs(문서 하나씩, 상위 문서 먼저)
 */
export const admin = new Hono<AppEnv>();

admin.use("*", async (c, next) => {
  const auth = c.req.header("authorization") ?? "";
  if (!c.env.ADMIN_TOKEN || auth !== `Bearer ${c.env.ADMIN_TOKEN}`) return c.json({ error: "권한이 없습니다" }, 401);
  await next();
});

const wsOf = async (db: D1Database, slug: string) => {
  const ws = await workspaceBySlug(db, slug);
  if (!ws) throw new HttpError(404, `워크스페이스가 없습니다: ${slug}`);
  return ws;
};

/** 워크스페이스를 만든다. reset이면 안의 메뉴·문서를 모두 지운다(R2 blob은 내용 주소라 남겨 두고 다시 쓴다) */
admin.post("/workspaces", async (c) => {
  const { slug, name, reset } = await c.req.json<{ slug: string; name: string; reset?: boolean }>();
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug ?? "")) throw new HttpError(400, "워크스페이스 slug는 영문 소문자·숫자·-만 씁니다");
  const db = c.env.DB;
  await db.prepare("INSERT INTO workspace (slug, name, created_at) VALUES (?, ?, ?) ON CONFLICT (slug) DO UPDATE SET name = excluded.name")
    .bind(slug, name, new Date().toISOString()).run();
  const ws = await wsOf(db, slug);
  if (reset) {
    await db.batch([
      db.prepare("DELETE FROM search WHERE workspace_id = ?").bind(ws.id),
      // 수정본(5.0)이 버전·문서를 가리키므로 먼저 지운다
      db.prepare("UPDATE document_version SET revision_id = NULL WHERE document_id IN (SELECT id FROM document WHERE workspace_id = ?)").bind(ws.id),
      db.prepare("DELETE FROM document_head WHERE document_id IN (SELECT id FROM document WHERE workspace_id = ?)").bind(ws.id),
      db.prepare("DELETE FROM document_revision WHERE document_id IN (SELECT id FROM document WHERE workspace_id = ?)").bind(ws.id),
      db.prepare("DELETE FROM version_file WHERE version_id IN (SELECT v.id FROM document_version v JOIN document d ON d.id = v.document_id WHERE d.workspace_id = ?)").bind(ws.id),
      db.prepare("DELETE FROM document_version WHERE document_id IN (SELECT id FROM document WHERE workspace_id = ?)").bind(ws.id),
      // 하위 문서가 상위를 가리키므로 관계를 먼저 끊고 지운다
      db.prepare("UPDATE document SET parent_id = NULL WHERE workspace_id = ?").bind(ws.id),
      db.prepare("DELETE FROM document WHERE workspace_id = ?").bind(ws.id),
      db.prepare("UPDATE menu SET parent_id = NULL WHERE workspace_id = ?").bind(ws.id),
      db.prepare("DELETE FROM menu WHERE workspace_id = ?").bind(ws.id),
      db.prepare("DELETE FROM top_menu WHERE workspace_id = ?").bind(ws.id),
    ]);
  }
  return c.json(ws);
});

interface MenuIn { slug: string; name: string; menus?: MenuIn[] }

/** 대분류와 메뉴 트리(원래 categories.yaml + menus.yaml). 상위 메뉴를 먼저 넣어 id를 얻고 하위를 넣는다 */
admin.post("/w/:ws/site", async (c) => {
  const ws = await wsOf(c.env.DB, c.req.param("ws"));
  const { categories } = await c.req.json<{ categories: { key: string; name: string; menus?: MenuIn[] }[] }>();
  const db = c.env.DB;
  await db.batch(categories.map((cat, i) =>
    db.prepare("INSERT INTO top_menu (workspace_id, key, name, sort) VALUES (?, ?, ?, ?)").bind(ws.id, cat.key, cat.name, i)));
  const insert = async (category: string, list: MenuIn[], parent: number | null) => {
    for (const [i, m] of list.entries()) {
      const row = await db.prepare("INSERT INTO menu (workspace_id, slug, category_key, parent_id, name, sort) VALUES (?, ?, ?, ?, ?, ?) RETURNING id")
        .bind(ws.id, m.slug, category, parent, m.name, i).first<{ id: number }>();
      await insert(category, m.menus ?? [], row!.id);
    }
  };
  for (const cat of categories) await insert(cat.key, cat.menus ?? [], null);
  return c.json({ ok: true });
});

/** 멤버 넣기(운영자용). 가져온 워크스페이스에 첫 owner를 둘 때 쓴다. 그 사람이 아직 로그인한 적 없으면 계정을 미리 만든다 */
admin.post("/w/:ws/members", async (c) => {
  const db = c.env.DB;
  const ws = await wsOf(db, c.req.param("ws"));
  const { email, role } = await c.req.json<{ email: string; role: "owner" | "editor" | "viewer" }>();
  if (!["owner", "editor", "viewer"].includes(role) || !/^[^@\s]+@[^@\s]+$/.test(email ?? "")) throw new HttpError(400, "email과 role(owner·editor·viewer)이 필요합니다");
  const now = new Date().toISOString();
  await db.prepare("INSERT INTO app_user (email, created_at) VALUES (?, ?) ON CONFLICT (email) DO NOTHING").bind(email.toLowerCase(), now).run();
  await db.prepare(`INSERT INTO member (workspace_id, user_id, role, created_at) SELECT ?, id, ?, ? FROM app_user WHERE email = ?
    ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = excluded.role`).bind(ws.id, role, now, email.toLowerCase()).run();
  return c.json({ ok: true });
});

/** R2에 아직 없는 blob */
admin.post("/w/:ws/blobs/missing", async (c) => {
  const ws = await wsOf(c.env.DB, c.req.param("ws"));
  const { shas } = await c.req.json<{ shas: string[] }>();
  const missing: string[] = [];
  for (const sha of [...new Set(shas)]) if (!(await c.env.BLOBS.head(blobKey(ws.id, sha)))) missing.push(sha);
  return c.json({ missing });
});

const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

/** blob 올리기. 내용의 sha256이 주소와 같아야 한다 */
admin.put("/w/:ws/blobs/:sha", async (c) => {
  const ws = await wsOf(c.env.DB, c.req.param("ws"));
  const sha = c.req.param("sha");
  const data = await c.req.arrayBuffer();
  if (hex(await crypto.subtle.digest("SHA-256", data)) !== sha) throw new HttpError(400, "내용의 sha256이 주소와 다릅니다");
  await c.env.BLOBS.put(blobKey(ws.id, sha), data);
  return c.json({ ok: true, size: data.byteLength });
});

interface DocIn {
  menu: string; slug: string; parent?: string | null; order?: number | null; title: string; kind: string; type?: string | null; sdlc?: string | null;
  status?: string; current: string; notion_url?: string | null; gdrive_url?: string | null; origin_url?: string | null;
  versions: { version: string; entry: string; note?: string | null; source?: string | null; created?: string | null; files: { path: string; size: number; sha256: string; mime?: string }[] }[];
  /** 최신 버전 대표 파일의 검색 본문(CLI가 core의 searchText로 만든다) */
  search?: string;
}

/** 문서 하나(버전·파일 목록 포함). 파일 본문 blob이 R2에 먼저 있어야 한다. 상위 문서는 먼저 가져와 있어야 한다 */
admin.post("/w/:ws/docs", async (c) => {
  const db = c.env.DB;
  const ws = await wsOf(db, c.req.param("ws"));
  const d = await c.req.json<DocIn>();
  const menu = await db.prepare("SELECT id FROM menu WHERE workspace_id = ? AND slug = ?").bind(ws.id, d.menu).first<{ id: number }>();
  if (!menu) throw new HttpError(400, `메뉴가 없습니다: ${d.menu}`);
  const parent = d.parent
    ? await db.prepare("SELECT id FROM document WHERE menu_id = ? AND slug = ?").bind(menu.id, d.parent).first<{ id: number }>()
    : null;
  if (d.parent && !parent) throw new HttpError(400, `상위 문서가 없습니다: ${d.parent}`);

  for (const sha of new Set(d.versions.flatMap((v) => v.files.map((f) => f.sha256)))) {
    if (!(await c.env.BLOBS.head(blobKey(ws.id, sha)))) throw new HttpError(409, `파일 본문이 아직 없습니다: ${sha}`);
  }

  const doc = await db.prepare(`INSERT INTO document (workspace_id, menu_id, slug, parent_id, sort, title, kind, type, sdlc, status, current_version,
      notion_url, gdrive_url, origin_url) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`)
    .bind(ws.id, menu.id, d.slug, parent?.id ?? null, d.order ?? null, d.title, d.kind, d.type ?? null, d.sdlc ?? null, d.status ?? "draft",
      d.current, d.notion_url ?? null, d.gdrive_url ?? null, d.origin_url ?? null).first<{ id: number }>();

  const vers = await db.batch(d.versions.map((v) =>
    db.prepare("INSERT INTO document_version (document_id, version, note, source, created_at, entry) VALUES (?, ?, ?, ?, ?, ?) RETURNING id")
      .bind(doc!.id, v.version, v.note ?? null, v.source ?? null, v.created ?? null, v.entry)));

  // 파일 행은 여러 줄을 한 문장으로 넣는다(D1 문장 하나의 바인드 값은 100개까지 → 7열 × 14줄)
  const rows = d.versions.flatMap((v, i) => v.files.map((f) =>
    [(vers[i].results[0] as { id: number }).id, f.path, f.mime ?? mimeOf(f.path), f.size, f.sha256, f.path === v.entry ? 1 : 0]));
  const stmts: D1PreparedStatement[] = [];
  for (let i = 0; i < rows.length; i += 14) {
    const chunk = rows.slice(i, i + 14);
    stmts.push(db.prepare(`INSERT INTO version_file (version_id, path, mime, size, sha256, is_entry) VALUES ${chunk.map(() => "(?, ?, ?, ?, ?, ?)").join(", ")}`)
      .bind(...chunk.flat()));
  }
  // 본문이 없는 형식도 한 줄 넣는다(제목·메뉴 이름으로 찾는다)
  stmts.push(db.prepare("INSERT INTO search (workspace_id, document_id, title, body) VALUES (?, ?, ?, ?)").bind(ws.id, doc!.id, d.title, d.search ?? ""));
  if (stmts.length) await db.batch(stmts);
  return c.json({ id: doc!.id, versions: d.versions.length, files: rows.length });
});
