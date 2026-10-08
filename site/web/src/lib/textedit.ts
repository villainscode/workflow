import { useQuery } from "@tanstack/react-query";

/** 2.0 텍스트 편집 API */
export interface Segment { id: number; text: string; hash: string; multiline: boolean; group: string; svg?: boolean; fmt?: string }
export interface SegmentList { format: "html" | "docx" | "pptx" | "xlsx"; version: string; entry: string; segments: Segment[] }

export const TEXT_EDITABLE = /\.(html?|docx|pptx|xlsx)$/i;

export const useSegments = (menu: string, doc: string, version: string) =>
  useQuery({
    queryKey: ["segments", menu, doc, version],
    queryFn: async () => {
      const res = await fetch(`/api/docs/${menu}/${doc}/segments?v=${encodeURIComponent(version)}`);
      if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `${res.status}`);
      return res.json() as Promise<SegmentList>;
    },
    staleTime: Infinity,
  });

export async function saveTextEdit(menu: string, doc: string, body: {
  baseVersion: string; changes: { id: number; hash: string; text: string }[]; note?: string;
}): Promise<{ version: string; changed: number }> {
  const res = await fetch(`/api/docs/${menu}/${doc}/text-edit`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string; version: string; changed: number };
  if (!res.ok) throw new Error(data.error ?? `${res.status} 오류`);
  return data;
}

export const editViewUrl = (menu: string, doc: string, version: string) =>
  `/api/docs/${menu}/${doc}/edit-view?v=${encodeURIComponent(version)}`;

// 저장 전 작성 내용(바뀐 조각 id → 글자)을 브라우저에 임시 보관한다. 저장소가 막혀 있으면 조용히 넘어간다
const key = (id: string) => `workflow:textdraft:${id}`;
export function loadTextDraft(id: string): Record<string, string> | null {
  try { const v = localStorage.getItem(key(id)); return v ? JSON.parse(v) : null; } catch { return null; }
}
export function saveTextDraft(id: string, changes: Map<number, string>) {
  try {
    if (changes.size === 0) localStorage.removeItem(key(id));
    else localStorage.setItem(key(id), JSON.stringify(Object.fromEntries(changes)));
  } catch { /* 보관 실패는 무시 */ }
}
export function clearTextDraft(id: string) {
  try { localStorage.removeItem(key(id)); } catch { /* 무시 */ }
}
