import { mimeOf } from "@workflow/core/mime";
import { safeRelPath } from "@workflow/core/upload";
import { getBlob, putBlob, sha256Hex } from "./blobs.ts";
import { HttpError, type Bindings, type User, type Workspace } from "./env.ts";
import { findDoc } from "./repo.ts";
import { versionFiles, writeVersion } from "./write.ts";

/**
 * 수정본(5.0 M1, spec/REQUIREMENT-5.0.md 5.1~5.2). 편집기의 자동 저장·오피스 편집 서버 저장·에이전트 연산이 수정본을 쌓고,
 * 사람이 "버전으로 저장"하면 마지막 수정본을 다음 버전으로 올린다(R2 복사 없음, 같은 blob을 가리킨다).
 *
 * - 매니페스트(그 수정본의 파일 목록)는 R2 blob(JSON)이 정본이다. D1 document_revision은 그 주소·작성자·출처를 둔다.
 * - rev는 문서 안에서 계속 늘어나는 번호다. 작업본(document_head)이 지금 버전을 기준으로 하면 그 rev·매니페스트가 작업 상태이고,
 *   다른 곳에서 새 버전이 생겼으면(업로드·확정) 작업 상태는 그 버전 파일로 다시 시작한다(rev 번호는 이어진다).
 * - 저장은 기준 rev(baseRev)가 지금 rev와 같아야 한다. 다르면 409(화면은 최신을 받아 남은 연산을 다시 적용한다).
 */

export interface ManifestFile { path: string; sha256: string; size: number; mime: string }
export interface Manifest { entry: string; files: ManifestFile[] }

const now = () => new Date().toISOString();

/** 같은 내용이면 같은 sha가 나오도록 경로순으로 정렬해 쓴다 */
export async function putManifest(env: Bindings, wsId: number, m: Manifest): Promise<string> {
  const files = [...m.files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((f) => ({ path: f.path, sha256: f.sha256, size: f.size, mime: f.mime }));
  const data = new TextEncoder().encode(JSON.stringify({ entry: m.entry, files }));
  const sha = await sha256Hex(data);
  await putBlob(env.BLOBS, wsId, sha, data);
  return sha;
}

export async function loadManifest(env: Bindings, wsId: number, sha: string): Promise<Manifest> {
  return JSON.parse(new TextDecoder().decode(await getBlob(env.BLOBS, wsId, sha))) as Manifest;
}

interface DocRef { id: number; current_version: string; slug: string; menu_slug: string }
interface HeadRow { rev: number; base_version: string }

/** 작업 상태: 기준 버전, 지금 rev, 파일 목록. 수정본이 없거나 기준 버전이 지난 것이면 지금 버전 파일에서 시작 */
export async function workState(env: Bindings, ws: Workspace, doc: DocRef) {
  const db = env.DB;
  const head = await db.prepare("SELECT rev, base_version FROM document_head WHERE document_id = ?").bind(doc.id).first<HeadRow>();
  if (head && head.base_version === doc.current_version) {
    const r = await db.prepare("SELECT id, manifest_sha FROM document_revision WHERE document_id = ? AND rev = ?")
      .bind(doc.id, head.rev).first<{ id: number; manifest_sha: string }>();
    return { baseVersion: head.base_version, rev: head.rev, revisionId: r!.id, manifest: await loadManifest(env, ws.id, r!.manifest_sha), fromRevision: true };
  }
  const v = await db.prepare("SELECT entry FROM document_version WHERE document_id = ? AND version = ?")
    .bind(doc.id, doc.current_version).first<{ entry: string }>();
  if (!v) throw new HttpError(404, `${doc.current_version} 버전이 없습니다`);
  const files = await versionFiles(db, doc.id, doc.current_version);
  return { baseVersion: doc.current_version, rev: head?.rev ?? 0, revisionId: null, manifest: { entry: v.entry, files }, fromRevision: false };
}

export interface RevisionChange {
  baseRev: number;
  /** 넣거나 바꿀 파일(내용) */
  put?: { path: string; data: Uint8Array }[];
  /** 이미 R2에 있는 blob을 가리키게 할 파일(복원·오피스 저장 등) */
  link?: ManifestFile[];
  remove?: string[];
  entry?: string;
  /** 파일 목록 전체를 바꾼다(되돌리기) */
  replace?: Manifest;
  source: "human" | "agent" | "office" | "restore";
  summary?: string;
}

/** 수정본 하나를 쌓는다. 바뀐 것이 없으면 그대로 돌려준다(changed: false) */
export async function saveRevision(env: Bindings, ws: Workspace, user: User | null, menu: string, docSlug: string, ch: RevisionChange) {
  const db = env.DB;
  const doc = await findDoc(db, ws.id, menu, docSlug);
  const state = await workState(env, ws, doc);
  if (ch.baseRev !== state.rev) {
    throw new HttpError(409, `다른 곳에서 먼저 저장했습니다(지금 수정본 ${state.rev}). 최신 내용을 받아 다시 적용하세요`);
  }
  const byPath = new Map((ch.replace ?? state.manifest).files.map((f) => [f.path, f]));
  let entry = ch.replace?.entry ?? state.manifest.entry;
  for (const p of ch.remove ?? []) byPath.delete(p);
  for (const f of ch.link ?? []) {
    const path = safeRelPath(f.path);
    if (!path) throw new HttpError(400, `잘못된 경로: ${f.path}`);
    if (!(await env.BLOBS.head(`ws/${ws.id}/blobs/${f.sha256}`))) throw new HttpError(400, `파일 본문이 없습니다: ${f.sha256}`);
    byPath.set(path, { ...f, path });
  }
  for (const f of ch.put ?? []) {
    const path = safeRelPath(f.path);
    if (!path) throw new HttpError(400, `잘못된 경로: ${f.path}`);
    const sha = await sha256Hex(f.data);
    await putBlob(env.BLOBS, ws.id, sha, f.data);
    byPath.set(path, { path, sha256: sha, size: f.data.byteLength, mime: mimeOf(path) });
  }
  if (ch.entry) entry = ch.entry;
  if (!byPath.has(entry)) throw new HttpError(400, `대표 파일(${entry})이 파일 목록에 없습니다`);
  const manifest: Manifest = { entry, files: [...byPath.values()] };
  const manifestSha = await putManifest(env, ws.id, manifest);
  const prevSha = state.fromRevision ? await putManifest(env, ws.id, state.manifest) : null;
  if (prevSha === manifestSha || (!state.fromRevision && sameFiles(state.manifest, manifest))) {
    return { rev: state.rev, baseVersion: state.baseVersion, changed: false, menu, doc: docSlug };
  }

  const rev = state.rev + 1;
  try {
    await db.batch([
      db.prepare(`INSERT INTO document_revision (document_id, rev, base_version, manifest_sha, author_id, source, summary, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).bind(doc.id, rev, state.baseVersion, manifestSha, user?.id ?? null, ch.source, ch.summary?.trim() || null, now()),
      db.prepare(`INSERT INTO document_head (document_id, rev, base_version, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT (document_id) DO UPDATE SET rev = excluded.rev, base_version = excluded.base_version, updated_at = excluded.updated_at`)
        .bind(doc.id, rev, state.baseVersion, now()),
    ]);
  } catch (e) {
    if (/UNIQUE constraint failed/i.test(String((e as Error).message))) {
      throw new HttpError(409, "다른 곳에서 먼저 저장했습니다. 최신 내용을 받아 다시 적용하세요");
    }
    throw e;
  }
  return { rev, baseVersion: state.baseVersion, changed: true, menu, doc: docSlug };
}

const sameFiles = (a: Manifest, b: Manifest) =>
  a.entry === b.entry && a.files.length === b.files.length && a.files.every((f) => b.files.some((g) => g.path === f.path && g.sha256 === f.sha256));

export async function listRevisions(env: Bindings, ws: Workspace, menu: string, docSlug: string, before?: number) {
  const doc = await findDoc(env.DB, ws.id, menu, docSlug);
  const { results } = await env.DB.prepare(`SELECT r.rev, r.base_version AS baseVersion, r.source, r.summary, r.created_at AS createdAt,
      u.email AS author, v.version AS publishedAs
    FROM document_revision r LEFT JOIN app_user u ON u.id = r.author_id
    LEFT JOIN document_version v ON v.revision_id = r.id
    WHERE r.document_id = ? AND (? IS NULL OR r.rev < ?) ORDER BY r.rev DESC LIMIT 50`).bind(doc.id, before ?? null, before ?? null).all();
  const head = await env.DB.prepare("SELECT rev, base_version FROM document_head WHERE document_id = ?").bind(doc.id).first<HeadRow>();
  return { head: head && head.base_version === doc.current_version ? head.rev : null, revisions: results };
}

/** 수정본 하나의 파일 목록. fileUrl은 콘텐츠 도메인 주소를 만든다 */
export async function getRevision(env: Bindings, ws: Workspace, menu: string, docSlug: string, rev: number) {
  const doc = await findDoc(env.DB, ws.id, menu, docSlug);
  const r = await env.DB.prepare("SELECT rev, base_version, manifest_sha, source, summary, created_at FROM document_revision WHERE document_id = ? AND rev = ?")
    .bind(doc.id, rev).first<{ rev: number; base_version: string; manifest_sha: string; source: string; summary: string | null; created_at: string }>();
  if (!r) throw new HttpError(404, `수정본 ${rev}이(가) 없습니다`);
  return { doc, rev: r.rev, baseVersion: r.base_version, source: r.source, summary: r.summary, createdAt: r.created_at, manifest: await loadManifest(env, ws.id, r.manifest_sha) };
}

/** 예전 수정본의 파일 목록으로 새 수정본을 만든다(과거는 지우지 않는다). rev 0은 작업본이 기준으로 삼는 버전 파일(편집 화면의 첫 되돌리기) */
export async function restoreRevision(env: Bindings, ws: Workspace, user: User | null, menu: string, docSlug: string, rev: number, baseRev: number) {
  if (rev === 0) {
    const doc = await findDoc(env.DB, ws.id, menu, docSlug);
    const st = await workState(env, ws, doc);
    const v = await env.DB.prepare("SELECT entry FROM document_version WHERE document_id = ? AND version = ?").bind(doc.id, st.baseVersion).first<{ entry: string }>();
    const manifest = { entry: v!.entry, files: await versionFiles(env.DB, doc.id, st.baseVersion) };
    return saveRevision(env, ws, user, menu, docSlug, { baseRev, replace: manifest, source: "restore", summary: `${st.baseVersion}(으)로 되돌림` });
  }
  const target = await getRevision(env, ws, menu, docSlug, rev);
  return saveRevision(env, ws, user, menu, docSlug, { baseRev, replace: target.manifest, source: "restore", summary: `수정본 ${rev}(으)로 되돌림` });
}

/** 지금 작업본을 다음 버전으로 올린다. R2 복사 없이 같은 blob을 가리키는 버전 행만 만든다 */
export async function publish(env: Bindings, ws: Workspace, menu: string, docSlug: string, input: { baseRev: number; note?: string; version?: string }) {
  const doc = await findDoc(env.DB, ws.id, menu, docSlug);
  const state = await workState(env, ws, doc);
  if (!state.fromRevision) throw new HttpError(409, "버전으로 올릴 수정본이 없습니다");
  if (input.baseRev !== state.rev) throw new HttpError(409, `다른 곳에서 먼저 저장했습니다(지금 수정본 ${state.rev}). 최신 내용을 확인하세요`);
  const version = await writeVersion(env, ws, { id: doc.id, current: doc.current_version }, {
    version: input.version, entry: state.manifest.entry, note: input.note, source: "revision", files: state.manifest.files,
    revisionId: state.revisionId ?? undefined,
  });
  // 작업본은 새 버전을 기준으로 이어간다(rev 번호는 그대로)
  await env.DB.prepare("UPDATE document_head SET base_version = ?, updated_at = ? WHERE document_id = ?").bind(version, now(), doc.id).run();
  return { menu, doc: docSlug, version, rev: state.rev };
}
