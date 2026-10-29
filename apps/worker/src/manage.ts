import { SLUG_RE } from "@workflow/core/upload";
import { slugify } from "@workflow/core/slug";
import { HttpError, type Workspace } from "./env.ts";
import { findDoc } from "./repo.ts";
import { blobKey } from "./env.ts";

/**
 * 메뉴·대분류·문서 관리와 휴지통(로컬 site/server/manage.ts와 같은 규칙). 원본이 D1이라 yaml·폴더 대신 행을 고친다.
 * 문서의 대분류는 메뉴에서 따라오므로, 메뉴를 다른 대분류로 옮기면 메뉴(하위 포함)의 category_key만 바꾸면 된다.
 */

interface MenuRow { id: number; slug: string; category_key: string; parent_id: number | null; name: string; sort: number }

async function menuOf(db: D1Database, wsId: number, slug: string): Promise<MenuRow> {
  const m = await db.prepare("SELECT * FROM menu WHERE workspace_id = ? AND slug = ?").bind(wsId, slug).first<MenuRow>();
  if (!m) throw new HttpError(404, `메뉴 ${slug}이(가) 없습니다`);
  return m;
}

async function allMenus(db: D1Database, wsId: number): Promise<MenuRow[]> {
  return (await db.prepare("SELECT * FROM menu WHERE workspace_id = ? ORDER BY sort").bind(wsId).all<MenuRow>()).results;
}

const subtree = (menus: MenuRow[], id: number): MenuRow[] => {
  const out: MenuRow[] = [];
  const walk = (pid: number) => menus.filter((m) => m.parent_id === pid).forEach((m) => { out.push(m); walk(m.id); });
  out.push(menus.find((m) => m.id === id)!);
  walk(id);
  return out;
};

/** 같은 자리 메뉴 순서를 0, 1, 2 …로 다시 쓴다. id를 주면 그 메뉴를 index 자리(없으면 맨 뒤)에 둔다 */
function reorderMenus(db: D1Database, siblings: MenuRow[], id?: number, index?: number): D1PreparedStatement[] {
  const ids = siblings.filter((m) => m.id !== id).sort((a, b) => a.sort - b.sort).map((m) => m.id);
  if (id !== undefined) ids.splice(index === undefined ? ids.length : Math.max(0, Math.min(index, ids.length)), 0, id);
  return ids.map((mid, i) => db.prepare("UPDATE menu SET sort = ? WHERE id = ?").bind(i, mid));
}

/** 이름만 받았을 때의 메뉴 slug(D-35). 영문·숫자가 있으면 그걸로, 없으면 folder-<짧은 난수>. 겹치면 -2, -3 … */
function autoMenuSlug(menus: MenuRow[], name: string): string {
  let base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (!base || base === "doc") base = `folder-${Math.random().toString(36).slice(2, 8)}`;
  let s = base;
  for (let i = 2; menus.some((m) => m.slug === s); i++) s = `${base}-${i}`;
  return s;
}

export async function addMenu(db: D1Database, ws: Workspace, category: string, name: string, slug?: string, parent?: string) {
  if (!name?.trim()) throw new HttpError(400, "메뉴 이름을 입력하세요");
  const menus = await allMenus(db, ws.id);
  const s = slug?.trim() || autoMenuSlug(menus, name);
  if (!SLUG_RE.test(s) || s === "doc" || s.startsWith("_")) throw new HttpError(400, "메뉴 slug를 영문 소문자, 숫자, 하이픈으로 입력하세요");
  if (menus.some((m) => m.slug === s)) throw new HttpError(409, `메뉴 slug ${s}이(가) 이미 있습니다`);
  let categoryKey = category;
  let parentId: number | null = null;
  if (parent) {
    const p = menus.find((m) => m.slug === parent);
    if (!p) throw new HttpError(404, `상위 메뉴 ${parent}이(가) 없습니다`);
    parentId = p.id;
    categoryKey = p.category_key;
  } else if (!(await db.prepare("SELECT 1 FROM top_menu WHERE workspace_id = ? AND key = ?").bind(ws.id, category).first())) {
    throw new HttpError(404, `대분류 ${category}이(가) 없습니다`);
  }
  const sort = menus.filter((m) => m.parent_id === parentId && (parentId !== null || m.category_key === categoryKey)).length;
  await db.prepare("INSERT INTO menu (workspace_id, slug, category_key, parent_id, name, sort) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(ws.id, s, categoryKey, parentId, name.trim(), sort).run();
  return { category: categoryKey, slug: s };
}

export async function renameMenu(db: D1Database, ws: Workspace, slug: string, name: string) {
  if (!name?.trim()) throw new HttpError(400, "메뉴 이름을 입력하세요");
  const m = await menuOf(db, ws.id, slug);
  await db.prepare("UPDATE menu SET name = ? WHERE id = ?").bind(name.trim(), m.id).run();
}

/** 메뉴를 다른 위치로. parent가 없으면 대분류 최상위, index가 없으면 맨 뒤. 하위 메뉴도 함께 대분류가 바뀐다 */
export async function moveMenu(db: D1Database, ws: Workspace, slug: string, to: { category: string; parent?: string | null; index?: number }) {
  const menus = await allMenus(db, ws.id);
  const node = menus.find((m) => m.slug === slug);
  if (!node) throw new HttpError(404, `메뉴 ${slug}이(가) 없습니다`);
  const tree = subtree(menus, node.id);
  let parentId: number | null = null;
  let category = to.category;
  if (to.parent) {
    const p = menus.find((m) => m.slug === to.parent);
    if (!p) throw new HttpError(404, `상위 메뉴 ${to.parent}이(가) 없습니다`);
    if (tree.some((m) => m.id === p.id)) throw new HttpError(400, "메뉴를 자기 자신이나 하위 메뉴 안으로 옮길 수 없습니다");
    parentId = p.id;
    category = p.category_key;
  } else if (!(await db.prepare("SELECT 1 FROM top_menu WHERE workspace_id = ? AND key = ?").bind(ws.id, category).first())) {
    throw new HttpError(404, `대분류 ${category}이(가) 없습니다`);
  }
  const oldSiblings = menus.filter((m) => m.id !== node.id && m.parent_id === node.parent_id && (node.parent_id !== null || m.category_key === node.category_key));
  const newSiblings = menus.filter((m) => m.id !== node.id && m.parent_id === parentId && (parentId !== null || m.category_key === category));
  await db.batch([
    db.prepare("UPDATE menu SET parent_id = ? WHERE id = ?").bind(parentId, node.id),
    ...tree.map((m) => db.prepare("UPDATE menu SET category_key = ? WHERE id = ?").bind(category, m.id)),
    ...reorderMenus(db, oldSiblings),
    ...reorderMenus(db, newSiblings.concat(node), node.id, to.index),
  ]);
}

/** 폴더(메뉴) 삭제: 안의 문서(하위 메뉴 것까지)를 휴지통으로 보내고 메뉴를 지운다(D-13 개정) */
export async function deleteMenu(db: D1Database, ws: Workspace, slug: string) {
  const menus = await allMenus(db, ws.id);
  const node = menus.find((m) => m.slug === slug);
  if (!node) throw new HttpError(404, `메뉴 ${slug}이(가) 없습니다`);
  const tree = subtree(menus, node.id);
  let trashed = 0;
  for (const m of tree) {
    const { results } = await db.prepare("SELECT d.slug FROM document d WHERE d.menu_id = ? AND d.parent_id IS NULL AND d.deleted_at IS NULL").bind(m.id).all<{ slug: string }>();
    for (const d of results) { await trashDoc(db, ws, m.slug, d.slug); trashed++; }
  }
  // 휴지통 문서는 메뉴 slug(trash_menu)만 남기고 메뉴 연결을 끊는다. 하위 메뉴부터 지운다
  await db.batch([
    ...tree.map((m) => db.prepare("UPDATE document SET menu_id = NULL WHERE menu_id = ?").bind(m.id)),
    ...[...tree].reverse().map((m) => db.prepare("DELETE FROM menu WHERE id = ?").bind(m.id)),
    ...reorderMenus(db, menus.filter((m) => m.id !== node.id && m.parent_id === node.parent_id && (node.parent_id !== null || m.category_key === node.category_key))),
  ]);
  return { trashed };
}

// ---------- 대분류 ----------

export async function addCategory(db: D1Database, ws: Workspace, name: string, key?: string) {
  if (!name?.trim()) throw new HttpError(400, "대분류 이름을 입력하세요");
  const k = key?.trim() || slugify(name) || "doc";
  if (!SLUG_RE.test(k) || k === "doc") throw new HttpError(400, "대분류 key를 영문 소문자, 숫자, 하이픈으로 입력하세요");
  const { results } = await db.prepare("SELECT key FROM top_menu WHERE workspace_id = ?").bind(ws.id).all<{ key: string }>();
  if (results.some((r) => r.key === k)) throw new HttpError(409, `대분류 ${k}이(가) 이미 있습니다`);
  await db.prepare("INSERT INTO top_menu (workspace_id, key, name, sort) VALUES (?, ?, ?, ?)").bind(ws.id, k, name.trim(), results.length).run();
  return { key: k };
}

export async function updateCategory(db: D1Database, ws: Workspace, key: string, change: { name?: string; index?: number }) {
  const { results } = await db.prepare("SELECT key FROM top_menu WHERE workspace_id = ? ORDER BY sort").bind(ws.id).all<{ key: string }>();
  const keys = results.map((r) => r.key);
  if (!keys.includes(key)) throw new HttpError(404, `대분류 ${key}이(가) 없습니다`);
  const stmts: D1PreparedStatement[] = [];
  if (change.name !== undefined) {
    if (!change.name.trim()) throw new HttpError(400, "대분류 이름을 입력하세요");
    stmts.push(db.prepare("UPDATE top_menu SET name = ? WHERE workspace_id = ? AND key = ?").bind(change.name.trim(), ws.id, key));
  }
  if (change.index !== undefined) {
    keys.splice(keys.indexOf(key), 1);
    keys.splice(Math.max(0, Math.min(change.index, keys.length)), 0, key);
    keys.forEach((k, i) => stmts.push(db.prepare("UPDATE top_menu SET sort = ? WHERE workspace_id = ? AND key = ?").bind(i, ws.id, k)));
  }
  if (stmts.length) await db.batch(stmts);
}

export async function deleteCategory(db: D1Database, ws: Workspace, key: string) {
  const { results } = await db.prepare("SELECT key FROM top_menu WHERE workspace_id = ?").bind(ws.id).all<{ key: string }>();
  if (!results.some((r) => r.key === key)) throw new HttpError(404, `대분류 ${key}이(가) 없습니다`);
  if (await db.prepare("SELECT 1 FROM menu WHERE workspace_id = ? AND category_key = ?").bind(ws.id, key).first()) {
    throw new HttpError(409, "메뉴가 있는 대분류는 지울 수 없습니다");
  }
  if (results.length === 1) throw new HttpError(409, "대분류는 하나 이상 있어야 합니다");
  await db.prepare("DELETE FROM top_menu WHERE workspace_id = ? AND key = ?").bind(ws.id, key).run();
}

// ---------- 문서 ----------

const STATUSES = new Set(["draft", "review", "approved"]);

export async function updateDoc(db: D1Database, ws: Workspace, menu: string, doc: string, change: { title?: string; status?: string; origin?: string | null }) {
  const d = await findDoc(db, ws.id, menu, doc);
  const stmts: D1PreparedStatement[] = [];
  if (change.title !== undefined) {
    if (!change.title.trim()) throw new HttpError(400, "제목을 입력하세요");
    stmts.push(db.prepare("UPDATE document SET title = ? WHERE id = ?").bind(change.title.trim(), d.id));
    stmts.push(db.prepare("UPDATE search SET title = ? WHERE document_id = ?").bind(change.title.trim(), d.id));
  }
  if (change.status !== undefined) {
    if (!STATUSES.has(change.status)) throw new HttpError(400, "상태는 draft, review, approved 중 하나입니다");
    stmts.push(db.prepare("UPDATE document SET status = ? WHERE id = ?").bind(change.status, d.id));
  }
  // 외부에서 가져온 문서의 출처(3.3). 빈 값이면 지운다
  if (change.origin !== undefined) {
    const o = change.origin?.trim() ?? "";
    if (o && !/^https?:\/\/\S+$/.test(o)) throw new HttpError(400, "출처는 http:// 또는 https:// 주소여야 합니다");
    stmts.push(db.prepare("UPDATE document SET origin_url = ? WHERE id = ?").bind(o || null, d.id));
  }
  if (stmts.length) await db.batch(stmts);
}

interface DocNode { id: number; slug: string; parent_id: number | null; sort: number | null; title: string }

/** 문서와 그 하위 문서들(휴지통 밖) */
async function docTree(db: D1Database, menuId: number | null, rootId: number, trashId?: number): Promise<DocNode[]> {
  const { results } = trashId !== undefined
    ? await db.prepare("SELECT id, slug, parent_id, sort, title FROM document WHERE trash_id = ?").bind(trashId).all<DocNode>()
    : await db.prepare("SELECT id, slug, parent_id, sort, title FROM document WHERE menu_id = ? AND deleted_at IS NULL").bind(menuId).all<DocNode>();
  const out: DocNode[] = [];
  const walk = (pid: number) => results.filter((d) => d.parent_id === pid).forEach((d) => { out.push(d); walk(d.id); });
  out.push(results.find((d) => d.id === rootId)!);
  walk(rootId);
  return out;
}

/**
 * 한 자리(메뉴 최상위 또는 상위 문서 아래) 문서 순서를 0, 1, 2 …로 다시 쓴다. id를 주면 그 문서를 index 자리(없으면 맨 뒤)에.
 * 정렬은 트리 API와 같다: order 있는 문서 먼저, 없는 문서는 제목(코드 값) 순
 */
async function reorderDocs(db: D1Database, menuId: number, parentId: number | null, id?: number, index?: number): Promise<D1PreparedStatement[]> {
  const { results } = await db.prepare(`SELECT id FROM document WHERE menu_id = ? AND parent_id IS ? AND deleted_at IS NULL
    ORDER BY sort IS NULL, sort, title`).bind(menuId, parentId).all<{ id: number }>();
  const ids = results.map((r) => r.id).filter((x) => x !== id);
  if (id !== undefined) ids.splice(index === undefined ? ids.length : Math.max(0, Math.min(index, ids.length)), 0, id);
  return ids.map((did, i) => db.prepare("UPDATE document SET sort = ? WHERE id = ?").bind(i, did));
}

/**
 * 문서를 옮긴다. to.menu(다른 메뉴 가능), to.parent(상위 문서 slug, 없으면 메뉴 최상위), to.index(그 자리 안 순서).
 * 하위 문서는 함께 간다. 다른 메뉴로 갈 때 같은 slug가 있으면 옮기는 문서는 -2 …, 하위 문서가 겹치면 409
 */
export async function moveDoc(db: D1Database, ws: Workspace, menu: string, doc: string, to: { menu?: string; parent?: string | null; index?: number }) {
  const d = await findDoc(db, ws.id, menu, doc);
  const toMenuSlug = to.menu || menu;
  const target = await menuOf(db, ws.id, toMenuSlug);
  const tree = await docTree(db, d.menu_id, d.id);
  let parentId: number | null = null;
  if (to.parent) {
    const p = await findDoc(db, ws.id, toMenuSlug, to.parent).catch(() => null);
    if (!p) throw new HttpError(404, `상위 문서 ${toMenuSlug}/${to.parent}이(가) 없습니다`);
    if (tree.some((x) => x.id === p.id)) throw new HttpError(400, "문서를 자기 자신이나 하위 문서 아래로 옮길 수 없습니다");
    parentId = p.id;
  }
  let slug = d.slug;
  const stmts: D1PreparedStatement[] = [];
  const moved = target.id !== d.menu_id || parentId !== d.parent_id;
  if (moved) {
    if (target.id !== d.menu_id) {
      const { results } = await db.prepare("SELECT slug FROM document WHERE menu_id = ? AND deleted_at IS NULL").bind(target.id).all<{ slug: string }>();
      const used = new Set(results.map((r) => r.slug));
      const clash = tree.slice(1).map((x) => x.slug).filter((s) => used.has(s));
      if (clash.length) throw new HttpError(409, `옮길 메뉴에 같은 slug의 문서가 있습니다: ${clash.join(", ")}`);
      for (let i = 2; used.has(slug); i++) slug = `${d.slug}-${i}`;
    }
    // 고유 색인(메뉴 + slug)은 문장마다 검사하므로 옮기는 문서의 새 slug를 먼저 정하고, 하위 문서는 그다음에 옮긴다
    stmts.push(db.prepare("UPDATE document SET menu_id = ?, parent_id = ?, slug = ? WHERE id = ?").bind(target.id, parentId, slug, d.id));
    if (target.id !== d.menu_id) stmts.push(...tree.slice(1).map((x) => db.prepare("UPDATE document SET menu_id = ? WHERE id = ?").bind(target.id, x.id)));
  }
  if (stmts.length) await db.batch(stmts);
  const reorder = [...(await reorderDocs(db, target.id, parentId, d.id, to.index))];
  if (moved) reorder.push(...(await reorderDocs(db, d.menu_id!, d.parent_id)));
  if (reorder.length) await db.batch(reorder);
  return { menu: toMenuSlug, doc: slug, category: target.category_key };
}

// ---------- 휴지통 ----------
// 문서와 하위 문서에 deleted_at·trash_id(= 지운 문서 id)를 단다. 목록에서 사라지고, 같은 slug를 새로 쓸 수 있다.

const nowKst = () => new Intl.DateTimeFormat("sv-SE", {
  timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
}).format(new Date());

export async function trashDoc(db: D1Database, ws: Workspace, menu: string, doc: string) {
  const d = await findDoc(db, ws.id, menu, doc);
  const tree = await docTree(db, d.menu_id, d.id);
  const at = nowKst();
  await db.batch([
    ...tree.map((x) => db.prepare("UPDATE document SET deleted_at = ?, trash_id = ?, trash_menu = ? WHERE id = ?").bind(at, d.id, menu, x.id)),
    ...tree.map((x) => db.prepare("DELETE FROM search WHERE document_id = ?").bind(x.id)),
  ]);
  return { id: String(d.id) };
}

export async function listTrash(db: D1Database, ws: Workspace) {
  const { results } = await db.prepare(`SELECT id, slug, title, trash_menu, deleted_at FROM document
    WHERE workspace_id = ? AND trash_id = id ORDER BY deleted_at DESC, id DESC`).bind(ws.id).all<{ id: number; slug: string; title: string; trash_menu: string; deleted_at: string }>();
  return results.map((r) => ({ id: String(r.id), menu: r.trash_menu, doc: r.slug, title: r.title, deletedAt: r.deleted_at }));
}

async function trashRoot(db: D1Database, ws: Workspace, id: string) {
  const r = await db.prepare("SELECT id, slug, trash_menu FROM document WHERE workspace_id = ? AND id = ? AND trash_id = id")
    .bind(ws.id, Number(id) || 0).first<{ id: number; slug: string; trash_menu: string }>();
  if (!r) throw new HttpError(404, "휴지통에 없는 항목입니다");
  return r;
}

/** 메뉴 최상위로 복원한다(하위 문서였어도). 원래 메뉴가 없으면 409로 메뉴를 고르게 한다 */
export async function restoreDoc(env: { DB: D1Database }, ws: Workspace, id: string, toMenu?: string) {
  const db = env.DB;
  const root = await trashRoot(db, ws, id);
  const menuSlug = toMenu || root.trash_menu;
  const target = await db.prepare("SELECT id, category_key FROM menu WHERE workspace_id = ? AND slug = ?").bind(ws.id, menuSlug).first<{ id: number; category_key: string }>();
  if (!target) throw new HttpError(409, `원래 메뉴(${menuSlug})가 없습니다. 복원할 메뉴를 고르세요`);
  const tree = await docTree(db, null, root.id, root.id);
  const { results } = await db.prepare("SELECT slug FROM document WHERE menu_id = ? AND deleted_at IS NULL").bind(target.id).all<{ slug: string }>();
  const used = new Set(results.map((r) => r.slug));
  const clash = tree.slice(1).map((x) => x.slug).filter((s) => used.has(s));
  if (clash.length) throw new HttpError(409, `복원할 메뉴에 같은 slug의 문서가 있습니다: ${clash.join(", ")}`);
  let slug = root.slug;
  for (let i = 2; used.has(slug); i++) slug = `${root.slug}-${i}`;
  // 순서(sort)는 지우기 전 값을 그대로 둔다(로컬은 meta.yaml order가 남는다). 고유 색인 때문에 복원하는 문서 slug를 먼저 정한다
  await db.batch([
    db.prepare("UPDATE document SET deleted_at = NULL, trash_id = NULL, trash_menu = NULL, menu_id = ?, parent_id = NULL, slug = ? WHERE id = ?")
      .bind(target.id, slug, root.id),
    ...tree.slice(1).map((x) => db.prepare("UPDATE document SET deleted_at = NULL, trash_id = NULL, trash_menu = NULL, menu_id = ? WHERE id = ?").bind(target.id, x.id)),
  ]);
  return { menu: menuSlug, doc: slug, category: target.category_key };
}

/** 영구 삭제: 문서·버전·파일 행을 지우고, 이 워크스페이스에서 더 이상 아무도 쓰지 않는 blob을 R2에서 지운다 */
export async function purgeDoc(env: { DB: D1Database; BLOBS: R2Bucket }, ws: Workspace, id: string) {
  const db = env.DB;
  const root = await trashRoot(db, ws, id);
  const tree = await docTree(db, null, root.id, root.id);
  const ids = tree.map((x) => x.id);
  const marks = ids.map(() => "?").join(", ");
  const { results: shas } = await db.prepare(`SELECT DISTINCT f.sha256 FROM version_file f JOIN document_version v ON v.id = f.version_id
    WHERE v.document_id IN (${marks})`).bind(...ids).all<{ sha256: string }>();
  await db.batch([
    db.prepare(`DELETE FROM version_file WHERE version_id IN (SELECT id FROM document_version WHERE document_id IN (${marks}))`).bind(...ids),
    db.prepare(`DELETE FROM document_version WHERE document_id IN (${marks})`).bind(...ids),
    db.prepare(`UPDATE document SET parent_id = NULL WHERE id IN (${marks})`).bind(...ids),
    db.prepare(`DELETE FROM document WHERE id IN (${marks})`).bind(...ids),
  ]);
  for (const { sha256 } of shas) {
    const used = await db.prepare(`SELECT 1 FROM version_file f JOIN document_version v ON v.id = f.version_id JOIN document d ON d.id = v.document_id
      WHERE d.workspace_id = ? AND f.sha256 = ? LIMIT 1`).bind(ws.id, sha256).first();
    if (!used) await env.BLOBS.delete(blobKey(ws.id, sha256));
  }
}
