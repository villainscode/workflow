import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { parseDocument } from "yaml";
import { imageSize } from "@workflow/core/image";
import { svgSize } from "@workflow/core/svg";
import { mimeOf } from "@workflow/core/mime";
import { DECK_ENTRY } from "@workflow/core/slide";
import * as work from "@workflow/core/work";
import { ASSET_EXT, WorkError, type DocStore, type Manifest, type ManifestFile, type RevisionSource } from "@workflow/core/work";
import { sessionLocked, type OfficeSessions } from "@workflow/core/office";
import { docDir, upload } from "./store.ts";

/**
 * 로컬 사이트 수정본 층(6.0 VL, D-58). 규칙은 Cloudflare와 같은 packages/core/src/work이고, 저장소만 로컬이다.
 * - 작업본은 docs/ 밖에 둔다: 파일 본문·매니페스트는 data/work/blobs/<sha256>(내용 주소), 수정본 행·작업본 머리·그림 자산은 data/work.db.
 *   work.db는 색인(index.db)과 달리 다시 만들지 않는다(git에도 넣지 않는다).
 * - 「버전으로 저장」하면 지금 버전 규칙대로 새 vN.N 폴더와 meta.yaml versions(source: revision)를 쓴다. 덱이 가리키는 그림 자산은 그 버전 폴더 assets/로 복사한다.
 * - 버전 파일은 docs/에서 읽어 처음 한 번 blobs에 복사해 둔다(작업본이 같은 sha로 가리킨다).
 * - 문서는 메뉴·문서 slug로 가리킨다. 문서를 다른 메뉴로 옮기면 그 전 작업본은 이어지지 않는다(버전 파일에서 다시 시작).
 */

const sha256 = (d: Uint8Array) => createHash("sha256").update(d).digest("hex");
const now = () => new Date().toISOString();

const SCHEMA = `
CREATE TABLE IF NOT EXISTS revision (id INTEGER PRIMARY KEY AUTOINCREMENT, doc TEXT NOT NULL, rev INTEGER NOT NULL, base_version TEXT NOT NULL,
  manifest_sha TEXT NOT NULL, source TEXT NOT NULL, summary TEXT, created_at TEXT NOT NULL, published_as TEXT, UNIQUE(doc, rev));
CREATE TABLE IF NOT EXISTS head (doc TEXT PRIMARY KEY, rev INTEGER NOT NULL, base_version TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS asset (sha256 TEXT PRIMARY KEY, mime TEXT NOT NULL, size INTEGER NOT NULL, width INTEGER, height INTEGER, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS office_session (doc TEXT PRIMARY KEY, doc_key TEXT NOT NULL, rev INTEGER NOT NULL, base_version TEXT NOT NULL, expires_at INTEGER NOT NULL);
`;

export interface AssetRow { sha256: string; mime: string; size: number; width: number | null; height: number | null }

export class LocalWork {
  readonly db: Database.Database;
  private blobDir: string;
  /** 버전 파일 sha 캐시(경로·크기·수정 시각이 같으면 다시 읽지 않는다) */
  private shaCache = new Map<string, { size: number; mtime: number; sha: string }>();

  /** indexed: 색인에서 sha256으로 버전 파일의 절대 경로를 찾는다(blobs에 없는 그림 자산을 버전 폴더에서 찾을 때) */
  constructor(private docsRoot: string, dataDir: string, private indexed: (sha: string) => string | null) {
    this.blobDir = join(dataDir, "work", "blobs");
    mkdirSync(this.blobDir, { recursive: true });
    this.db = new Database(join(dataDir, "work.db"));
    this.db.pragma("journal_mode = WAL");
    this.db.exec(SCHEMA);
  }

  // ---------- 내용 주소 blob ----------
  private blobPath = (sha: string) => {
    if (!/^[0-9a-f]{64}$/.test(sha)) throw new WorkError(400, `잘못된 sha: ${sha}`);
    return join(this.blobDir, sha);
  };
  hasBlob(sha: string) {
    if (existsSync(this.blobPath(sha))) return true;
    return this.fromDocs(sha);
  }
  getBlob(sha: string): Uint8Array {
    if (!existsSync(this.blobPath(sha)) && !this.fromDocs(sha)) throw new WorkError(404, `파일 본문이 없습니다: ${sha}`);
    return readFileSync(this.blobPath(sha));
  }
  putBlob(sha: string, data: Uint8Array) {
    const p = this.blobPath(sha);
    if (!existsSync(p)) writeFileSync(p, data);
  }
  /** blobs에 없으면 docs/ 버전 파일(색인)에서 찾아 복사한다(다른 곳에서 clone한 리포의 덱 그림 등) */
  private fromDocs(sha: string) {
    const rel = this.indexed(sha);
    if (!rel) return false;
    if (!existsSync(rel)) return false;
    const data = readFileSync(rel);
    if (sha256(data) !== sha) return false;
    this.putBlob(sha, data);
    return true;
  }

  // ---------- 문서 하나의 저장소 ----------
  private meta(menu: string, doc: string) {
    const dir = docDir(this.docsRoot, menu, doc);
    const js = parseDocument(readFileSync(join(dir, "meta.yaml"), "utf8")).toJS() as { current: string; versions: { version: string; entry: string }[] };
    return { dir, ...js };
  }

  /** 버전 폴더 파일 목록. 본문은 blobs에 복사해 둔다 */
  private versionManifest(dir: string, version: string, entry: string): Manifest | null {
    const root = join(dir, version);
    if (!existsSync(root)) return null;
    const walk = (rel: string): string[] => readdirSync(join(root, rel), { withFileTypes: true }).flatMap((e) => {
      if (e.name.startsWith(".")) return [];
      const p = rel ? `${rel}/${e.name}` : e.name;
      return e.isDirectory() ? walk(p) : [p];
    });
    const files: ManifestFile[] = walk("").map((path) => {
      const full = join(root, path);
      const st = statSync(full);
      let hit = this.shaCache.get(full);
      if (!hit || hit.size !== st.size || hit.mtime !== st.mtimeMs) {
        const data = readFileSync(full);
        hit = { size: st.size, mtime: st.mtimeMs, sha: sha256(data) };
        this.shaCache.set(full, hit);
        this.putBlob(hit.sha, data);
      } else if (!existsSync(this.blobPath(hit.sha))) this.putBlob(hit.sha, readFileSync(full));
      return { path, sha256: hit.sha, size: st.size, mime: mimeOf(path) };
    });
    return { entry, files };
  }

  store(menu: string, doc: string): DocStore {
    const key = `${menu}/${doc}`;
    const m = this.meta(menu, doc);
    return {
      currentVersion: m.current,
      head: async () => {
        const h = this.db.prepare("SELECT rev, base_version FROM head WHERE doc = ?").get(key) as { rev: number; base_version: string } | undefined;
        return h ? { rev: h.rev, baseVersion: h.base_version } : null;
      },
      revision: async (rev) => {
        const r = this.db.prepare("SELECT id, manifest_sha FROM revision WHERE doc = ? AND rev = ?").get(key, rev) as { id: number; manifest_sha: string } | undefined;
        return r ? { id: r.id, manifestSha: r.manifest_sha } : null;
      },
      version: async (version) => {
        const v = m.versions.find((x) => x.version === version);
        return v ? this.versionManifest(m.dir, version, v.entry) : null;
      },
      getBlob: async (sha) => this.getBlob(sha),
      putBlob: async (sha, data) => this.putBlob(sha, data),
      hasBlob: async (sha) => this.hasBlob(sha),
      addRevision: async (r) => {
        try {
          this.db.transaction(() => {
            this.db.prepare("INSERT INTO revision (doc, rev, base_version, manifest_sha, source, summary, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
              .run(key, r.rev, r.baseVersion, r.manifestSha, r.source, r.summary, now());
            this.db.prepare(`INSERT INTO head (doc, rev, base_version, updated_at) VALUES (?, ?, ?, ?)
              ON CONFLICT (doc) DO UPDATE SET rev = excluded.rev, base_version = excluded.base_version, updated_at = excluded.updated_at`)
              .run(key, r.rev, r.baseVersion, now());
          })();
        } catch (e) {
          if (/UNIQUE constraint failed/i.test(String((e as Error).message))) throw new WorkError(409, "다른 곳에서 먼저 저장했습니다. 최신 내용을 받아 다시 적용하세요");
          throw e;
        }
      },
      // 오피스 편집 세션(6.0 VO)이 살아 있으면 잠김
      locked: () => sessionLocked(this.officeSessions(menu, doc)),
    };
  }

  /** 문서 하나의 오피스 편집 세션(6.0 VO). 로컬에는 사용자가 없어 userId는 비운다 */
  officeSessions(menu: string, doc: string): OfficeSessions {
    const key = `${menu}/${doc}`;
    return {
      get: async () => {
        const r = this.db.prepare("SELECT doc_key, rev, base_version, expires_at FROM office_session WHERE doc = ?").get(key) as
          { doc_key: string; rev: number; base_version: string; expires_at: number } | undefined;
        return r ? { key: r.doc_key, rev: r.rev, baseVersion: r.base_version, userId: null, expiresAt: r.expires_at } : null;
      },
      put: async (s) => {
        this.db.prepare(`INSERT INTO office_session (doc, doc_key, rev, base_version, expires_at) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT (doc) DO UPDATE SET doc_key = excluded.doc_key, rev = excluded.rev, base_version = excluded.base_version, expires_at = excluded.expires_at`)
          .run(key, s.key, s.rev, s.baseVersion, s.expiresAt);
      },
      remove: async (k) => { this.db.prepare("DELETE FROM office_session WHERE doc = ? AND doc_key = ?").run(key, k); },
    };
  }

  /** 문서 제목(meta.yaml title) */
  title(menu: string, doc: string) {
    const m = this.meta(menu, doc) as { title?: string };
    return m.title ?? doc;
  }

  // ---------- 이력·버전으로 저장 ----------
  listRevisions(menu: string, doc: string, before?: number) {
    const key = `${menu}/${doc}`;
    const revisions = this.db.prepare(`SELECT rev, base_version AS baseVersion, source, summary, created_at AS createdAt, NULL AS author, published_as AS publishedAs
      FROM revision WHERE doc = ? AND (? IS NULL OR rev < ?) ORDER BY rev DESC LIMIT 50`).all(key, before ?? null, before ?? null);
    const head = this.db.prepare("SELECT rev, base_version FROM head WHERE doc = ?").get(key) as { rev: number; base_version: string } | undefined;
    return { head: head && head.base_version === this.meta(menu, doc).current ? head.rev : null, revisions };
  }

  async getRevision(menu: string, doc: string, rev: number) {
    const r = this.db.prepare("SELECT rev, base_version, manifest_sha, source, summary, created_at FROM revision WHERE doc = ? AND rev = ?").get(`${menu}/${doc}`, rev) as
      { rev: number; base_version: string; manifest_sha: string; source: string; summary: string | null; created_at: string } | undefined;
    if (!r) throw new WorkError(404, `수정본 ${rev}이(가) 없습니다`);
    return { rev: r.rev, baseVersion: r.base_version, source: r.source, summary: r.summary, createdAt: r.created_at, manifest: await work.loadManifest(this.store(menu, doc), r.manifest_sha) };
  }

  /** 작업본 폴더(r<rev> 또는 버전) 안 파일 하나. 편집 사본의 상대 경로 그림·CSS가 여기서 풀린다 */
  async folderFile(menu: string, doc: string, folder: string, path: string) {
    const store = this.store(menu, doc);
    const manifest = /^r\d+$/.test(folder) ? (await this.getRevision(menu, doc, Number(folder.slice(1)))).manifest : await store.version(folder);
    const f = manifest?.files.find((x) => x.path === path);
    if (!f) throw new WorkError(404, "파일이 없습니다");
    return { mime: f.mime, data: this.getBlob(f.sha256) };
  }

  /** 지금 작업본을 다음 버전 폴더로 쓴다(meta.yaml source: revision). 덱이면 가리키는 그림 자산을 assets/로 함께 넣는다 */
  async publish(menu: string, doc: string, input: { baseRev: number; note?: string; version?: string }) {
    const store = this.store(menu, doc);
    const state = await work.publishState(store, input.baseRev);
    const files = state.manifest.files.map((f) => ({ path: f.path, data: this.getBlob(f.sha256) }));
    if (state.manifest.entry === DECK_ENTRY) {
      const dec = new TextDecoder();
      const slides = files.filter((f) => /^slides\/[^/]+\.html$/.test(f.path)).map((f) => dec.decode(f.data));
      for (const sha of work.deckAssetShas(slides)) {
        const a = this.asset(sha);
        const path = `assets/${sha.slice(0, 16)}.${ASSET_EXT[a?.mime ?? ""] ?? "bin"}`;
        if (a && !files.some((f) => f.path === path)) files.push({ path, data: this.getBlob(sha) });
      }
    }
    const r = upload(this.docsRoot, { menu, doc, entry: state.manifest.entry, note: input.note, version: input.version, source: "revision", files });
    const key = `${menu}/${doc}`;
    this.db.prepare("UPDATE head SET base_version = ?, updated_at = ? WHERE doc = ?").run(r.version, now(), key);
    this.db.prepare("UPDATE revision SET published_as = ? WHERE doc = ? AND rev = ?").run(r.version, key, state.rev);
    return { menu, doc, version: r.version, rev: state.rev };
  }

  // ---------- 그림 자산(편집기 공통) ----------
  putAsset(file: { mime: string; data: Uint8Array }) {
    // 크기·형식 검사와 SVG 소독은 Worker와 같은 core prepareAsset(6.0 V4)
    const p = work.prepareAsset(file.mime, file.data);
    const sha = sha256(p.data);
    this.putBlob(sha, p.data);
    this.db.prepare("INSERT INTO asset (sha256, mime, size, width, height, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (sha256) DO NOTHING")
      .run(sha, p.mime, p.data.byteLength, p.width, p.height, now());
    return { asset: `asset:${sha}`, sha256: sha, mime: p.mime, size: p.data.byteLength, width: p.width, height: p.height,
      ...(p.removed ? { removed: p.removed, drawio: p.drawio } : {}) };
  }

  /** 자산 행. 없으면 버전 폴더에 복사된 그림(색인)에서 다시 만든다 */
  asset(sha: string): AssetRow | null {
    const row = this.db.prepare("SELECT sha256, mime, size, width, height FROM asset WHERE sha256 = ?").get(sha) as AssetRow | undefined;
    if (row) return row;
    if (!this.hasBlob(sha)) return null;
    const data = this.getBlob(sha);
    const mime = Object.keys(ASSET_EXT).find((m) => m === mimeOf(this.indexed(sha) ?? ""));
    let size = mime === "image/svg+xml" ? null : imageSize(data);
    if (mime === "image/svg+xml") try { size = svgSize(new TextDecoder().decode(data)); } catch { size = null; }
    if (!size || !mime) return null;
    this.db.prepare("INSERT INTO asset (sha256, mime, size, width, height, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (sha256) DO NOTHING")
      .run(sha, mime, data.byteLength, size.width, size.height, now());
    return { sha256: sha, mime, size: data.byteLength, ...size };
  }
}

export type { RevisionSource };
