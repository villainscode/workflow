import puppeteer, { type Page } from "@cloudflare/puppeteer";
import { DECK_ENTRY, loadSlide, parseDeckIndex, renderDeckHtml, slidePath, type DeckIndex, type Slide } from "@workflow/core/slide";
import { getBlob, sha256Hex } from "./blobs.ts";
import { HttpError, type Bindings, type Workspace } from "./env.ts";
import { findDoc } from "./repo.ts";
import { workState, type ManifestFile } from "./revisions.ts";
import { versionFiles } from "./write.ts";
import { noteUsage } from "./usage.ts";

/**
 * 덱 PDF 내보내기와 슬라이드 PNG 미리보기(5.0 M7, 명세 12절). Cloudflare Browser Rendering으로 정적 HTML(core renderDeckHtml,
 * 화면 렌더러와 같은 DOM·기본 스타일)을 열어 1920×1080 쪽으로 인쇄한다. 결과는 내용(파일 sha 묶음)으로 R2에 캐시한다.
 * 그림은 콘텐츠 도메인 서명 주소로 읽고, 인쇄 전에 글꼴(document.fonts.ready)과 모든 그림 decode()를 기다린다.
 */

const dec = new TextDecoder();
const cacheKey = (wsId: number, kind: "pdf" | "png", key: string) => `ws/${wsId}/cache/deck-${kind}/${key}`;

/** 버전(없으면 지금 버전) 또는 작업본(work)의 덱 파일 */
async function deckFiles(env: Bindings, ws: Workspace, menu: string, docSlug: string, which: { version?: string; work?: boolean }) {
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
  const read = async (p: string) => { const f = by.get(p); if (!f) throw new HttpError(500, `${p} 파일이 없습니다`); return dec.decode(await getBlob(env.BLOBS, ws.id, f.sha256)); };
  const { index } = parseDeckIndex(await read(DECK_ENTRY));
  if (!index) throw new HttpError(500, "deck.json을 읽을 수 없습니다");
  const slides = await Promise.all(index.order.map(async (id) => loadSlide(await read(slidePath(id)))));
  // 캐시 키: 색인과 슬라이드 파일 sha(내용이 같으면 같은 결과)
  const key = await sha256Hex(new TextEncoder().encode([DECK_ENTRY, ...index.order.map(slidePath)].map((p) => by.get(p)!.sha256).join(",")));
  return { index, slides, key, slideSha: (id: string) => by.get(slidePath(id))!.sha256 };
}

/** 헤드리스 브라우저가 읽어도 되는 주소: 이 워크스페이스 그림(콘텐츠 도메인 /_asset/)과 Google Fonts뿐 */
const allowed = (url: string, assetBase: string) =>
  url.startsWith(`${assetBase}/_asset/`) || /^https:\/\/fonts\.(googleapis|gstatic)\.com\//.test(url) || url.startsWith("data:") || url === "about:blank";

async function render<T>(env: Bindings, html: string, assetBase: string, fn: (page: Page) => Promise<T>): Promise<T> {
  if (!env.BROWSER) throw new HttpError(501, "PDF 내보내기를 쓸 수 없는 환경입니다(Browser Rendering 없음)");
  const browser = await puppeteer.launch(env.BROWSER);
  try {
    const page = await browser.newPage();
    await page.setRequestInterception(true);
    page.on("request", (r) => { if (allowed(r.url(), assetBase)) void r.continue(); else void r.abort(); });
    await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });
    await page.setContent(html, { waitUntil: "networkidle0", timeout: 30_000 });
    // 브라우저 안에서 도는 글(Worker 타입에는 document가 없어 문자열로 넘긴다)
    await page.evaluate("(async () => { await document.fonts.ready; await Promise.all([...document.images].map((i) => i.decode().catch(() => {}))); })()");
    return await fn(page);
  } finally {
    await browser.close();
  }
}

/** 덱 PDF(슬라이드마다 1920×1080 한 쪽) */
export async function deckPdf(env: Bindings, ws: Workspace, menu: string, docSlug: string, which: { version?: string; work?: boolean }, assetBase: string) {
  const d = await deckFiles(env, ws, menu, docSlug, which);
  const k = cacheKey(ws.id, "pdf", d.key);
  const hit = await env.BLOBS.get(k);
  if (hit) return { title: d.index.title, body: new Uint8Array(await hit.arrayBuffer()) };
  const html = renderDeckHtml(d.index, d.slides, (sha) => `${assetBase}/_asset/${sha}`);
  const pdf = await render(env, html, assetBase, (page) => page.pdf({ width: "1920px", height: "1080px", printBackground: true, preferCSSPageSize: true }));
  const body = new Uint8Array(pdf as Uint8Array);
  await env.BLOBS.put(k, body);
  await noteUsage(env, ws.id, "render", `${menu}/${docSlug}`);
  return { title: d.index.title, body };
}

/** 슬라이드 하나 PNG(960×540). 에이전트가 배치를 확인할 때(deck_render) */
export async function slidePng(env: Bindings, ws: Workspace, menu: string, docSlug: string, slideId: string, which: { version?: string; work?: boolean }, assetBase: string) {
  const d = await deckFiles(env, ws, menu, docSlug, which);
  const slide = d.slides.find((s) => s.id === slideId);
  if (!slide) throw new HttpError(404, `슬라이드 ${slideId}이(가) 없습니다`);
  const k = cacheKey(ws.id, "png", `${d.key}-${d.slideSha(slideId)}`);
  const hit = await env.BLOBS.get(k);
  if (hit) return new Uint8Array(await hit.arrayBuffer());
  const html = renderDeckHtml(d.index as DeckIndex, [slide as Slide], (sha) => `${assetBase}/_asset/${sha}`);
  const png = await render(env, html, assetBase, async (page) => {
    await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 0.5 });
    return page.screenshot({ type: "png", clip: { x: 0, y: 0, width: 1920, height: 1080 } });
  });
  const body = new Uint8Array(png as Uint8Array);
  await env.BLOBS.put(k, body);
  await noteUsage(env, ws.id, "render", `${menu}/${docSlug}#${slideId}`);
  return body;
}
