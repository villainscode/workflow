import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, extname, join, normalize, relative, isAbsolute } from "node:path";
import { unzipSync } from "fflate";
import { loadSite, type MenuNode } from "./sitefiles.ts";
import { adapterFor, EditError, type Change } from "./textedit/index.ts";
import { wrapForEdit } from "./textedit/html.ts";
import { wrapSvgForEdit } from "./textedit/svg.ts";
import { Document, parseDocument, YAMLSeq } from "yaml";

/** docs/에 파일과 yaml을 쓰는 작업. 원본(파일)을 먼저 쓰고, 색인은 호출한 쪽에서 다시 만든다. */

export class StoreError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export interface IncomingFile { path: string; data: Uint8Array }

export interface UploadInput {
  menu: string;
  doc?: string;          // 기존 문서 slug. 없으면 새 문서
  title?: string;        // 새 문서 제목
  slug?: string;         // 새 문서 slug (없으면 파일 이름에서 만든다)
  version?: string;      // 없으면 다음 버전을 자동으로 정한다
  note?: string;
  entry?: string;        // 대표 파일. 없으면 자동 선택
  source?: "upload" | "edit" | "text-edit";
  /** 외부에서 가져온 문서의 출처 주소(예: claude.ai 아티팩트). meta.yaml의 origin_url에 남긴다 */
  origin?: string;
  files: IncomingFile[];
}

const VERSION_RE = /^v(\d+)\.(\d+)$/;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const KIND: Record<string, string> = {
  html: "html", htm: "html", svg: "image", png: "image", jpg: "image", jpeg: "image", gif: "image", webp: "image",
  pdf: "pdf", pptx: "pptx", docx: "docx", xlsx: "xlsx", csv: "xlsx", md: "markdown", drawio: "drawio",
};

export const slugify = (s: string) =>
  s.toLowerCase().replace(/\.[a-z0-9]+$/, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "doc";

/** 다음 버전 번호. 처음 만들 때는 v0.0(화면에서는 draft), 그 뒤 수정마다 v0.1, v0.2 … */
export function nextVersion(versions: string[]): string {
  const nums = versions.map((v) => VERSION_RE.exec(v)).filter(Boolean).map((m) => [Number(m![1]), Number(m![2])]);
  if (nums.length === 0) return "v0.0";
  nums.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const [major, minor] = nums[nums.length - 1];
  return `v${major}.${minor + 1}`;
}

/** 업로드 경로를 정리한다. 상위 폴더로 나가거나 숨김 파일이면 거부한다. */
function safeRelPath(p: string): string | null {
  const n = normalize(p.replace(/\\/g, "/")).replace(/^\/+/, "");
  if (!n || isAbsolute(n) || n.startsWith("..") || n.split("/").some((seg) => seg.startsWith("."))) return null;
  return n;
}

/** zip 하나만 올리면 풀어서 쓴다. 폴더째 올리면 공통 최상위 폴더 이름은 뗀다. */
function normalizeFiles(files: IncomingFile[]): IncomingFile[] {
  let list = files;
  if (list.length === 1 && extname(list[0].path).toLowerCase() === ".zip") {
    const entries = unzipSync(list[0].data);
    list = Object.entries(entries).filter(([p]) => !p.endsWith("/") && !p.startsWith("__MACOSX/"))
      .map(([path, data]) => ({ path, data }));
  }
  const cleaned = list.flatMap((f) => {
    const p = safeRelPath(f.path);
    return p ? [{ path: p, data: f.data }] : [];
  });
  const tops = new Set(cleaned.map((f) => (f.path.includes("/") ? f.path.split("/")[0] : "")));
  if (tops.size === 1 && !tops.has("")) {
    const top = [...tops][0] + "/";
    return cleaned.map((f) => ({ ...f, path: f.path.slice(top.length) }));
  }
  return cleaned;
}

function pickEntry(files: IncomingFile[], wanted?: string): string {
  if (wanted) {
    if (!files.some((f) => f.path === wanted)) throw new StoreError(400, `대표 파일 ${wanted}이(가) 업로드 목록에 없습니다`);
    return wanted;
  }
  const byDepth = [...files].sort((a, b) => a.path.split("/").length - b.path.split("/").length);
  return (byDepth.find((f) => /(^|\/)index\.html?$/i.test(f.path)) ?? byDepth.find((f) => /\.html?$/i.test(f.path)) ?? byDepth[0]).path;
}

const sha = (d: Uint8Array) => createHash("sha256").update(d).digest("hex");

function listFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.name.startsWith(".")) return [];
    const p = join(dir, e.name);
    return e.isDirectory() ? listFiles(p).map((c) => join(e.name, c)) : [e.name];
  });
}

/** 메뉴가 속한 대분류 key */
function findMenuCategory(docsRoot: string, menu: string): string | null {
  const has = (list: MenuNode[] | undefined): boolean => (list ?? []).some((m) => m.slug === menu || has(m.menus));
  return loadSite(docsRoot).categories.find((c) => has(c.menus))?.key ?? null;
}

export function upload(docsRoot: string, input: UploadInput) {
  const category = findMenuCategory(docsRoot, input.menu);
  if (!category) throw new StoreError(400, `메뉴 ${input.menu}이(가) menus.yaml에 없습니다`);

  const files = normalizeFiles(input.files);
  if (files.length === 0) throw new StoreError(400, "올릴 파일이 없습니다");
  const entry = pickEntry(files, input.entry);

  // 대상 문서 정하기
  let docSlug: string;
  let isNew = false;
  if (input.doc) {
    docSlug = input.doc;
    if (!existsSync(join(docsRoot, input.menu, docSlug, "meta.yaml"))) throw new StoreError(404, `문서 ${input.menu}/${docSlug}이(가) 없습니다`);
  } else {
    if (!input.title?.trim()) throw new StoreError(400, "새 문서에는 제목이 필요합니다");
    const base = input.slug?.trim() || slugify(entry.split("/").pop()!);
    if (!SLUG_RE.test(base)) throw new StoreError(400, `slug는 영문 소문자, 숫자, 하이픈만 쓸 수 있습니다: ${base}`);
    docSlug = base;
    for (let i = 2; existsSync(join(docsRoot, input.menu, docSlug)); i++) docSlug = `${base}-${i}`;
    isNew = true;
  }
  const docDir = join(docsRoot, input.menu, docSlug);
  const metaPath = join(docDir, "meta.yaml");
  let meta: Document = isNew ? new Document({}) : parseDocument(readFileSync(metaPath, "utf8"));
  const existing = isNew ? [] : ((meta.toJS().versions ?? []) as { version: string; entry: string }[]);

  // 버전 정하기와 중복 확인
  const version = input.version?.trim() || nextVersion(existing.map((v) => v.version));
  if (!VERSION_RE.test(version)) throw new StoreError(400, `버전은 v<숫자>.<숫자> 형식이어야 합니다: ${version}`);
  if (existing.some((v) => v.version === version) || existsSync(join(docDir, version))) {
    throw new StoreError(409, `${version} 버전이 이미 있습니다`);
  }
  if (!isNew) {
    const current = meta.get("current") as string;
    const curDir = join(docDir, current);
    if (existsSync(curDir)) {
      const curFiles = listFiles(curDir);
      const same = curFiles.length === files.length && files.every((f) =>
        curFiles.includes(f.path) && sha(readFileSync(join(curDir, f.path))) === sha(f.data));
      if (same) throw new StoreError(409, `직전 버전(${current})과 내용이 같아 새 버전을 만들지 않았습니다`);
    }
  }

  // 1) 파일 쓰기
  for (const f of files) {
    const target = join(docDir, version, f.path);
    if (relative(join(docDir, version), target).startsWith("..")) throw new StoreError(400, `잘못된 경로: ${f.path}`);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, f.data);
  }

  // 2) meta.yaml 쓰기 (기존 주석과 순서는 유지)
  const versionEntry = {
    version, entry, note: input.note?.trim() || null, source: input.source ?? "upload", created: new Date().toISOString().slice(0, 10),
  };
  if (isNew) {
    const ext = extname(entry).slice(1).toLowerCase();
    meta = new Document({
      title: input.title!.trim(), category, menu: input.menu, kind: KIND[ext] ?? "code", status: "draft",
      current: version, versions: [versionEntry], notion_url: null, gdrive_url: null,
      ...(input.origin ? { origin_url: input.origin } : {}),
    });
  } else {
    const seq = meta.get("versions") as YAMLSeq;
    seq.add(meta.createNode(versionEntry));
    meta.set("current", version);
    if (input.origin) meta.set("origin_url", input.origin);
  }
  mkdirSync(docDir, { recursive: true });
  writeFileSync(metaPath, meta.toString({ lineWidth: 0, nullStr: "" }));

  return { menu: input.menu, doc: docSlug, version, category, created: isNew };
}

/**
 * 사이트에서 편집한 Markdown 저장. 기준 버전의 파일을 그대로 가져오고 대표 파일 내용만 바꿔 새 버전으로 쓴다.
 * 그사이 다른 곳에서 새 버전이 생겼으면 덮어쓰지 않도록 거부한다.
 */
export function saveEdit(docsRoot: string, menu: string, doc: string,
  input: { baseVersion: string; content: string; note?: string; version?: string }) {
  const docDir = join(docsRoot, menu, doc);
  const metaPath = join(docDir, "meta.yaml");
  if (!existsSync(metaPath)) throw new StoreError(404, `문서 ${menu}/${doc}이(가) 없습니다`);
  const meta = parseDocument(readFileSync(metaPath, "utf8")).toJS() as { current: string; versions: { version: string; entry: string }[] };
  if (meta.current !== input.baseVersion) {
    throw new StoreError(409, `편집하는 동안 새 버전(${meta.current})이 생겼습니다. 새로고침해서 최신 내용을 확인하세요`);
  }
  const base = meta.versions.find((v) => v.version === input.baseVersion);
  if (!base) throw new StoreError(404, `${input.baseVersion} 버전이 없습니다`);
  if (!/\.md$/i.test(base.entry)) throw new StoreError(400, "Markdown 문서만 사이트에서 편집할 수 있습니다");

  const baseDir = join(docDir, input.baseVersion);
  const files: IncomingFile[] = listFiles(baseDir).map((p) => ({
    path: p, data: p === base.entry ? new TextEncoder().encode(input.content) : readFileSync(join(baseDir, p)),
  }));
  return upload(docsRoot, { menu, doc, entry: base.entry, note: input.note, version: input.version, source: "edit", files });
}

/** 다음 정식 버전 번호: 가장 높은 major + 1 (v0.x → v1.0, v1.2 → v2.0) */
export function nextMajor(versions: string[]): string {
  const majors = versions.map((v) => VERSION_RE.exec(v)).filter((m) => m !== null).map((m) => Number(m[1]));
  return `v${(majors.length ? Math.max(...majors) : 0) + 1}.0`;
}

/**
 * draft(또는 review) 문서를 정식 버전으로 확정한다. 현재 버전 폴더를 새 정식 버전(v1.0 등)으로 복사하고
 * meta.yaml에 버전을 추가한 뒤 current와 status(approved)를 바꾼다. 기존 버전 폴더는 건드리지 않는다.
 */
export function release(docsRoot: string, menu: string, doc: string, note?: string) {
  const docDir = join(docsRoot, menu, doc);
  const metaPath = join(docDir, "meta.yaml");
  if (!existsSync(metaPath)) throw new StoreError(404, `문서 ${menu}/${doc}이(가) 없습니다`);
  const meta = parseDocument(readFileSync(metaPath, "utf8"));
  const js = meta.toJS() as { current: string; status?: string; versions: { version: string; entry: string }[] };
  if (js.status === "approved") throw new StoreError(409, "이미 정식 버전입니다");
  const base = js.versions.find((v) => v.version === js.current);
  if (!base || !existsSync(join(docDir, js.current))) throw new StoreError(404, `현재 버전(${js.current}) 폴더가 없습니다`);

  const version = nextMajor(js.versions.map((v) => v.version));
  if (existsSync(join(docDir, version))) throw new StoreError(409, `${version} 폴더가 이미 있습니다`);
  cpSync(join(docDir, js.current), join(docDir, version), { recursive: true });

  (meta.get("versions") as YAMLSeq).add(meta.createNode({
    version, entry: base.entry, note: note?.trim() || `${js.current === "v0.0" ? "draft" : js.current} 버전을 정식 버전으로 확정`, source: "release",
    created: new Date().toISOString().slice(0, 10),
  }));
  meta.set("current", version);
  meta.set("status", "approved");
  writeFileSync(metaPath, meta.toString({ lineWidth: 0, nullStr: "" }));
  return { menu, doc, from: js.current, version };
}

// ---------- 텍스트 편집(2.0): HTML·DOCX·PPTX의 태그 안 글자만 고친다 ----------

function versionEntry(docsRoot: string, menu: string, doc: string, version?: string) {
  const docDir = join(docsRoot, menu, doc);
  const metaPath = join(docDir, "meta.yaml");
  if (!existsSync(metaPath)) throw new StoreError(404, `문서 ${menu}/${doc}이(가) 없습니다`);
  const meta = parseDocument(readFileSync(metaPath, "utf8")).toJS() as { current: string; versions: { version: string; entry: string }[] };
  const v = version || meta.current;
  const found = meta.versions.find((x) => x.version === v);
  if (!found) throw new StoreError(404, `${v} 버전이 없습니다`);
  return { docDir, current: meta.current, version: v, entry: found.entry, path: join(docDir, v, found.entry) };
}

/** HTML·SVG 편집 화면용 사본(조각마다 data-seg로 감싼 문서). SVG는 XML 그대로 돌려준다 */
export function htmlEditView(docsRoot: string, menu: string, doc: string, version?: string): { type: "html" | "svg"; body: string } {
  const v = versionEntry(docsRoot, menu, doc, version);
  const format = adapterFor(v.entry)?.format;
  if (format === "svg") return { type: "svg", body: wrapSvgForEdit(readFileSync(v.path)) };
  if (format !== "html") throw new StoreError(400, "HTML·SVG 문서만 그 자리 편집을 지원합니다");
  const dir = v.entry.includes("/") ? v.entry.slice(0, v.entry.lastIndexOf("/") + 1) : "";
  return { type: "html", body: wrapForEdit(readFileSync(v.path), `/files/${menu}/${doc}/${v.version}/${dir}`) };
}

/** 대표 파일의 텍스트 조각 목록. 지원하지 않는 형식이면 400 */
export function readSegments(docsRoot: string, menu: string, doc: string, version?: string) {
  const v = versionEntry(docsRoot, menu, doc, version);
  const a = adapterFor(v.entry);
  if (!a) throw new StoreError(400, `${extname(v.entry)} 파일은 텍스트 편집을 지원하지 않습니다 (HTML·SVG·DOCX·PPTX·XLSX)`);
  return { format: a.format, version: v.version, entry: v.entry, segments: a.adapter.extract(readFileSync(v.path)) };
}

/** 저장하지 않고 바뀐 조각을 반영한 대표 파일을 돌려준다(DOCX·PPTX 편집기의 미리보기용) */
export function previewTextEdit(docsRoot: string, menu: string, doc: string, input: { baseVersion: string; changes: Change[] }) {
  const v = versionEntry(docsRoot, menu, doc, input.baseVersion);
  const a = adapterFor(v.entry);
  if (!a) throw new StoreError(400, `${extname(v.entry)} 파일은 텍스트 편집을 지원하지 않습니다`);
  try {
    return { format: a.format, entry: v.entry, data: a.adapter.apply(readFileSync(v.path), input.changes ?? []).data };
  } catch (e) {
    if (e instanceof EditError) throw new StoreError(e.status, e.message);
    throw e;
  }
}

/**
 * 바뀐 텍스트 조각만 원본에 반영해 새 버전(source: text-edit)으로 저장한다.
 * 기준 버전이 최신이 아니거나 조각의 원래 글자가 달라졌으면 거부한다. 대표 파일 말고는 그대로 복사한다.
 */
export function saveTextEdit(docsRoot: string, menu: string, doc: string,
  input: { baseVersion: string; changes: Change[]; note?: string }) {
  const v = versionEntry(docsRoot, menu, doc, input.baseVersion);
  if (v.current !== input.baseVersion) {
    throw new StoreError(409, `편집하는 동안 새 버전(${v.current})이 생겼습니다. 새로고침해서 최신 내용을 확인하세요`);
  }
  const a = adapterFor(v.entry);
  if (!a) throw new StoreError(400, `${extname(v.entry)} 파일은 텍스트 편집을 지원하지 않습니다`);
  let result: { data: Uint8Array; changed: number; warnings?: string[] };
  try {
    result = a.adapter.apply(readFileSync(v.path), input.changes ?? []);
  } catch (e) {
    if (e instanceof EditError) throw new StoreError(e.status, e.message);
    throw e;
  }
  if (result.changed === 0) throw new StoreError(409, "바뀐 텍스트가 없습니다");

  const baseDir = join(v.docDir, input.baseVersion);
  const files: IncomingFile[] = listFiles(baseDir).map((p) => ({
    path: p, data: p === v.entry ? result.data : readFileSync(join(baseDir, p)),
  }));
  return { ...upload(docsRoot, { menu, doc, entry: v.entry, note: input.note, source: "text-edit", files }), changed: result.changed, warnings: result.warnings ?? [] };
}
