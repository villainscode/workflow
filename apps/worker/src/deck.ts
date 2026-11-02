import * as work from "@workflow/core/work";
import type { DeckIndex, SlideOp } from "@workflow/core/slide";
import type { Bindings, User, Workspace } from "./env.ts";
import { storeFor } from "./revisions.ts";

/**
 * 슬라이드 덱 편집(5.0 M4, 명세 docs/editor-spec/slide-editor-spec 10절). 덱은 kind: deck 문서이고 파일은 deck.json + slides/<id>.html.
 * 저장은 수정본으로 한다(D-49). 규칙은 packages/core/src/work(로컬 사이트와 같이 쓴다).
 */

type Source = "human" | "agent";

/** 덱 작업본: 색인과 슬라이드 HTML 전부, 지금 rev */
export async function readDeck(env: Bindings, ws: Workspace, menu: string, docSlug: string) {
  return work.readDeck((await storeFor(env, ws, menu, docSlug)).store);
}

export async function patchSlide(env: Bindings, ws: Workspace, user: User | null, menu: string, docSlug: string, sid: string,
  input: { baseRev: number; ops: SlideOp[]; summary?: string }, source: Source) {
  return { ...(await work.patchSlide((await storeFor(env, ws, menu, docSlug, user)).store, sid, input, source)), menu, doc: docSlug };
}

export async function putSlide(env: Bindings, ws: Workspace, user: User | null, menu: string, docSlug: string, sid: string,
  input: { baseRev: number; html: string; index?: number; summary?: string }, source: Source) {
  return { ...(await work.putSlide((await storeFor(env, ws, menu, docSlug, user)).store, sid, input, source)), menu, doc: docSlug };
}

export async function patchDeck(env: Bindings, ws: Workspace, user: User | null, menu: string, docSlug: string,
  input: { baseRev: number; index: Partial<DeckIndex>; summary?: string }, source: Source) {
  return { ...(await work.patchDeck((await storeFor(env, ws, menu, docSlug, user)).store, input, source)), menu, doc: docSlug };
}

/** 수정본 파일 저장(POST …/revisions {put})으로 덱 파일을 바꿀 때도 업로드와 같은 검사를 한다(5.0 M8 보안 점검) */
export async function checkDeckPut(env: Bindings, ws: Workspace, menu: string, docSlug: string, put: { path: string; data: Uint8Array }[]) {
  await work.checkDeckPut((await storeFor(env, ws, menu, docSlug)).store, put);
}
