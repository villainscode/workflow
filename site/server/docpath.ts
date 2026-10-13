import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * 문서 폴더 위치. 문서는 메뉴 폴더 바로 아래(docs/<메뉴>/<문서>/)나, 다른 문서 폴더 안(하위 문서: docs/<메뉴>/<상위>/<하위>/)에 있다.
 * 문서 폴더 안의 하위 폴더 중 버전 폴더(vN.N)가 아니고 meta.yaml이 있는 것이 하위 문서다.
 * 문서 slug는 메뉴 안에서(깊이와 상관없이) 하나뿐이라, 주소·API는 계속 메뉴 + 문서 slug로 문서를 가리킨다.
 */

export const VERSION_DIR_RE = /^v\d+\.\d+$/;

export interface DocDir { slug: string; dir: string; parent: string | null; depth: number }

/** 메뉴 폴더 안의 문서 폴더를 위에서부터(상위 문서가 하위보다 먼저) 모두 찾는다 */
export function listDocDirs(docsRoot: string, menu: string): DocDir[] {
  const out: DocDir[] = [];
  const visit = (dir: string, parent: string | null, depth: number) => {
    if (!existsSync(dir)) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name.startsWith(".") || e.name.startsWith("_") || VERSION_DIR_RE.test(e.name)) continue;
      const p = join(dir, e.name);
      // 메뉴 바로 아래 폴더는 meta.yaml이 없어도 문서 후보로 돌려준다(스캔이 "meta.yaml 없음" 경고를 낸다)
      if (depth > 0 && !existsSync(join(p, "meta.yaml"))) continue;
      out.push({ slug: e.name, dir: p, parent, depth });
      if (existsSync(join(p, "meta.yaml"))) visit(p, e.name, depth + 1);
    }
  };
  visit(join(docsRoot, menu), null, 0);
  return out;
}

export function findDocDir(docsRoot: string, menu: string, doc: string): DocDir | null {
  if (!/^[a-z0-9-]+$/.test(menu) || !/^[a-z0-9-]+$/.test(doc)) return null;
  return listDocDirs(docsRoot, menu).find((d) => d.slug === doc && existsSync(join(d.dir, "meta.yaml"))) ?? null;
}

/** 메뉴 안에서 이미 쓰고 있는 문서 slug */
export const docSlugsIn = (docsRoot: string, menu: string) => new Set(listDocDirs(docsRoot, menu).map((d) => d.slug));

/** 한 폴더(메뉴 폴더 또는 문서 폴더) 바로 아래의 문서 폴더 이름 */
export function childDocNames(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith(".") && !e.name.startsWith("_") && !VERSION_DIR_RE.test(e.name) && existsSync(join(dir, e.name, "meta.yaml")))
    .map((e) => e.name);
}

/** 문서 폴더 안의 하위 문서 slug(손자 이하 포함) */
export function descendantSlugs(dir: string): string[] {
  return childDocNames(dir).flatMap((n) => [n, ...descendantSlugs(join(dir, n))]);
}
