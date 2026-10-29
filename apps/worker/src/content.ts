import type { Context } from "hono";
import { blobKey, type AppEnv } from "./env.ts";
import { resolveContent } from "./repo.ts";
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

  const file = await resolveContent(c.env.DB, wsId, segments);
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
