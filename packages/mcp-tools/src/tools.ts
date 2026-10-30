import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { parseSeg as parseCoreSeg } from "@workflow/core/seg";

/**
 * workflow-docs MCP 도구(3.0, REQUIREMENT-3.0 3.1 · 4.0 P6). 로컬 stdio 서버(site/mcp/server.ts)와 Cloudflare 원격 MCP(apps/worker/src/mcp.ts)가 같이 쓴다.
 * 도구는 사이트 API(워크스페이스 기준 경로: /tree, /docs/…, /upload, /menus, /search, /focus)를 부르므로 저장 규칙·충돌 검사·실시간 반영이 화면 편집과 같다.
 * 휴지통·영구 삭제·메뉴 삭제 도구는 두지 않는다(D-24). 호스트의 api는 X-Workflow-Agent: claude-code를 붙여 화면이 Claude의 변경을 알린다(3.4). 쓰기 도구는 변경 메모 앞에 "Claude Code:"를 붙인다(D-26).
 */

export interface UploadFile { path: string; data: Uint8Array }

export interface ToolHost {
  /** 사이트 API 호출. path는 워크스페이스 기준(/tree 등). 실패는 ToolError로 */
  api<T>(path: string, init?: RequestInit): Promise<T>;
  /** 화면 주소 앞부분. 로컬 http://localhost:8000, Cloudflare https://workflow.simplite.net/<워크스페이스> */
  webBase: string;
  /** 업로드 도구가 파일을 받는 방법: 로컬은 경로, 원격은 내용 */
  files: { schema: z.ZodType; collect(input: unknown): Promise<UploadFile[]> | UploadFile[]; how: string };
}

// ---------- 사이트 API ----------

interface DocSummary { slug: string; menuSlug: string; parent: string | null; title: string; kind: string; status: string; currentVersion: string }
interface MenuNode { slug: string; name: string; documents: DocSummary[]; menus: MenuNode[] }
interface Category { key: string; name: string; menus: MenuNode[] }
interface Tree { categories: Category[]; warnings: string[] }
interface DocVersion { version: string; note: string | null; source: string | null; createdAt: string | null; files: { path: string; isEntry: boolean; size: number }[] }
interface DocDetail {
  menuSlug: string; slug: string; title: string; kind: string; type: string | null; status: string; currentVersion: string;
  notionUrl: string | null; gdriveUrl: string | null; originUrl: string | null; versions: DocVersion[];
}
interface Segment { id: number; text: string; hash: string; multiline: boolean; group: string; svg?: boolean; fmt?: string }

export class ToolError extends Error {
  /** 사이트 API의 HTTP 상태(있을 때). 409·400에 고칠 방법을 붙이는 데 쓴다 */
  constructor(message: string, public status?: number) { super(message); }
}

/** 응답을 JSON으로 읽고, 실패면 서버의 error 메시지로 ToolError(호스트의 api 구현이 쓴다) */
export async function readJson<T>(res: Response, path: string): Promise<T> {
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new ToolError(body.error ?? `${res.status} ${path}`, res.status);
  return body;
}

const json = (body: unknown): RequestInit => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const withPrefix = (note: string | undefined, fallback: string) => `Claude Code: ${note?.trim() || fallback}`;
const versionLabel = (v: string) => (v === "v0.0" ? "draft" : v);



/** 파일 1개를 올릴 때 저장 이름을 바꾼다(아티팩트처럼 임시 이름인 파일) */
function renameSingle(list: UploadFile[], filename?: string): UploadFile[] {
  if (!filename) return list;
  if (list.length !== 1) throw new ToolError("filename은 파일 1개를 올릴 때만 쓸 수 있습니다");
  if (!/^[^/\\]+\.[a-z0-9]+$/i.test(filename)) throw new ToolError(`파일 이름에 확장자가 필요하고 폴더 구분자는 쓸 수 없습니다: ${filename}`);
  return [{ ...list[0], path: filename }];
}

export function registerTools(server: McpServer, host: ToolHost) {
  const api = host.api;
  const WEB = host.webBase.replace(/\/$/, "");
  const docUrl = (category: string, menu: string, doc: string, version?: string, seg?: string) => {
    const q = new URLSearchParams();
    if (version) q.set("v", version);
    if (seg) q.set("seg", seg);
    return `${WEB}/${category}/${menu}/${doc}${q.size ? `?${q}` : ""}`;
  };
  async function uploadFiles(fields: Record<string, string | undefined>, files: UploadFile[]) {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) if (v) form.append(k, v);
    form.append("paths", JSON.stringify(files.map((f) => f.path)));
    for (const f of files) form.append("files", new Blob([new Uint8Array(f.data)]), f.path.split("/").pop()!);
    return api<{ menu: string; doc: string; version: string; category: string; created: boolean }>("/upload", { method: "POST", body: form });
  }

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
    const tree = await api<Tree>("/tree");
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
      // 사이트 주소 앞부분(Cloudflare는 /<워크스페이스>)을 떼고 대분류/메뉴/문서를 읽는다
      const base = new URL(WEB).pathname.replace(/\/$/, "");
      const path = base && u.pathname.startsWith(base + "/") ? u.pathname.slice(base.length) : u.pathname;
      const [category, menu, doc] = path.split("/").filter(Boolean).map(decodeURIComponent);
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

  const loadDoc = (r: Ref) => api<DocDetail>(`/docs/${r.menu}/${r.doc}`);
  const loadSegments = (r: Ref, version: string) =>
    api<{ format: string; version: string; entry: string; segments: Segment[] }>(`/docs/${r.menu}/${r.doc}/segments?v=${encodeURIComponent(version)}`);

  /** 조각 지정 `12`, `12-15`, 목록 `3,10-12`를 id 집합으로(규칙은 core의 parseSeg, 화면과 같다) */
  function parseSeg(seg?: string): Set<number> | null {
    const ids = parseCoreSeg(seg);
    return ids.length ? new Set(ids) : null;
  }

  // ---------- 도구 ----------

  const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
  const safe = <A>(fn: (a: A) => Promise<string>) => async (a: A) => {
    try { return text(await fn(a)); }
    catch (e) { return { ...text(e instanceof ToolError ? e.message : `오류: ${(e as Error).message}`), isError: true }; }
  };
  const REF = z.string().describe(`문서 지정: 사이트 주소(예: ${WEB}/sdlc/code-review-automation/review-modes?v=v1.0&seg=12), "대분류/메뉴/문서", "SDLC > 메뉴 > 문서 제목", 또는 문서 제목`);

  server.registerTool("list_documents", {
    title: "문서 목록",
    description: "업무 문서 사이트의 대분류 → 메뉴 → 문서 트리를 보여 준다. 각 문서의 주소·현재 버전·상태 포함.",
    inputSchema: { category: z.string().optional().describe("대분류 key 또는 이름으로 좁히기(예: sdlc)") },
    annotations: { readOnlyHint: true },
  }, safe(async ({ category }) => {
    const tree = await api<Tree>("/tree");
    const cats = tree.categories.filter((c) => !category || c.key === category || c.name.toLowerCase() === category.toLowerCase());
    const lines: string[] = [];
    const walk = (c: Category, list: MenuNode[], depth: number) => list.forEach((m) => {
      lines.push(`${"  ".repeat(depth)}- 메뉴 ${m.name} (slug: ${m.slug})`);
      // 하위 문서는 상위 문서 아래에 한 칸 더 들여 쓴다
      const docs = (parent: string | null, d0: number): void => m.documents.filter((d) => d.parent === parent).forEach((d) => {
        lines.push(`${"  ".repeat(d0)}• ${d.title} — ${versionLabel(d.currentVersion)} · ${d.status} · ${d.kind} · ${docUrl(c.key, m.slug, d.slug)}`);
        docs(d.slug, d0 + 1);
      });
      docs(null, depth + 1);
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
    const hits = await api<{ slug: string; menuSlug: string; title: string; kind: string; currentVersion: string; category: string; menuName: string; matches: number; snippet: string }[]>(`/search?${q}`);
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
    const res = await api<{ version: string; changed: number; warnings?: string[] }>(`/docs/${r.menu}/${r.doc}/text-edit`,
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
    const res = await api<{ version: string }>(`/docs/${r.menu}/${r.doc}/edit`, json({ baseVersion: d.currentVersion, content, note: withPrefix(note, "Markdown 수정") }));
    return `${d.title}: ${versionLabel(res.version)}로 저장했습니다.\n${docUrl(r.category, r.menu, r.doc)}`;
  }));

  server.registerTool("upload_document", {
    title: "새 문서 등록",
    description: `${host.files.how} 새 문서를 등록한다(첫 버전은 draft). HTML·Markdown·이미지·PDF·DOCX·PPTX·XLSX·draw.io 등. claude.ai 아티팩트는 Artifact 도구로 읽어 그 내용을 넘기고 origin에 아티팩트 주소를 준다.`,
    inputSchema: {
      menu: z.string().describe("메뉴 slug 또는 이름(list_documents로 확인)"),
      title: z.string().describe("문서 제목"),
      files: host.files.schema,
      slug: z.string().optional().describe("문서 slug(영문 소문자·숫자·하이픈). 없으면 파일 이름에서 만든다"),
      parent: z.string().optional().describe("하위 문서로 만들 때 상위 문서 slug(같은 메뉴)"),
      entry: z.string().optional().describe("파일이 여러 개일 때 사이트에서 열 대표 파일(업로드 목록 기준 상대 경로)"),
      note: z.string().optional(),
      origin: z.string().optional().describe("외부에서 가져온 경우 출처 주소(예: https://claude.ai/artifact/…)"),
      filename: z.string().optional().describe("파일 1개일 때 저장할 파일 이름(예: platform-env.html). 아티팩트처럼 임시 이름인 파일에 쓴다"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  }, safe(async ({ menu, title, files, slug, parent, entry, note, origin, filename }) => {
    const m = findMenu(await api<Tree>("/tree"), menu);
    const list = renameSingle(await host.files.collect(files), filename);
    const res = await uploadFiles({ menu: m.menu.slug, title, slug, parent, entry, origin, note: withPrefix(note, origin ? `외부에서 가져옴: ${origin}` : "새 문서 등록") }, list);
    return `새 문서 "${title}"를 ${m.category.name} › ${m.path.join(" › ")}에 ${versionLabel(res.version)}로 등록했습니다(파일 ${list.length}개).\n${docUrl(res.category, res.menu, res.doc)}`;
  }));

  server.registerTool("upload_version", {
    title: "새 버전 올리기",
    description: `${host.files.how} 기존 문서의 다음 버전으로 저장한다. 내용이 직전 버전과 같으면 거부된다.`,
    inputSchema: {
      ref: REF,
      files: host.files.schema,
      version: z.string().optional().describe("버전 번호(예: v0.3). 없으면 다음 번호"),
      entry: z.string().optional(),
      note: z.string().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  }, safe(async ({ ref, files, version, entry, note }) => {
    const r = await resolveRef(ref);
    const list = await host.files.collect(files);
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
    const tree = await api<Tree>("/tree");
    const cat = tree.categories.find((c) => c.key === category || c.name.toLowerCase() === category.toLowerCase());
    if (!cat) throw new ToolError(`대분류 "${category}"이(가) 없습니다: ${tree.categories.map((c) => `${c.name}(${c.key})`).join(", ")}`);
    const parentSlug = parent ? findMenu(tree, parent).menu.slug : undefined;
    const res = await api<{ slug: string }>("/menus", json({ category: cat.key, name, slug, parent: parentSlug }));
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
    const res = await api<{ from: string; version: string }>(`/docs/${r.menu}/${r.doc}/release`,
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
    const res = await api<{ clients: number }>("/focus", json({ menu: r.menu, doc: r.doc, version: r.version, seg: r.seg }));
    const url = docUrl(r.category, r.menu, r.doc, r.version, r.seg);
    return res.clients > 0
      ? `열린 사이트 화면 ${res.clients}개를 옮겼습니다.\n${url}`
      : `열린 사이트 화면이 없습니다. 브라우저에서 이 주소를 여세요:\n${url}`;
  }));

  // ---------- 슬라이드 덱(5.0 M4, 명세 docs/slide-editor-spec.html 11절) ----------

  const DECK_FORMAT = "덱 형식: 캔버스 1920×1080px, 여백 128px, 글자 24px 이상. 슬라이드 한 장 = <section id=\"슬라이드id\" style=\"…\">…</section>(직계 <aside>는 발표자 노트). " +
    "블록 section div h1 h2 h3 p ul ol li table tr th td img hr, 글자 안 마크 b i u a[href^=https] span[style=color] br. 속성은 data-eid·style·img의 src(asset:<sha256>만)·alt. " +
    "CSS는 위치(position absolute·relative, left top width height), 배치(display flex·grid, flex-*, grid-template-columns, gap, align-*, justify-*, padding), 글자(font-*, line-height, letter-spacing, color, text-align, text-decoration), " +
    "상자(background 단색, border*, border-radius), 이미지(object-fit, object-position). 단위 px·%·fr. margin·z-index·url()·script·on* 금지. 표 열 너비는 첫 행 칸의 width:N%.";
  const SLIDE_OPS = "연산(eid로 대상 지정): setText{eid,html}, setStyle{eid,set,unset}, setAttr{eid,name:alt|src,value}, insert{parent,index,html}, remove{eid}, restore{parent,index,html}, move{eid,parent,index}, " +
    "toPinned{eid,box:{left,top,width,height}}, tableCols{eid,widths}, tableRow{eid,at,op:add|remove}, tableCol{eid,at,op:add|remove}, setNotes{text}";
  const LOCAL_ONLY = (e: unknown) => {
    if (e instanceof ToolError && (e.status === 404 && /Not Found|^404/.test(e.message))) throw new ToolError("이 사이트에서는 고칠 수 없습니다(로컬 사이트는 보기만, D-51). Cloudflare 워크스페이스에서 쓰세요.");
    throw e;
  };
  interface DeckWork { rev: number; baseVersion: string; index: { title: string; order: string[] }; slides: { id: string; html: string }[] }
  const loadDeck = (r: Ref) => api<DeckWork>(`/docs/${r.menu}/${r.doc}/deck`);

  server.registerTool("deck_create", {
    title: "슬라이드 덱 만들기",
    description: `새 슬라이드 덱 문서를 만든다(draft). 슬라이드마다 HTML 한 조각. 형식에 맞지 않으면 파일:줄:칸과 고칠 방법(fix)이 담긴 진단을 돌려준다. ${DECK_FORMAT}`,
    inputSchema: {
      menu: z.string().describe("메뉴 slug 또는 이름"),
      title: z.string().describe("덱 제목"),
      slides: z.array(z.object({ id: z.string().describe("슬라이드 id(영문 소문자·숫자·-), section id와 같게"), html: z.string() })).min(1),
      slug: z.string().optional(),
      palette: z.array(z.string()).optional().describe("속성 패널 색 견본(#rrggbb)"),
      faces: z.record(z.string(), z.object({ family: z.string(), href: z.string().describe("https://fonts.googleapis.com/css2?… 만") })).optional(),
      note: z.string().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  }, safe(async ({ menu, title, slides, slug, palette, faces, note }) => {
    const m = findMenu(await api<Tree>("/tree"), menu);
    const enc = new TextEncoder();
    const index = { v: 1, title, order: slides.map((s) => s.id), ...(palette ? { palette } : {}), ...(faces ? { faces } : {}) };
    const files = [{ path: "deck.json", data: enc.encode(JSON.stringify(index, null, 2) + "\n") }, ...slides.map((s) => ({ path: `slides/${s.id}.html`, data: enc.encode(s.html) }))];
    const res = await uploadFiles({ menu: m.menu.slug, title, slug, entry: "deck.json", note: withPrefix(note, "슬라이드 덱 만듦") }, files);
    return `슬라이드 덱 "${title}"(${slides.length}장)을 만들었습니다. 고치려면 deck_get으로 eid를 읽고 slide_patch를 쓰세요.\n${docUrl(res.category, res.menu, res.doc)}`;
  }));

  server.registerTool("deck_get", {
    title: "슬라이드 덱 읽기",
    description: "덱의 색인(제목·순서)과 슬라이드 HTML(eid가 붙은 형식)·작업본 rev를 읽는다. 사람이 고친 뒤에는 반드시 다시 읽고 고친다.",
    inputSchema: { ref: REF, slides: z.array(z.string()).optional().describe("이 슬라이드 id만") },
    annotations: { readOnlyHint: true },
  }, safe(async ({ ref, slides }) => {
    const r = await resolveRef(ref);
    const d = await loadDeck(r).catch(LOCAL_ONLY);
    const list = d.slides.filter((s) => !slides || slides.includes(s.id));
    return `덱 "${d.index.title}" · rev ${d.rev}(기준 ${versionLabel(d.baseVersion)}) · 순서 ${d.index.order.join(", ")}\n\n` +
      list.map((s) => `--- ${s.id}\n${s.html}`).join("\n");
  }));

  server.registerTool("slide_put", {
    title: "슬라이드 통째로 쓰기",
    description: `슬라이드 하나를 HTML로 통째로 쓴다(새 id면 index 자리, 없으면 끝에 추가). 작은 수정은 slide_patch를 쓴다(사람의 다른 편집을 덮지 않는다). ${DECK_FORMAT}`,
    inputSchema: {
      ref: REF, slideId: z.string(), html: z.string(),
      baseRev: z.number().int().optional().describe("deck_get에서 읽은 rev. 없으면 지금 rev"),
      index: z.number().int().optional(), note: z.string().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: true },
  }, safe(async ({ ref, slideId, html, baseRev, index, note }) => {
    const r = await resolveRef(ref);
    const rev = baseRev ?? (await loadDeck(r).catch(LOCAL_ONLY)).rev;
    const res = await api<{ rev: number; added: boolean }>(`/docs/${r.menu}/${r.doc}/deck/slides/${encodeURIComponent(slideId)}`,
      { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ baseRev: rev, html, index, summary: withPrefix(note, `슬라이드 ${slideId} 다시 씀`) }) }).catch(LOCAL_ONLY);
    return `슬라이드 ${slideId}를 ${res.added ? "추가" : "다시 썼"}습니다(수정본 ${res.rev}). 버전은 사람이 「버전으로 저장」할 때 생깁니다.\n${docUrl(r.category, r.menu, r.doc)}`;
  }));

  server.registerTool("slide_patch", {
    title: "슬라이드 고치기(연산)",
    description: `슬라이드 하나에 편집 연산을 적용한다. 대상은 deck_get으로 읽은 data-eid로 가리킨다. baseRev가 지났어도 대상 요소가 모두 있으면 최신본에 다시 적용되고, 지워진 요소면 실패한다. ${SLIDE_OPS}. ${DECK_FORMAT}`,
    inputSchema: {
      ref: REF, slideId: z.string(),
      ops: z.array(z.record(z.string(), z.unknown())).min(1).describe(SLIDE_OPS),
      baseRev: z.number().int().optional(), note: z.string().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  }, safe(async ({ ref, slideId, ops, baseRev, note }) => {
    const r = await resolveRef(ref);
    const rev = baseRev ?? (await loadDeck(r).catch(LOCAL_ONLY)).rev;
    const res = await api<{ rev: number; rebased: boolean; html: string }>(`/docs/${r.menu}/${r.doc}/deck/slides/${encodeURIComponent(slideId)}`,
      json({ baseRev: rev, ops, summary: withPrefix(note, `슬라이드 ${slideId} 연산 ${ops.length}개`) })).catch(LOCAL_ONLY);
    return `슬라이드 ${slideId}에 연산 ${ops.length}개를 적용했습니다(수정본 ${res.rev}${res.rebased ? ", 그사이 바뀐 최신본에 다시 적용" : ""}).\n${res.html}`;
  }));

  server.registerTool("deck_render", {
    title: "슬라이드 미리보기",
    description: "슬라이드 하나를 PNG(960×540)로 그려 돌려준다. 고친 뒤 배치·넘침을 눈으로 확인할 때 쓴다. 작업본(최신 수정본)을 그린다.",
    inputSchema: { ref: REF, slideId: z.string() },
    annotations: { readOnlyHint: true },
  }, async ({ ref, slideId }) => {
    try {
      const r = await resolveRef(ref);
      const res = await api<{ png: string; width: number; height: number }>(`/docs/${r.menu}/${r.doc}/deck/png?work=1&format=json&slide=${encodeURIComponent(slideId)}`).catch(LOCAL_ONLY);
      return { content: [{ type: "image" as const, data: res.png, mimeType: "image/png" }, { type: "text" as const, text: `슬라이드 ${slideId} (${res.width}×${res.height}, 캔버스 1920×1080의 절반)` }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: e instanceof ToolError ? e.message : `오류: ${(e as Error).message}` }], isError: true };
    }
  });

  server.registerTool("asset_put", {
    title: "그림 올리기",
    description: "PNG·JPEG·WebP·GIF 그림을 올리고 슬라이드에 쓸 asset:<sha256> 주소를 받는다(같은 그림은 한 번만 저장). SVG는 받지 않는다.",
    inputSchema: {
      base64: z.string().describe("그림 파일 내용(base64)"),
      mime: z.enum(["image/png", "image/jpeg", "image/webp", "image/gif"]),
      name: z.string().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  }, safe(async ({ base64, mime, name }) => {
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const form = new FormData();
    form.append("file", new File([bytes], name ?? `image.${mime.split("/")[1]}`, { type: mime }));
    const res = await api<{ asset: string; width: number; height: number }>("/assets", { method: "POST", body: form }).catch(LOCAL_ONLY);
    return `${res.asset} (${res.width}×${res.height}px)`;
  }));

  // ---------- 구조 편집·수정본(5.0 M7): HTML·DOCX·PPTX·XLSX 연산, 수정본 목록·되돌리기 ----------

  const STRUCT_OPS = "HTML 연산(eid로 대상): setText{eid,html(인라인 마크만)}, setAttr{eid,name:src|alt|href,value}, setWidth{eid,percent|null}, insert{ref,where:before|after,node:{kind:table,rows,cols,header?}|{kind:image,src(상대 경로·https·asset:<sha>),alt?,width?}|{kind:paragraph,text?}|{kind:heading,level:2|3|4,text?}}, " +
    "remove{eid}, move{eid,ref,where}, tableRow{eid,at,op:add|remove}, tableCol{eid,at,op:add|remove}, tableCols{eid,widths(%)}. " +
    "DOCX·PPTX 연산(table·image는 doc_structure의 id): tableRow{table,at,op}, tableCol{table,at,op}, tableCols{table,widths}, replaceImage{image,asset:\"asset:<sha>\"}. XLSX: colWidth{sheet,col(0부터),width(글자 수)}";
  /** 연산 실패에 고칠 방법을 붙인다(명세 15절: 잘못된 연산에 진단·fix) */
  const withFix = (e: unknown): never => {
    if (!(e instanceof ToolError)) throw e;
    if (e.status === 409) throw new ToolError(`${e.message}\n→ doc_structure로 최신 eid·id와 rev를 다시 읽고 연산을 고쳐 보내세요.`, 409);
    if (e.status === 400) throw new ToolError(`${e.message}\n→ 쓸 수 있는 연산: ${STRUCT_OPS}`, 400);
    return LOCAL_ONLY(e) as never;
  };
  interface Block { eid: string; tag: string; text: string; table?: { rows: number; cols: number; widths: number[] | null; merged: boolean }; image?: { src: string; alt: string; width: number | null }; editable: boolean }
  interface Structure { rev: number; baseVersion: string; entry: string; kind: string; blocks?: Block[];
    tables?: { id: string; where: string; rows: number; cols: number; widths: number[]; merged: boolean; header: string[] }[];
    images?: { id: string; where: string; media: string }[]; sheets?: { id: string; name: string; widths: number[] }[] }

  server.registerTool("doc_structure", {
    title: "문서 구조 읽기",
    description: "HTML·DOCX·PPTX·XLSX 작업본의 구조를 읽는다: HTML은 블록(eid·태그·글자, 표 행·열·너비, 그림), 오피스는 표·그림·시트 id. doc_ops 전에 반드시 읽는다(eid는 저장할 때마다 바뀐다).",
    inputSchema: { ref: REF },
    annotations: { readOnlyHint: true },
  }, safe(async ({ ref }) => {
    const r = await resolveRef(ref);
    const s = await api<Structure>(`/docs/${r.menu}/${r.doc}/work/structure`).catch(LOCAL_ONLY);
    const head = `${s.entry} (${s.kind}) · rev ${s.rev}(기준 ${versionLabel(s.baseVersion)})`;
    if (s.blocks) {
      return `${head}\n` + s.blocks.map((b) => {
        const extra = b.table ? ` [표 ${b.table.rows}×${b.table.cols}${b.table.widths ? ` 너비 ${b.table.widths.join("/")}%` : ""}${b.table.merged ? " 병합 있음" : ""}]`
          : b.image ? ` [그림 ${b.image.src}${b.image.alt ? ` "${b.image.alt}"` : ""}]` : "";
        return `${b.eid} <${b.tag}>${extra}${b.text ? ` ${b.text.slice(0, 60)}` : ""}${b.editable ? "" : " (글자 고치기 불가)"}`;
      }).join("\n");
    }
    return [head,
      ...(s.tables ?? []).map((t) => `표 ${t.id} · ${t.where} · ${t.rows}×${t.cols} · 너비 ${t.widths.join("/")}%${t.merged ? " · 병합 있음(행·열 불가)" : ""}${t.header.length ? ` · 머리: ${t.header.join(" | ")}` : ""}`),
      ...(s.images ?? []).map((i) => `그림 ${i.id} · ${i.where} · ${i.media}`),
      ...(s.sheets ?? []).map((x) => `시트 ${x.id} · ${x.name} · 열 너비 ${x.widths.slice(0, 8).join("/")}…`)].join("\n");
  }));

  server.registerTool("doc_ops", {
    title: "문서 구조 고치기(연산)",
    description: `HTML·DOCX·PPTX·XLSX 작업본에 구조 연산을 적용해 수정본 하나로 저장한다(표 행·열·너비, 블록 넣기·지우기·옮기기, 그림). 대상은 doc_structure로 읽은 eid·id. 버전은 사람이 「버전으로 저장」할 때 생긴다. ${STRUCT_OPS}`,
    inputSchema: {
      ref: REF,
      ops: z.array(z.record(z.string(), z.unknown())).min(1).describe(STRUCT_OPS),
      baseRev: z.number().int().optional().describe("doc_structure에서 읽은 rev. 없으면 지금 rev"),
      note: z.string().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  }, safe(async ({ ref, ops, baseRev, note }) => {
    const r = await resolveRef(ref);
    const rev = baseRev ?? (await api<Structure>(`/docs/${r.menu}/${r.doc}/work/structure`).catch(LOCAL_ONLY)).rev;
    const res = await api<{ rev: number; changed: boolean }>(`/docs/${r.menu}/${r.doc}/revisions`, json({ baseRev: rev, ops, summary: withPrefix(note, `구조 연산 ${ops.length}개`) })).catch(withFix);
    return res.changed ? `연산 ${ops.length}개를 적용해 수정본 ${res.rev}로 저장했습니다. eid가 바뀌었으니 더 고치려면 doc_structure를 다시 읽으세요.\n${docUrl(r.category, r.menu, r.doc)}`
      : "바뀐 것이 없어 수정본을 만들지 않았습니다.";
  }));

  interface Rev { rev: number; baseVersion: string; source: string; summary: string | null; createdAt: string; author: string | null; publishedAs: string | null }
  server.registerTool("revision_list", {
    title: "수정본 목록",
    description: "문서의 수정본(자동 저장·에이전트 저장) 이력을 최신부터 보여 준다. 출처(human·agent·restore), 작성자, 메모, 버전으로 올린 수정본.",
    inputSchema: { ref: REF },
    annotations: { readOnlyHint: true },
  }, safe(async ({ ref }) => {
    const r = await resolveRef(ref);
    const res = await api<{ head: number | null; revisions: Rev[] }>(`/docs/${r.menu}/${r.doc}/revisions`).catch(LOCAL_ONLY);
    if (!res.revisions.length) return "수정본이 없습니다(지금 버전 그대로).";
    return res.revisions.map((x) => `r${x.rev}${x.rev === res.head ? " (지금)" : ""} · ${x.source} · ${x.author ?? "-"} · ${x.createdAt.slice(0, 16).replace("T", " ")} · ${x.summary ?? ""}${x.publishedAs ? ` · ${versionLabel(x.publishedAs)}로 올림` : ""}`).join("\n");
  }));

  server.registerTool("revision_restore", {
    title: "수정본 되돌리기",
    description: "예전 수정본(rev, 0이면 기준 버전 내용)의 내용으로 새 수정본을 만든다. 지난 수정본은 지우지 않는다.",
    inputSchema: { ref: REF, rev: z.number().int().min(0), baseRev: z.number().int().optional().describe("지금 rev(없으면 서버에서 읽는다)") },
    annotations: { readOnlyHint: false, destructiveHint: false },
  }, safe(async ({ ref, rev, baseRev }) => {
    const r = await resolveRef(ref);
    const cur = baseRev ?? (await api<{ rev: number }>(`/docs/${r.menu}/${r.doc}/work`).catch(LOCAL_ONLY)).rev;
    const res = await api<{ rev: number; changed: boolean }>(`/docs/${r.menu}/${r.doc}/revisions/${rev}/restore`, json({ baseRev: cur })).catch(withFix);
    return res.changed ? `${rev === 0 ? "기준 버전" : `수정본 ${rev}`} 내용으로 수정본 ${res.rev}를 만들었습니다.\n${docUrl(r.category, r.menu, r.doc)}` : "이미 그 내용이라 바꾸지 않았습니다.";
  }));
}
