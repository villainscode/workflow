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
import { StoreError, addMenu, upload, type IncomingFile } from "./store.ts";
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

app.post<{ Body: { category: string; name: string; slug?: string } }>("/api/menus", async (req) => {
  const result = addMenu(DOCS_ROOT, req.body.category, req.body.name, req.body.slug);
  reindex("menu");
  return result;
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
