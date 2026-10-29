import type { Block } from "@workflow/core/structedit/html";
import type { OoxmlImage, OoxmlSheet, OoxmlTable } from "@workflow/core/structedit/ooxml";
import { API } from "./base.ts";

/**
 * 5.0 구조 편집·수정본 API(Cloudflare 전용, spec/REQUIREMENT-5.0.md 5.4).
 * 연산(ops)은 서버가 작업본 대표 파일에 적용해 수정본 하나로 저장한다. 그림은 먼저 자산으로 올리고 `asset:<sha>`로 가리킨다.
 */

export type { Block };
export interface Structure {
  baseVersion: string; rev: number; entry: string; kind: "html" | "docx" | "pptx" | "xlsx";
  blocks?: Block[]; tables?: OoxmlTable[]; images?: OoxmlImage[]; sheets?: OoxmlSheet[];
}
export interface WorkFile { path: string; sha256: string; size: number; mime: string; url: string }
export interface Work { baseVersion: string; rev: number; fromRevision: boolean; entry: string; files: WorkFile[] }
export interface Revision {
  rev: number; baseVersion: string; source: "human" | "agent" | "office" | "restore"; summary: string | null;
  createdAt: string; author: string | null; publishedAs: string | null;
}

/** 서버가 409(다른 곳에서 먼저 저장)를 돌려줬는지 화면이 구분한다 */
export class SaveConflict extends Error {}

async function send<T>(res: Response): Promise<T> {
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  if (res.status === 409) throw new SaveConflict(body.error ?? "다른 곳에서 먼저 저장했습니다");
  if (!res.ok) throw new Error(body.error ?? `${res.status} 오류`);
  return body as T;
}
const post = (url: string, body: unknown) =>
  fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const D = (menu: string, doc: string) => `${API}/docs/${menu}/${doc}`;

export const getStructure = async (menu: string, doc: string) => send<Structure>(await fetch(`${D(menu, doc)}/work/structure`));
export const getWork = async (menu: string, doc: string) => send<Work>(await fetch(`${D(menu, doc)}/work`));
export const editViewUrl = (menu: string, doc: string, rev: number) => `${D(menu, doc)}/work/edit-view?r=${rev}`;
export const workPdfUrl = (menu: string, doc: string, rev: number) => `${D(menu, doc)}/work/pdf?r=${rev}`;

export const applyOps = async (menu: string, doc: string, baseRev: number, ops: unknown[], summary?: string) =>
  send<{ rev: number; changed: boolean }>(await post(`${D(menu, doc)}/revisions`, { baseRev, ops, summary }));

export const listRevisions = async (menu: string, doc: string) =>
  send<{ head: number | null; revisions: Revision[] }>(await fetch(`${D(menu, doc)}/revisions`));

export const restoreRevision = async (menu: string, doc: string, rev: number, baseRev: number) =>
  send<{ rev: number; changed: boolean }>(await post(`${D(menu, doc)}/revisions/${rev}/restore`, { baseRev }));

export const publishWork = async (menu: string, doc: string, baseRev: number, note?: string) =>
  send<{ version: string; rev: number }>(await post(`${D(menu, doc)}/publish`, { baseRev, note }));

/** 아주 큰 사진은 긴 변 3840px로 줄여 올린다(5.0 M2). GIF는 움직임을 지키려고 그대로 둔다 */
const MAX_SIDE = 3840;
async function shrink(file: File): Promise<File> {
  if (file.type === "image/gif" || !/^image\/(png|jpeg|webp)$/.test(file.type)) return file;
  const bmp = await createImageBitmap(file).catch(() => null);
  if (!bmp || Math.max(bmp.width, bmp.height) <= MAX_SIDE) return file;
  const k = MAX_SIDE / Math.max(bmp.width, bmp.height);
  const canvas = new OffscreenCanvas(Math.round(bmp.width * k), Math.round(bmp.height * k));
  canvas.getContext("2d")!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  const blob = await canvas.convertToBlob({ type: file.type === "image/png" ? "image/png" : "image/jpeg", quality: 0.9 });
  return new File([blob], file.name, { type: blob.type });
}

export async function uploadAsset(file: File): Promise<{ asset: string; width: number; height: number }> {
  const form = new FormData();
  form.append("file", await shrink(file));
  return send(await fetch(`${API}/assets`, { method: "POST", body: form }));
}

export const STRUCT_EDITABLE = /\.(html?|docx|pptx|xlsx)$/i;
