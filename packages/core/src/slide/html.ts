import { CANVAS, esc, type Slide, type SlideNode } from "./parse.ts";
import { FAMILY_RE, type DeckIndex } from "./deck.ts";

/**
 * 슬라이드를 정적 HTML로(5.0 M7, 명세 12절 PDF·미리보기). 화면 렌더러(site/web SlideRenderer)와 같은 DOM 모양·같은 기본 스타일을 쓴다:
 * .slide-root(1920×1080), table 안 tbody, 글자 조각은 이미 검증된 인라인 마크, 링크는 새 탭. 그림 asset: 주소는 assetUrl로 바꾼다.
 * 기본 스타일(SLIDE_BASE_CSS)은 화면도 이것을 넣는다(한 곳에서 정한다).
 */

export const SLIDE_BASE_CSS = `
.slide-root{position:relative;width:1920px;height:1080px;overflow:hidden;background:#ffffff;color:#1c2026;font-family:"IBM Plex Sans KR",sans-serif;font-size:32px;line-height:1.4;box-sizing:border-box}
.slide-root *,.slide-root *::before,.slide-root *::after{box-sizing:border-box}
.slide-root h1{font-size:96px;font-weight:600;line-height:1.15;margin:0}
.slide-root h2{font-size:64px;font-weight:600;line-height:1.2;margin:0}
.slide-root h3{font-size:44px;font-weight:600;line-height:1.25;margin:0}
.slide-root p{font-size:32px;margin:0}
.slide-root ul,.slide-root ol{margin:0;padding-left:1.2em}
.slide-root ul{list-style:disc}
.slide-root ol{list-style:decimal}
.slide-root li{font-size:32px}
.slide-root table{border-collapse:collapse;width:100%;table-layout:fixed}
.slide-root th,.slide-root td{border:1px solid #c9ccd1;padding:12px 16px;text-align:left;vertical-align:top}
.slide-root th{font-weight:600}
.slide-root hr{border:0;border-top:2px solid currentColor;width:100%;margin:0}
.slide-root img{display:block;max-width:100%}
.slide-root a{color:inherit;text-decoration:underline}
.slide-root .slide-img-missing{display:flex;align-items:center;justify-content:center;background:#eceef1;color:#5b6270;font-size:24px;border:2px dashed #c9ccd1}
`;

const escAttr = (s: string) => esc(s).replace(/"/g, "&quot;");
const linkSafe = (html: string) => html.replace(/<a href=/g, '<a target="_blank" rel="noopener noreferrer" href=');
const styleAttr = (s: Record<string, string>) => {
  const t = Object.entries(s).map(([k, v]) => `${k}:${v}`).join(";");
  return t ? ` style="${escAttr(t)}"` : "";
};

/** asset:<sha> → 그릴 주소(없으면 자리 표시) */
export type AssetUrl = (sha: string) => string | null;

function node(n: SlideNode, assetUrl: AssetUrl, root = false): string {
  if (n.kind === "text") return `<span>${linkSafe(n.html)}</span>`;
  if (n.tag === "img") {
    const sha = n.attrs.src?.startsWith("asset:") ? n.attrs.src.slice(6) : "";
    const url = sha ? assetUrl(sha) : null;
    return url ? `<img src="${escAttr(url)}" alt="${escAttr(n.attrs.alt ?? "")}"${styleAttr(n.style)}>`
      : `<div class="slide-img-missing" role="img" aria-label="${escAttr(n.attrs.alt ?? "")}"${styleAttr(n.style)}>${esc(n.attrs.alt || "그림")}</div>`;
  }
  if (n.tag === "hr") return `<hr${styleAttr(n.style)}>`;
  const tag = root ? "div" : n.tag;
  const cls = root ? ' class="slide-root"' : "";
  const onlyText = n.children.length > 0 && n.children.every((c) => c.kind === "text");
  const inner = onlyText ? linkSafe(n.children.map((c) => (c as { html: string }).html).join("")) : n.children.map((c) => node(c, assetUrl)).join("");
  return `<${tag}${cls}${styleAttr(n.style)}>${n.tag === "table" ? `<tbody>${inner}</tbody>` : inner}</${tag}>`;
}

export const renderSlideHtml = (slide: Slide, assetUrl: AssetUrl) => node(slide.root, assetUrl, true);

/** 인쇄·미리보기용 문서 하나: 덱 글꼴, 기본 스타일, 슬라이드마다 1920×1080 쪽 */
export function renderDeckHtml(index: DeckIndex, slides: Slide[], assetUrl: AssetUrl): string {
  // 검증을 거치지 않은 색인이 와도 CSS·태그로 새지 않게: 형식에 맞는 글꼴만, Google Fonts 주소만
  const faces = Object.values(index.faces ?? {}).filter((f) => FAMILY_RE.test(f.family) && /^https:\/\/fonts\.googleapis\.com\//.test(f.href));
  const family = faces[0] ? `font-family:"${faces[0].family}","IBM Plex Sans KR",sans-serif;` : "";
  const links = [
    "https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+KR:wght@400;600;700&display=block",
    ...faces.map((f) => f.href),
  ].map((h) => `<link rel="stylesheet" href="${escAttr(h)}">`).join("");
  // 인쇄용 문서에서는 스크립트가 돌 일이 없다(글꼴·그림만 읽는다)
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="script-src 'none'; object-src 'none'; base-uri 'none'"><title>${esc(index.title)}</title>${links}
<style>@page{size:${CANVAS.width}px ${CANVAS.height}px;margin:0}html,body{margin:0;padding:0;background:#fff}
.slide-page{width:${CANVAS.width}px;height:${CANVAS.height}px;overflow:hidden;break-after:page;${family}}.slide-page:last-child{break-after:auto}
${SLIDE_BASE_CSS}</style></head><body>${slides.map((s) => `<section class="slide-page" data-slide="${escAttr(s.id)}">${renderSlideHtml(s, assetUrl)}</section>`).join("")}</body></html>`;
}
