/**
 * 정렬·분배 계산(6.0 4.1). 문서 종류와 무관한 순수 함수: 상자 목록을 받아 옮긴 뒤 상자를 같은 순서로 돌려준다.
 * 상자 하나면 bounds(캔버스·섹션) 기준으로, 여럿이면 고른 상자들을 감싸는 상자 기준으로 맞춘다. 분배는 세 개부터.
 */

export interface Box { left: number; top: number; width: number; height: number }
export type AlignHow = "left" | "hcenter" | "right" | "top" | "vcenter" | "bottom";

export function alignBoxes(boxes: Box[], how: AlignHow, bounds?: Box): Box[] {
  const b = boxes.length === 1 && bounds ? bounds : enclose(boxes);
  return boxes.map((x) => {
    switch (how) {
      case "left": return { ...x, left: b.left };
      case "hcenter": return { ...x, left: b.left + (b.width - x.width) / 2 };
      case "right": return { ...x, left: b.left + b.width - x.width };
      case "top": return { ...x, top: b.top };
      case "vcenter": return { ...x, top: b.top + (b.height - x.height) / 2 };
      case "bottom": return { ...x, top: b.top + b.height - x.height };
    }
  });
}

/** 처음·끝 상자는 그대로 두고 사이 간격을 같게 한다 */
export function distributeBoxes(boxes: Box[], axis: "x" | "y"): Box[] {
  if (boxes.length < 3) return boxes;
  const [pos, size] = axis === "x" ? (["left", "width"] as const) : (["top", "height"] as const);
  const order = boxes.map((_, i) => i).sort((a, c) => boxes[a][pos] - boxes[c][pos]);
  const first = boxes[order[0]], last = boxes[order[order.length - 1]];
  const span = last[pos] + last[size] - first[pos];
  const gap = (span - order.reduce((s, i) => s + boxes[i][size], 0)) / (order.length - 1);
  const out = boxes.map((x) => ({ ...x }));
  let at = first[pos];
  for (const i of order) { out[i][pos] = at; at += boxes[i][size] + gap; }
  return out;
}

function enclose(boxes: Box[]): Box {
  const left = Math.min(...boxes.map((b) => b.left)), top = Math.min(...boxes.map((b) => b.top));
  const right = Math.max(...boxes.map((b) => b.left + b.width)), bottom = Math.max(...boxes.map((b) => b.top + b.height));
  return { left, top, width: right - left, height: bottom - top };
}
