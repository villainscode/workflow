import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { parse } from "yaml";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { sql } from "drizzle-orm";
import { topMenus, menus, documents, documentVersions, versionFiles } from "./schema.ts";
import { loadSite, type MenuNode } from "./sitefiles.ts";
import { listDocDirs } from "./docpath.ts";
import { mimeOf } from "@workflow/core/mime";
import { isSearchable, searchText as coreSearchText } from "@workflow/core/search-text";

interface MetaFile {
  title: string; category: string; menu: string; kind: string; type?: string; sdlc?: string;
  status?: string; order?: number; current: string; notion_url?: string | null; gdrive_url?: string | null; origin_url?: string | null;
  versions: { version: string; entry: string; note?: string; source?: string; created?: string | Date }[];
}

export { mimeOf };

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.name.startsWith(".")) return [];
    const p = join(dir, e.name);
    return e.isDirectory() ? walk(p) : [p];
  });
}

/** 검색용 본문(규칙은 core의 searchText) */
const searchText = (path: string) => (isSearchable(path) ? coreSearchText(path, readFileSync(path, "utf8")) : "");

const asDate = (v: unknown) => (v instanceof Date ? v.toISOString().slice(0, 10) : v == null ? null : String(v));

/** docs/를 읽어 색인 테이블을 채운다. 문제가 있어도 멈추지 않고 경고로 모은다. */
export function scanDocs(db: BetterSQLite3Database, docsRoot: string, repoRoot: string): string[] {
  const warnings: string[] = [];
  const site = loadSite(docsRoot);
  site.orphanTrees.forEach((k) => warnings.push(`menus.yaml: categories.yaml에 없는 대분류 key의 메뉴 트리 '${k}'`));
  const known = new Set<string>();

  db.transaction((tx) => {
    site.categories.forEach((c, ci) => {
      tx.insert(topMenus).values({ key: c.key, name: c.name, sort: ci }).run();
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

      // 하위 문서(문서 폴더 안의 문서 폴더)까지. slug는 메뉴 안에서 하나뿐이어야 한다
      const seen = new Set<string>();
      for (const docDir of listDocDirs(docsRoot, menuDir.name)) {
        const base = docDir.dir;
        const metaPath = join(base, "meta.yaml");
        if (seen.has(docDir.slug)) { warnings.push(`${relative(repoRoot, base)}: 같은 메뉴에 문서 slug ${docDir.slug}이(가) 이미 있음`); continue; }
        seen.add(docDir.slug);
        if (!existsSync(metaPath)) { warnings.push(`${relative(repoRoot, base)}: meta.yaml 없음`); continue; }

        let meta: MetaFile;
        try { meta = parse(readFileSync(metaPath, "utf8")) as MetaFile; }
        catch (e) { warnings.push(`${relative(repoRoot, metaPath)}: yaml 오류 ${(e as Error).message}`); continue; }
        if (meta.menu !== menuDir.name) warnings.push(`${relative(repoRoot, metaPath)}: menu(${meta.menu})가 폴더(${menuDir.name})와 다름`);

        const doc = tx.insert(documents).values({
          menuSlug: menuDir.name, slug: docDir.slug, parentSlug: docDir.parent,
          sort: typeof meta.order === "number" ? meta.order : null, title: meta.title, kind: meta.kind, type: meta.type ?? null,
          sdlc: meta.sdlc ?? null, status: meta.status ?? "draft", currentVersion: meta.current,
          notionUrl: meta.notion_url ?? null, gdriveUrl: meta.gdrive_url ?? null, originUrl: meta.origin_url ?? null,
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
          if (entryFound && v.version === meta.current) {
            tx.run(sql`INSERT INTO search (document_id, title, body) VALUES (${doc.id}, ${meta.title}, ${searchText(join(vDir, v.entry))})`);
          }
        }
      }
    }
  });
  return warnings;
}
