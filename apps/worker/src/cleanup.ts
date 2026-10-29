import type { Bindings } from "./env.ts";

/**
 * 매일 정리(Cron Trigger, 4.0 P8). 지난 세션·쓰지 않고 만료된 초대를 지우고, 어떤 버전도 가리키지 않는 blob(업로드 도중 실패한 것,
 * 영구 삭제에서 놓친 것)을 R2에서 지운다. blob은 올린 지 하루가 지난 것만 지운다(지금 올리는 중인 것을 지우지 않게).
 * OAuth(KV)는 기록마다 TTL이 있어 따로 지우지 않는다.
 */
export async function cleanup(env: Bindings, now = Date.now()) {
  const iso = new Date(now).toISOString();
  const db = env.DB;
  const [s, i] = await db.batch([
    db.prepare("DELETE FROM session WHERE expires_at < ?").bind(iso),
    db.prepare("DELETE FROM invite WHERE used_at IS NULL AND expires_at < ?").bind(iso),
  ]);
  // 수정본 보존(D-50): 버전으로 올린 것·작업본(head)은 늘 남기고, 나머지는 문서마다 최근 200개 안이면서 30일이 안 된 것만 남긴다
  const cutoff = new Date(now - 30 * 86400_000).toISOString();
  const pruned = await db.prepare(`DELETE FROM document_revision WHERE id IN (
      SELECT r.id FROM document_revision r
      LEFT JOIN document_version v ON v.revision_id = r.id
      LEFT JOIN document_head h ON h.document_id = r.document_id AND h.rev = r.rev
      WHERE v.id IS NULL AND h.document_id IS NULL
        AND (r.created_at < ? OR (SELECT COUNT(*) FROM document_revision r2 WHERE r2.document_id = r.document_id AND r2.rev > r.rev) >= 200))`)
    .bind(cutoff).run();
  let blobs = 0;
  const { results: wss } = await db.prepare("SELECT id FROM workspace").all<{ id: number }>();
  for (const { id } of wss) {
    // 남은 수정본의 매니페스트와 그 파일, 편집기 이미지 자산도 "쓰는 blob"으로 센다
    const keep = new Set<string>();
    const { results: mans } = await db.prepare(`SELECT DISTINCT r.manifest_sha FROM document_revision r JOIN document d ON d.id = r.document_id
      WHERE d.workspace_id = ?`).bind(id).all<{ manifest_sha: string }>();
    for (const { manifest_sha } of mans) {
      keep.add(manifest_sha);
      const obj = await env.BLOBS.get(`ws/${id}/blobs/${manifest_sha}`);
      if (obj) for (const f of (JSON.parse(await obj.text()) as { files: { sha256: string }[] }).files) keep.add(f.sha256);
    }
    const { results: assets } = await db.prepare("SELECT sha256 FROM asset WHERE workspace_id = ?").bind(id).all<{ sha256: string }>();
    for (const a of assets) keep.add(a.sha256);
    let cursor: string | undefined;
    do {
      const page = await env.BLOBS.list({ prefix: `ws/${id}/blobs/`, cursor, limit: 500 });
      cursor = page.truncated ? page.cursor : undefined;
      const old = page.objects.filter((o) => now - o.uploaded.getTime() > 86400_000);
      for (let k = 0; k < old.length; k += 90) {
        const chunk = old.slice(k, k + 90);
        const shas = chunk.map((o) => o.key.slice(o.key.lastIndexOf("/") + 1));
        const { results } = await db.prepare(`SELECT DISTINCT f.sha256 FROM version_file f JOIN document_version v ON v.id = f.version_id
          JOIN document d ON d.id = v.document_id WHERE d.workspace_id = ? AND f.sha256 IN (${shas.map(() => "?").join(", ")})`)
          .bind(id, ...shas).all<{ sha256: string }>();
        const used = new Set([...results.map((r) => r.sha256), ...shas.filter((x) => keep.has(x))]);
        const gone = chunk.filter((o) => !used.has(o.key.slice(o.key.lastIndexOf("/") + 1))).map((o) => o.key);
        if (gone.length) { await env.BLOBS.delete(gone); blobs += gone.length; }
      }
    } while (cursor);
  }
  const result = { sessions: s.meta.changes, invites: i.meta.changes, revisions: pruned.meta.changes, blobs };
  console.log("정리", JSON.stringify(result));
  return result;
}
