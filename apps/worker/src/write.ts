import { adapterFor, EditError, type Change } from "@workflow/core/textedit";
import { wrapForEdit } from "@workflow/core/textedit/html";
import { wrapSvgForEdit } from "@workflow/core/textedit/svg";
import { mimeOf } from "@workflow/core/mime";
import { isSearchable, searchText } from "@workflow/core/search-text";
import { kindOf, normalizeFiles, nowStamp, pickEntry, SLUG_RE, type IncomingFile } from "@workflow/core/upload";
import { nextMajor, nextVersion, VERSION_RE } from "@workflow/core/versions";
import { slugify } from "@workflow/core/slug";
import { getBlob, putBlob, sha256Hex } from "./blobs.ts";
import { HttpError, type Bindings, type Workspace } from "./env.ts";
import { findDoc } from "./repo.ts";

/**
 * 버전 쓰기(로컬 site/server/store.ts의 upload·saveEdit·release·saveTextEdit와 같은 규칙).
 * 파일 본문은 R2에 내용 주소로 먼저 올리고(이미 있으면 건너뜀), 버전·파일 행·current는 D1 batch 한 번(트랜잭션)으로 쓴다.
 * UNIQUE(document_id, version)가 동시 저장을 막는다: 같은 기준에서 두 사람이 저장하면 뒤의 사람은 409.
 */

const TZ = "Asia/Seoul";

export interface VersionFileIn { path: string; sha256: string; size: number; mime: string; data?: Uint8Array }
interface MenuRow { id: number; slug: string; category_key: string }

export async function menuBySlug(db: D1Database, wsId: number, slug: string): Promise<MenuRow> {
  const m = await db.prepare("SELECT id, slug, category_key FROM menu WHERE workspace_id = ? AND slug = ?").bind(wsId, slug).first<MenuRow>();
  if (!m) throw new HttpError(400, `메뉴 ${slug}이(가) 없습니다`);
  return m;
}

/** 메뉴 안(휴지통 밖) 문서 slug */
async function docSlugsIn(db: D1Database, menuId: number): Promise<Set<string>> {
  const { results } = await db.prepare("SELECT slug FROM document WHERE menu_id = ? AND deleted_at IS NULL").bind(menuId).all<{ slug: string }>();
  return new Set(results.map((r) => r.slug));
}

export async function versionFiles(db: D1Database, docId: number, version: string): Promise<VersionFileIn[]> {
  const { results } = await db.prepare(`SELECT f.path, f.sha256, f.size, f.mime FROM version_file f JOIN document_version v ON v.id = f.version_id
    WHERE v.document_id = ? AND v.version = ? ORDER BY f.id`).bind(docId, version).all<VersionFileIn>();
  return results;
}

const isUnique = (e: unknown) => /UNIQUE constraint failed/i.test(String((e as Error)?.message ?? e));

/** 버전 하나를 쓴다. data가 있는 파일만 R2에 올린다(나머지는 이전 버전 blob을 그대로 가리킨다) */
export async function writeVersion(env: Bindings, ws: Workspace, doc: { id: number; current: string | null }, input: {
  version?: string; entry: string; note?: string | null; source: string; files: VersionFileIn[]; origin?: string; status?: string; title?: string;
  /** 수정본을 버전으로 올릴 때(5.0) 그 수정본 id */
  revisionId?: number;
}): Promise<string> {
  const db = env.DB;
  const { results: vs } = await db.prepare("SELECT version FROM document_version WHERE document_id = ?").bind(doc.id).all<{ version: string }>();
  const existing = vs.map((v) => v.version);
  const version = input.version?.trim() || nextVersion(existing);
  if (!VERSION_RE.test(version)) throw new HttpError(400, `버전은 v<숫자>.<숫자> 형식이어야 합니다: ${version}`);
  if (existing.includes(version)) throw new HttpError(409, `${version} 버전이 이미 있습니다`);
  if (doc.current && input.source !== "release") {
    const cur = await versionFiles(db, doc.id, doc.current);
    const same = cur.length === input.files.length && input.files.every((f) => cur.some((c) => c.path === f.path && c.sha256 === f.sha256));
    if (same) throw new HttpError(409, `직전 버전(${doc.current})과 내용이 같아 새 버전을 만들지 않았습니다`);
  }

  for (const f of input.files) if (f.data) await putBlob(env.BLOBS, ws.id, f.sha256, f.data);

  const stmts: D1PreparedStatement[] = [
    db.prepare("INSERT INTO document_version (document_id, version, note, source, created_at, entry, revision_id) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(doc.id, version, input.note?.trim() || null, input.source, nowStamp(new Date(), TZ), input.entry, input.revisionId ?? null),
  ];
  // 파일 행: ?1·?2(문서·버전)를 줄마다 다시 쓰고 한 줄에 5개씩(바인드 값 100개 한도 → 19줄)
  for (let i = 0; i < input.files.length; i += 19) {
    const chunk = input.files.slice(i, i + 19);
    const rows = chunk.map((_, j) => {
      const b = 3 + j * 5;
      return `((SELECT id FROM document_version WHERE document_id = ?1 AND version = ?2), ?${b}, ?${b + 1}, ?${b + 2}, ?${b + 3}, ?${b + 4})`;
    });
    stmts.push(db.prepare(`INSERT INTO version_file (version_id, path, mime, size, sha256, is_entry) VALUES ${rows.join(", ")}`)
      .bind(doc.id, version, ...chunk.flatMap((f) => [f.path, f.mime, f.size, f.sha256, f.path === input.entry ? 1 : 0])));
  }
  const sets = ["current_version = ?"];
  const vals: unknown[] = [version];
  if (input.origin) { sets.push("origin_url = ?"); vals.push(input.origin); }
  if (input.status) { sets.push("status = ?"); vals.push(input.status); }
  stmts.push(db.prepare(`UPDATE document SET ${sets.join(", ")} WHERE id = ?`).bind(...vals, doc.id));

  // 검색 본문: 새 문서는 늘 한 줄(본문이 없어도 제목·메뉴 이름으로 찾는다), 그 뒤로는 대표 파일 내용이 바뀐 텍스트 형식일 때만 다시 넣는다
  const entryFile = input.files.find((f) => f.path === input.entry);
  if (!doc.current || (entryFile?.data && isSearchable(input.entry))) {
    const title = input.title ?? (await db.prepare("SELECT title FROM document WHERE id = ?").bind(doc.id).first<{ title: string }>())!.title;
    stmts.push(db.prepare("DELETE FROM search WHERE document_id = ?").bind(doc.id));
    stmts.push(db.prepare("INSERT INTO search (workspace_id, document_id, title, body) VALUES (?, ?, ?, ?)")
      .bind(ws.id, doc.id, title, entryFile?.data ? searchText(input.entry, new TextDecoder().decode(entryFile.data)) : ""));
  }
  try {
    await db.batch(stmts);
  } catch (e) {
    if (isUnique(e)) throw new HttpError(409, `${version} 버전을 다른 곳에서 먼저 저장했습니다. 새로고침해서 최신 내용을 확인하세요`);
    throw e;
  }
  return version;
}

export interface UploadInput {
  menu: string; doc?: string; parent?: string; title?: string; slug?: string; version?: string; note?: string; entry?: string;
  origin?: string; files: IncomingFile[];
}

export async function upload(env: Bindings, ws: Workspace, input: UploadInput) {
  const db = env.DB;
  const menu = await menuBySlug(db, ws.id, input.menu);
  const files = normalizeFiles(input.files);
  if (files.length === 0) throw new HttpError(400, "올릴 파일이 없습니다");
  const entry = pickEntry(files.map((f) => f.path), input.entry);
  if (!entry) throw new HttpError(400, `대표 파일 ${input.entry}이(가) 업로드 목록에 없습니다`);
  const vfiles = await Promise.all(files.map(async (f) => ({
    path: f.path, sha256: await sha256Hex(f.data), size: f.data.byteLength, mime: mimeOf(f.path), data: f.data,
  })));

  if (input.doc) {
    const d = await findDoc(db, ws.id, input.menu, input.doc);
    const version = await writeVersion(env, ws, { id: d.id, current: d.current_version }, {
      version: input.version, entry, note: input.note, source: "upload", files: vfiles, origin: input.origin,
    });
    return { menu: input.menu, doc: d.slug, version, category: menu.category_key, created: false };
  }

  if (!input.title?.trim()) throw new HttpError(400, "새 문서에는 제목이 필요합니다");
  const base = input.slug?.trim() || slugify(entry.split("/").pop()!) || "doc";
  if (!SLUG_RE.test(base)) throw new HttpError(400, `slug는 영문 소문자, 숫자, 하이픈만 쓸 수 있습니다: ${base}`);
  const used = await docSlugsIn(db, menu.id);
  let slug = base;
  for (let i = 2; used.has(slug); i++) slug = `${base}-${i}`;
  const parent = input.parent ? await findDoc(db, ws.id, input.menu, input.parent) : null;

  const row = await db.prepare(`INSERT INTO document (workspace_id, menu_id, slug, parent_id, title, kind, status, current_version, origin_url)
      VALUES (?, ?, ?, ?, ?, ?, 'draft', '', ?) RETURNING id`)
    .bind(ws.id, menu.id, slug, parent?.id ?? null, input.title.trim(), kindOf(entry), input.origin ?? null).first<{ id: number }>();
  try {
    const version = await writeVersion(env, ws, { id: row!.id, current: null }, {
      version: input.version, entry, note: input.note, source: "upload", files: vfiles, title: input.title.trim(),
    });
    return { menu: input.menu, doc: slug, version, category: menu.category_key, created: true };
  } catch (e) {
    await db.prepare("DELETE FROM document WHERE id = ?").bind(row!.id).run();
    throw e;
  }
}

/** 버전과 대표 파일 */
async function versionEntry(db: D1Database, wsId: number, menu: string, doc: string, version?: string) {
  const d = await findDoc(db, wsId, menu, doc);
  const v = version || d.current_version;
  const row = await db.prepare("SELECT entry FROM document_version WHERE document_id = ? AND version = ?").bind(d.id, v).first<{ entry: string }>();
  if (!row) throw new HttpError(404, `${v} 버전이 없습니다`);
  const files = await versionFiles(db, d.id, v);
  const entryFile = files.find((f) => f.path === row.entry);
  if (!entryFile) throw new HttpError(404, `대표 파일(${row.entry})이 없습니다`);
  return { doc: d, version: v, entry: row.entry, files, entryFile };
}

/** Markdown 저장: 기준 버전 파일을 그대로 두고 대표 .md만 바꿔 새 버전(source: edit) */
export async function saveEdit(env: Bindings, ws: Workspace, menu: string, doc: string,
  input: { baseVersion: string; content: string; note?: string; version?: string }) {
  const v = await versionEntry(env.DB, ws.id, menu, doc, input.baseVersion);
  if (v.doc.current_version !== input.baseVersion) {
    throw new HttpError(409, `편집하는 동안 새 버전(${v.doc.current_version})이 생겼습니다. 새로고침해서 최신 내용을 확인하세요`);
  }
  if (!/\.md$/i.test(v.entry)) throw new HttpError(400, "Markdown 문서만 사이트에서 편집할 수 있습니다");
  const data = new TextEncoder().encode(input.content);
  const files = v.files.map((f) => (f.path === v.entry ? { ...f, sha256: "", size: data.byteLength, data } : f));
  for (const f of files) if (f.data) f.sha256 = await sha256Hex(f.data);
  const version = await writeVersion(env, ws, { id: v.doc.id, current: v.doc.current_version }, {
    version: input.version, entry: v.entry, note: input.note, source: "edit", files,
  });
  return { menu, doc, version, category: await categoryOf(env.DB, v.doc.menu_id), created: false };
}

const categoryOf = async (db: D1Database, menuId: number) =>
  (await db.prepare("SELECT category_key FROM menu WHERE id = ?").bind(menuId).first<{ category_key: string }>())!.category_key;

/** 정식 확정: 현재 버전 파일 목록을 다음 major로 복사(R2 복사 없음, 같은 blob을 가리킨다)하고 status approved */
export async function release(env: Bindings, ws: Workspace, menu: string, doc: string, note?: string) {
  const v = await versionEntry(env.DB, ws.id, menu, doc);
  if (v.doc.status === "approved") throw new HttpError(409, "이미 정식 버전입니다");
  const { results } = await env.DB.prepare("SELECT version FROM document_version WHERE document_id = ?").bind(v.doc.id).all<{ version: string }>();
  const version = nextMajor(results.map((r) => r.version));
  await writeVersion(env, ws, { id: v.doc.id, current: v.doc.current_version }, {
    version, entry: v.entry, source: "release", files: v.files, status: "approved",
    note: note?.trim() || `${v.version === "v0.0" ? "draft" : v.version} 버전을 정식 버전으로 확정`,
  });
  return { menu, doc, from: v.version, version };
}

// ---------- 텍스트 편집(2.0) ----------

function adapterOf(entry: string) {
  const a = adapterFor(entry);
  if (!a) throw new HttpError(400, `${entry.slice(entry.lastIndexOf("."))} 파일은 텍스트 편집을 지원하지 않습니다 (HTML·SVG·DOCX·PPTX·XLSX)`);
  return a;
}

function applyChanges(a: ReturnType<typeof adapterOf>, data: Uint8Array, changes: Change[]) {
  try {
    return a.adapter.apply(data, changes ?? []);
  } catch (e) {
    if (e instanceof EditError) throw new HttpError(e.status, e.message);
    throw e;
  }
}

export async function readSegments(env: Bindings, ws: Workspace, menu: string, doc: string, version?: string) {
  const v = await versionEntry(env.DB, ws.id, menu, doc, version);
  const a = adapterOf(v.entry);
  return { format: a.format, version: v.version, entry: v.entry, segments: a.adapter.extract(await getBlob(env.BLOBS, ws.id, v.entryFile.sha256)) };
}

/** HTML·SVG 편집 화면용 사본. baseHref는 버전 폴더(대표 파일이 있는 폴더)의 콘텐츠 주소 */
export async function editView(env: Bindings, ws: Workspace, menu: string, doc: string, version: string | undefined,
  baseHref: (docId: number, version: string, dir: string) => Promise<string>) {
  const v = await versionEntry(env.DB, ws.id, menu, doc, version);
  const format = adapterOf(v.entry).format;
  const data = await getBlob(env.BLOBS, ws.id, v.entryFile.sha256);
  if (format === "svg") return { type: "svg" as const, body: wrapSvgForEdit(data) };
  if (format !== "html") throw new HttpError(400, "HTML·SVG 문서만 그 자리 편집을 지원합니다");
  const dir = v.entry.includes("/") ? v.entry.slice(0, v.entry.lastIndexOf("/") + 1) : "";
  return { type: "html" as const, body: wrapForEdit(data, await baseHref(v.doc.id, v.version, dir)) };
}

export async function previewTextEdit(env: Bindings, ws: Workspace, menu: string, doc: string, input: { baseVersion: string; changes: Change[] }) {
  const v = await versionEntry(env.DB, ws.id, menu, doc, input.baseVersion);
  const a = adapterOf(v.entry);
  return { format: a.format, entry: v.entry, data: applyChanges(a, await getBlob(env.BLOBS, ws.id, v.entryFile.sha256), input.changes).data };
}

export async function saveTextEdit(env: Bindings, ws: Workspace, menu: string, doc: string,
  input: { baseVersion: string; changes: Change[]; note?: string }) {
  const v = await versionEntry(env.DB, ws.id, menu, doc, input.baseVersion);
  if (v.doc.current_version !== input.baseVersion) {
    throw new HttpError(409, `편집하는 동안 새 버전(${v.doc.current_version})이 생겼습니다. 새로고침해서 최신 내용을 확인하세요`);
  }
  const a = adapterOf(v.entry);
  const result = applyChanges(a, await getBlob(env.BLOBS, ws.id, v.entryFile.sha256), input.changes);
  if (result.changed === 0) throw new HttpError(409, "바뀐 텍스트가 없습니다");
  const sha = await sha256Hex(result.data);
  const files = v.files.map((f) => (f.path === v.entry ? { ...f, sha256: sha, size: result.data.byteLength, data: result.data } : f));
  const version = await writeVersion(env, ws, { id: v.doc.id, current: v.doc.current_version }, {
    entry: v.entry, note: input.note, source: "text-edit", files,
  });
  return { menu, doc, version, category: await categoryOf(env.DB, v.doc.menu_id), created: false, changed: result.changed, warnings: result.warnings ?? [] };
}
