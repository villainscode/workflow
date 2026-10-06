import { createReadStream, mkdirSync } from "node:fs";
import { resolve, join, sep } from "node:path";
import Fastify, { type FastifyError } from "fastify";
import fastifyStatic from "@fastify/static";
import fastifyMultipart from "@fastify/multipart";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { watch } from "chokidar";
import type { ServerResponse } from "node:http";
import { DDL, categories, menus, documents, documentVersions, versionFiles } from "./schema.ts";
import { scanDocs } from "./scan.ts";
import { StoreError, saveEdit, upload, type IncomingFile } from "./store.ts";
import {
  addCategory, addMenu, deleteCategory, deleteMenu, listTrash, moveDoc, moveMenu, purgeDoc, renameMenu, restoreDoc,
  trashDoc, updateCategory, updateDoc,
} from "./manage.ts";
import { convert, type Target } from "./convert.ts";

const SITE_ROOT = resolve(import.meta.dirname, "..");
const REPO_ROOT = resolve(SITE_ROOT, "..");
const DOCS_ROOT = join(REPO_ROOT, "docs");
const PORT = Number(process.env.PORT ?? 5174);
const MAX_UPLOAD = 200 * 1024 * 1024;
const CACHE_DIR = join(SITE_ROOT, "data/cache");

mkdirSync(join(SITE_ROOT, "data"), { recursive: true });
const sqlite = new Database(join(SITE_ROOT, "data/index.db"));
sqlite.pragma("journal_mode = WAL");
const db = drizzle(sqlite);

// 변경 알림(SSE)을 받는 브라우저 목록
const clients = new Set<ServerResponse>();
function broadcast(event: object) {
  const msg = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of clients) res.write(msg);
}

let warnings: string[] = [];
function reindex(reason: string) {
  sqlite.exec(DDL);
  warnings = scanDocs(db, DOCS_ROOT, REPO_ROOT);
  warnings.forEach((w) => app.log.warn(w));
  broadcast({ type: "changed", reason });
}

const app = Fastify({ logger: { level: "info" }, bodyLimit: MAX_UPLOAD });

await app.register(fastifyMultipart, { limits: { fileSize: MAX_UPLOAD, files: 2000 } });
// docs/ 원본 파일. HTML 문서의 상대 경로 리소스와 링크도 이 경로 아래에서 풀린다.
await app.register(fastifyStatic, { root: DOCS_ROOT, prefix: "/files/", dotfiles: "ignore", index: false, cacheControl: false });

app.setErrorHandler((err: FastifyError | StoreError, _req, reply) => {
  if (err instanceof StoreError) return reply.code(err.status).send({ error: err.message });
  app.log.error(err);
  return reply.code((err as FastifyError).statusCode ?? 500).send({ error: err.message });
});

app.get("/api/tree", async () => {
  const cats = db.select().from(categories).orderBy(asc(categories.sort)).all();
  const menuRows = db.select().from(menus).orderBy(asc(menus.sort)).all();
  const docRows = db
    .select({
      slug: documents.slug, menuSlug: documents.menuSlug, title: documents.title,
      kind: documents.kind, status: documents.status, currentVersion: documents.currentVersion,
    })
    .from(documents).where(isNull(documents.deletedAt)).orderBy(asc(documents.title)).all();

  const build = (category: string, parent: string | null): unknown[] =>
    menuRows
      .filter((m) => m.categoryKey === category && m.parentSlug === parent)
      .map((m) => ({
        slug: m.slug, name: m.name,
        documents: docRows.filter((d) => d.menuSlug === m.slug),
        menus: build(category, m.slug),
      }));

  return { categories: cats.map((c) => ({ key: c.key, name: c.name, menus: build(c.key, null) })), warnings };
});

app.get<{ Params: { menu: string; doc: string } }>("/api/docs/:menu/:doc", async (req, reply) => {
  const doc = db.select().from(documents)
    .where(and(eq(documents.menuSlug, req.params.menu), eq(documents.slug, req.params.doc))).get();
  if (!doc) return reply.code(404).send({ error: "문서를 찾을 수 없습니다" });

  const versions = db.select().from(documentVersions).where(eq(documentVersions.documentId, doc.id)).all();
  const files = versions.length
    ? db.select().from(versionFiles).where(inArray(versionFiles.versionId, versions.map((v) => v.id))).all()
    : [];
  return {
    ...doc,
    versions: versions.map((v) => ({
      ...v,
      files: files.filter((f) => f.versionId === v.id)
        .map((f) => ({ ...f, url: "/files/" + f.path.replace(/^docs\//, "") })),
    })),
  };
});

/**
 * 업로드. multipart 필드: menu, doc?, title?, slug?, version?, note?, entry?, paths(JSON 배열, 파일 순서와 같은 상대 경로)
 * 그리고 files(여러 개). 폴더째 올릴 때는 paths로 하위 경로를 넘긴다.
 */
app.post("/api/upload", async (req) => {
  const fields: Record<string, string> = {};
  const raw: { name: string; data: Uint8Array }[] = [];
  for await (const part of req.parts()) {
    if (part.type === "file") raw.push({ name: part.filename, data: await part.toBuffer() });
    else fields[part.fieldname] = String(part.value ?? "");
  }
  const paths: string[] = fields.paths ? JSON.parse(fields.paths) : [];
  const files: IncomingFile[] = raw.map((f, i) => ({ path: paths[i] || f.name, data: f.data }));

  const result = upload(DOCS_ROOT, {
    menu: fields.menu, doc: fields.doc || undefined, title: fields.title, slug: fields.slug,
    version: fields.version, note: fields.note, entry: fields.entry || undefined, files,
  });
  reindex("upload");
  return result;
});

app.post<{ Params: { menu: string; doc: string }; Body: { baseVersion: string; content: string; note?: string; version?: string } }>(
  "/api/docs/:menu/:doc/edit",
  async (req) => {
    const result = saveEdit(DOCS_ROOT, req.params.menu, req.params.doc, req.body);
    reindex("edit");
    return result;
  },
);

// ---------- 관리: 고친 뒤 바로 다시 색인한다 ----------
type MenuParams = { Params: { slug: string } };
type DocParams = { Params: { menu: string; doc: string } };
const done = <T>(reason: string, result: T) => { reindex(reason); return result ?? { ok: true }; };

app.post<{ Body: { category: string; name: string; slug?: string; parent?: string } }>("/api/menus", async (req) =>
  done("menu", addMenu(DOCS_ROOT, req.body.category, req.body.name, req.body.slug, req.body.parent)));
app.patch<MenuParams & { Body: { name: string } }>("/api/menus/:slug", async (req) =>
  done("menu", renameMenu(DOCS_ROOT, req.params.slug, req.body.name)));
app.post<MenuParams & { Body: { category: string; parent?: string | null; index?: number } }>("/api/menus/:slug/move", async (req) =>
  done("menu", moveMenu(DOCS_ROOT, req.params.slug, req.body)));
app.delete<MenuParams>("/api/menus/:slug", async (req) => done("menu", deleteMenu(DOCS_ROOT, req.params.slug)));

app.post<{ Body: { name: string; key?: string } }>("/api/categories", async (req) =>
  done("category", addCategory(DOCS_ROOT, req.body.name, req.body.key)));
app.patch<{ Params: { key: string }; Body: { name?: string; index?: number } }>("/api/categories/:key", async (req) =>
  done("category", updateCategory(DOCS_ROOT, req.params.key, req.body)));
app.delete<{ Params: { key: string } }>("/api/categories/:key", async (req) =>
  done("category", deleteCategory(DOCS_ROOT, req.params.key)));

app.patch<DocParams & { Body: { title?: string; status?: string } }>("/api/docs/:menu/:doc", async (req) =>
  done("doc", updateDoc(DOCS_ROOT, req.params.menu, req.params.doc, req.body)));
app.post<DocParams & { Body: { menu: string } }>("/api/docs/:menu/:doc/move", async (req) =>
  done("doc", moveDoc(DOCS_ROOT, req.params.menu, req.params.doc, req.body.menu)));
app.delete<DocParams>("/api/docs/:menu/:doc", async (req) => done("trash", trashDoc(DOCS_ROOT, req.params.menu, req.params.doc)));

app.get("/api/trash", async () => listTrash(DOCS_ROOT));
app.post<{ Params: { id: string }; Body: { menu?: string } }>("/api/trash/:id/restore", async (req) =>
  done("restore", restoreDoc(DOCS_ROOT, req.params.id, req.body?.menu)));
app.delete<{ Params: { id: string } }>("/api/trash/:id", async (req) => done("purge", purgeDoc(DOCS_ROOT, req.params.id)));

// ---------- 검색: 제목·메뉴·본문 부분 일치. 제목에 맞은 문서를 먼저 ----------
app.get<{ Querystring: { q?: string; category?: string; kind?: string } }>("/api/search", async (req) => {
  const q = (req.query.q ?? "").trim();
  if (!q) return [];
  const like = `%${q.replace(/[\\%_]/g, (c) => "\\" + c)}%`;
  const rows = sqlite.prepare(`
    SELECT d.slug, d.menu_slug AS menuSlug, d.title, d.kind, d.status, m.category_key AS category, m.name AS menuName,
           s.body, (s.title LIKE @like ESCAPE '\\') AS inTitle
    FROM search s JOIN document d ON d.id = s.document_id JOIN menu m ON m.slug = d.menu_slug
    WHERE (s.title LIKE @like ESCAPE '\\' OR s.body LIKE @like ESCAPE '\\' OR m.name LIKE @like ESCAPE '\\')
      AND (@category IS NULL OR m.category_key = @category)
      AND (@kind IS NULL OR d.kind = @kind)
    ORDER BY inTitle DESC, d.title
    LIMIT 50`).all({ like, category: req.query.category || null, kind: req.query.kind || null }) as
    { slug: string; menuSlug: string; title: string; kind: string; status: string; category: string; menuName: string; body: string; inTitle: number }[];

  const lower = q.toLowerCase();
  return rows.map(({ body, inTitle, ...r }) => {
    const text = body ?? "";
    const at = text.toLowerCase().indexOf(lower);
    let count = 0;
    for (let i = text.toLowerCase().indexOf(lower); i >= 0; i = text.toLowerCase().indexOf(lower, i + lower.length)) count++;
    const snippet = at < 0 ? "" : (at > 60 ? "…" : "") + text.slice(Math.max(0, at - 60), at + q.length + 100).replace(/\s+/g, " ") + "…";
    return { ...r, inTitle: !!inTitle, matches: count, snippet };
  });
});

// 변환 결과. 예: /api/convert/pdf/<메뉴>/<문서>/<버전>/slides.pptx
app.get<{ Params: { to: string; "*": string } }>("/api/convert/:to/*", async (req, reply) => {
  const to = req.params.to as Target;
  if (to !== "pdf" && to !== "svg") return reply.code(400).send({ error: "pdf 또는 svg만 지원합니다" });
  const out = await convert(DOCS_ROOT, CACHE_DIR, decodeURIComponent(req.params["*"]), to);
  reply.header("Cache-Control", "private, max-age=31536000, immutable");
  return reply.type(to === "pdf" ? "application/pdf" : "image/svg+xml").send(createReadStream(out));
});

app.post("/api/reindex", async () => { reindex("manual"); return { ok: true, warnings }; });

app.get("/api/events", (req, reply) => {
  reply.hijack();
  const res = reply.raw;
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  res.write(": connected\n\n");
  clients.add(res);
  const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
  req.raw.on("close", () => { clearInterval(ping); clients.delete(res); });
});

// 사이트 밖에서 docs/를 고친 경우(에디터, Claude Code, git pull)도 반영한다. 여러 변경은 묶어서 한 번만 다시 색인한다.
let timer: NodeJS.Timeout | undefined;
watch(DOCS_ROOT, {
  ignoreInitial: true,
  ignored: (p) => p.split(sep).some((seg) => seg.startsWith(".")),
  awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
}).on("all", () => {
  clearTimeout(timer);
  timer = setTimeout(() => reindex("watch"), 300);
});

reindex("start");
await app.listen({ host: "127.0.0.1", port: PORT });
