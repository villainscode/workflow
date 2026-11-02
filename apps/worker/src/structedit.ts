import * as work from "@workflow/core/work";
import type { StructOp } from "@workflow/core/work";
import { assetRow } from "./assets.ts";
import type { Bindings, User, Workspace } from "./env.ts";
import type { findDoc } from "./repo.ts";
import { storeFor } from "./revisions.ts";

/**
 * 구조 편집(5.0 M3·M5). 작업본 대표 파일에 연산(ops)을 적용해 수정본으로 저장한다. 규칙은 packages/core/src/work(로컬 사이트와 같이 쓴다).
 * - HTML: 원본 패치. 그림 주소에 `asset:<sha>`를 주면 그 자산을 대표 파일 옆 `assets/`에 넣고 상대 경로로 바꾼다.
 * - DOCX·PPTX·XLSX: OOXML 직접 편집(D-47 C). 그림 교체는 `{ t: "replaceImage", image, asset: "asset:<sha>" }`.
 */

export type { StructOp };

/** 편집 화면용 목록: HTML은 블록과 속성 패널 견본, 오피스는 표·그림·시트 */
export async function readStructure(env: Bindings, ws: Workspace, menu: string, docSlug: string) {
  return work.readStructure((await storeFor(env, ws, menu, docSlug)).store);
}

/** HTML 구조 편집 화면용 사본(data-eid + <base>). baseHref는 작업본 폴더 안 대표 파일 폴더의 콘텐츠 주소 */
export async function structEditView(env: Bindings, ws: Workspace, menu: string, docSlug: string,
  baseHref: (doc: Awaited<ReturnType<typeof findDoc>>, folder: string, dir: string) => Promise<string>) {
  const { doc, store } = await storeFor(env, ws, menu, docSlug);
  return work.structEditView(store, (folder, dir) => baseHref(doc, folder, dir));
}

/** 연산을 적용해 수정본 하나로 저장한다. 바뀐 것이 없으면 수정본을 만들지 않는다(changed: false) */
export async function applyStructOps(env: Bindings, ws: Workspace, user: User | null, menu: string, docSlug: string,
  input: { baseRev: number; ops: StructOp[]; summary?: string; source: "human" | "agent" }) {
  const { store } = await storeFor(env, ws, menu, docSlug, user);
  return { ...(await work.applyStructOps(store, (sha) => assetRow(env.DB, ws.id, sha), input)), menu, doc: docSlug };
}
