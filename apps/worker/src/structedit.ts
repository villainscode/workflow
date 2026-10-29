import { applyOps, markEids, outline, type HtmlOp } from "@workflow/core/structedit/html";
import { applyOoxmlOps, ooxmlStructure, type OoxmlKind, type OoxmlOp } from "@workflow/core/structedit/ooxml";
import { assetRow } from "./assets.ts";
import { getBlob } from "./blobs.ts";
import { HttpError, type Bindings, type User, type Workspace } from "./env.ts";
import { findDoc } from "./repo.ts";
import { saveRevision, workState, type ManifestFile } from "./revisions.ts";

/**
 * 구조 편집(5.0 M3·M5). 작업본 대표 파일에 연산(ops)을 적용해 수정본으로 저장한다. 편집 화면과 에이전트(MCP)가 같은 길을 쓴다.
 * - HTML: 원본 패치(packages/core/src/structedit/html.ts). 그림 주소에 `asset:<sha>`를 주면 그 자산을 대표 파일 옆 `assets/`에 넣고 상대 경로로 바꾼다.
 * - DOCX·PPTX·XLSX: OOXML 직접 편집(D-47 C, structedit/ooxml.ts). 그림 교체는 `{ t: "replaceImage", image, asset: "asset:<sha>" }`.
 */

type Kind = "html" | OoxmlKind;
export type StructOp = HtmlOp | Exclude<OoxmlOp, { t: "replaceImage" }> | { t: "replaceImage"; image: string; asset: string };

function kindOf(entry: string): Kind {
  const ext = entry.slice(entry.lastIndexOf(".") + 1).toLowerCase();
  if (ext === "html" || ext === "htm") return "html";
  if (ext === "docx" || ext === "pptx" || ext === "xlsx") return ext;
  throw new HttpError(400, "구조 편집은 HTML·DOCX·PPTX·XLSX 문서만 지원합니다");
}

async function entryOf(env: Bindings, ws: Workspace, menu: string, docSlug: string) {
  const doc = await findDoc(env.DB, ws.id, menu, docSlug);
  const st = await workState(env, ws, doc);
  const file = st.manifest.files.find((f) => f.path === st.manifest.entry);
  if (!file) throw new HttpError(404, "대표 파일이 없습니다");
  return { doc, st, kind: kindOf(st.manifest.entry), data: await getBlob(env.BLOBS, ws.id, file.sha256) };
}

/** 편집 화면용 목록: HTML은 블록(표·그림 포함), 오피스는 표·그림·시트 */
export async function readStructure(env: Bindings, ws: Workspace, menu: string, docSlug: string) {
  const { st, kind, data } = await entryOf(env, ws, menu, docSlug);
  const common = { baseVersion: st.baseVersion, rev: st.rev, entry: st.manifest.entry, kind };
  if (kind === "html") return { ...common, blocks: outline(new TextDecoder().decode(data)) };
  return { ...common, ...ooxmlStructure(kind, data) };
}

/** HTML 구조 편집 화면용 사본(data-eid + <base>). baseHref는 작업본 폴더 안 대표 파일 폴더의 콘텐츠 주소 */
export async function structEditView(env: Bindings, ws: Workspace, menu: string, docSlug: string,
  baseHref: (doc: Awaited<ReturnType<typeof findDoc>>, folder: string, dir: string) => Promise<string>) {
  const { doc, st, kind, data } = await entryOf(env, ws, menu, docSlug);
  if (kind !== "html") throw new HttpError(400, "HTML 문서만 그 자리 구조 편집을 지원합니다");
  const entry = st.manifest.entry;
  const dir = entry.includes("/") ? entry.slice(0, entry.lastIndexOf("/") + 1) : "";
  return { rev: st.rev, body: markEids(new TextDecoder().decode(data), await baseHref(doc, st.fromRevision ? `r${st.rev}` : st.baseVersion, dir)) };
}

const ASSET_EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };

async function asset(env: Bindings, ws: Workspace, ref: string) {
  const sha = /^asset:([0-9a-f]{64})$/.exec(ref)?.[1];
  const row = sha ? await assetRow(env.DB, ws.id, sha) : null;
  if (!row) throw new HttpError(400, `없는 이미지 자산입니다: ${ref}`);
  return row;
}

/** 연산을 적용해 수정본 하나로 저장한다. 바뀐 것이 없으면 수정본을 만들지 않는다(changed: false) */
export async function applyStructOps(env: Bindings, ws: Workspace, user: User | null, menu: string, docSlug: string,
  input: { baseRev: number; ops: StructOp[]; summary?: string; source: "human" | "agent" }) {
  if (!Array.isArray(input.ops) || input.ops.length === 0) throw new HttpError(400, "ops가 비어 있습니다");
  const { st, kind, data } = await entryOf(env, ws, menu, docSlug);
  // 다른 곳에서 먼저 저장했으면 연산을 적용하기 전에 알린다(saveRevision도 다시 확인한다)
  if (input.baseRev !== st.rev) throw new HttpError(409, `다른 곳에서 먼저 저장했습니다(지금 수정본 ${st.rev}). 최신 내용을 받아 다시 적용하세요`);
  const entry = st.manifest.entry;
  const link: ManifestFile[] = [];
  let out: Uint8Array;

  if (kind === "html") {
    const dir = entry.includes("/") ? entry.slice(0, entry.lastIndexOf("/") + 1) : "";
    const local = async (ref: string) => {
      if (!ref.startsWith("asset:")) return ref;
      const a = await asset(env, ws, ref);
      const rel = `assets/${a.sha256.slice(0, 16)}.${ASSET_EXT[a.mime]}`;
      link.push({ path: dir + rel, sha256: a.sha256, size: a.size, mime: a.mime });
      return rel;
    };
    const ops: HtmlOp[] = [];
    for (const op of input.ops as HtmlOp[]) {
      if (op.t === "setAttr" && op.name === "src") ops.push({ ...op, value: await local(op.value) });
      else if (op.t === "insert" && op.node.kind === "image") ops.push({ ...op, node: { ...op.node, src: await local(op.node.src) } });
      else ops.push(op);
    }
    out = new TextEncoder().encode(applyOps(new TextDecoder().decode(data), ops));
  } else {
    const ops: OoxmlOp[] = [];
    for (const op of input.ops as StructOp[]) {
      if (op.t === "replaceImage") {
        const a = await asset(env, ws, op.asset);
        ops.push({ t: "replaceImage", image: op.image, mime: a.mime, data: await getBlob(env.BLOBS, ws.id, a.sha256) });
      } else ops.push(op as OoxmlOp);
    }
    out = applyOoxmlOps(kind, data, ops);
  }
  if (out === data) return { rev: st.rev, baseVersion: st.baseVersion, changed: false, menu, doc: docSlug };
  return saveRevision(env, ws, user, menu, docSlug, {
    baseRev: input.baseRev, put: [{ path: entry, data: out }], link, source: input.source,
    summary: input.summary ?? summarize(input.ops),
  });
}

const OP_NAME: Record<string, string> = {
  setText: "글자", setAttr: "속성", setWidth: "너비", insert: "넣기", remove: "지우기", move: "옮기기",
  tableRow: "표 행", tableCol: "표 열", tableCols: "표 열 너비", replaceImage: "그림 교체", colWidth: "열 너비",
};
/** 메모가 없으면 연산 종류로 만든다. 예: "표 행 2, 그림 교체 1" */
function summarize(ops: StructOp[]) {
  const n = new Map<string, number>();
  for (const op of ops) n.set(OP_NAME[op.t] ?? op.t, (n.get(OP_NAME[op.t] ?? op.t) ?? 0) + 1);
  return [...n].map(([k, v]) => `${k} ${v}`).join(", ");
}
