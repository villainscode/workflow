import puppeteer, { type Page } from "@cloudflare/puppeteer";
import { DECK_ENTRY, loadSlide, parseDeckIndex, renderDeckHtml, slidePath } from "@workflow/core/slide";
import { getBlob, sha256Hex } from "./blobs.ts";
import { HttpError, type Bindings, type Workspace } from "./env.ts";
import { docPath, findDoc } from "./repo.ts";
import { workState, type ManifestFile } from "./revisions.ts";
import { versionFiles } from "./write.ts";
import { noteUsage } from "./usage.ts";

/**
 * Cloudflare Browser Rendering으로 그리기(5.0 M7·M8). 결과는 내용(파일 sha 묶음)으로 R2에 캐시한다.
 * - HTML 문서 PDF 내보내기: 버전의 대표 HTML을 콘텐츠 도메인 주소로 열어 A4로 인쇄한다(상대 경로 그림·CSS도 같이 읽힌다).
 * - 슬라이드 PNG 미리보기(deck_render): 정적 HTML(core renderDeckHtml, 화면 렌더러와 같은 DOM·기본 스타일)을 960×540으로.
 * 열 때는 load까지만 기다린다. 실제 Browser Rendering에서는 networkidle0이 거의 매번 30초 시간 초과였다(TESTING 5절).
 * 그 뒤 글꼴(document.fonts.ready)과 모든 그림 decode()를 기다린다.
 */

const dec = new TextDecoder();
const cacheKey = (wsId: number, kind: "html-pdf" | "deck-png", key: string) => `ws/${wsId}/cache/${kind}/${key}`;
const filesKey = (files: ManifestFile[]) => sha256Hex(new TextEncoder().encode(files.map((f) => `${f.path}:${f.sha256}`).sort().join(",")));

/** 헤드리스 브라우저가 읽어도 되는 주소: 이 워크스페이스 콘텐츠(그림·CSS)와 Google Fonts뿐 */
const allowed = (url: string, contentBase: string) =>
  url.startsWith(`${contentBase}/`) || /^https:\/\/fonts\.(googleapis|gstatic)\.com\//.test(url) || url.startsWith("data:") || url === "about:blank";

async function render<T>(env: Bindings, contentBase: string, open: (page: Page) => Promise<unknown>, fn: (page: Page) => Promise<T>): Promise<T> {
  if (!env.BROWSER) throw new HttpError(501, "PDF 내보내기를 쓸 수 없는 환경입니다(Browser Rendering 없음)");
  const browser = await puppeteer.launch(env.BROWSER);
  try {
    const page = await browser.newPage();
    await page.setRequestInterception(true);
    page.on("request", (r) => { if (allowed(r.url(), contentBase)) void r.continue(); else void r.abort(); });
    await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });
    await open(page);
    // 브라우저 안에서 도는 글(Worker 타입에는 document가 없어 문자열로 넘긴다)
    await page.evaluate("(async () => { await document.fonts.ready; await Promise.all([...document.images].map((i) => i.decode().catch(() => {}))); })()");
    return await fn(page);
  } finally {
    await browser.close();
  }
}

/** HTML 문서 PDF(버전, 없으면 지금 버전). contentBase는 <콘텐츠 출처>/c/<토큰> */
export async function htmlPdf(env: Bindings, ws: Workspace, menu: string, docSlug: string, version: string | undefined, contentBase: string) {
  const doc = await findDoc(env.DB, ws.id, menu, docSlug);
  const v = version ?? doc.current_version;
  const row = await env.DB.prepare("SELECT entry FROM document_version WHERE document_id = ? AND version = ?").bind(doc.id, v).first<{ entry: string }>();
  if (!row) throw new HttpError(404, `${v} 버전이 없습니다`);
  if (!/\.html?$/i.test(row.entry)) throw new HttpError(400, "PDF 내보내기는 HTML 문서만 지원합니다");
  const files = await versionFiles(env.DB, doc.id, v);
  const k = cacheKey(ws.id, "html-pdf", await filesKey(files));
  const name = `${doc.title} ${v}.pdf`;
  const hit = await env.BLOBS.get(k);
  if (hit) return { name, body: new Uint8Array(await hit.arrayBuffer()) };
  const enc = (p: string) => p.split("/").map(encodeURIComponent).join("/");
  const url = `${contentBase}/${enc(await docPath(env.DB, doc, doc.menu_slug))}/${v}/${enc(row.entry)}`;
  const pdf = await render(env, contentBase, (page) => page.goto(url, { waitUntil: "load", timeout: 30_000 }),
    (page) => page.pdf({ format: "A4", printBackground: true, margin: { top: "12mm", bottom: "12mm", left: "12mm", right: "12mm" } }));
  const body = new Uint8Array(pdf as Uint8Array);
  await env.BLOBS.put(k, body);
  await noteUsage(env, ws.id, "render", `${menu}/${docSlug}`);
  return { name, body };
}

/** 슬라이드 하나 PNG(960×540). 에이전트가 배치를 확인할 때(deck_render). 버전 또는 작업본(work) */
export async function slidePng(env: Bindings, ws: Workspace, menu: string, docSlug: string, slideId: string, which: { version?: string; work?: boolean }, contentBase: string) {
  const doc = await findDoc(env.DB, ws.id, menu, docSlug);
  let files: ManifestFile[], entry: string;
  if (which.work) {
    const st = await workState(env, ws, doc);
    files = st.manifest.files; entry = st.manifest.entry;
  } else {
    const v = which.version ?? doc.current_version;
    const row = await env.DB.prepare("SELECT entry FROM document_version WHERE document_id = ? AND version = ?").bind(doc.id, v).first<{ entry: string }>();
    if (!row) throw new HttpError(404, `${v} 버전이 없습니다`);
    files = await versionFiles(env.DB, doc.id, v); entry = row.entry;
  }
  if (entry !== DECK_ENTRY) throw new HttpError(400, "슬라이드 덱(deck.json) 문서가 아닙니다");
  const by = new Map(files.map((f) => [f.path, f]));
  const read = async (p: string) => { const f = by.get(p); if (!f) throw new HttpError(404, `${p} 파일이 없습니다`); return dec.decode(await getBlob(env.BLOBS, ws.id, f.sha256)); };
  const { index } = parseDeckIndex(await read(DECK_ENTRY));
  if (!index) throw new HttpError(500, "deck.json을 읽을 수 없습니다");
  if (!index.order.includes(slideId)) throw new HttpError(404, `슬라이드 ${slideId}이(가) 없습니다`);
  const slide = loadSlide(await read(slidePath(slideId)));
  // 캐시 키: 색인(글꼴)과 그 슬라이드 파일
  const k = cacheKey(ws.id, "deck-png", await filesKey([by.get(DECK_ENTRY)!, by.get(slidePath(slideId))!]));
  const hit = await env.BLOBS.get(k);
  if (hit) return new Uint8Array(await hit.arrayBuffer());
  const html = renderDeckHtml(index, [slide], (sha) => `${contentBase}/_asset/${sha}`);
  const png = await render(env, contentBase, (page) => page.setContent(html, { waitUntil: "load", timeout: 30_000 }), async (page) => {
    await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 0.5 });
    return page.screenshot({ type: "png", clip: { x: 0, y: 0, width: 1920, height: 1080 } });
  });
  const body = new Uint8Array(png as Uint8Array);
  await env.BLOBS.put(k, body);
  await noteUsage(env, ws.id, "render", `${menu}/${docSlug}#${slideId}`);
  return body;
}
