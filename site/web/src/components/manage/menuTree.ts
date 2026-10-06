import type { Category, MenuNode } from "../../lib/api.ts";

export interface FlatMenu { menu: MenuNode; depth: number; category: Category; parent: MenuNode | null; siblings: MenuNode[]; index: number }

/** 대분류 → 메뉴 트리를 들여쓰기 목록으로 편다. 선택 상자와 순서 이동에서 같이 쓴다. */
export function flattenMenus(categories: Category[]): FlatMenu[] {
  const out: FlatMenu[] = [];
  const walk = (list: MenuNode[], depth: number, category: Category, parent: MenuNode | null) =>
    list.forEach((menu, index) => {
      out.push({ menu, depth, category, parent, siblings: list, index });
      walk(menu.menus, depth + 1, category, menu);
    });
  categories.forEach((c) => walk(c.menus, 0, c, null));
  return out;
}

export const contains = (node: MenuNode, slug: string): boolean =>
  node.slug === slug || node.menus.some((m) => contains(m, slug));
