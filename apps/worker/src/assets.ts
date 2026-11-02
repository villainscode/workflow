import { prepareAsset } from "@workflow/core/work";
import { putBlob, sha256Hex } from "./blobs.ts";
import type { Bindings, User, Workspace } from "./env.ts";

/**
 * 편집기 이미지 자산(5.0 M1). 모든 편집기(HTML·슬라이드·PDF 도장 등)가 같은 경로로 올린다.
 * 본문은 R2 ws/<id>/blobs/<sha256>(내용이 같으면 한 번만), 목록·크기는 D1 asset. 문서에는 `asset:<sha256>`만 쓰고,
 * 그릴 때 서명 주소로 바꾼다(서명 토큰은 12~24시간이라 주소를 문서에 넣으면 깨진다).
 * SVG(6.0 V4)는 저장 전에 소독한 결과만 저장한다(core prepareAsset). 콘텐츠 도메인에서만 sandbox CSP와 함께 준다.
 */

export async function putAsset(env: Bindings, ws: Workspace, user: User | null, file: File) {
  const p = prepareAsset(file.type, new Uint8Array(await file.arrayBuffer()));
  const sha = await sha256Hex(p.data);
  await putBlob(env.BLOBS, ws.id, sha, p.data);
  await env.DB.prepare(`INSERT INTO asset (workspace_id, sha256, mime, size, width, height, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (workspace_id, sha256) DO NOTHING`)
    .bind(ws.id, sha, p.mime, p.data.byteLength, p.width, p.height, user?.id ?? null, new Date().toISOString()).run();
  return { asset: `asset:${sha}`, sha256: sha, mime: p.mime, size: p.data.byteLength, width: p.width, height: p.height,
    ...(p.removed ? { removed: p.removed, drawio: p.drawio } : {}) };
}

export async function assetRow(db: D1Database, wsId: number, sha: string) {
  return db.prepare("SELECT sha256, mime, size, width, height FROM asset WHERE workspace_id = ? AND sha256 = ?").bind(wsId, sha)
    .first<{ sha256: string; mime: string; size: number; width: number | null; height: number | null }>();
}
