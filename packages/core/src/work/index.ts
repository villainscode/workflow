import { mimeOf } from "../mime.ts";
import { imageSize } from "../image.ts";
import { sanitizeSvg, svgSize, SvgError } from "../svg.ts";
import { safeRelPath } from "../upload.ts";
import { applyOps as applyHtmlOps, docTheme, markEids, outline, StructEditError, type HtmlOp } from "../structedit/html.ts";
import { applyOoxmlOps, MAX_OPS, ooxmlStructure, type OoxmlKind, type OoxmlOp } from "../structedit/ooxml.ts";
import {
  applyOps as applySlideOps, checkDeck, DECK_ENTRY, formatDiagnostics, loadSlide, parseDeckIndex, parseSlide, serializeSlide, SlideError,
  slidePath, type DeckIndex, type SlideOp,
} from "../slide/index.ts";

/**
 * 수정본 층(5.0 M1, 6.0 VL D-58). Cloudflare(D1·R2)와 로컬 사이트(SQLite·data 폴더)가 같은 규칙으로 작업본을 쌓는다.
 * 저장소마다 다른 부분은 DocStore(문서 하나의 수정본 행·버전 파일·내용 주소 blob)로 받고, 여기서는 규칙만 둔다.
 *
 * - 매니페스트(그 수정본의 파일 목록)는 blob(JSON)이 정본이다. 수정본 행은 그 sha·출처·메모를 둔다.
 * - rev는 문서 안에서 계속 늘어나는 번호다. 작업본 머리(head)가 지금 버전을 기준으로 하면 그 rev·매니페스트가 작업 상태이고,
 *   다른 곳에서 새 버전이 생겼으면(업로드·확정) 작업 상태는 그 버전 파일로 다시 시작한다(rev 번호는 이어진다).
 * - 저장은 기준 rev(baseRev)가 지금 rev와 같아야 한다. 다르면 409(화면은 최신을 받아 남은 연산을 다시 적용한다).
 * - 구조 편집(HTML 원본 패치·OOXML)과 슬라이드 덱 연산도 여기서 작업본에 적용한다. 화면과 에이전트(MCP)가 같은 길을 쓴다.
 */

export class WorkError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export interface ManifestFile { path: string; sha256: string; size: number; mime: string }
export interface Manifest { entry: string; files: ManifestFile[] }
export type RevisionSource = "human" | "agent" | "office" | "restore";

/** 문서 하나의 저장소. Worker는 D1·R2, 로컬은 SQLite·data/work 폴더로 만든다 */
export interface DocStore {
  /** 지금 버전(meta.yaml current) */
  currentVersion: string;
  head(): Promise<{ rev: number; baseVersion: string } | null>;
  revision(rev: number): Promise<{ id: number; manifestSha: string } | null>;
  /** 버전의 대표 파일과 파일 목록. 본문은 getBlob(sha)로 읽을 수 있어야 한다 */
  version(version: string): Promise<Manifest | null>;
  getBlob(sha: string): Promise<Uint8Array>;
  putBlob(sha: string, data: Uint8Array): Promise<void>;
  hasBlob(sha: string): Promise<boolean>;
  /** 수정본 행을 넣고 작업본 머리를 그 rev로 옮긴다. 같은 rev가 이미 있으면 WorkError(409) */
  addRevision(r: { rev: number; baseVersion: string; manifestSha: string; source: RevisionSource; summary: string | null }): Promise<void>;
  /** 오피스 편집 세션이 열려 있으면 true(6.0 VO). 그동안 오피스 저장 말고는 쓰지 않는다 */
  locked?(): Promise<boolean>;
}

export async function sha256Hex(data: Uint8Array): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", data as Uint8Array<ArrayBuffer>))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const enc = new TextEncoder();
const dec = new TextDecoder();
export const LOCKED = "오피스 편집기에서 편집 중인 문서입니다. 편집기를 닫아 저장이 끝나면 다시 할 수 있습니다";
const conflict = (rev: number) => new WorkError(409, `다른 곳에서 먼저 저장했습니다(지금 수정본 ${rev}). 최신 내용을 받아 다시 적용하세요`);

/** 같은 내용이면 같은 sha가 나오도록 경로순으로 정렬해 쓴다 */
export async function putManifest(store: DocStore, m: Manifest): Promise<string> {
  const files = [...m.files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((f) => ({ path: f.path, sha256: f.sha256, size: f.size, mime: f.mime }));
  const data = enc.encode(JSON.stringify({ entry: m.entry, files }));
  const sha = await sha256Hex(data);
  await store.putBlob(sha, data);
  return sha;
}

export const loadManifest = async (store: DocStore, sha: string): Promise<Manifest> => JSON.parse(dec.decode(await store.getBlob(sha))) as Manifest;

export interface WorkState { baseVersion: string; rev: number; revisionId: number | null; manifest: Manifest; fromRevision: boolean }

/** 작업 상태: 기준 버전, 지금 rev, 파일 목록. 수정본이 없거나 기준 버전이 지난 것이면 지금 버전 파일에서 시작 */
export async function workState(store: DocStore): Promise<WorkState> {
  const head = await store.head();
  if (head && head.baseVersion === store.currentVersion) {
    const r = await store.revision(head.rev);
    if (r) return { baseVersion: head.baseVersion, rev: head.rev, revisionId: r.id, manifest: await loadManifest(store, r.manifestSha), fromRevision: true };
  }
  const manifest = await store.version(store.currentVersion);
  if (!manifest) throw new WorkError(404, `${store.currentVersion} 버전이 없습니다`);
  return { baseVersion: store.currentVersion, rev: head?.rev ?? 0, revisionId: null, manifest, fromRevision: false };
}

export interface RevisionChange {
  baseRev: number;
  /** 넣거나 바꿀 파일(내용) */
  put?: { path: string; data: Uint8Array }[];
  /** 이미 저장소에 있는 blob을 가리키게 할 파일(복원·자산·오피스 저장 등) */
  link?: ManifestFile[];
  remove?: string[];
  entry?: string;
  /** 파일 목록 전체를 바꾼다(되돌리기) */
  replace?: Manifest;
  source: RevisionSource;
  summary?: string;
}
export interface Saved { rev: number; baseVersion: string; changed: boolean }

/** 수정본 하나를 쌓는다. 바뀐 것이 없으면 그대로 돌려준다(changed: false) */
export async function saveRevision(store: DocStore, ch: RevisionChange): Promise<Saved> {
  if (ch.source !== "office" && (await store.locked?.())) throw new WorkError(409, LOCKED);
  const state = await workState(store);
  if (ch.baseRev !== state.rev) throw conflict(state.rev);
  const byPath = new Map((ch.replace ?? state.manifest).files.map((f) => [f.path, f]));
  let entry = ch.replace?.entry ?? state.manifest.entry;
  for (const p of ch.remove ?? []) byPath.delete(p);
  for (const f of ch.link ?? []) {
    const path = safeRelPath(f.path);
    if (!path) throw new WorkError(400, `잘못된 경로: ${f.path}`);
    if (!(await store.hasBlob(f.sha256))) throw new WorkError(400, `파일 본문이 없습니다: ${f.sha256}`);
    byPath.set(path, { ...f, path });
  }
  for (const f of ch.put ?? []) {
    const path = safeRelPath(f.path);
    if (!path) throw new WorkError(400, `잘못된 경로: ${f.path}`);
    const sha = await sha256Hex(f.data);
    await store.putBlob(sha, f.data);
    byPath.set(path, { path, sha256: sha, size: f.data.byteLength, mime: mimeOf(path) });
  }
  if (ch.entry) entry = ch.entry;
  if (!byPath.has(entry)) throw new WorkError(400, `대표 파일(${entry})이 파일 목록에 없습니다`);
  const manifest: Manifest = { entry, files: [...byPath.values()] };
  const manifestSha = await putManifest(store, manifest);
  const prevSha = state.fromRevision ? await putManifest(store, state.manifest) : null;
  if (prevSha === manifestSha || (!state.fromRevision && sameFiles(state.manifest, manifest))) {
    return { rev: state.rev, baseVersion: state.baseVersion, changed: false };
  }
  const rev = state.rev + 1;
  await store.addRevision({ rev, baseVersion: state.baseVersion, manifestSha, source: ch.source, summary: ch.summary?.trim() || null });
  return { rev, baseVersion: state.baseVersion, changed: true };
}

const sameFiles = (a: Manifest, b: Manifest) =>
  a.entry === b.entry && a.files.length === b.files.length && a.files.every((f) => b.files.some((g) => g.path === f.path && g.sha256 === f.sha256));

/** 예전 수정본(또는 rev 0: 작업본이 기준으로 삼는 버전 파일)의 파일 목록으로 새 수정본을 만든다(과거는 지우지 않는다) */
export async function restoreRevision(store: DocStore, rev: number, baseRev: number): Promise<Saved> {
  if (rev === 0) {
    const st = await workState(store);
    const manifest = await store.version(st.baseVersion);
    if (!manifest) throw new WorkError(404, `${st.baseVersion} 버전이 없습니다`);
    return saveRevision(store, { baseRev, replace: manifest, source: "restore", summary: `${st.baseVersion}(으)로 되돌림` });
  }
  const r = await store.revision(rev);
  if (!r) throw new WorkError(404, `수정본 ${rev}이(가) 없습니다`);
  return saveRevision(store, { baseRev, replace: await loadManifest(store, r.manifestSha), source: "restore", summary: `수정본 ${rev}(으)로 되돌림` });
}

/** 버전으로 올리기 전 확인: 올릴 수정본이 있고 기준 rev가 지금과 같다 */
export async function publishState(store: DocStore, baseRev: number): Promise<WorkState> {
  if (await store.locked?.()) throw new WorkError(409, LOCKED);
  const state = await workState(store);
  if (!state.fromRevision) throw new WorkError(409, "버전으로 올릴 수정본이 없습니다");
  if (baseRev !== state.rev) throw new WorkError(409, `다른 곳에서 먼저 저장했습니다(지금 수정본 ${state.rev}). 최신 내용을 확인하세요`);
  return state;
}

// ---------- 구조 편집(5.0 M3·M5) ----------

type StructKind = "html" | OoxmlKind;
export type StructOp = HtmlOp | Exclude<OoxmlOp, { t: "replaceImage" }> | { t: "replaceImage"; image: string; asset: string };
/** 그림 자산: `asset:<sha>`를 찾는다. 본문은 store.getBlob(sha)로 읽는다 */
export type AssetLookup = (sha: string) => Promise<{ sha256: string; mime: string; size: number } | null>;

function structKind(entry: string): StructKind {
  const ext = entry.slice(entry.lastIndexOf(".") + 1).toLowerCase();
  if (ext === "html" || ext === "htm") return "html";
  if (ext === "docx" || ext === "pptx" || ext === "xlsx") return ext;
  throw new WorkError(400, "구조 편집은 HTML·DOCX·PPTX·XLSX 문서만 지원합니다");
}

async function entryOf(store: DocStore) {
  const st = await workState(store);
  const file = st.manifest.files.find((f) => f.path === st.manifest.entry);
  if (!file) throw new WorkError(404, "대표 파일이 없습니다");
  return { st, kind: structKind(st.manifest.entry), data: await store.getBlob(file.sha256) };
}

/** 편집 화면용 목록: HTML은 블록(표·그림 포함)과 속성 패널 견본(글꼴·색 토큰), 오피스는 표·그림·시트 */
export async function readStructure(store: DocStore) {
  const { st, kind, data } = await entryOf(store);
  const common = { baseVersion: st.baseVersion, rev: st.rev, entry: st.manifest.entry, kind };
  if (kind === "html") { const html = dec.decode(data); return { ...common, blocks: outline(html), theme: docTheme(html) }; }
  return { ...common, ...ooxmlStructure(kind, data) };
}

/** HTML 구조 편집 화면용 사본(data-eid + <base>). baseHref(작업본 폴더 이름, 대표 파일 폴더)는 런타임이 주소를 만든다 */
export async function structEditView(store: DocStore, baseHref: (folder: string, dir: string) => string | Promise<string>) {
  const { st, kind, data } = await entryOf(store);
  if (kind !== "html") throw new WorkError(400, "HTML 문서만 그 자리 구조 편집을 지원합니다");
  const entry = st.manifest.entry;
  const dir = entry.includes("/") ? entry.slice(0, entry.lastIndexOf("/") + 1) : "";
  return { rev: st.rev, body: markEids(dec.decode(data), await baseHref(st.fromRevision ? `r${st.rev}` : st.baseVersion, dir)) };
}

export const ASSET_EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif", "image/svg+xml": "svg" };
export const MAX_ASSET = 10 * 1024 * 1024;

/**
 * 올릴 그림 자산 검사(Worker·로컬 공통). 래스터는 머리에서 크기를 읽고, SVG(6.0 V4)는 저장 전에 소독한 결과를 저장한다(원본은 남기지 않는다).
 * removed는 소독에서 지운 것(화면·MCP 진단), drawio는 draw.io 편집 정보가 있는지.
 */
export function prepareAsset(mime: string, data: Uint8Array): { mime: string; data: Uint8Array; width: number; height: number; removed?: string[]; drawio?: boolean } {
  if (!ASSET_EXT[mime]) throw new WorkError(400, "PNG·JPEG·WebP·GIF·SVG만 올릴 수 있습니다");
  if (data.byteLength > MAX_ASSET) throw new WorkError(413, "10MB 이하만 올릴 수 있습니다");
  if (mime === "image/svg+xml") {
    try {
      const r = sanitizeSvg(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(data));
      return { mime, data: enc.encode(r.svg), ...svgSize(r.svg), removed: r.removed, drawio: r.drawio };
    } catch (e) {
      if (e instanceof SvgError) throw new WorkError(e.status, e.message);
      if (e instanceof TypeError) throw new WorkError(400, "SVG는 UTF-8 글이어야 합니다");
      throw e;
    }
  }
  const size = imageSize(data);
  if (!size) throw new WorkError(400, "이미지 파일을 읽을 수 없습니다");
  return { mime, data, ...size };
}

async function needAsset(assets: AssetLookup, ref: string) {
  const sha = /^asset:([0-9a-f]{64})$/.exec(ref)?.[1];
  const row = sha ? await assets(sha) : null;
  if (!row) throw new WorkError(400, `없는 이미지 자산입니다: ${ref}`);
  return row;
}

/** 연산을 적용해 수정본 하나로 저장한다. 바뀐 것이 없으면 수정본을 만들지 않는다(changed: false) */
export async function applyStructOps(store: DocStore, assets: AssetLookup,
  input: { baseRev: number; ops: StructOp[]; summary?: string; source: "human" | "agent" }): Promise<Saved> {
  if (!Array.isArray(input.ops) || input.ops.length === 0) throw new WorkError(400, "ops가 비어 있습니다");
  if (input.ops.length > MAX_OPS) throw new WorkError(400, `연산은 한 번에 ${MAX_OPS}개까지입니다`);
  const { st, kind, data } = await entryOf(store);
  // 다른 곳에서 먼저 저장했으면 연산을 적용하기 전에 알린다(saveRevision도 다시 확인한다)
  if (input.baseRev !== st.rev) throw conflict(st.rev);
  const entry = st.manifest.entry;
  const link: ManifestFile[] = [];
  let out: Uint8Array;
  try {
    if (kind === "html") {
      const dir = entry.includes("/") ? entry.slice(0, entry.lastIndexOf("/") + 1) : "";
      // 그림 주소 asset:<sha> → 대표 파일 옆 assets/에 넣고 상대 경로로
      const local = async (ref: string) => {
        if (!ref.startsWith("asset:")) return ref;
        const a = await needAsset(assets, ref);
        const rel = `assets/${a.sha256.slice(0, 16)}.${ASSET_EXT[a.mime]}`;
        link.push({ path: dir + rel, sha256: a.sha256, size: a.size, mime: a.mime });
        return rel;
      };
      const ops: HtmlOp[] = [];
      // 인라인 SVG: asset:<sha>(svg 자산)를 그 글로 바꾼다. 글을 바로 준 경우도 html.ts가 다시 소독한다
      const svgText = async (n: { svg?: string; src?: string }) => {
        if (typeof n.svg === "string") return n.svg;
        const a = await needAsset(assets, n.src ?? "");
        if (a.mime !== "image/svg+xml") throw new WorkError(400, "인라인으로 넣을 수 있는 것은 SVG 자산뿐입니다");
        return dec.decode(await store.getBlob(a.sha256));
      };
      for (const op of input.ops as HtmlOp[]) {
        if ((op.t === "insert" || op.t === "place") && op.node?.kind === "svg") ops.push({ ...op, node: { kind: "svg", svg: await svgText(op.node as { svg?: string; src?: string }) } } as HtmlOp);
        else if (op.t === "setAttr" && op.name === "src") ops.push({ ...op, value: await local(op.value) });
        else if (op.t === "insert" && op.node.kind === "image") ops.push({ ...op, node: { ...op.node, src: await local(op.node.src) } });
        else if (op.t === "place" && op.node?.kind === "image") ops.push({ ...op, node: { ...op.node, src: await local(op.node.src) } });
        else ops.push(op);
      }
      out = enc.encode(applyHtmlOps(dec.decode(data), ops));
    } else {
      const ops: OoxmlOp[] = [];
      for (const op of input.ops as StructOp[]) {
        if (op.t === "replaceImage") {
          const a = await needAsset(assets, op.asset);
          if (a.mime === "image/svg+xml") throw new WorkError(400, "오피스 문서 그림은 PNG·JPEG·WebP·GIF로만 바꿀 수 있습니다(SVG는 HTML·슬라이드에 넣으세요)");
          ops.push({ t: "replaceImage", image: op.image, mime: a.mime, data: await store.getBlob(a.sha256) });
        } else ops.push(op as OoxmlOp);
      }
      out = applyOoxmlOps(kind, data, ops);
    }
  } catch (e) {
    if (e instanceof StructEditError) throw new WorkError(e.status, e.message);
    throw e;
  }
  if (out === data) return { rev: st.rev, baseVersion: st.baseVersion, changed: false };
  return saveRevision(store, {
    baseRev: input.baseRev, put: [{ path: entry, data: out }], link, source: input.source,
    summary: input.summary ?? summarize(input.ops),
  });
}

const OP_NAME: Record<string, string> = {
  setText: "글자", setAttr: "속성", setWidth: "너비", insert: "넣기", remove: "지우기", move: "옮기기",
  tableRow: "표 행", tableCol: "표 열", tableCols: "표 열 너비", replaceImage: "그림 교체", colWidth: "열 너비",
  setStyle: "서식", tableRowHeight: "표 행 높이", duplicate: "복제",
  toPinned: "자유 배치", unpin: "흐름으로 되돌림", place: "자유 배치 넣기", svgAttr: "SVG 도형",
};
/** 메모가 없으면 연산 종류로 만든다. 예: "표 행 2, 그림 교체 1" */
function summarize(ops: StructOp[]) {
  const n = new Map<string, number>();
  for (const op of ops) n.set(OP_NAME[op.t] ?? op.t, (n.get(OP_NAME[op.t] ?? op.t) ?? 0) + 1);
  return [...n].map(([k, v]) => `${k} ${v}`).join(", ");
}

// ---------- 슬라이드 덱(5.0 M4, 명세 docs/slide-editor-spec.html 10절) ----------
// 덱은 deck.json + slides/<id>.html. 슬라이드 한 장을 바꾸면 그 파일 blob 하나만 새로 생긴다.
// baseRev가 지금과 다르면 최신 작업본에 연산을 다시 적용해 본다. 대상 요소가 모두 있으면 저장하고, 없으면 409.

async function loadDeck(store: DocStore) {
  const st = await workState(store);
  if (st.manifest.entry !== DECK_ENTRY) throw new WorkError(400, "슬라이드 덱(deck.json) 문서가 아닙니다");
  const files = new Map(st.manifest.files.map((f) => [f.path, f]));
  const text = async (path: string) => {
    const f = files.get(path);
    return f ? dec.decode(await store.getBlob(f.sha256)) : null;
  };
  const { index, diagnostics } = parseDeckIndex((await text(DECK_ENTRY)) ?? "");
  if (!index) throw new WorkError(500, `deck.json을 읽을 수 없습니다: ${diagnostics[0]?.message}`);
  return { st, index, text };
}

/** 덱 작업본: 색인과 슬라이드 HTML 전부, 지금 rev */
export async function readDeck(store: DocStore) {
  const { st, index, text } = await loadDeck(store);
  // 늘 직렬화 형식(eid가 붙은)으로 준다. 가져오기 등으로 eid 없이 들어온 파일도 같은 번호를 받는다(번호는 문서 순서로 정해진다)
  const slides = await Promise.all(index.order.map(async (id) => ({ id, html: serializeSlide(loadSlide((await text(slidePath(id))) ?? "")) })));
  return { baseVersion: st.baseVersion, rev: st.rev, index, slides };
}

const diagError = (e: unknown) =>
  e instanceof SlideError ? new WorkError(e.status, e.diagnostics.length ? `${e.message}\n${formatDiagnostics(e.diagnostics)}` : e.message) : e;

/** 최신 작업본을 읽어 change를 적용하고 저장한다. 그사이 다른 저장이 끼면 다시 읽어 한 번 더(최대 3번) */
async function withLatest<T>(store: DocStore, baseRev: number,
  change: (d: Awaited<ReturnType<typeof loadDeck>>) => Promise<{ put: { path: string; data: Uint8Array }[]; remove?: string[]; summary: string; result: T }>,
  source: "human" | "agent") {
  if (typeof baseRev !== "number") throw new WorkError(400, "baseRev가 필요합니다");
  for (let attempt = 0; ; attempt++) {
    const d = await loadDeck(store);
    let c;
    try { c = await change(d); } catch (e) { throw diagError(e); }
    try {
      const r = await saveRevision(store, { baseRev: d.st.rev, put: c.put, remove: c.remove, source, summary: c.summary });
      return { ...r, rebased: baseRev !== d.st.rev, ...c.result };
    } catch (e) {
      if (!(e instanceof WorkError && e.status === 409) || attempt >= 2) throw e;
    }
  }
}

/** 슬라이드 하나에 연산 적용 → 수정본. 돌려주는 inverse로 화면이 되돌리기를 만든다 */
export async function patchSlide(store: DocStore, sid: string, input: { baseRev: number; ops: SlideOp[]; summary?: string }, source: "human" | "agent") {
  if (!Array.isArray(input.ops) || input.ops.length === 0) throw new WorkError(400, "ops가 비어 있습니다");
  if (input.ops.length > 500) throw new WorkError(400, "연산은 한 번에 500개까지입니다");
  return withLatest(store, input.baseRev, async ({ index, text }) => {
    if (!index.order.includes(sid)) throw new WorkError(404, `슬라이드 ${sid}이(가) 없습니다`);
    const r = applySlideOps(loadSlide((await text(slidePath(sid)))!), input.ops);
    const html = serializeSlide(r.slide);
    return { put: [{ path: slidePath(sid), data: enc.encode(html) }], summary: input.summary ?? `슬라이드 ${sid} 편집`, result: { slide: sid, html, inverse: r.inverse } };
  }, source);
}

/** 슬라이드 통째로 쓰기(에이전트·복제). order에 없으면 index 자리(없으면 끝)에 더한다 */
export async function putSlide(store: DocStore, sid: string, input: { baseRev: number; html: string; index?: number; summary?: string }, source: "human" | "agent") {
  return withLatest(store, input.baseRev, async ({ index }) => {
    const p = parseSlide(input.html ?? "");
    if (!p.slide || p.diagnostics.length) throw new WorkError(400, `슬라이드 형식 오류 ${p.diagnostics.length}건\n${formatDiagnostics(p.diagnostics)}`);
    if (p.slide.id !== sid) throw new WorkError(400, `section id(${p.slide.id})가 슬라이드 id(${sid})와 다릅니다`);
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
export async function patchDeck(store: DocStore, input: { baseRev: number; index: Partial<DeckIndex>; summary?: string }, source: "human" | "agent") {
  return withLatest(store, input.baseRev, async ({ index }) => {
    const next = { ...index, ...input.index, v: 1 };
    const { index: ok, diagnostics } = parseDeckIndex(JSON.stringify(next));
    if (!ok) throw new WorkError(400, `덱 색인 오류\n${formatDiagnostics(diagnostics)}`);
    const unknown = ok.order.filter((id) => !index.order.includes(id));
    if (unknown.length) throw new WorkError(400, `없는 슬라이드: ${unknown.join(", ")} (먼저 슬라이드를 만드세요)`);
    const removed = index.order.filter((id) => !ok.order.includes(id));
    return {
      put: [{ path: DECK_ENTRY, data: enc.encode(JSON.stringify(ok, null, 2) + "\n") }],
      remove: removed.map(slidePath),
      summary: input.summary ?? (removed.length ? `슬라이드 ${removed.join(", ")} 지움` : "덱 색인 고침"),
      result: { index: ok },
    };
  }, source);
}

/**
 * 수정본 파일 저장(put)으로 덱 파일(deck.json·slides/*.html)을 바꿀 때도 업로드와 같은 검사를 한다(5.0 M8 보안 점검).
 * 덱이 아니거나 덱 파일을 건드리지 않으면 아무것도 하지 않는다
 */
export async function checkDeckPut(store: DocStore, put: { path: string; data: Uint8Array }[]) {
  if (!put.some((f) => f.path === DECK_ENTRY || /^slides\/[^/]+\.html$/.test(f.path))) return;
  const st = await workState(store);
  if (st.manifest.entry !== DECK_ENTRY) return;
  const files = new Map<string, string>();
  for (const f of st.manifest.files) {
    if (f.path === DECK_ENTRY || /^slides\/[^/]+\.html$/.test(f.path)) files.set(f.path, dec.decode(await store.getBlob(f.sha256)));
  }
  for (const f of put) files.set(f.path, dec.decode(f.data));
  const r = checkDeck(files);
  if (r.diagnostics.length) throw new WorkError(400, `덱 형식 오류 ${r.diagnostics.length}건\n${formatDiagnostics(r.diagnostics)}`);
}

/** 덱 슬라이드가 가리키는 그림 자산 sha 목록(로컬 버전 저장 때 버전 폴더 assets/로 복사한다) */
export function deckAssetShas(slides: string[]): string[] {
  const out = new Set<string>();
  for (const html of slides) for (const m of html.matchAll(/asset:([0-9a-f]{64})/g)) out.add(m[1]);
  return [...out];
}
