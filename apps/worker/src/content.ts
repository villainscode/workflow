import type { Context } from "hono";
import { blobKey, type AppEnv, type Bindings } from "./env.ts";
import { docPath, resolveContent } from "./repo.ts";
import { assetRow } from "./assets.ts";
import { loadManifest } from "./revisions.ts";
import { verifyContentToken } from "./token.ts";

/**
 * 사용자 콘텐츠: GET /c/<토큰>/<메뉴>/<상위...>/<문서>/<버전>/<파일 경로>
 * 운영에서는 workflow-files.simplite.net에서만 받는다(앱과 다른 출처, 5.5). 토큰이 경로 앞에 있어 HTML 안 상대 경로가 그대로 풀린다.
 */
export async function serveContent(c: Context<AppEnv>) {
  const [token, ...segments] = c.req.path.replace(/^\/c\//, "").split("/").map(decodeURIComponent);
  const wsId = await verifyContentToken(c.env.SIGNING_KEY, token ?? "");
  if (wsId === null) return c.text("주소가 만료되었거나 올바르지 않습니다. 문서를 다시 여세요", 403);
  if (segments.some((s) => s === ".." || s === "." || s === "")) return c.text("Not Found", 404);

  // 편집기 이미지 자산: /c/<토큰>/_asset/<sha256> (메뉴 slug는 _로 시작할 수 없어 겹치지 않는다)
  if (segments[0] === "_asset" && segments.length === 2) {
    const a = await assetRow(c.env.DB, wsId, segments[1]);
    if (!a) return c.text("Not Found", 404);
    const obj = await c.env.BLOBS.get(blobKey(wsId, a.sha256));
    if (!obj) return c.text("Not Found", 404);
    return new Response(obj.body, { headers: {
      "content-type": a.mime, "content-length": String(a.size), etag: `"${a.sha256}"`, "cache-control": "private, max-age=31536000, immutable",
      "x-content-type-options": "nosniff", "referrer-policy": "no-referrer",
      ...(c.env.APP_ORIGIN && c.req.header("origin") === c.env.APP_ORIGIN ? { "access-control-allow-origin": c.env.APP_ORIGIN, vary: "Origin" } : {}),
    } });
  }
  // 버전 자리에 r<번호>가 오면 그 수정본(작업본 미리보기). 매니페스트에서 파일을 찾는다
  const file = segments.some((s, i) => i >= 2 && /^r\d+$/.test(s))
    ? await resolveRevisionContent(c.env, wsId, segments)
    : await resolveContent(c.env.DB, wsId, segments);
  if (!file) return c.text("Not Found", 404);
  const etag = `"${file.sha256}"`;
  if (c.req.header("if-none-match") === etag) return c.body(null, 304);
  const obj = await c.env.BLOBS.get(blobKey(wsId, file.sha256));
  if (!obj) return c.text("파일 본문이 없습니다", 404);

  const textual = /^text\/|^application\/json|svg\+xml|yaml/.test(file.mime);
  const headers = new Headers({
    "content-type": textual ? `${file.mime}; charset=utf-8` : file.mime,
    "content-length": String(file.size),
    etag,
    "cache-control": "private, max-age=3600",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  });
  // 앱 화면이 글자 파일(Markdown·코드·표·DOCX)을 fetch로 읽는다. 콘텐츠 도메인이 따로이므로 앱 출처만 허용한다(자격 증명은 주소의 토큰뿐, 쿠키 없음)
  if (c.env.APP_ORIGIN && c.req.header("origin") === c.env.APP_ORIGIN) {
    headers.set("access-control-allow-origin", c.env.APP_ORIGIN);
    headers.set("vary", "Origin");
  }
  // HTML·SVG는 직접 열려도 스크립트가 출처 권한을 갖지 못하게 sandbox. PDF는 Chrome이 sandbox 안에서 열지 않아 걸지 않는다(.claude/guides/site-local.md 뷰어 절)
  if (/html|svg/.test(file.mime)) {
    headers.set("content-security-policy", "sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox allow-forms allow-modals allow-downloads");
  }
  return new Response(obj.body, { headers });
}

/** 수정본 콘텐츠: 메뉴/상위.../문서/r<번호>/파일 경로. 상위 경로가 실제와 다르면 없는 것으로 본다(버전 경로와 같은 규칙) */
async function resolveRevisionContent(env: Bindings, wsId: number, segments: string[]) {
  const ri = segments.findIndex((s, i) => i >= 2 && /^r\d+$/.test(s));
  if (ri < 0 || ri === segments.length - 1) return null;
  const [menu, ...chain] = segments.slice(0, ri);
  const doc = await env.DB.prepare(`SELECT d.id, d.slug, d.parent_id, r.manifest_sha FROM document d JOIN menu m ON m.id = d.menu_id
      JOIN document_revision r ON r.document_id = d.id
      WHERE d.workspace_id = ? AND m.slug = ? AND d.slug = ? AND d.deleted_at IS NULL AND r.rev = ?`)
    .bind(wsId, menu, chain[chain.length - 1], Number(segments[ri].slice(1))).first<{ id: number; slug: string; parent_id: number | null; manifest_sha: string }>();
  if (!doc || (await docPath(env.DB, doc, menu)) !== `${menu}/${chain.join("/")}`) return null;
  const path = segments.slice(ri + 1).join("/");
  const f = (await loadManifest(env, wsId, doc.manifest_sha)).files.find((x) => x.path === path);
  return f ? { sha256: f.sha256, mime: f.mime, size: f.size } : null;
}
