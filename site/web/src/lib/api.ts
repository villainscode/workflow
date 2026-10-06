import { useQuery } from "@tanstack/react-query";

export interface DocSummary {
  slug: string; menuSlug: string; title: string; kind: string; status: string; currentVersion: string;
}
export interface MenuNode { slug: string; name: string; documents: DocSummary[]; menus: MenuNode[] }
export interface Category { key: string; name: string; menus: MenuNode[] }
export interface Tree { categories: Category[]; warnings: string[] }

export interface VersionFile { id: number; path: string; mime: string; size: number; sha256: string; isEntry: boolean; url: string }
export interface DocVersion { id: number; version: string; note: string | null; source: string | null; createdAt: string | null; files: VersionFile[] }
export interface DocDetail {
  id: number; menuSlug: string; slug: string; title: string; kind: string; type: string | null; sdlc: string | null;
  status: string; currentVersion: string; notionUrl: string | null; gdriveUrl: string | null; versions: DocVersion[];
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json() as Promise<T>;
}

export const useTree = () => useQuery({ queryKey: ["tree"], queryFn: () => getJson<Tree>("/api/tree") });

export const useDoc = (menu: string, doc: string) =>
  useQuery({ queryKey: ["doc", menu, doc], queryFn: () => getJson<DocDetail>(`/api/docs/${menu}/${doc}`) });
