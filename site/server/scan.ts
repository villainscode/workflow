import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, extname } from "node:path";
import { parse } from "yaml";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { categories, menus, documents, documentVersions, versionFiles } from "./schema.ts";

interface MenuNode { slug: string; name: string; menus?: MenuNode[] }
interface MenusFile { categories: { key: string; name: string; menus?: MenuNode[] }[] }
interface MetaFile {
  title: string; category: string; menu: string; kind: string; type?: string; sdlc?: string;
  status?: string; current: string; notion_url?: string | null; gdrive_url?: string | null;
  versions: { version: string; entry: string; note?: string; source?: string; created?: string | Date }[];
}

const MIME: Record<string, string> = {
  ".html": "text/html", ".htm": "text/html", ".md": "text/markdown", ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
  ".pdf": "application/pdf",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".csv": "text/csv", ".json": "application/json", ".yaml": "text/yaml", ".yml": "text/yaml",
  ".drawio": "application/vnd.jgraph.mxfile", ".mmd": "text/plain",
};
export const mimeOf = (p: string) => MIME[extname(p).toLowerCase()] ?? "text/plain";

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.name.startsWith(".")) return [];
    const p = join(dir, e.name);
    return e.isDirectory() ? walk(p) : [p];
  });
}

const asDate = (v: unknown) => (v instanceof Date ? v.toISOString().slice(0, 10) : v == null ? null : String(v));

/** docs/를 읽어 색인 테이블을 채운다. 문제가 있어도 멈추지 않고 경고로 모은다. */
export function scanDocs(db: BetterSQLite3Database, docsRoot: string, repoRoot: string): string[] {
  const warnings: string[] = [];
  const menusFile = parse(readFileSync(join(docsRoot, "_site/menus.yaml"), "utf8")) as MenusFile;
  const known = new Set<string>();

  db.transaction((tx) => {
    menusFile.categories.forEach((c, ci) => {
      tx.insert(categories).values({ key: c.key, name: c.name, sort: ci }).run();
      const addMenus = (list: MenuNode[] | undefined, parent: string | null) =>
        (list ?? []).forEach((m, mi) => {
          if (known.has(m.slug)) return warnings.push(`menus.yaml: 메뉴 slug 중복 ${m.slug}`);
          known.add(m.slug);
          tx.insert(menus).values({ slug: m.slug, categoryKey: c.key, parentSlug: parent, name: m.name, sort: mi }).run();
          addMenus(m.menus, m.slug);
        });
      addMenus(c.menus, null);
    });

    for (const menuDir of readdirSync(docsRoot, { withFileTypes: true })) {
      if (!menuDir.isDirectory() || menuDir.name.startsWith("_") || menuDir.name.startsWith(".")) continue;
      if (!known.has(menuDir.name)) { warnings.push(`docs/${menuDir.name}: menus.yaml에 없는 메뉴`); continue; }

      for (const docDir of readdirSync(join(docsRoot, menuDir.name), { withFileTypes: true })) {
        if (!docDir.isDirectory() || docDir.name.startsWith(".")) continue;
        const base = join(docsRoot, menuDir.name, docDir.name);
        const metaPath = join(base, "meta.yaml");
        if (!existsSync(metaPath)) { warnings.push(`${relative(repoRoot, base)}: meta.yaml 없음`); continue; }

        let meta: MetaFile;
        try { meta = parse(readFileSync(metaPath, "utf8")) as MetaFile; }
        catch (e) { warnings.push(`${relative(repoRoot, metaPath)}: yaml 오류 ${(e as Error).message}`); continue; }
        if (meta.menu !== menuDir.name) warnings.push(`${relative(repoRoot, metaPath)}: menu(${meta.menu})가 폴더(${menuDir.name})와 다름`);

        const doc = tx.insert(documents).values({
          menuSlug: menuDir.name, slug: docDir.name, title: meta.title, kind: meta.kind, type: meta.type ?? null,
          sdlc: meta.sdlc ?? null, status: meta.status ?? "draft", currentVersion: meta.current,
          notionUrl: meta.notion_url ?? null, gdriveUrl: meta.gdrive_url ?? null,
        }).returning({ id: documents.id }).get();

        for (const v of meta.versions ?? []) {
          const vDir = join(base, v.version);
          if (!existsSync(vDir)) { warnings.push(`${relative(repoRoot, vDir)}: 버전 폴더 없음`); continue; }
          const ver = tx.insert(documentVersions).values({
            documentId: doc.id, version: v.version, note: v.note ?? null, source: v.source ?? null, createdAt: asDate(v.created),
          }).returning({ id: documentVersions.id }).get();

          let entryFound = false;
          for (const f of walk(vDir)) {
            const rel = relative(vDir, f);
            const isEntry = rel === v.entry;
            entryFound ||= isEntry;
            const buf = readFileSync(f);
            tx.insert(versionFiles).values({
              versionId: ver.id, path: relative(repoRoot, f), mime: mimeOf(f), size: statSync(f).size,
              sha256: createHash("sha256").update(buf).digest("hex"), isEntry,
            }).run();
          }
          if (!entryFound) warnings.push(`${relative(repoRoot, vDir)}: entry 파일(${v.entry}) 없음`);
        }
      }
    }
  });
  return warnings;
}
