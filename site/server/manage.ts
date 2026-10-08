import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseDocument } from "yaml";
import { loadSite, saveSite, type CategoryNode, type MenuNode, type Site } from "./sitefiles.ts";
import { StoreError, slugify } from "./store.ts";

/**
 * 메뉴·대분류·문서 관리. 원본(categories.yaml, menus.yaml, meta.yaml, 폴더)을 고치고, 색인은 호출한 쪽에서 다시 만든다.
 * 메뉴 slug는 docs/ 바로 아래 폴더 이름이므로, 메뉴를 옮기거나 하위로 넣어도 폴더는 그대로다.
 */

type MenusFile = Pick<Site, "categories">;

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TRASH = "_trash";

// ---------- 메뉴 원본: categories.yaml(대분류) + menus.yaml(좌측 트리) ----------

/** 메뉴를 찾아 그 메뉴가 들어 있는 목록과 위치를 돌려준다 */
function locate(data: MenusFile, slug: string): { list: MenuNode[]; index: number; category: CategoryNode } | null {
  const search = (list: MenuNode[], category: CategoryNode): ReturnType<typeof locate> => {
    for (let i = 0; i < list.length; i++) {
      if (list[i].slug === slug) return { list, index: i, category };
      const found = search(list[i].menus ?? [], category);
      if (found) return found;
    }
    return null;
  };
  for (const c of data.categories) {
    c.menus ??= [];
    const found = search(c.menus, c);
    if (found) return found;
  }
  return null;
}

const contains = (node: MenuNode, slug: string): boolean =>
  node.slug === slug || (node.menus ?? []).some((m) => contains(m, slug));

function menuHasDocs(docsRoot: string, slug: string): boolean {
  const dir = join(docsRoot, slug);
  return existsSync(dir) && readdirSync(dir, { withFileTypes: true }).some((e) => e.isDirectory() && !e.name.startsWith("."));
}

export function addMenu(docsRoot: string, category: string, name: string, slug?: string, parent?: string) {
  const data: MenusFile = loadSite(docsRoot);
  const s = slug?.trim() || slugify(name);
  if (!name.trim()) throw new StoreError(400, "메뉴 이름을 입력하세요");
  if (!SLUG_RE.test(s) || s === "doc" || s.startsWith("_")) throw new StoreError(400, "메뉴 slug를 영문 소문자, 숫자, 하이픈으로 입력하세요");
  if (locate(data, s) || existsSync(join(docsRoot, s))) throw new StoreError(409, `메뉴 slug ${s}이(가) 이미 있습니다`);

  let target: MenuNode[];
  let categoryKey = category;
  if (parent) {
    const p = locate(data, parent);
    if (!p) throw new StoreError(404, `상위 메뉴 ${parent}이(가) 없습니다`);
    const node = p.list[p.index];
    target = node.menus ??= [];
    categoryKey = p.category.key;
  } else {
    const c = data.categories.find((x) => x.key === category);
    if (!c) throw new StoreError(404, `대분류 ${category}이(가) 없습니다`);
    target = c.menus ??= [];
  }
  target.push({ slug: s, name: name.trim() });
  saveSite(docsRoot, data);
  return { category: categoryKey, slug: s };
}

export function renameMenu(docsRoot: string, slug: string, name: string) {
  if (!name.trim()) throw new StoreError(400, "메뉴 이름을 입력하세요");
  const data: MenusFile = loadSite(docsRoot);
  const at = locate(data, slug);
  if (!at) throw new StoreError(404, `메뉴 ${slug}이(가) 없습니다`);
  at.list[at.index].name = name.trim();
  saveSite(docsRoot, data);
}

/** 메뉴를 다른 위치로 옮긴다. parent가 없으면 대분류의 최상위, index가 없으면 맨 뒤 */
export function moveMenu(docsRoot: string, slug: string, to: { category: string; parent?: string | null; index?: number }) {
  const data: MenusFile = loadSite(docsRoot);
  const at = locate(data, slug);
  if (!at) throw new StoreError(404, `메뉴 ${slug}이(가) 없습니다`);
  const node = at.list[at.index];
  if (to.parent && contains(node, to.parent)) throw new StoreError(400, "메뉴를 자기 자신이나 하위 메뉴 안으로 옮길 수 없습니다");

  at.list.splice(at.index, 1);
  let target: MenuNode[];
  if (to.parent) {
    const p = locate(data, to.parent);
    if (!p) throw new StoreError(404, `상위 메뉴 ${to.parent}이(가) 없습니다`);
    target = p.list[p.index].menus ??= [];
  } else {
    const c = data.categories.find((x) => x.key === to.category);
    if (!c) throw new StoreError(404, `대분류 ${to.category}이(가) 없습니다`);
    target = c.menus ??= [];
  }
  const index = to.index === undefined ? target.length : Math.max(0, Math.min(to.index, target.length));
  target.splice(index, 0, node);
  saveSite(docsRoot, data);
  updateDocCategories(docsRoot, data);
}

export function deleteMenu(docsRoot: string, slug: string) {
  const data: MenusFile = loadSite(docsRoot);
  const at = locate(data, slug);
  if (!at) throw new StoreError(404, `메뉴 ${slug}이(가) 없습니다`);
  if (at.list[at.index].menus?.length) throw new StoreError(409, "하위 메뉴가 있는 메뉴는 지울 수 없습니다. 하위 메뉴를 먼저 옮기거나 지우세요");
  if (menuHasDocs(docsRoot, slug)) throw new StoreError(409, "문서가 있는 메뉴는 지울 수 없습니다. 문서를 먼저 옮기거나 휴지통으로 보내세요");
  at.list.splice(at.index, 1);
  saveSite(docsRoot, data);
  // 숨김 파일(.DS_Store 등)만 남은 폴더일 때만 지운다. 다른 파일이 있으면 폴더는 그대로 둔다
  const dir = join(docsRoot, slug);
  if (existsSync(dir) && readdirSync(dir).every((n) => n.startsWith("."))) rmSync(dir, { recursive: true, force: true });
}

// ---------- 대분류 ----------

export function addCategory(docsRoot: string, name: string, key?: string) {
  const data: MenusFile = loadSite(docsRoot);
  const k = key?.trim() || slugify(name);
  if (!name.trim()) throw new StoreError(400, "대분류 이름을 입력하세요");
  if (!SLUG_RE.test(k) || k === "doc") throw new StoreError(400, "대분류 key를 영문 소문자, 숫자, 하이픈으로 입력하세요");
  if (data.categories.some((c) => c.key === k)) throw new StoreError(409, `대분류 ${k}이(가) 이미 있습니다`);
  data.categories.push({ key: k, name: name.trim(), menus: [] });
  saveSite(docsRoot, data);
  return { key: k };
}

export function updateCategory(docsRoot: string, key: string, change: { name?: string; index?: number }) {
  const data: MenusFile = loadSite(docsRoot);
  const i = data.categories.findIndex((c) => c.key === key);
  if (i < 0) throw new StoreError(404, `대분류 ${key}이(가) 없습니다`);
  if (change.name !== undefined) {
    if (!change.name.trim()) throw new StoreError(400, "대분류 이름을 입력하세요");
    data.categories[i].name = change.name.trim();
  }
  if (change.index !== undefined) {
    const [c] = data.categories.splice(i, 1);
    data.categories.splice(Math.max(0, Math.min(change.index, data.categories.length)), 0, c);
  }
  saveSite(docsRoot, data);
}

export function deleteCategory(docsRoot: string, key: string) {
  const data: MenusFile = loadSite(docsRoot);
  const c = data.categories.find((x) => x.key === key);
  if (!c) throw new StoreError(404, `대분류 ${key}이(가) 없습니다`);
  if (c.menus?.length) throw new StoreError(409, "메뉴가 있는 대분류는 지울 수 없습니다");
  if (data.categories.length === 1) throw new StoreError(409, "대분류는 하나 이상 있어야 합니다");
  data.categories = data.categories.filter((x) => x.key !== key);
  saveSite(docsRoot, data);
}

/** 메뉴가 다른 대분류로 옮겨지면 그 메뉴(하위 포함) 문서의 meta.yaml category도 맞춘다 */
function updateDocCategories(docsRoot: string, data: MenusFile) {
  const owner = new Map<string, string>();
  const walk = (list: MenuNode[] = [], key: string) => list.forEach((m) => { owner.set(m.slug, key); walk(m.menus, key); });
  data.categories.forEach((c) => walk(c.menus, c.key));
  for (const [menu, category] of owner) {
    const dir = join(docsRoot, menu);
    if (!existsSync(dir)) continue;
    for (const d of readdirSync(dir, { withFileTypes: true })) {
      const metaPath = join(dir, d.name, "meta.yaml");
      if (!d.isDirectory() || !existsSync(metaPath)) continue;
      const meta = parseDocument(readFileSync(metaPath, "utf8"));
      if (meta.get("category") !== category) {
        meta.set("category", category);
        writeFileSync(metaPath, meta.toString({ lineWidth: 0, nullStr: "" }));
      }
    }
  }
}

// ---------- 문서 ----------

const STATUSES = new Set(["draft", "review", "approved"]);

function docMetaPath(docsRoot: string, menu: string, doc: string) {
  const p = join(docsRoot, menu, doc, "meta.yaml");
  if (!existsSync(p)) throw new StoreError(404, `문서 ${menu}/${doc}이(가) 없습니다`);
  return p;
}

export function updateDoc(docsRoot: string, menu: string, doc: string, change: { title?: string; status?: string; origin?: string | null }) {
  const metaPath = docMetaPath(docsRoot, menu, doc);
  const meta = parseDocument(readFileSync(metaPath, "utf8"));
  if (change.title !== undefined) {
    if (!change.title.trim()) throw new StoreError(400, "제목을 입력하세요");
    meta.set("title", change.title.trim());
  }
  if (change.status !== undefined) {
    if (!STATUSES.has(change.status)) throw new StoreError(400, "상태는 draft, review, approved 중 하나입니다");
    meta.set("status", change.status);
  }
  // 외부에서 가져온 문서의 출처(3.3). 빈 값이면 지운다
  if (change.origin !== undefined) {
    const o = change.origin?.trim() ?? "";
    if (o && !/^https?:\/\/\S+$/.test(o)) throw new StoreError(400, "출처는 http:// 또는 https:// 주소여야 합니다");
    if (o) meta.set("origin_url", o); else meta.delete("origin_url");
  }
  writeFileSync(metaPath, meta.toString({ lineWidth: 0, nullStr: "" }));
}

/** 문서 폴더를 다른 메뉴 폴더로 옮긴다. 같은 slug가 있으면 뒤에 숫자를 붙인다 */
export function moveDoc(docsRoot: string, menu: string, doc: string, toMenu: string) {
  const metaPath = docMetaPath(docsRoot, menu, doc);
  if (menu === toMenu) return { menu, doc };
  const data: MenusFile = loadSite(docsRoot);
  const target = locate(data, toMenu);
  if (!target) throw new StoreError(404, `메뉴 ${toMenu}이(가) 없습니다`);

  let slug = doc;
  for (let i = 2; existsSync(join(docsRoot, toMenu, slug)); i++) slug = `${doc}-${i}`;
  const meta = parseDocument(readFileSync(metaPath, "utf8"));
  meta.set("menu", toMenu);
  meta.set("category", target.category.key);
  writeFileSync(metaPath, meta.toString({ lineWidth: 0, nullStr: "" }));
  mkdirSync(join(docsRoot, toMenu), { recursive: true });
  renameSync(join(docsRoot, menu, doc), join(docsRoot, toMenu, slug));
  return { menu: toMenu, doc: slug, category: target.category.key };
}

// ---------- 휴지통 ----------
// docs/_trash/<삭제 시각>--<메뉴>--<문서>/ 로 옮긴다. 스캔은 _로 시작하는 폴더를 건너뛰므로 목록에서 사라진다.

// 삭제 시각(로컬 시간) yyyyMMddHHmmss
const stamp = () => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};
const TRASH_RE = /^(\d{14})--([a-z0-9-]+)--([a-z0-9-]+)$/;

export function trashDoc(docsRoot: string, menu: string, doc: string) {
  docMetaPath(docsRoot, menu, doc);
  const dir = join(docsRoot, TRASH);
  mkdirSync(dir, { recursive: true });
  const id = `${stamp()}--${menu}--${doc}`;
  renameSync(join(docsRoot, menu, doc), join(dir, id));
  return { id };
}

export function listTrash(docsRoot: string) {
  const dir = join(docsRoot, TRASH);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((id) => {
    const m = TRASH_RE.exec(id);
    if (!m) return [];
    let title = m[3];
    try { title = (parseDocument(readFileSync(join(dir, id, "meta.yaml"), "utf8")).get("title") as string) ?? title; } catch { /* 제목 없으면 slug */ }
    const t = m[1];
    return [{ id, menu: m[2], doc: m[3], title, deletedAt: `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)} ${t.slice(8, 10)}:${t.slice(10, 12)}` }];
  }).sort((a, b) => b.id.localeCompare(a.id));
}

export function restoreDoc(docsRoot: string, id: string, toMenu?: string) {
  const m = TRASH_RE.exec(id);
  const src = join(docsRoot, TRASH, id);
  if (!m || !existsSync(src)) throw new StoreError(404, "휴지통에 없는 항목입니다");
  const menu = toMenu || m[2];
  const data: MenusFile = loadSite(docsRoot);
  const target = locate(data, menu);
  if (!target) throw new StoreError(409, `원래 메뉴(${menu})가 없습니다. 복원할 메뉴를 고르세요`);

  let slug = m[3];
  for (let i = 2; existsSync(join(docsRoot, menu, slug)); i++) slug = `${m[3]}-${i}`;
  const metaPath = join(src, "meta.yaml");
  if (existsSync(metaPath)) {
    const meta = parseDocument(readFileSync(metaPath, "utf8"));
    meta.set("menu", menu);
    meta.set("category", target.category.key);
    writeFileSync(metaPath, meta.toString({ lineWidth: 0, nullStr: "" }));
  }
  mkdirSync(join(docsRoot, menu), { recursive: true });
  renameSync(src, join(docsRoot, menu, slug));
  return { menu, doc: slug, category: target.category.key };
}

export function purgeDoc(docsRoot: string, id: string) {
  if (!TRASH_RE.test(id)) throw new StoreError(404, "휴지통에 없는 항목입니다");
  const src = join(docsRoot, TRASH, id);
  if (!existsSync(src)) throw new StoreError(404, "휴지통에 없는 항목입니다");
  rmSync(src, { recursive: true, force: true });
  const dir = join(docsRoot, TRASH);
  if (readdirSync(dir).length === 0) rmdirSync(dir);
}
