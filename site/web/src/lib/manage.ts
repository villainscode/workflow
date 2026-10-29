import { useQuery } from "@tanstack/react-query";
import { API } from "./base.ts";

/** 관리 API. 실패하면 서버가 준 한국어 메시지로 Error를 던진다. */
async function call<T = { ok: true }>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(data.error ?? `${res.status} 오류`);
  return data as T;
}

export const manage = {
  addMenu: (category: string, name: string, slug?: string, parent?: string) =>
    call<{ slug: string }>("POST", `${API}/menus`, { category, name, slug: slug || undefined, parent }),
  renameMenu: (slug: string, name: string) => call("PATCH", `${API}/menus/${slug}`, { name }),
  moveMenu: (slug: string, to: { category: string; parent?: string | null; index?: number }) =>
    call("POST", `${API}/menus/${slug}/move`, to),
  /** 안의 문서는 모두 휴지통으로 간다 */
  deleteMenu: (slug: string) => call<{ trashed: number }>("DELETE", `${API}/menus/${slug}`),

  addCategory: (name: string, key?: string) => call<{ key: string }>("POST", `${API}/categories`, { name, key: key || undefined }),
  updateCategory: (key: string, change: { name?: string; index?: number }) => call("PATCH", `${API}/categories/${key}`, change),
  deleteCategory: (key: string) => call("DELETE", `${API}/categories/${key}`),

  updateDoc: (menu: string, doc: string, change: { title?: string; status?: string; origin?: string }) =>
    call("PATCH", `${API}/docs/${menu}/${doc}`, change),
  /** to.parent: 상위 문서 slug(null이면 메뉴 바로 아래), to.index: 그 자리 안 순서(없으면 맨 뒤) */
  moveDoc: (menu: string, doc: string, to: { menu: string; parent?: string | null; index?: number }) =>
    call<{ menu: string; doc: string; category: string }>("POST", `${API}/docs/${menu}/${doc}/move`, to),
  release: (menu: string, doc: string) =>
    call<{ menu: string; doc: string; from: string; version: string }>("POST", `${API}/docs/${menu}/${doc}/release`),
  trashDoc: (menu: string, doc: string) => call<{ id: string }>("DELETE", `${API}/docs/${menu}/${doc}`),

  restore: (id: string, menu?: string) =>
    call<{ menu: string; doc: string; category: string }>("POST", `${API}/trash/${id}/restore`, { menu }),
  purge: (id: string) => call("DELETE", `${API}/trash/${id}`),
};

export interface TrashItem { id: string; menu: string; doc: string; title: string; deletedAt: string }
export const useTrash = () =>
  useQuery({ queryKey: ["trash"], queryFn: async () => (await fetch(`${API}/trash`)).json() as Promise<TrashItem[]> });

export interface SearchHit {
  slug: string; menuSlug: string; title: string; kind: string; status: string; currentVersion: string; category: string; menuName: string;
  inTitle: boolean; matches: number; snippet: string;
}
export const useSearch = (q: string, category?: string) =>
  useQuery({
    queryKey: ["search", q, category ?? ""],
    queryFn: async () => {
      const p = new URLSearchParams({ q });
      if (category) p.set("category", category);
      return (await fetch(`${API}/search?${p}`)).json() as Promise<SearchHit[]>;
    },
    enabled: q.trim().length > 0,
    placeholderData: (prev) => prev,
  });
