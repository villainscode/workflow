import { mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { DDL, categories, menus, documents, documentVersions, versionFiles } from "./schema.ts";
import { scanDocs } from "./scan.ts";

const SITE_ROOT = resolve(import.meta.dirname, "..");
const REPO_ROOT = resolve(SITE_ROOT, "..");
const DOCS_ROOT = join(REPO_ROOT, "docs");
const PORT = Number(process.env.PORT ?? 5174);

mkdirSync(join(SITE_ROOT, "data"), { recursive: true });
const sqlite = new Database(join(SITE_ROOT, "data/index.db"));
sqlite.pragma("journal_mode = WAL");
const db = drizzle(sqlite);

let warnings: string[] = [];
function reindex() {
  sqlite.exec(DDL);
  warnings = scanDocs(db, DOCS_ROOT, REPO_ROOT);
  warnings.forEach((w) => app.log.warn(w));
}

const app = Fastify({ logger: { level: "info" } });

// docs/ 원본 파일. HTML 문서의 상대 경로 리소스와 링크도 이 경로 아래에서 풀린다.
await app.register(fastifyStatic, { root: DOCS_ROOT, prefix: "/files/", dotfiles: "ignore", index: false });

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

app.post("/api/reindex", async () => { reindex(); return { ok: true, warnings }; });

reindex();
await app.listen({ host: "127.0.0.1", port: PORT });
