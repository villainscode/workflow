import { uploadAsset } from "../lib/structedit.ts";

/** SVG 편집(6.0 V4) 공통: 주소에서 SVG 글 읽기, draw.io SVG인지, 고친 SVG를 새 자산으로 올리기 */

/** 그림으로 넣을 수 있는 형식(SVG는 파일 참조로 들어간다) */
export const IMAGE_ACCEPT = "image/png,image/jpeg,image/webp,image/gif,image/svg+xml";

export async function fetchSvg(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`SVG를 읽지 못했습니다(${res.status})`);
  return res.text();
}

/** draw.io가 내보낸 편집용 SVG(루트 <svg>에 content 속성) */
export const isDrawioSvg = (svg: string) => /^\s*(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)?<svg\b[^>]*\scontent="/.test(svg);

/** 고친 SVG를 새 자산으로(서버가 소독한다). 지운 것이 있으면 removed로 돌려준다 */
export async function uploadSvg(svg: string, name = "drawing.svg") {
  return uploadAsset(new File([svg], name, { type: "image/svg+xml" }));
}
