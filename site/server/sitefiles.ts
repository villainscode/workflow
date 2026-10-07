import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Document, parse } from "yaml";

/**
 * 사이트 메뉴 원본 두 파일을 읽고 쓴다.
 *   docs/_site/categories.yaml  상단 메뉴(대분류): key, name, 순서
 *   docs/_site/menus.yaml       좌측 메뉴 트리: 대분류 key → 메뉴 목록
 * 관리 코드는 둘을 합친 Site(대분류마다 menus를 단 목록)로 다루고, 저장할 때 다시 두 파일로 나눈다.
 */

export interface MenuNode { slug: string; name: string; menus?: MenuNode[] }
export interface CategoryNode { key: string; name: string; menus?: MenuNode[] }
export interface Site { categories: CategoryNode[]; orphanTrees: string[] }

const CATEGORIES = "_site/categories.yaml";
const MENUS = "_site/menus.yaml";

const read = (docsRoot: string, file: string) => {
  const p = join(docsRoot, file);
  return existsSync(p) ? readFileSync(p, "utf8") : "";
};
// 파일 맨 위 # 주석 줄. yaml 라이브러리는 이 주석을 첫 키에 붙여 버리므로 원문에서 그대로 떼어 둔다
const header = (raw: string) => raw.match(/^(?:#.*\n)*/)?.[0] ?? "";

function readTrees(docsRoot: string): Record<string, MenuNode[]> {
  const trees = (parse(read(docsRoot, MENUS)) as { menus?: Record<string, MenuNode[] | null> } | null)?.menus ?? {};
  return Object.fromEntries(Object.entries(trees).map(([k, v]) => [k, v ?? []]));
}

export function loadSite(docsRoot: string): Site {
  const cats = ((parse(read(docsRoot, CATEGORIES)) as { categories?: { key: string; name: string }[] } | null)?.categories ?? [])
    .map((c) => ({ key: String(c.key), name: String(c.name) }));
  const trees = readTrees(docsRoot);
  return {
    categories: cats.map((c) => ({ ...c, menus: trees[c.key] ?? [] })),
    // categories.yaml에 없는 대분류 key의 트리. 지우지 않고 보존하며 색인 경고로 알린다
    orphanTrees: Object.keys(trees).filter((k) => !cats.some((c) => c.key === k) && trees[k].length > 0),
  };
}

function writeIfChanged(docsRoot: string, file: string, content: string) {
  if (read(docsRoot, file) !== content) writeFileSync(join(docsRoot, file), content);
}

export function saveSite(docsRoot: string, site: Pick<Site, "categories">) {
  // 빈 하위 메뉴 목록은 지워 파일을 깔끔하게 둔다
  const clean = (list: MenuNode[] = []): MenuNode[] =>
    list.map((m) => (m.menus?.length ? { slug: m.slug, name: m.name, menus: clean(m.menus) } : { slug: m.slug, name: m.name }));

  const cats = new Document({ categories: site.categories.map(({ key, name }) => ({ key, name })) });
  writeIfChanged(docsRoot, CATEGORIES, header(read(docsRoot, CATEGORIES)) + cats.toString({ lineWidth: 0 }));

  const known = new Set(site.categories.map((c) => c.key));
  const orphans = Object.entries(readTrees(docsRoot)).filter(([k, v]) => !known.has(k) && v.length > 0);
  const trees = new Document({ menus: Object.fromEntries([...site.categories.map((c) => [c.key, clean(c.menus)]), ...orphans]) });
  writeIfChanged(docsRoot, MENUS, header(read(docsRoot, MENUS)) + trees.toString({ lineWidth: 0 }));
}
