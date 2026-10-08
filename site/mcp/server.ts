import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

/**
 * workflow-docs MCP 서버(3.0, REQUIREMENT-3.0 3.1). Claude Code가 업무 문서 사이트를 직접 다루게 한다.
 * 사이트 서버(`cd site && npm run dev`)의 REST API를 부르므로 저장 규칙·충돌 검사·실시간 반영이 화면 편집과 같다.
 * 휴지통·영구 삭제·메뉴 삭제 도구는 두지 않는다(D-24). 모든 요청에 X-Workflow-Agent: claude-code를 붙여 화면이 Claude의 변경을 알린다(3.4). 쓰기 도구는 변경 메모 앞에 "Claude Code:"를 붙인다(D-26).
 * stdout은 MCP 통신에 쓰이므로 로그는 stderr로만 남긴다.
 */

const API = (process.env.WORKFLOW_API ?? "http://127.0.0.1:5174").replace(/\/$/, "");
const WEB = (process.env.WORKFLOW_WEB ?? "http://localhost:5173").replace(/\/$/, "");
// 상대 경로 파일은 리포 루트(Claude Code가 이 서버를 띄우는 위치) 기준으로 읽는다
const ROOT = process.env.WORKFLOW_ROOT ?? process.cwd();

// ---------- 사이트 API ----------

interface DocSummary { slug: string; menuSlug: string; title: string; kind: string; status: string; currentVersion: string }
interface MenuNode { slug: string; name: string; documents: DocSummary[]; menus: MenuNode[] }
interface Category { key: string; name: string; menus: MenuNode[] }
interface Tree { categories: Category[]; warnings: string[] }
interface DocVersion { version: string; note: string | null; source: string | null; createdAt: string | null; files: { path: string; isEntry: boolean; size: number }[] }
interface DocDetail {
  menuSlug: string; slug: string; title: string; kind: string; type: string | null; status: string; currentVersion: string;
  notionUrl: string | null; gdriveUrl: string | null; originUrl: string | null; versions: DocVersion[];
}
interface Segment { id: number; text: string; hash: string; multiline: boolean; group: string; svg?: boolean; fmt?: string }

class ToolError extends Error {}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    // 사이트가 Claude Code의 변경을 알아보고 열린 화면에 알리도록 표시한다(3.4)
    res = await fetch(API + path, { ...init, headers: { ...(init?.headers as Record<string, string> | undefined), "x-workflow-agent": "claude-code" } });
  } catch {
    throw new ToolError(`사이트 서버(${API})에 연결할 수 없습니다. 리포에서 \`cd site && npm run dev\`로 먼저 실행하세요.`);
  }
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new ToolError(body.error ?? `${res.status} ${path}`);
  return body;
}

const json = (body: unknown): RequestInit => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const withPrefix = (note: string | undefined, fallback: string) => `Claude Code: ${note?.trim() || fallback}`;
const versionLabel = (v: string) => (v === "v0.0" ? "draft" : v);
const docUrl = (category: string, menu: string, doc: string, version?: string, seg?: string) => {
  const q = new URLSearchParams();
  if (version) q.set("v", version);
  if (seg) q.set("seg", seg);
  return `${WEB}/${category}/${menu}/${doc}${q.size ? `?${q}` : ""}`;
};

// ---------- 메뉴·문서 찾기 ----------

function flatMenus(tree: Tree) {
  const out: { category: Category; menu: MenuNode; path: string[] }[] = [];
  const walk = (c: Category, list: MenuNode[], path: string[]) => list.forEach((m) => {
    out.push({ category: c, menu: m, path: [...path, m.name] });
    walk(c, m.menus, [...path, m.name]);
  });
  tree.categories.forEach((c) => walk(c, c.menus, []));
  return out;
}

function findMenu(tree: Tree, key: string) {
  const k = key.trim().toLowerCase();
  const all = flatMenus(tree);
  const hit = all.filter((x) => x.menu.slug === key.trim()) .concat(all.filter((x) => x.menu.name.toLowerCase() === k));
  if (hit.length === 0) throw new ToolError(`메뉴 "${key}"을(를) 찾을 수 없습니다. list_documents로 메뉴 slug를 확인하세요.`);
  return hit[0];
}

interface Ref { category: string; menu: string; doc: string; version?: string; seg?: string }

/**
 * 문서 지정 방식: 사이트 주소(…/sdlc/menu/doc?v=v1.0&seg=12 또는 12-20), "대분류/메뉴/문서", "메뉴/문서",
 * "SDLC > 메뉴 이름 > 문서 제목", 문서 제목.
 */
async function resolveRef(ref: string): Promise<Ref> {
  const tree = await api<Tree>("/api/tree");
  const all = flatMenus(tree).flatMap((m) => m.menu.documents.map((d) => ({ ...m, doc: d })));
  const pick = (cands: typeof all, why: string) => {
    if (cands.length === 1) return { category: cands[0].category.key, menu: cands[0].menu.slug, doc: cands[0].doc.slug };
    if (cands.length === 0) throw new ToolError(`문서를 찾을 수 없습니다: ${why}. find_documents로 검색하세요.`);
    throw new ToolError(`문서가 여러 개 맞습니다(${why}). 주소나 "대분류/메뉴/문서"로 정확히 지정하세요:\n` +
      cands.slice(0, 10).map((c) => `- ${c.category.key}/${c.menu.slug}/${c.doc.slug} (${c.doc.title})`).join("\n"));
  };

  const s = ref.trim();
  if (/^https?:\/\//.test(s)) {
    const u = new URL(s);
    const [category, menu, doc] = u.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    if (!doc) throw new ToolError(`문서 주소가 아닙니다: ${s} (예: ${WEB}/sdlc/메뉴/문서)`);
    return { category, menu, doc, version: u.searchParams.get("v") ?? undefined, seg: u.searchParams.get("seg") ?? u.hash.match(/seg=([\d,-]+)/)?.[1] };
  }
  if (/^[a-z0-9-]+(\/[a-z0-9-]+){1,2}$/.test(s)) {
    const parts = s.split("/");
    const [menu, doc] = parts.slice(-2);
    return pick(all.filter((x) => x.menu.slug === menu && x.doc.slug === doc && (parts.length === 2 || x.category.key === parts[0])), s);
  }
  if (s.includes(">")) {
    const parts = s.split(">").map((p) => p.trim().toLowerCase());
    const title = parts[parts.length - 1];
    return pick(all.filter((x) => x.doc.title.toLowerCase() === title &&
      parts.slice(0, -1).every((p) => p === x.category.name.toLowerCase() || p === x.category.key || x.path.some((n) => n.toLowerCase() === p))), s);
  }
  const exact = all.filter((x) => x.doc.title === s);
  return pick(exact.length ? exact : all.filter((x) => x.doc.title.toLowerCase().includes(s.toLowerCase())), s);
}

const loadDoc = (r: Ref) => api<DocDetail>(`/api/docs/${r.menu}/${r.doc}`);
const loadSegments = (r: Ref, version: string) =>
  api<{ format: string; version: string; entry: string; segments: Segment[] }>(`/api/docs/${r.menu}/${r.doc}/segments?v=${encodeURIComponent(version)}`);

/** 조각 지정 `12`, `12-15`, 목록 `3,10-12`를 id 집합으로(사이트 web/src/lib/seg.ts의 parseSeg와 같은 규칙) */
function parseSeg(seg?: string): Set<number> | null {
  if (!seg) return null;
  const out = new Set<number>();
  for (const part of seg.split(",")) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part.trim());
    if (!m) continue;
    const a = Number(m[1]), b = Number(m[2] ?? m[1]);
    for (let i = Math.min(a, b); i <= Math.max(a, b) && i - Math.min(a, b) < 5000; i++) out.add(i);
  }
  return out.size ? out : null;
}

/** 파일·폴더 경로를 업로드 목록으로 펼친다. 폴더는 폴더 이름부터의 상대 경로를 유지한다. filename은 파일 1개일 때 저장 이름 */
function collectFiles(paths: string[], filename?: string): { path: string; data: Buffer }[] {
  const out: { path: string; data: Buffer }[] = [];
  for (const p of paths) {
    const abs = isAbsolute(p) ? p : resolve(ROOT, p);
    let st;
    try { st = statSync(abs); } catch { throw new ToolError(`파일을 찾을 수 없습니다: ${p}`); }
    if (st.isDirectory()) {
      const walk = (dir: string): void => readdirSync(dir, { withFileTypes: true }).forEach((e) => {
        if (e.name.startsWith(".")) return;
        const f = join(dir, e.name);
        if (e.isDirectory()) walk(f); else out.push({ path: join(basename(abs), relative(abs, f)), data: readFileSync(f) });
      });
      walk(abs);
    } else out.push({ path: basename(abs), data: readFileSync(abs) });
  }
  if (out.length === 0) throw new ToolError("올릴 파일이 없습니다");
  if (filename) {
    if (out.length !== 1) throw new ToolError("filename은 파일 1개를 올릴 때만 쓸 수 있습니다");
    if (!/^[^/\\]+\.[a-z0-9]+$/i.test(filename)) throw new ToolError(`파일 이름에 확장자가 필요하고 폴더 구분자는 쓸 수 없습니다: ${filename}`);
    out[0].path = filename;
  }
  return out;
}

async function uploadFiles(fields: Record<string, string | undefined>, files: { path: string; data: Buffer }[]) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) if (v) form.append(k, v);
  form.append("paths", JSON.stringify(files.map((f) => f.path)));
  for (const f of files) form.append("files", new Blob([new Uint8Array(f.data)]), basename(f.path));
  return api<{ menu: string; doc: string; version: string; category: string; created: boolean }>("/api/upload", { method: "POST", body: form });
}

// ---------- 도구 ----------

const server = new McpServer({ name: "workflow-docs", version: "0.1.0" });
const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const safe = <A>(fn: (a: A) => Promise<string>) => async (a: A) => {
  try { return text(await fn(a)); }
  catch (e) { return { ...text(e instanceof ToolError ? e.message : `오류: ${(e as Error).message}`), isError: true }; }
};
const REF = z.string().describe("문서 지정: 사이트 주소(예: http://localhost:5173/sdlc/code-review-automation/review-modes?v=v1.0&seg=12), \"대분류/메뉴/문서\", \"SDLC > 메뉴 > 문서 제목\", 또는 문서 제목");

server.registerTool("list_documents", {
  title: "문서 목록",
  description: "업무 문서 사이트의 대분류 → 메뉴 → 문서 트리를 보여 준다. 각 문서의 주소·현재 버전·상태 포함.",
  inputSchema: { category: z.string().optional().describe("대분류 key 또는 이름으로 좁히기(예: sdlc)") },
  annotations: { readOnlyHint: true },
}, safe(async ({ category }) => {
  const tree = await api<Tree>("/api/tree");
  const cats = tree.categories.filter((c) => !category || c.key === category || c.name.toLowerCase() === category.toLowerCase());
  const lines: string[] = [];
  const walk = (c: Category, list: MenuNode[], depth: number) => list.forEach((m) => {
    lines.push(`${"  ".repeat(depth)}- 메뉴 ${m.name} (slug: ${m.slug})`);
    m.documents.forEach((d) => lines.push(`${"  ".repeat(depth + 1)}• ${d.title} — ${versionLabel(d.currentVersion)} · ${d.status} · ${d.kind} · ${docUrl(c.key, m.slug, d.slug)}`));
    walk(c, m.menus, depth + 1);
  });
  cats.forEach((c) => { lines.push(`## ${c.name} (key: ${c.key})`); if (!c.menus.length) lines.push("  (메뉴 없음)"); walk(c, c.menus, 1); });
  if (tree.warnings.length) lines.push(`\n색인 경고 ${tree.warnings.length}건: ${tree.warnings.join(" / ")}`);
  return lines.join("\n");
}));

server.registerTool("find_documents", {
  title: "문서 검색",
  description: "제목·메뉴 이름·본문(각 문서 최신 버전의 HTML·Markdown·텍스트)에서 찾는다.",
  inputSchema: { query: z.string().describe("찾을 글자"), category: z.string().optional().describe("대분류 key로 좁히기") },
  annotations: { readOnlyHint: true },
}, safe(async ({ query, category }) => {
  const q = new URLSearchParams({ q: query });
  if (category) q.set("category", category);
  const hits = await api<{ slug: string; menuSlug: string; title: string; kind: string; currentVersion: string; category: string; menuName: string; matches: number; snippet: string }[]>(`/api/search?${q}`);
  if (!hits.length) return `"${query}"와(과) 맞는 문서가 없습니다.`;
  return hits.map((h) => `- ${h.title} (${h.category} › ${h.menuName}, ${versionLabel(h.currentVersion)}, ${h.kind}${h.matches ? `, 본문 ${h.matches}곳` : ""})\n  ${docUrl(h.category, h.menuSlug, h.slug)}${h.snippet ? `\n  …${h.snippet}` : ""}`).join("\n");
}));

server.registerTool("get_document", {
  title: "문서 정보",
  description: "문서의 제목·상태·형식·버전 목록(메모 포함)·대표 파일과 사이트 주소를 보여 준다.",
  inputSchema: { ref: REF },
  annotations: { readOnlyHint: true },
}, safe(async ({ ref }) => {
  const r = await resolveRef(ref);
  const d = await loadDoc(r);
  const cur = d.versions.find((v) => v.version === d.currentVersion);
  return [
    `${d.title}`,
    `주소: ${docUrl(r.category, r.menu, r.doc)}`,
    `대분류/메뉴/문서: ${r.category}/${r.menu}/${r.doc}`,
    `형식: ${d.kind} · 상태: ${d.status} · 현재 버전: ${versionLabel(d.currentVersion)} · 대표 파일: ${cur?.files.find((f) => f.isEntry)?.path ?? "-"}`,
    d.originUrl ? `출처: ${d.originUrl}` : "",
    `텍스트 편집: ${/(html?|svg|docx|pptx|xlsx)$/i.test(cur?.files.find((f) => f.isEntry)?.path ?? "") ? "가능(get_text → edit_text)" : d.kind === "markdown" ? "Markdown 전체 저장(save_markdown)" : "지원 안 함"}`,
    "버전:",
    ...d.versions.map((v) => `- ${versionLabel(v.version)}${v.version === d.currentVersion ? " (최신)" : ""} · ${v.source ?? ""} · ${v.createdAt ?? ""}${v.note ? ` · ${v.note}` : ""}`),
  ].filter(Boolean).join("\n");
}));

server.registerTool("get_text", {
  title: "텍스트 조각 조회",
  description: "HTML·SVG·DOCX·PPTX·XLSX 문서의 텍스트 조각(태그 안 글자)을 [id] 위치: 글자 형식으로 보여 준다. edit_text에 이 id를 쓴다. 주소에 seg가 있으면 그 범위 주변만, query가 있으면 그 글자가 든 조각만 보여 준다.",
  inputSchema: {
    ref: REF,
    query: z.string().optional().describe("이 글자가 든 조각만"),
    context: z.number().int().min(0).max(20).optional().describe("seg 범위 앞뒤로 함께 보여 줄 조각 수(기본 3)"),
    limit: z.number().int().min(1).max(1000).optional().describe("최대 조각 수(기본 300)"),
  },
  annotations: { readOnlyHint: true },
}, safe(async ({ ref, query, context, limit }) => {
  const r = await resolveRef(ref);
  const d = await loadDoc(r);
  const version = r.version ?? d.currentVersion;
  const { segments, format, entry } = await loadSegments(r, version);
  let list = segments;
  const picked = parseSeg(r.seg);
  if (picked) {
    const c = context ?? 3;
    const ids = [...picked];
    list = list.filter((s) => ids.some((id) => Math.abs(s.id - id) <= c));
  }
  if (query) list = list.filter((s) => s.text.includes(query));
  const max = limit ?? 300;
  const head = `${d.title} · ${format} · ${entry} · ${versionLabel(version)}${version === d.currentVersion ? " (최신, 편집 가능)" : " (이전 버전: 편집은 최신 버전에서만)"} · 조각 ${list.length}/${segments.length}개`;
  const mark = (s: Segment) => (picked?.has(s.id) ? "▶ " : "");
  const body = list.slice(0, max).map((s) => `${mark(s)}[${s.id}] ${s.group}${s.svg ? " (다이어그램)" : ""}${s.fmt ? ` (${s.fmt})` : ""}${s.multiline ? " (줄바꿈 가능)" : ""}: ${s.text}`);
  return [head, ...body, list.length > max ? `… ${list.length - max}개 더 있음(limit·query로 좁히세요)` : ""].filter(Boolean).join("\n");
}));

server.registerTool("edit_text", {
  title: "텍스트 고치기",
  description: "HTML·SVG·DOCX·PPTX·XLSX 문서의 태그 안 글자만 고쳐 새 버전으로 저장한다(구조·서식은 그대로). 각 변경은 {segment, text}(조각 글자 전체를 바꿈) 또는 {find, replace}(그 글자가 든 조각에서 부분 교체) 중 하나. 최신 버전에서만 고칠 수 있다.",
  inputSchema: {
    ref: REF,
    changes: z.array(z.object({
      segment: z.number().int().optional().describe("get_text의 조각 id"),
      text: z.string().optional().describe("segment를 줄 때: 그 조각의 새 글자 전체"),
      find: z.string().optional().describe("이 글자가 든 조각을 찾아"),
      replace: z.string().optional().describe("find를 이 글자로 바꾼다"),
      all: z.boolean().optional().describe("find가 여러 조각에 있으면 모두 바꾼다(기본: 하나만 허용)"),
    })).min(1),
    note: z.string().optional().describe("변경 메모(앞에 \"Claude Code:\"가 붙는다)"),
  },
  annotations: { readOnlyHint: false, destructiveHint: false },
}, safe(async ({ ref, changes, note }) => {
  const r = await resolveRef(ref);
  const d = await loadDoc(r);
  if (r.version && r.version !== d.currentVersion) throw new ToolError(`${versionLabel(r.version)}은(는) 이전 버전입니다. 최신 버전(${versionLabel(d.currentVersion)})에서만 고칠 수 있습니다.`);
  const { segments } = await loadSegments(r, d.currentVersion);
  const byId = new Map(segments.map((s) => [s.id, s]));
  const next = new Map<number, string>();
  for (const c of changes) {
    if (c.segment !== undefined) {
      const s = byId.get(c.segment);
      if (!s) throw new ToolError(`조각 ${c.segment}이(가) 없습니다. get_text로 다시 확인하세요.`);
      if (c.text === undefined) throw new ToolError(`조각 ${c.segment}: text(새 글자)가 필요합니다.`);
      next.set(s.id, c.text);
    } else if (c.find !== undefined) {
      if (c.replace === undefined) throw new ToolError(`"${c.find}": replace(바꿀 글자)가 필요합니다.`);
      const hits = segments.filter((s) => (next.get(s.id) ?? s.text).includes(c.find!));
      if (hits.length === 0) throw new ToolError(`"${c.find}"이(가) 든 조각이 없습니다. 태그 경계로 글자가 나뉘었을 수 있으니 get_text로 확인하세요.`);
      if (hits.length > 1 && !c.all) throw new ToolError(`"${c.find}"이(가) 조각 ${hits.length}곳에 있습니다: ${hits.slice(0, 8).map((h) => `[${h.id}] ${h.group}`).join(", ")}. segment로 지정하거나 all: true를 주세요.`);
      for (const h of hits) next.set(h.id, (next.get(h.id) ?? h.text).split(c.find).join(c.replace));
    } else throw new ToolError("각 변경에는 segment+text 또는 find+replace가 필요합니다.");
  }
  const payload = [...next].filter(([id, t]) => byId.get(id)!.text !== t).map(([id, t]) => ({ id, hash: byId.get(id)!.hash, text: t }));
  if (!payload.length) return "바뀐 글자가 없습니다(원래 글자와 같음).";
  const res = await api<{ version: string; changed: number; warnings?: string[] }>(`/api/docs/${r.menu}/${r.doc}/text-edit`,
    json({ baseVersion: d.currentVersion, changes: payload, note: withPrefix(note, `텍스트 ${payload.length}곳 수정`) }));
  return [`${d.title}: ${payload.length}곳을 고쳐 ${versionLabel(res.version)}로 저장했습니다.`, docUrl(r.category, r.menu, r.doc),
    ...payload.map((p) => `- [${p.id}] ${byId.get(p.id)!.group}: 「${byId.get(p.id)!.text}」 → 「${p.text}」`),
    ...(res.warnings ?? []).map((w) => `주의: ${w}`)].join("\n");
}));

server.registerTool("save_markdown", {
  title: "Markdown 저장",
  description: "Markdown 문서의 내용 전체를 새 버전으로 저장한다(최신 버전 기준).",
  inputSchema: { ref: REF, content: z.string().describe("새 Markdown 내용 전체"), note: z.string().optional() },
  annotations: { readOnlyHint: false, destructiveHint: false },
}, safe(async ({ ref, content, note }) => {
  const r = await resolveRef(ref);
  const d = await loadDoc(r);
  const res = await api<{ version: string }>(`/api/docs/${r.menu}/${r.doc}/edit`, json({ baseVersion: d.currentVersion, content, note: withPrefix(note, "Markdown 수정") }));
  return `${d.title}: ${versionLabel(res.version)}로 저장했습니다.\n${docUrl(r.category, r.menu, r.doc)}`;
}));

server.registerTool("upload_document", {
  title: "새 문서 등록",
  description: "로컬 파일(들)이나 폴더로 새 문서를 등록한다(첫 버전은 draft). HTML·Markdown·이미지·PDF·DOCX·PPTX·XLSX·draw.io 등. claude.ai 아티팩트는 Artifact 도구로 읽어 저장한 파일 경로를 넘기고 origin에 아티팩트 주소를 준다.",
  inputSchema: {
    menu: z.string().describe("메뉴 slug 또는 이름(list_documents로 확인)"),
    title: z.string().describe("문서 제목"),
    files: z.array(z.string()).min(1).describe("파일·폴더 경로(리포 루트 기준 상대 경로 또는 절대 경로)"),
    slug: z.string().optional().describe("문서 slug(영문 소문자·숫자·하이픈). 없으면 파일 이름에서 만든다"),
    entry: z.string().optional().describe("파일이 여러 개일 때 사이트에서 열 대표 파일(업로드 목록 기준 상대 경로)"),
    note: z.string().optional(),
    origin: z.string().optional().describe("외부에서 가져온 경우 출처 주소(예: https://claude.ai/artifact/…)"),
    filename: z.string().optional().describe("파일 1개일 때 저장할 파일 이름(예: platform-env.html). 아티팩트처럼 임시 이름인 파일에 쓴다"),
  },
  annotations: { readOnlyHint: false, destructiveHint: false },
}, safe(async ({ menu, title, files, slug, entry, note, origin, filename }) => {
  const m = findMenu(await api<Tree>("/api/tree"), menu);
  const list = collectFiles(files, filename);
  const res = await uploadFiles({ menu: m.menu.slug, title, slug, entry, origin, note: withPrefix(note, origin ? `외부에서 가져옴: ${origin}` : "새 문서 등록") }, list);
  return `새 문서 "${title}"를 ${m.category.name} › ${m.path.join(" › ")}에 ${versionLabel(res.version)}로 등록했습니다(파일 ${list.length}개).\n${docUrl(res.category, res.menu, res.doc)}`;
}));

server.registerTool("upload_version", {
  title: "새 버전 올리기",
  description: "기존 문서에 새 파일(들)을 올려 다음 버전으로 저장한다. 내용이 직전 버전과 같으면 거부된다.",
  inputSchema: {
    ref: REF,
    files: z.array(z.string()).min(1).describe("파일·폴더 경로"),
    version: z.string().optional().describe("버전 번호(예: v0.3). 없으면 다음 번호"),
    entry: z.string().optional(),
    note: z.string().optional(),
  },
  annotations: { readOnlyHint: false, destructiveHint: false },
}, safe(async ({ ref, files, version, entry, note }) => {
  const r = await resolveRef(ref);
  const list = collectFiles(files);
  const res = await uploadFiles({ menu: r.menu, doc: r.doc, version, entry, note: withPrefix(note, "새 버전 업로드") }, list);
  return `${versionLabel(res.version)}로 올렸습니다(파일 ${list.length}개).\n${docUrl(res.category, res.menu, res.doc)}`;
}));

server.registerTool("create_menu", {
  title: "메뉴 만들기",
  description: "대분류 아래(또는 다른 메뉴 아래)에 새 메뉴를 만든다.",
  inputSchema: {
    category: z.string().describe("대분류 key 또는 이름(예: sdlc)"),
    name: z.string().describe("메뉴 이름"),
    slug: z.string().optional().describe("메뉴 slug(영문). docs/ 아래 폴더 이름이 된다"),
    parent: z.string().optional().describe("상위 메뉴 slug 또는 이름"),
  },
  annotations: { readOnlyHint: false, destructiveHint: false },
}, safe(async ({ category, name, slug, parent }) => {
  const tree = await api<Tree>("/api/tree");
  const cat = tree.categories.find((c) => c.key === category || c.name.toLowerCase() === category.toLowerCase());
  if (!cat) throw new ToolError(`대분류 "${category}"이(가) 없습니다: ${tree.categories.map((c) => `${c.name}(${c.key})`).join(", ")}`);
  const parentSlug = parent ? findMenu(tree, parent).menu.slug : undefined;
  const res = await api<{ slug: string }>("/api/menus", json({ category: cat.key, name, slug, parent: parentSlug }));
  return `메뉴 "${name}"(slug: ${res.slug})를 ${cat.name}${parent ? ` › ${parent}` : ""} 아래에 만들었습니다.`;
}));

server.registerTool("release_document", {
  title: "정식 버전 확정",
  description: "draft·review 문서를 정식 버전(v1.0, 이미 v1.x면 v2.0)으로 확정한다. 현재 버전을 복사해 새 버전을 만들고 상태를 approved로 바꾼다.",
  inputSchema: { ref: REF },
  annotations: { readOnlyHint: false, destructiveHint: false },
}, safe(async ({ ref }) => {
  const r = await resolveRef(ref);
  const d = await loadDoc(r);
  const next = `v${Math.max(0, ...d.versions.map((v) => Number(/^v(\d+)/.exec(v.version)?.[1] ?? 0))) + 1}.0`;
  const res = await api<{ from: string; version: string }>(`/api/docs/${r.menu}/${r.doc}/release`,
    json({ note: withPrefix(undefined, `정식 버전으로 확정 (${versionLabel(d.currentVersion)} → ${next})`) }));
  return `${versionLabel(res.from)} → ${res.version}(approved)로 확정했습니다.\n${docUrl(r.category, r.menu, r.doc)}`;
}));

server.registerTool("focus_in_site", {
  title: "사이트 화면 이동",
  description: "열려 있는 사이트 화면을 그 문서(주소의 버전·seg 조각 포함)로 옮기고 조각을 강조한다. 고친 곳을 사용자에게 보여 줄 때 쓴다.",
  inputSchema: { ref: REF },
  annotations: { readOnlyHint: true },
}, safe(async ({ ref }) => {
  const r = await resolveRef(ref);
  const res = await api<{ clients: number }>("/api/focus", json({ menu: r.menu, doc: r.doc, version: r.version, seg: r.seg }));
  const url = docUrl(r.category, r.menu, r.doc, r.version, r.seg);
  return res.clients > 0
    ? `열린 사이트 화면 ${res.clients}개를 옮겼습니다.\n${url}`
    : `열린 사이트 화면이 없습니다. 브라우저에서 이 주소를 여세요:\n${url}`;
}));

await server.connect(new StdioServerTransport());
console.error(`workflow-docs MCP 서버 시작 (API ${API})`);
