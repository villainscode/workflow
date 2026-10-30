import type { Bindings } from "./env.ts";

/**
 * 사용량 지표(5.0 M8). 돈이 드는 일(PDF 변환 컨테이너, Browser Rendering)은 캐시에 없을 때만 활동 기록에 남기고,
 * 워크스페이스 관리자(owner)가 최근 기간의 수정본·버전·저장 용량·변환·렌더링 횟수를 본다.
 */

/** 캐시에 없어 실제로 변환·렌더링했을 때 한 줄(실패해도 본 작업은 그대로) */
export async function noteUsage(env: Bindings, wsId: number, action: "convert" | "render", target: string) {
  await env.DB.prepare("INSERT INTO activity (workspace_id, user_id, agent, action, target, version, at) VALUES (?, NULL, NULL, ?, ?, NULL, ?)")
    .bind(wsId, action, target, new Date().toISOString()).run().catch((e) => console.error("사용량 기록 실패", e));
}

export async function usage(env: Bindings, wsId: number, days: number) {
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const db = env.DB;
  const [revs, versions, files, assets, paid] = await Promise.all([
    db.prepare(`SELECT r.source, COUNT(*) AS n FROM document_revision r JOIN document d ON d.id = r.document_id
      WHERE d.workspace_id = ? AND r.created_at >= ? GROUP BY r.source`).bind(wsId, since).all<{ source: string; n: number }>(),
    // 버전 작성 시각은 로컬 시각 문자열(yyyy-MM-dd HH:mm:ss)이라 날짜 앞부분으로 비교한다
    db.prepare(`SELECT COUNT(*) AS n FROM document_version v JOIN document d ON d.id = v.document_id
      WHERE d.workspace_id = ? AND v.created_at >= ?`).bind(wsId, since.slice(0, 10)).first<{ n: number }>(),
    db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS bytes FROM (SELECT DISTINCT f.sha256, f.size FROM version_file f
      JOIN document_version v ON v.id = f.version_id JOIN document d ON d.id = v.document_id WHERE d.workspace_id = ?)`).bind(wsId).first<{ n: number; bytes: number }>(),
    db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS bytes FROM asset WHERE workspace_id = ?").bind(wsId).first<{ n: number; bytes: number }>(),
    db.prepare("SELECT action, COUNT(*) AS n FROM activity WHERE workspace_id = ? AND action IN ('convert', 'render') AND at >= ? GROUP BY action")
      .bind(wsId, since).all<{ action: string; n: number }>(),
  ]);
  const bySource = Object.fromEntries(revs.results.map((r) => [r.source, r.n]));
  const byAction = Object.fromEntries(paid.results.map((r) => [r.action, r.n]));
  return {
    days,
    revisions: { total: revs.results.reduce((a, r) => a + r.n, 0), human: bySource.human ?? 0, agent: bySource.agent ?? 0, restore: bySource.restore ?? 0 },
    versions: versions?.n ?? 0,
    storage: { versionFiles: files?.n ?? 0, versionBytes: files?.bytes ?? 0, assets: assets?.n ?? 0, assetBytes: assets?.bytes ?? 0 },
    conversions: byAction.convert ?? 0,
    renders: byAction.render ?? 0,
  };
}
