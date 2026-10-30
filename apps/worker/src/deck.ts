import { applyOps, DECK_ENTRY, formatDiagnostics, loadSlide, parseDeckIndex, parseSlide, serializeSlide, SlideError, slidePath, type DeckIndex, type SlideOp } from "@workflow/core/slide";
import { getBlob } from "./blobs.ts";
import { HttpError, type Bindings, type User, type Workspace } from "./env.ts";
import { findDoc } from "./repo.ts";
import { saveRevision, workState } from "./revisions.ts";

/**
 * 슬라이드 덱 편집(5.0 M4, 명세 docs/slide-editor-spec.html 10절). 덱은 kind: deck 문서이고 파일은 deck.json + slides/<id>.html.
 * 저장은 수정본(revisions.ts)으로 한다. 정본은 R2(D-49): 슬라이드 한 장을 바꾸면 그 파일 blob 하나만 새로 생긴다.
 * baseRev가 지금과 다르면 최신 작업본에 연산을 다시 적용해 본다. 대상 요소가 모두 있으면 저장하고, 없으면 409(명세 10절).
 */

const dec = new TextDecoder();
const enc = new TextEncoder();

async function load(env: Bindings, ws: Workspace, menu: string, docSlug: string) {
  const doc = await findDoc(env.DB, ws.id, menu, docSlug);
  const st = await workState(env, ws, doc);
  if (st.manifest.entry !== DECK_ENTRY) throw new HttpError(400, "슬라이드 덱(deck.json) 문서가 아닙니다");
  const files = new Map(st.manifest.files.map((f) => [f.path, f]));
  const text = async (path: string) => {
    const f = files.get(path);
    return f ? dec.decode(await getBlob(env.BLOBS, ws.id, f.sha256)) : null;
  };
  const { index, diagnostics } = parseDeckIndex((await text(DECK_ENTRY)) ?? "");
  if (!index) throw new HttpError(500, `deck.json을 읽을 수 없습니다: ${diagnostics[0]?.message}`);
  return { doc, st, index, text };
}

/** 덱 작업본: 색인과 슬라이드 HTML 전부, 지금 rev */
export async function readDeck(env: Bindings, ws: Workspace, menu: string, docSlug: string) {
  const { st, index, text } = await load(env, ws, menu, docSlug);
  // 늘 직렬화 형식(eid가 붙은)으로 준다. 가져오기 등으로 eid 없이 들어온 파일도 같은 번호를 받는다(번호는 문서 순서로 정해진다)
  const slides = await Promise.all(index.order.map(async (id) => ({ id, html: serializeSlide(loadSlide((await text(slidePath(id))) ?? "")) })));
  return { baseVersion: st.baseVersion, rev: st.rev, index, slides };
}

type Source = "human" | "agent";
const diagError = (e: unknown) => {
  if (e instanceof SlideError) {
    const err = new HttpError(e.status, e.diagnostics.length ? `${e.message}\n${formatDiagnostics(e.diagnostics)}` : e.message);
    return err;
  }
  return e;
};

/** 최신 작업본을 읽어 change를 적용하고 저장한다. 그사이 다른 저장이 끼면 다시 읽어 한 번 더(최대 3번) */
async function withLatest<T>(env: Bindings, ws: Workspace, user: User | null, menu: string, docSlug: string, baseRev: number,
  change: (d: Awaited<ReturnType<typeof load>>) => Promise<{ put: { path: string; data: Uint8Array }[]; remove?: string[]; summary: string; result: T }>, source: Source) {
  for (let attempt = 0; ; attempt++) {
    const d = await load(env, ws, menu, docSlug);
    if (typeof baseRev !== "number") throw new HttpError(400, "baseRev가 필요합니다");
    let c;
    try { c = await change(d); } catch (e) { throw diagError(e); }
    try {
      const r = await saveRevision(env, ws, user, menu, docSlug, { baseRev: d.st.rev, put: c.put, remove: c.remove, source, summary: c.summary });
      return { ...r, rebased: baseRev !== d.st.rev, ...c.result };
    } catch (e) {
      if (!(e instanceof HttpError && e.status === 409) || attempt >= 2) throw e;
    }
  }
}

/** 슬라이드 하나에 연산 적용 → 수정본. 돌려주는 inverse로 화면이 되돌리기를 만든다 */
export async function patchSlide(env: Bindings, ws: Workspace, user: User | null, menu: string, docSlug: string, sid: string,
  input: { baseRev: number; ops: SlideOp[]; summary?: string }, source: Source) {
  if (!Array.isArray(input.ops) || input.ops.length === 0) throw new HttpError(400, "ops가 비어 있습니다");
  return withLatest(env, ws, user, menu, docSlug, input.baseRev, async ({ index, text }) => {
    if (!index.order.includes(sid)) throw new HttpError(404, `슬라이드 ${sid}이(가) 없습니다`);
    const slide = loadSlide((await text(slidePath(sid)))!);
    const r = applyOps(slide, input.ops);
    const html = serializeSlide(r.slide);
    return { put: [{ path: slidePath(sid), data: enc.encode(html) }], summary: input.summary ?? `슬라이드 ${sid} 편집`, result: { slide: sid, html, inverse: r.inverse } };
  }, source);
}

/** 슬라이드 통째로 쓰기(에이전트·복제). order에 없으면 index 자리(없으면 끝)에 더한다 */
export async function putSlide(env: Bindings, ws: Workspace, user: User | null, menu: string, docSlug: string, sid: string,
  input: { baseRev: number; html: string; index?: number; summary?: string }, source: Source) {
  return withLatest(env, ws, user, menu, docSlug, input.baseRev, async ({ index }) => {
    const p = parseSlide(input.html ?? "");
    if (!p.slide || p.diagnostics.length) throw new HttpError(400, `슬라이드 형식 오류 ${p.diagnostics.length}건\n${formatDiagnostics(p.diagnostics)}`);
    if (p.slide.id !== sid) throw new HttpError(400, `section id(${p.slide.id})가 슬라이드 id(${sid})와 다릅니다`);
    const html = serializeSlide(p.slide);
    const put = [{ path: slidePath(sid), data: enc.encode(html) }];
    const added = !index.order.includes(sid);
    if (added) {
      const order = [...index.order];
      order.splice(input.index === undefined ? order.length : Math.max(0, Math.min(input.index, order.length)), 0, sid);
      put.push({ path: DECK_ENTRY, data: enc.encode(JSON.stringify({ ...index, order }, null, 2) + "\n") });
    }
    return { put, summary: input.summary ?? (added ? `슬라이드 ${sid} 추가` : `슬라이드 ${sid} 다시 씀`), result: { slide: sid, html, added } };
  }, source);
}

/** 색인 바꾸기(제목·순서·섹션·글꼴·팔레트). order에서 빠진 슬라이드 파일은 지운다. 새 id는 putSlide로 먼저 만든다 */
export async function patchDeck(env: Bindings, ws: Workspace, user: User | null, menu: string, docSlug: string,
  input: { baseRev: number; index: Partial<DeckIndex>; summary?: string }, source: Source) {
  return withLatest(env, ws, user, menu, docSlug, input.baseRev, async ({ index }) => {
    const next = { ...index, ...input.index, v: 1 };
    const { index: ok, diagnostics } = parseDeckIndex(JSON.stringify(next));
    if (!ok) throw new HttpError(400, `덱 색인 오류\n${formatDiagnostics(diagnostics)}`);
    const unknown = ok.order.filter((id) => !index.order.includes(id));
    if (unknown.length) throw new HttpError(400, `없는 슬라이드: ${unknown.join(", ")} (먼저 슬라이드를 만드세요)`);
    const removed = index.order.filter((id) => !ok.order.includes(id));
    return {
      put: [{ path: DECK_ENTRY, data: enc.encode(JSON.stringify(ok, null, 2) + "\n") }],
      remove: removed.map(slidePath),
      summary: input.summary ?? (removed.length ? `슬라이드 ${removed.join(", ")} 지움` : "덱 색인 고침"),
      result: { index: ok },
    };
  }, source);
}
