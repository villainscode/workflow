import { blobKey } from "./env.ts";

export async function sha256Hex(data: Uint8Array | ArrayBuffer): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", data))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** 내용 주소 저장: 이미 있으면 다시 쓰지 않는다(R2 쓰기 횟수 절약) */
export async function putBlob(r2: R2Bucket, wsId: number, sha: string, data: Uint8Array) {
  if (!(await r2.head(blobKey(wsId, sha)))) await r2.put(blobKey(wsId, sha), data);
}

export async function getBlob(r2: R2Bucket, wsId: number, sha: string): Promise<Uint8Array> {
  const obj = await r2.get(blobKey(wsId, sha));
  if (!obj) throw new Error(`파일 본문이 없습니다: ${sha}`);
  return new Uint8Array(await obj.arrayBuffer());
}
