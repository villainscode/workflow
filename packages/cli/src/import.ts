/**
 * 리포 docs/(categories.yaml · menus.yaml · 문서별 meta.yaml · 버전 폴더 · 하위 문서)를 Cloudflare 워크스페이스로 가져온다(REQUIREMENT-4.0 P2).
 * 같은 워크스페이스로 다시 돌리면 안의 메뉴·문서를 비우고 다시 넣는다. 파일 본문은 내용 주소라 R2에 없는 것만 올린다.
 *
 *   npx tsx packages/cli/src/import.ts --url http://127.0.0.1:8787 --token <ADMIN_TOKEN> --ws tommoro --name 투모로 [--docs docs] [--owner me@example.com]
 * --owner를 주면 그 Google 계정을 워크스페이스 owner로 넣는다(초대제라 첫 owner는 이렇게 둔다)
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { parse } from "yaml";
import { mimeOf } from "@workflow/core/mime";
import { isSearchable, searchText } from "@workflow/core/search-text";
import { VERSION_RE } from "@workflow/core/versions";

const { values: opt } = parseArgs({
  options: {
    url: { type: "string" }, token: { type: "string" }, ws: { type: "string" }, name: { type: "string" },
    docs: { type: "string", default: "docs" }, owner: { type: "string" },
  },
});
if (!opt.url || !opt.token || !opt.ws) {
  console.error("사용법: import.ts --url <Worker 주소> --token <ADMIN_TOKEN> --ws <워크스페이스 slug> [--name 이름] [--docs docs]");
  process.exit(2);
}
const DOCS = resolve(opt.docs!);
const API = `${opt.url!.replace(/\/$/, "")}/api/admin`;
const auth = { authorization: `Bearer ${opt.token}` };

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(API + path, {
    method, headers: { ...auth, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({})) as T & { error?: string };
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${json.error ?? ""}`);
  return json;
}

interface MenuNode { slug: string; name: string; menus?: MenuNode[] }
interface Meta {
  title: string; menu: string; kind: string; type?: string; sdlc?: string; status?: string; order?: number; current: string;
  notion_url?: string | null; gdrive_url?: string | null; origin_url?: string | null;
  versions: { version: string; entry: string; note?: string; source?: string; created?: string | Date }[];
}

const readYaml = <T>(p: string): T | null => (existsSync(p) ? (parse(readFileSync(p, "utf8")) as T) : null);
const asDate = (v: unknown) => (v instanceof Date ? v.toISOString().slice(0, 10) : v == null ? null : String(v));

const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
  e.name.startsWith(".") ? [] : e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]);

/** 문서 폴더(상위 먼저). 버전 폴더가 아니고 meta.yaml이 있는 폴더(site/server/docpath.ts의 listDocDirs와 같은 규칙) */
function docDirs(dir: string, parent: string | null): { slug: string; dir: string; parent: string | null }[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !/^[._]/.test(e.name) && !VERSION_RE.test(e.name) && existsSync(join(dir, e.name, "meta.yaml")))
    .flatMap((e) => [{ slug: e.name, dir: join(dir, e.name), parent }, ...docDirs(join(dir, e.name), e.name)]);
}

const sha256 = (buf: Buffer) => createHash("sha256").update(buf).digest("hex");

const cats = readYaml<{ categories: { key: string; name: string }[] }>(join(DOCS, "_site/categories.yaml"))?.categories ?? [];
const trees = readYaml<{ menus: Record<string, MenuNode[] | null> }>(join(DOCS, "_site/menus.yaml"))?.menus ?? {};
const categories = cats.map((c) => ({ key: String(c.key), name: String(c.name), menus: trees[c.key] ?? [] }));
const menuSlugs = (list: MenuNode[]): string[] => list.flatMap((m) => [m.slug, ...menuSlugs(m.menus ?? [])]);

await api("POST", "/workspaces", { slug: opt.ws, name: opt.name ?? opt.ws, reset: true });
await api("POST", `/w/${opt.ws}/site`, { categories });
console.log(`대분류 ${categories.length}개, 메뉴 ${categories.flatMap((c) => menuSlugs(c.menus)).length}개`);

let docCount = 0, fileCount = 0, uploaded = 0;
for (const menu of categories.flatMap((c) => menuSlugs(c.menus))) {
  for (const d of docDirs(join(DOCS, menu), null)) {
    const meta = readYaml<Meta>(join(d.dir, "meta.yaml"))!;
    const blobs = new Map<string, Buffer>();
    const versions = [];
    let search: string | undefined;
    for (const v of meta.versions ?? []) {
      const vDir = join(d.dir, v.version);
      if (!existsSync(vDir)) { console.warn(`건너뜀: ${relative(DOCS, vDir)} 버전 폴더 없음`); continue; }
      const files = walk(vDir).map((f) => {
        const buf = readFileSync(f);
        const sha = sha256(buf);
        blobs.set(sha, buf);
        return { path: relative(vDir, f).split("\\").join("/"), size: buf.byteLength, sha256: sha, mime: mimeOf(f) };
      });
      if (v.version === meta.current && isSearchable(v.entry) && existsSync(join(vDir, v.entry))) {
        search = searchText(v.entry, readFileSync(join(vDir, v.entry), "utf8"));
      }
      versions.push({ version: v.version, entry: v.entry, note: v.note ?? null, source: v.source ?? null, created: asDate(v.created), files });
    }
    const { missing } = await api<{ missing: string[] }>("POST", `/w/${opt.ws}/blobs/missing`, { shas: [...blobs.keys()] });
    for (const sha of missing) {
      const res = await fetch(`${API}/w/${opt.ws}/blobs/${sha}`, { method: "PUT", headers: auth, body: new Uint8Array(blobs.get(sha)!) });
      if (!res.ok) throw new Error(`blob ${sha}: ${res.status}`);
      uploaded++;
    }
    await api("POST", `/w/${opt.ws}/docs`, {
      menu, slug: d.slug, parent: d.parent, order: typeof meta.order === "number" ? meta.order : null, title: meta.title, kind: meta.kind,
      type: meta.type ?? null, sdlc: meta.sdlc ?? null, status: meta.status ?? "draft", current: meta.current,
      notion_url: meta.notion_url ?? null, gdrive_url: meta.gdrive_url ?? null, origin_url: meta.origin_url ?? null, versions, search,
    });
    docCount++;
    fileCount += versions.reduce((n, v) => n + v.files.length, 0);
    console.log(`  ${menu}/${d.parent ? d.parent + "/" : ""}${d.slug} — ${meta.title} (버전 ${versions.length})`);
  }
}
console.log(`문서 ${docCount}개, 파일 ${fileCount}개(새로 올린 본문 ${uploaded}개)`);
if (opt.owner) {
  await api("POST", `/w/${opt.ws}/members`, { email: opt.owner, role: "owner" });
  console.log(`owner: ${opt.owner}`);
}
