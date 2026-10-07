import { useQuery } from "@tanstack/react-query";

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
    call<{ slug: string }>("POST", "/api/menus", { category, name, slug: slug || undefined, parent }),
  renameMenu: (slug: string, name: string) => call("PATCH", `/api/menus/${slug}`, { name }),
  moveMenu: (slug: string, to: { category: string; parent?: string | null; index?: number }) =>
    call("POST", `/api/menus/${slug}/move`, to),
  deleteMenu: (slug: string) => call("DELETE", `/api/menus/${slug}`),

  addCategory: (name: string, key?: string) => call<{ key: string }>("POST", "/api/categories", { name, key: key || undefined }),
  updateCategory: (key: string, change: { name?: string; index?: number }) => call("PATCH", `/api/categories/${key}`, change),
  deleteCategory: (key: string) => call("DELETE", `/api/categories/${key}`),

  updateDoc: (menu: string, doc: string, change: { title?: string; status?: string }) =>
    call("PATCH", `/api/docs/${menu}/${doc}`, change),
  moveDoc: (menu: string, doc: string, to: string) =>
    call<{ menu: string; doc: string; category: string }>("POST", `/api/docs/${menu}/${doc}/move`, { menu: to }),
  release: (menu: string, doc: string) =>
    call<{ menu: string; doc: string; from: string; version: string }>("POST", `/api/docs/${menu}/${doc}/release`),
  trashDoc: (menu: string, doc: string) => call<{ id: string }>("DELETE", `/api/docs/${menu}/${doc}`),

  restore: (id: string, menu?: string) =>
    call<{ menu: string; doc: string; category: string }>("POST", `/api/trash/${id}/restore`, { menu }),
  purge: (id: string) => call("DELETE", `/api/trash/${id}`),
};

export interface TrashItem { id: string; menu: string; doc: string; title: string; deletedAt: string }
export const useTrash = () =>
  useQuery({ queryKey: ["trash"], queryFn: async () => (await fetch("/api/trash")).json() as Promise<TrashItem[]> });

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
      return (await fetch(`/api/search?${p}`)).json() as Promise<SearchHit[]>;
    },
    enabled: q.trim().length > 0,
    placeholderData: (prev) => prev,
  });
