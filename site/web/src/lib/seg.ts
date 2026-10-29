import { BASENAME } from "./base.ts";
import { formatSeg } from "@workflow/core/seg";

/** 조각 지정(3.2) 해석·표기는 core(화면과 MCP 공용) */
export { formatSeg, parseSeg } from "@workflow/core/seg";

/** 붙여 넣을 참조 주소. 버전을 늘 넣어 나중에 문서가 바뀌어도 가리키는 곳이 그대로다 */
export const refUrl = (category: string, menu: string, doc: string, version: string, ids: number[]) =>
  `${location.origin}${BASENAME}/${category}/${menu}/${doc}?v=${encodeURIComponent(version)}&seg=${formatSeg(ids)}`;

/** 클립보드에 쓴다. Clipboard API가 막힌 환경에서는 예전 방식으로 복사한다 */
export async function copyText(text: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* 아래 방식으로 */ }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  const ok = document.execCommand("copy");
  ta.remove();
  return ok;
}
