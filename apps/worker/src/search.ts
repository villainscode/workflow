import type { Workspace } from "./env.ts";

/** 검색: 제목·메뉴 이름·본문 부분 일치(trigram 색인 위의 LIKE). 제목에 맞은 문서를 먼저(로컬 GET /api/search와 같은 모양) */
export async function search(db: D1Database, ws: Workspace, q: string, category?: string, kind?: string) {
  q = q.trim();
  if (!q) return [];
  const like = `%${q.replace(/[\\%_]/g, (c) => "\\" + c)}%`;
  const { results } = await db.prepare(`
    SELECT d.slug, m.slug AS menuSlug, d.title, d.kind, d.status, d.current_version AS currentVersion, m.category_key AS category, m.name AS menuName,
           s.body, (s.title LIKE ?1 ESCAPE '\\') AS inTitle
    FROM search s JOIN document d ON d.id = s.document_id JOIN menu m ON m.id = d.menu_id
    WHERE s.workspace_id = ?2 AND d.deleted_at IS NULL
      AND (s.title LIKE ?1 ESCAPE '\\' OR s.body LIKE ?1 ESCAPE '\\' OR m.name LIKE ?1 ESCAPE '\\')
      AND (?3 IS NULL OR m.category_key = ?3)
      AND (?4 IS NULL OR d.kind = ?4)
    ORDER BY inTitle DESC, d.title
    LIMIT 50`).bind(like, ws.id, category || null, kind || null)
    .all<{ slug: string; menuSlug: string; title: string; kind: string; status: string; currentVersion: string; category: string; menuName: string; body: string; inTitle: number }>();
  const lower = q.toLowerCase();
  return results.map(({ body, inTitle, ...r }) => {
    const text = body ?? "";
    const low = text.toLowerCase();
    const at = low.indexOf(lower);
    let count = 0;
    for (let i = at; i >= 0; i = low.indexOf(lower, i + lower.length)) count++;
    const snippet = at < 0 ? "" : (at > 60 ? "…" : "") + text.slice(Math.max(0, at - 60), at + q.length + 100).replace(/\s+/g, " ") + "…";
    return { ...r, inTitle: !!inTitle, matches: count, snippet };
  });
}
