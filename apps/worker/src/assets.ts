import { imageSize } from "@workflow/core/image";
import { putBlob, sha256Hex } from "./blobs.ts";
import { HttpError, type Bindings, type User, type Workspace } from "./env.ts";

/**
 * 편집기 이미지 자산(5.0 M1). 모든 편집기(HTML·슬라이드·PDF 도장 등)가 같은 경로로 올린다.
 * 본문은 R2 ws/<id>/blobs/<sha256>(내용이 같으면 한 번만), 목록·크기는 D1 asset. 문서에는 `asset:<sha256>`만 쓰고,
 * 그릴 때 서명 주소로 바꾼다(서명 토큰은 12~24시간이라 주소를 문서에 넣으면 깨진다).
 * SVG는 받지 않는다(스크립트를 품을 수 있다).
 */

const TYPES: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };
export const MAX_ASSET = 10 * 1024 * 1024;

export async function putAsset(env: Bindings, ws: Workspace, user: User | null, file: File) {
  if (!TYPES[file.type]) throw new HttpError(400, "PNG·JPEG·WebP·GIF만 올릴 수 있습니다");
  if (file.size > MAX_ASSET) throw new HttpError(413, "10MB 이하만 올릴 수 있습니다");
  const data = new Uint8Array(await file.arrayBuffer());
  const size = imageSize(data);
  if (!size) throw new HttpError(400, "이미지 파일을 읽을 수 없습니다");
  const sha = await sha256Hex(data);
  await putBlob(env.BLOBS, ws.id, sha, data);
  await env.DB.prepare(`INSERT INTO asset (workspace_id, sha256, mime, size, width, height, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (workspace_id, sha256) DO NOTHING`)
    .bind(ws.id, sha, file.type, data.byteLength, size.width, size.height, user?.id ?? null, new Date().toISOString()).run();
  return { asset: `asset:${sha}`, sha256: sha, mime: file.type, size: data.byteLength, ...size };
}

export async function assetRow(db: D1Database, wsId: number, sha: string) {
  return db.prepare("SELECT sha256, mime, size, width, height FROM asset WHERE workspace_id = ? AND sha256 = ?").bind(wsId, sha)
    .first<{ sha256: string; mime: string; size: number; width: number | null; height: number | null }>();
}
