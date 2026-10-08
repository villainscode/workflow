/**
 * 문서 참조의 조각 지정(3.2). 주소 `?seg=` 값: `12`, `12-15`, 목록 `3,10-12`.
 * MCP 서버(site/mcp/server.ts)의 parseSeg와 같은 규칙이다.
 */
export function parseSeg(seg: string | null | undefined): number[] {
  if (!seg) return [];
  const out = new Set<number>();
  for (const part of seg.split(",")) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part.trim());
    if (!m) continue;
    const a = Number(m[1]), b = Number(m[2] ?? m[1]);
    for (let i = Math.min(a, b); i <= Math.max(a, b) && i - Math.min(a, b) < 5000; i++) out.add(i);
  }
  return [...out].sort((x, y) => x - y);
}

/** 조각 id 목록을 가장 짧은 `seg` 값으로: [3, 10, 11, 12] → "3,10-12" */
export function formatSeg(ids: number[]): string {
  const sorted = [...new Set(ids)].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < sorted.length; i++) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
    parts.push(i === j ? `${sorted[i]}` : `${sorted[i]}-${sorted[j]}`);
    i = j;
  }
  return parts.join(",");
}

/** 붙여 넣을 참조 주소. 버전을 늘 넣어 나중에 문서가 바뀌어도 가리키는 곳이 그대로다 */
export const refUrl = (category: string, menu: string, doc: string, version: string, ids: number[]) =>
  `${location.origin}/${category}/${menu}/${doc}?v=${encodeURIComponent(version)}&seg=${formatSeg(ids)}`;

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
