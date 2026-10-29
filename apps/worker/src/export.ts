import { Zip, ZipPassThrough } from "fflate";
import { stringify } from "yaml";
import { blobKey, type Bindings, type Workspace } from "./env.ts";

/**
 * 워크스페이스 내보내기(4.0 P8): 리포 docs/와 같은 모양의 zip(_site/categories.yaml · menus.yaml · 문서별 meta.yaml · 버전 폴더).
 * 가져오기 CLI(packages/cli/src/import.ts --docs)로 그대로 다시 넣을 수 있어 백업·이전에 쓴다. 휴지통 문서는 넣지 않는다.
 * 파일은 R2에서 하나씩 흘려보내고 압축하지 않고 담는다(DOCX·PNG처럼 이미 압축된 파일이 많아 CPU만 든다). 메모리에 zip 전체를 두지 않는다.
 */

interface MenuRow { id: number; slug: string; name: string; category_key: string; parent_id: number | null }
interface DocRow {
  id: number; menu_id: number; slug: string; parent_id: number | null; sort: number | null; title: string; kind: string; type: string | null;
  sdlc: string | null; status: string; current_version: string; notion_url: string | null; gdrive_url: string | null; origin_url: string | null;
}

export function exportWorkspace(env: Bindings, ws: Workspace): ReadableStream<Uint8Array> {
  const db = env.DB;
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const out = new ReadableStream<Uint8Array>({ start(c) { controller = c; } });
  const zip = new Zip((err, chunk, final) => {
    if (err) return controller.error(err);
    controller.enqueue(chunk);
    if (final) controller.close();
  });
  const addText = (path: string, text: string) => {
    const f = new ZipPassThrough(path);
    zip.add(f);
    f.push(new TextEncoder().encode(text), true);
  };

  (async () => {
    const [cats, menus, docs] = await db.batch([
      db.prepare("SELECT key, name FROM top_menu WHERE workspace_id = ? ORDER BY sort").bind(ws.id),
      db.prepare("SELECT id, slug, name, category_key, parent_id FROM menu WHERE workspace_id = ? ORDER BY sort").bind(ws.id),
      db.prepare("SELECT * FROM document WHERE workspace_id = ? AND deleted_at IS NULL ORDER BY id").bind(ws.id),
    ]);
    const menuRows = menus.results as unknown as MenuRow[];
    const docRows = docs.results as unknown as DocRow[];
    const tree = (cat: string, parent: number | null): object[] => menuRows.filter((m) => m.category_key === cat && m.parent_id === parent)
      .map((m) => { const sub = tree(cat, m.id); return sub.length ? { slug: m.slug, name: m.name, menus: sub } : { slug: m.slug, name: m.name }; });
    const catList = cats.results as { key: string; name: string }[];
    addText("docs/_site/categories.yaml", `# ${ws.name} 워크스페이스 내보내기(${new Date().toISOString()})\n` + stringify({ categories: catList }));
    addText("docs/_site/menus.yaml", stringify({ menus: Object.fromEntries(catList.map((c) => [c.key, tree(c.key, null)])) }));

    const byId = new Map(docRows.map((d) => [d.id, d]));
    const menuOf = new Map(menuRows.map((m) => [m.id, m]));
    const folder = (d: DocRow): string => (d.parent_id && byId.has(d.parent_id) ? `${folder(byId.get(d.parent_id)!)}/${d.slug}` : `${menuOf.get(d.menu_id)!.slug}/${d.slug}`);

    for (const d of docRows) {
      const dir = `docs/${folder(d)}`;
      const m = menuOf.get(d.menu_id)!;
      const { results: versions } = await db.prepare("SELECT id, version, note, source, created_at, entry FROM document_version WHERE document_id = ? ORDER BY id")
        .bind(d.id).all<{ id: number; version: string; note: string | null; source: string | null; created_at: string | null; entry: string }>();
      addText(`${dir}/meta.yaml`, stringify({
        title: d.title, category: m.category_key, menu: m.slug, kind: d.kind, ...(d.type ? { type: d.type } : {}), ...(d.sdlc ? { sdlc: d.sdlc } : {}),
        status: d.status, current: d.current_version,
        versions: versions.map((v) => ({ version: v.version, entry: v.entry, note: v.note, source: v.source, created: v.created_at })),
        ...(d.sort !== null ? { order: d.sort } : {}),
        notion_url: d.notion_url, gdrive_url: d.gdrive_url, ...(d.origin_url ? { origin_url: d.origin_url } : {}),
      }, { lineWidth: 0, nullStr: "" }));
      for (const v of versions) {
        const { results: files } = await db.prepare("SELECT path, sha256 FROM version_file WHERE version_id = ? ORDER BY id").bind(v.id).all<{ path: string; sha256: string }>();
        for (const f of files) {
          const entry = new ZipPassThrough(`${dir}/${v.version}/${f.path}`);
          zip.add(entry);
          const obj = await env.BLOBS.get(blobKey(ws.id, f.sha256));
          if (!obj) { entry.push(new Uint8Array(0), true); continue; }
          const reader = obj.body.getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) { entry.push(new Uint8Array(0), true); break; }
            entry.push(value);
          }
        }
      }
    }
    zip.end();
  })().catch((e) => controller.error(e));
  return out;
}
