/**
 * 자유 배치 좌표(6.0 V3). 편집 사본 DOM에서 재는 순수 함수라 화면과 화면 테스트(배치 검사)가 같이 쓴다.
 * - 좌표 기준은 요소의 실제 위치 기준 상자(가장 가까운 위치 지정 조상, 없으면 기준 섹션)다. left·width는 그 너비의 %, top은 px.
 * - 기준 섹션 최소 높이는 고정 요소를 뺀 흐름 높이와 고정 요소 바닥 중 큰 값(min-height가 content-box면 padding·border를 뺀다).
 *   고정 요소 바닥은 편집 폭과 좁은 화면 규칙 바로 위 폭(641px) 둘 다에서 재 큰 쪽을 쓴다(글자가 다시 줄바꿈되면 길어진다, 6.0 12절).
 * 함수 안에서 바깥 이름을 쓰지 않는다(화면 테스트가 toString()으로 브라우저에 넣는다).
 */

export interface PinBox { left: number; top: number; width: number }

/** 고정했을 때 위치 기준이 될 상자 */
export function containingBlock(el: HTMLElement, base: HTMLElement): HTMLElement {
  const win = el.ownerDocument.defaultView!;
  for (let p = el.parentElement; p && p !== base; p = p.parentElement) if (win.getComputedStyle(p).position !== "static") return p;
  return base;
}

/** 화면 상자(clientX·Y 기준) → 기준 상자 안 고정 상자 */
export function pinBoxOf(r: { left: number; top: number; width: number }, cb: HTMLElement): PinBox {
  const c = cb.getBoundingClientRect();
  const w = cb.clientWidth || 1;
  return { left: ((r.left - c.left - cb.clientLeft) / w) * 100, top: r.top - c.top - cb.clientTop, width: (r.width / w) * 100 };
}

/**
 * 기준 섹션 최소 높이(px, min-height에 그대로 쓸 값). flow가 false면 고정 요소 바닥만 본다:
 * 좁은 폭(641px)에서 글자가 다시 줄바꿈되어 길어진 고정 요소까지 담으려고 재는데, 그 폭의 흐름 높이는 넓은 화면에 빈칸만 만든다.
 */
export function baseMinHeight(base: HTMLElement, flow = true): number {
  const win = base.ownerDocument.defaultView!;
  const cs = win.getComputedStyle(base);
  const prev = base.style.minHeight;
  base.style.minHeight = "0px";
  const b = base.getBoundingClientRect();
  let outer = flow ? b.height : 0;
  const padB = parseFloat(cs.paddingBottom) + parseFloat(cs.borderBottomWidth);
  for (const el of base.querySelectorAll<HTMLElement>("[data-pin]")) {
    if (win.getComputedStyle(el).position !== "absolute") continue;
    outer = Math.max(outer, el.getBoundingClientRect().bottom - b.top + padB);
  }
  base.style.minHeight = prev;
  const inner = cs.boxSizing === "border-box" ? 0
    : parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom) + parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
  return Math.ceil(outer - inner);
}

/** 미리 보기: 요소를 고정 위치로 그려 둔다(저장하면 사본을 다시 읽어 버려진다) */
export function previewPin(el: HTMLElement, base: HTMLElement, box: PinBox) {
  base.style.position = "relative";
  el.setAttribute("data-pin", "");
  el.style.position = "absolute";
  el.style.left = `${box.left}%`;
  el.style.top = `${box.top}px`;
  el.style.width = `${box.width}%`;
  el.style.margin = "0";
}

/** 기준 섹션 최소 높이: 편집 폭과 641px(좁은 화면 규칙 바로 위)에서 잰 고정 요소 바닥 중 큰 값. 641px은 화면 밖 사본으로 잰다 */
export async function minHeightFor(doc: Document, base: HTMLElement): Promise<number> {
  const here = baseMinHeight(base);
  const eid = base.getAttribute("data-base");
  if (!eid) return here;
  const f = document.createElement("iframe");
  f.setAttribute("sandbox", "allow-same-origin");
  f.setAttribute("aria-hidden", "true");
  f.style.cssText = "position:fixed;left:-10000px;top:0;width:641px;height:900px;border:0;visibility:hidden";
  f.srcdoc = `<!doctype html>${doc.documentElement.outerHTML}`;
  try {
    const loaded = new Promise<void>((ok) => { f.onload = () => ok(); });
    document.body.appendChild(f);
    await Promise.race([loaded, new Promise((ok) => setTimeout(ok, 3000))]);
    await f.contentDocument?.fonts?.ready;
    const narrow = f.contentDocument?.querySelector<HTMLElement>(`[data-base="${eid}"]`);
    return Math.max(here, narrow ? baseMinHeight(narrow, false) : 0);
  } finally { f.remove(); }
}

/** 맞춤선(섹션 경계·가운데·이웃 요소) 가까이(6px)면 붙인다. 상자는 화면 좌표, 돌려주는 값은 옮길 양 */
export function snapDelta(box: { left: number; top: number; width: number; height: number }, xs: number[], ys: number[], gap = 6) {
  const best = (edges: number[], lines: number[]) => {
    let d = 0, min = gap + 1;
    for (const e of edges) for (const l of lines) if (Math.abs(l - e) < min) { min = Math.abs(l - e); d = l - e; }
    return min <= gap ? d : 0;
  };
  return {
    dx: best([box.left, box.left + box.width / 2, box.left + box.width], xs),
    dy: best([box.top, box.top + box.height / 2, box.top + box.height], ys),
  };
}
