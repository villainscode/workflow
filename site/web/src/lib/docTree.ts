import type { DocSummary } from "./api.ts";

/** 메뉴 안 문서 목록(parent로 연결)을 트리로. 서버가 준 순서(order → 제목)를 그대로 따른다 */
export interface DocNode { doc: DocSummary; children: DocNode[] }

export function buildDocTree(docs: DocSummary[]): DocNode[] {
  const slugs = new Set(docs.map((d) => d.slug));
  const make = (parent: string | null): DocNode[] =>
    docs.filter((d) => (parent === null ? !d.parent || !slugs.has(d.parent) : d.parent === parent))
      .map((doc) => ({ doc, children: make(doc.slug) }));
  return make(null);
}

/** 트리 순서로 펴고 깊이를 붙인다(선택 상자 들여쓰기용) */
export function flattenDocs(docs: DocSummary[]): { doc: DocSummary; depth: number }[] {
  const out: { doc: DocSummary; depth: number }[] = [];
  const walk = (nodes: DocNode[], depth: number) => nodes.forEach((n) => { out.push({ doc: n.doc, depth }); walk(n.children, depth + 1); });
  walk(buildDocTree(docs), 0);
  return out;
}
