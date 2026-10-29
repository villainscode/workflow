/**
 * 화면이 어디에서 도는지. 로컬 사이트(site/, Fastify)와 Cloudflare(apps/worker, VITE_CLOUD=1 빌드)가 같은 화면을 쓴다(REQUIREMENT-4.0).
 *   로컬     주소 /<대분류>/<메뉴>/<문서>,       API /api/...
 *   Cloudflare 주소 /<워크스페이스>/<대분류>/…, API /api/w/<워크스페이스>/...
 * 화면 경로는 둘이 같고, Cloudflare에서는 라우터 basename이 워크스페이스다.
 */
// Markdown 파서(parseMarkdown)를 통해 Node 테스트에서도 읽히므로 Vite 환경값·location이 없을 수 있다
export const CLOUD = import.meta.env?.VITE_CLOUD === "1";

/** 지금 워크스페이스 slug(Cloudflare). 주소 첫 칸 */
export const WS = CLOUD && typeof location !== "undefined" ? decodeURIComponent(location.pathname.split("/")[1] ?? "") : "";

/** 라우터 basename. 로컬은 "" */
export const BASENAME = CLOUD && WS ? `/${WS}` : "";

/** API 앞부분 */
export const API = CLOUD ? `/api/w/${encodeURIComponent(WS)}` : "/api";
