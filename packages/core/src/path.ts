/** node:path 없이 쓰는 경로 도우미(Workers·브라우저 공용). 경로 구분자는 "/"만 쓴다 */

/** 확장자(점 포함). 숨김 파일 이름(".env")은 확장자가 없다 */
export function extname(p: string): string {
  const base = p.slice(p.lastIndexOf("/") + 1);
  const i = base.lastIndexOf(".");
  return i > 0 ? base.slice(i) : "";
}
