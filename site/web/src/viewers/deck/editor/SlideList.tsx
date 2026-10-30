import { closestCenter, DndContext, KeyboardSensor, PointerSensor, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { arrayMove, SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Copy, GripVertical, Plus, Trash2 } from "lucide-react";
import type { Slide } from "@workflow/core/slide";
import { IconButton } from "../../../components/IconButton.tsx";
import { SlideCanvas, SlideRenderer } from "../SlideRenderer.tsx";

/** 슬라이드 목록(명세 06절): 끌어서·키보드(Space로 잡고 화살표)로 순서 바꾸기, 새 슬라이드·복제·지우기 */
export function SlideList({ order, slides, current, family, busy, onSelect, onReorder, onAdd, onDuplicate, onRemove }: {
  order: string[]; slides: Record<string, Slide>; current: string; family?: string; busy: boolean;
  onSelect: (id: string) => void; onReorder: (order: string[]) => void; onAdd: (after: number) => void;
  onDuplicate: (id: string) => void; onRemove: (id: string) => void;
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    onReorder(arrayMove(order, order.indexOf(String(active.id)), order.indexOf(String(over.id))));
  };
  return (
    <div className="flex min-h-0 flex-col border-r border-line bg-surface">
      <ol className="min-h-0 flex-1 space-y-1 overflow-y-auto p-2" aria-label="슬라이드 목록">
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext items={order} strategy={verticalListSortingStrategy}>
            {order.map((id, i) => (
              <Row key={id} id={id} n={i + 1} slide={slides[id]} family={family} active={id === current} busy={busy} last={order.length === 1}
                onSelect={() => onSelect(id)} onDuplicate={() => onDuplicate(id)} onRemove={() => onRemove(id)} />
            ))}
          </SortableContext>
        </DndContext>
      </ol>
      <div className="border-t border-line p-2">
        <IconButton icon={Plus} label="새 슬라이드" text="새 슬라이드" variant="outline" disabled={busy}
          onClick={() => onAdd(order.indexOf(current))} className="w-full justify-center" />
      </div>
    </div>
  );
}

function Row({ id, n, slide, family, active, busy, last, onSelect, onDuplicate, onRemove }: {
  id: string; n: number; slide: Slide; family?: string; active: boolean; busy: boolean; last: boolean;
  onSelect: () => void; onDuplicate: () => void; onRemove: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id, disabled: busy });
  return (
    <li ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.6 : 1 }}
      className={`group rounded-md p-1 ${active ? "bg-accent-soft" : "hover:bg-sunken"}`}>
      <div className="flex items-start gap-1">
        <div className="flex w-5 shrink-0 flex-col items-center gap-1 pt-0.5">
          <span className="font-mono text-[11px] text-muted">{n}</span>
          <button type="button" className="cursor-grab rounded text-muted hover:text-fg" aria-label={`${n}번 슬라이드 옮기기`} data-tip="끌어서 순서 바꾸기" {...attributes} {...listeners}>
            <GripVertical size={14} aria-hidden />
          </button>
        </div>
        <button type="button" onClick={onSelect} aria-current={active ? "true" : undefined} aria-label={`${n}번 슬라이드 편집`}
          className={`block overflow-hidden rounded border ${active ? "border-accent" : "border-line"}`}>
          {slide && <SlideCanvas width={150}><SlideRenderer slide={slide} family={family} /></SlideCanvas>}
        </button>
      </div>
      <div className="mt-0.5 flex justify-end gap-0.5 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100">
        <IconButton icon={Copy} label="슬라이드 복제" size={14} disabled={busy} onClick={onDuplicate} />
        <IconButton icon={Trash2} label="슬라이드 지우기" size={14} disabled={busy || last} onClick={onRemove} />
      </div>
    </li>
  );
}
