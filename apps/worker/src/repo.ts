import { HttpError, type Workspace } from "./env.ts";

/** D1 조회. 모든 함수가 workspace id를 받아 그 워크스페이스 안만 본다(5.1) */

export async function workspaceBySlug(db: D1Database, slug: string): Promise<Workspace | null> {
  return db.prepare("SELECT id, slug, name FROM workspace WHERE slug = ?").bind(slug).first<Workspace>();
}

interface MenuRow { id: number; slug: string; category_key: string; parent_id: number | null; name: string }
interface DocRow {
  id: number; menu_id: number; slug: string; parent_id: number | null; title: string; kind: string; status: string; current_version: string;
}

/** 대분류 → 메뉴 트리 → 문서. 로컬 서버 GET /api/tree와 같은 모양 */
export async function tree(db: D1Database, wsId: number) {
  const [cats, menus, docs] = await db.batch([
    db.prepare("SELECT key, name FROM top_menu WHERE workspace_id = ? ORDER BY sort").bind(wsId),
    db.prepare("SELECT id, slug, category_key, parent_id, name FROM menu WHERE workspace_id = ? ORDER BY sort").bind(wsId),
    // 같은 자리 안에서 order가 있는 문서가 먼저(그 순서대로), 없는 문서는 제목순으로 뒤에(로컬과 같은 정렬)
    db.prepare(`SELECT id, menu_id, slug, parent_id, title, kind, status, current_version FROM document
      WHERE workspace_id = ? AND deleted_at IS NULL ORDER BY sort IS NULL, sort, title`).bind(wsId),
  ]);
  const menuRows = menus.results as unknown as MenuRow[];
  const docRows = docs.results as unknown as DocRow[];
  const slugOfDoc = new Map(docRows.map((d) => [d.id, d.slug]));
  const slugOfMenu = new Map(menuRows.map((m) => [m.id, m.slug]));
  const build = (category: string, parent: number | null): unknown[] =>
    menuRows
      .filter((m) => m.category_key === category && m.parent_id === parent)
      .map((m) => ({
        slug: m.slug, name: m.name,
        documents: docRows.filter((d) => d.menu_id === m.id).map((d) => ({
          slug: d.slug, menuSlug: slugOfMenu.get(d.menu_id)!, parent: d.parent_id === null ? null : slugOfDoc.get(d.parent_id) ?? null,
          title: d.title, kind: d.kind, status: d.status, currentVersion: d.current_version,
        })),
        menus: build(category, m.id),
      }));
  return {
    categories: (cats.results as { key: string; name: string }[]).map((c) => ({ key: c.key, name: c.name, menus: build(c.key, null) })),
    warnings: [] as string[],
  };
}

interface DocFull extends DocRow {
  sort: number | null; type: string | null; sdlc: string | null; notion_url: string | null; gdrive_url: string | null; origin_url: string | null; deleted_at: string | null;
}

/** 메뉴 slug + 문서 slug로 문서를 찾는다. 휴지통 문서는 없는 것으로 본다 */
export async function findDoc(db: D1Database, wsId: number, menu: string, doc: string): Promise<DocFull & { menu_slug: string }> {
  const row = await db.prepare(`SELECT d.*, m.slug AS menu_slug FROM document d JOIN menu m ON m.id = d.menu_id
    WHERE d.workspace_id = ? AND m.slug = ? AND d.slug = ? AND d.deleted_at IS NULL`).bind(wsId, menu, doc).first<DocFull & { menu_slug: string }>();
  if (!row) throw new HttpError(404, "문서를 찾을 수 없습니다");
  return row;
}

/** 문서 폴더 경로(메뉴/상위.../문서). 로컬 docs/ 폴더 구조와 같아서 HTML 안 상대 링크가 그대로 풀린다 */
export async function docPath(db: D1Database, doc: { id: number; parent_id: number | null; slug: string }, menuSlug: string): Promise<string> {
  const chain = [doc.slug];
  let parent = doc.parent_id;
  for (let i = 0; parent !== null && i < 32; i++) {
    const p = await db.prepare("SELECT slug, parent_id FROM document WHERE id = ?").bind(parent).first<{ slug: string; parent_id: number | null }>();
    if (!p) break;
    chain.unshift(p.slug);
    parent = p.parent_id;
  }
  return `${menuSlug}/${chain.join("/")}`;
}

interface VersionRow { id: number; document_id: number; version: string; note: string | null; source: string | null; created_at: string | null; entry: string }
interface FileRow { id: number; version_id: number; path: string; mime: string; size: number; sha256: string; is_entry: number }

/** 문서 상세(버전·파일). 로컬 GET /api/docs/:menu/:doc과 같은 모양. fileUrl은 파일 주소를 만든다 */
export async function docDetail(db: D1Database, wsId: number, menu: string, doc: string, fileUrl: (docPath: string, version: string, path: string) => string) {
  const d = await findDoc(db, wsId, menu, doc);
  const [versions, files, parent] = await db.batch([
    db.prepare("SELECT * FROM document_version WHERE document_id = ? ORDER BY id").bind(d.id),
    db.prepare("SELECT f.* FROM version_file f JOIN document_version v ON v.id = f.version_id WHERE v.document_id = ? ORDER BY f.id").bind(d.id),
    db.prepare("SELECT slug FROM document WHERE id = ?").bind(d.parent_id),
  ]);
  const path = await docPath(db, d, d.menu_slug);
  const fileRows = files.results as unknown as FileRow[];
  return {
    id: d.id, menuSlug: d.menu_slug, slug: d.slug, parentSlug: (parent.results[0] as { slug: string } | undefined)?.slug ?? null,
    sort: d.sort ?? null, title: d.title, kind: d.kind, type: d.type, sdlc: d.sdlc, status: d.status, currentVersion: d.current_version,
    notionUrl: d.notion_url, gdriveUrl: d.gdrive_url, originUrl: d.origin_url, deletedAt: d.deleted_at,
    versions: (versions.results as unknown as VersionRow[]).map((v) => ({
      id: v.id, documentId: v.document_id, version: v.version, note: v.note, source: v.source, createdAt: v.created_at,
      files: fileRows.filter((f) => f.version_id === v.id).map((f) => ({
        id: f.id, versionId: f.version_id, path: f.path, mime: f.mime, size: f.size, sha256: f.sha256, isEntry: !!f.is_entry,
        url: fileUrl(path, v.version, f.path),
      })),
    })),
  };
}

/**
 * 콘텐츠 경로(메뉴/상위.../문서/버전/파일 경로)를 파일 행으로. 버전 폴더(vN.N) 앞의 마지막 이름이 문서 slug다.
 * slug가 메뉴 안에서 하나뿐이라 상위 이름은 확인만 한다.
 */
export async function resolveContent(db: D1Database, wsId: number, segments: string[]): Promise<FileRow | null> {
  const vi = segments.findIndex((s, i) => i >= 2 && /^v\d+\.\d+$/.test(s));
  if (vi < 0 || vi === segments.length - 1) return null;
  const [menu, ...docChain] = segments.slice(0, vi);
  const doc = docChain[docChain.length - 1];
  const path = segments.slice(vi + 1).join("/");
  const row = await db.prepare(`SELECT f.*, d.id AS doc_id, d.parent_id AS doc_parent FROM version_file f
      JOIN document_version v ON v.id = f.version_id JOIN document d ON d.id = v.document_id JOIN menu m ON m.id = d.menu_id
      WHERE d.workspace_id = ? AND m.slug = ? AND d.slug = ? AND d.deleted_at IS NULL AND v.version = ? AND f.path = ?`)
    .bind(wsId, menu, doc, segments[vi], path).first<FileRow & { doc_id: number; doc_parent: number | null }>();
  if (!row) return null;
  // 주소의 상위 문서 경로가 실제와 다르면 없는 것으로 본다(같은 문서가 여러 주소로 열리지 않게)
  if ((await docPath(db, { id: row.doc_id, parent_id: row.doc_parent, slug: doc }, menu)) !== `${menu}/${docChain.join("/")}`) return null;
  return row;
}
