import type { DeckIndex, SlideOp } from "@workflow/core/slide";
import { API } from "./base.ts";
import { SaveConflict } from "./structedit.ts";

/** 덱 편집 API(5.0 M4, Cloudflare). 저장은 모두 수정본이 된다. 409는 SaveConflict */

export interface DeckWork { baseVersion: string; rev: number; index: DeckIndex; slides: { id: string; html: string }[] }
export interface SlideSaved { rev: number; changed: boolean; rebased: boolean; slide: string; html: string; inverse: SlideOp[] }

async function send<T>(res: Response): Promise<T> {
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  if (res.status === 409) throw new SaveConflict(body.error ?? "다른 곳에서 먼저 저장했습니다");
  if (!res.ok) throw new Error(body.error ?? `${res.status} 오류`);
  return body as T;
}
const D = (menu: string, doc: string) => `${API}/docs/${menu}/${doc}/deck`;
const req = (method: string, body: unknown, keepalive = false): RequestInit =>
  ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body), keepalive });

export const getDeck = async (menu: string, doc: string) => send<DeckWork>(await fetch(D(menu, doc)));

export const patchSlide = async (menu: string, doc: string, sid: string, baseRev: number, ops: SlideOp[], keepalive = false) =>
  send<SlideSaved>(await fetch(`${D(menu, doc)}/slides/${encodeURIComponent(sid)}`, req("POST", { baseRev, ops }, keepalive)));

export const putSlide = async (menu: string, doc: string, sid: string, baseRev: number, html: string, index?: number) =>
  send<{ rev: number; html: string; added: boolean }>(await fetch(`${D(menu, doc)}/slides/${encodeURIComponent(sid)}`, req("PUT", { baseRev, html, index })));

export const patchDeckIndex = async (menu: string, doc: string, baseRev: number, index: Partial<DeckIndex>, summary?: string) =>
  send<{ rev: number; index: DeckIndex }>(await fetch(D(menu, doc), req("PATCH", { baseRev, index, summary })));
