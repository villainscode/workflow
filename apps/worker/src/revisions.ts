import * as work from "@workflow/core/work";
import type { DocStore, Manifest, ManifestFile, RevisionChange } from "@workflow/core/work";
import { getBlob, putBlob } from "./blobs.ts";
import { blobKey, HttpError, type Bindings, type User, type Workspace } from "./env.ts";
import { findDoc } from "./repo.ts";
import { versionFiles, writeVersion } from "./write.ts";

/**
 * 수정본(5.0 M1, spec/REQUIREMENT-5.0.md 5.1~5.2)의 Cloudflare 저장소. 규칙은 packages/core/src/work(로컬 사이트와 같이 쓴다, 6.0 VL)에 있고,
 * 여기서는 문서 하나의 저장소(DocStore)를 D1·R2로 만든다.
 * - 매니페스트·파일 본문은 R2 ws/<id>/blobs/<sha256>. D1 document_revision은 그 주소·작성자·출처, document_head는 작업본 머리.
 * - 버전으로 올릴 때는 R2 복사 없이 같은 blob을 가리키는 버전 행만 만든다.
 */

export type { Manifest, ManifestFile };

const now = () => new Date().toISOString();

interface DocRef { id: number; current_version: string; slug: string; menu_slug: string }

/** 문서 하나의 수정본 저장소(D1·R2). user는 새 수정본의 작성자 */
export function docStore(env: Bindings, ws: Workspace, doc: DocRef, user: User | null = null): DocStore {
  const db = env.DB;
  return {
    currentVersion: doc.current_version,
    head: async () => {
      const h = await db.prepare("SELECT rev, base_version FROM document_head WHERE document_id = ?").bind(doc.id).first<{ rev: number; base_version: string }>();
      return h ? { rev: h.rev, baseVersion: h.base_version } : null;
    },
    revision: async (rev) => {
      const r = await db.prepare("SELECT id, manifest_sha FROM document_revision WHERE document_id = ? AND rev = ?").bind(doc.id, rev).first<{ id: number; manifest_sha: string }>();
      return r ? { id: r.id, manifestSha: r.manifest_sha } : null;
    },
    version: async (version) => {
      const v = await db.prepare("SELECT entry FROM document_version WHERE document_id = ? AND version = ?").bind(doc.id, version).first<{ entry: string }>();
      return v ? { entry: v.entry, files: await versionFiles(db, doc.id, version) } : null;
    },
    getBlob: (sha) => getBlob(env.BLOBS, ws.id, sha),
    putBlob: (sha, data) => putBlob(env.BLOBS, ws.id, sha, data),
    hasBlob: async (sha) => !!(await env.BLOBS.head(blobKey(ws.id, sha))),
    addRevision: async (r) => {
      try {
        await db.batch([
          db.prepare(`INSERT INTO document_revision (document_id, rev, base_version, manifest_sha, author_id, source, summary, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).bind(doc.id, r.rev, r.baseVersion, r.manifestSha, user?.id ?? null, r.source, r.summary, now()),
          db.prepare(`INSERT INTO document_head (document_id, rev, base_version, updated_at) VALUES (?, ?, ?, ?)
            ON CONFLICT (document_id) DO UPDATE SET rev = excluded.rev, base_version = excluded.base_version, updated_at = excluded.updated_at`)
            .bind(doc.id, r.rev, r.baseVersion, now()),
        ]);
      } catch (e) {
        if (/UNIQUE constraint failed/i.test(String((e as Error).message))) throw new HttpError(409, "다른 곳에서 먼저 저장했습니다. 최신 내용을 받아 다시 적용하세요");
        throw e;
      }
    },
  };
}

/** 메뉴·문서 slug로 저장소 */
export async function storeFor(env: Bindings, ws: Workspace, menu: string, docSlug: string, user: User | null = null) {
  const doc = await findDoc(env.DB, ws.id, menu, docSlug);
  return { doc, store: docStore(env, ws, doc, user) };
}

export async function loadManifest(env: Bindings, wsId: number, sha: string): Promise<Manifest> {
  return JSON.parse(new TextDecoder().decode(await getBlob(env.BLOBS, wsId, sha))) as Manifest;
}

/** 작업 상태: 기준 버전, 지금 rev, 파일 목록 */
export const workState = (env: Bindings, ws: Workspace, doc: DocRef) => work.workState(docStore(env, ws, doc));

/** 수정본 하나를 쌓는다. 바뀐 것이 없으면 그대로 돌려준다(changed: false) */
export async function saveRevision(env: Bindings, ws: Workspace, user: User | null, menu: string, docSlug: string, ch: RevisionChange) {
  const { store } = await storeFor(env, ws, menu, docSlug, user);
  return { ...(await work.saveRevision(store, ch)), menu, doc: docSlug };
}

export async function listRevisions(env: Bindings, ws: Workspace, menu: string, docSlug: string, before?: number) {
  const doc = await findDoc(env.DB, ws.id, menu, docSlug);
  const { results } = await env.DB.prepare(`SELECT r.rev, r.base_version AS baseVersion, r.source, r.summary, r.created_at AS createdAt,
      u.email AS author, v.version AS publishedAs
    FROM document_revision r LEFT JOIN app_user u ON u.id = r.author_id
    LEFT JOIN document_version v ON v.revision_id = r.id
    WHERE r.document_id = ? AND (? IS NULL OR r.rev < ?) ORDER BY r.rev DESC LIMIT 50`).bind(doc.id, before ?? null, before ?? null).all();
  const head = await env.DB.prepare("SELECT rev, base_version FROM document_head WHERE document_id = ?").bind(doc.id).first<{ rev: number; base_version: string }>();
  return { head: head && head.base_version === doc.current_version ? head.rev : null, revisions: results };
}

/** 수정본 하나의 파일 목록 */
export async function getRevision(env: Bindings, ws: Workspace, menu: string, docSlug: string, rev: number) {
  const doc = await findDoc(env.DB, ws.id, menu, docSlug);
  const r = await env.DB.prepare("SELECT rev, base_version, manifest_sha, source, summary, created_at FROM document_revision WHERE document_id = ? AND rev = ?")
    .bind(doc.id, rev).first<{ rev: number; base_version: string; manifest_sha: string; source: string; summary: string | null; created_at: string }>();
  if (!r) throw new HttpError(404, `수정본 ${rev}이(가) 없습니다`);
  return { doc, rev: r.rev, baseVersion: r.base_version, source: r.source, summary: r.summary, createdAt: r.created_at, manifest: await loadManifest(env, ws.id, r.manifest_sha) };
}

/** 예전 수정본의 파일 목록으로 새 수정본을 만든다. rev 0은 작업본이 기준으로 삼는 버전 파일 */
export async function restoreRevision(env: Bindings, ws: Workspace, user: User | null, menu: string, docSlug: string, rev: number, baseRev: number) {
  const { store } = await storeFor(env, ws, menu, docSlug, user);
  return { ...(await work.restoreRevision(store, rev, baseRev)), menu, doc: docSlug };
}

/** 지금 작업본을 다음 버전으로 올린다. R2 복사 없이 같은 blob을 가리키는 버전 행만 만든다 */
export async function publish(env: Bindings, ws: Workspace, menu: string, docSlug: string, input: { baseRev: number; note?: string; version?: string }) {
  const { doc, store } = await storeFor(env, ws, menu, docSlug);
  const state = await work.publishState(store, input.baseRev);
  const version = await writeVersion(env, ws, { id: doc.id, current: doc.current_version }, {
    version: input.version, entry: state.manifest.entry, note: input.note, source: "revision", files: state.manifest.files,
    revisionId: state.revisionId ?? undefined,
  });
  // 작업본은 새 버전을 기준으로 이어간다(rev 번호는 그대로)
  await env.DB.prepare("UPDATE document_head SET base_version = ?, updated_at = ? WHERE document_id = ?").bind(version, now(), doc.id).run();
  return { menu, doc: docSlug, version, rev: state.rev };
}
