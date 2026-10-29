/** 영문 kebab-case slug. 영문·숫자가 없으면 빈 문자열(부르는 쪽이 기본값을 정한다). 파일 확장자는 뗀다 */
export const slugify = (s: string) =>
  s.toLowerCase().replace(/\.[a-z0-9]+$/, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
