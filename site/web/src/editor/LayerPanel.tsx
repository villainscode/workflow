import { ArrowDown, ArrowUp } from "lucide-react";
import { IconButton } from "../components/IconButton.tsx";

/**
 * 레이어(요소 트리) 패널(6.0 4.1). 문서 종류와 무관하게 부르는 쪽이 트리를 펼친 목록으로 준다.
 * 목록 순서가 문서 순서다(흐름 배치의 위→아래, 겹친 고정 요소는 아래쪽 항목이 위에 그려진다). 위로·아래로는 같은 부모 안에서 한 칸 옮긴다.
 */

export interface LayerItem { id: string; label: string; depth: number; first: boolean; last: boolean; movable: boolean }

export function LayerPanel({ items, selected, onSelect, onMove }: {
  items: LayerItem[];
  selected: string[];
  onSelect: (id: string, additive: boolean) => void;
  onMove: (id: string, dir: -1 | 1) => void;
}) {
  return (
    <section aria-label="레이어">
      <h3 className="mb-1 text-xs font-semibold text-muted">레이어</h3>
      <p className="mb-1 text-[11px] text-muted">문서 순서입니다. 겹치면 아래쪽 항목이 위에 그려집니다.</p>
      <ul className="space-y-px" role="tree">
        {items.map((it) => {
          const on = selected.includes(it.id);
          return (
            <li key={it.id} role="treeitem" aria-selected={on} className={`group flex items-center rounded ${on ? "bg-accent-soft text-accent" : "hover:bg-sunken"}`}>
              <button type="button" className="min-w-0 flex-1 truncate py-0.5 pr-1 text-left text-xs" style={{ paddingLeft: 4 + it.depth * 12 }}
                onClick={(e) => onSelect(it.id, e.shiftKey)}>{it.label}</button>
              {it.movable && (
                <span className="flex shrink-0">
                  <IconButton icon={ArrowUp} label="위로 (문서 순서 한 칸 앞)" size={14} disabled={it.first} onClick={() => onMove(it.id, -1)} />
                  <IconButton icon={ArrowDown} label="아래로 (문서 순서 한 칸 뒤)" size={14} disabled={it.last} onClick={() => onMove(it.id, 1)} />
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
