import { useState } from "react";
import { useNavigate } from "react-router";
import { useTree } from "../../lib/api.ts";
import { manage, useTrash, type TrashItem } from "../../lib/manage.ts";
import { Modal, ui } from "../Modal.tsx";
import { useAction } from "./useAction.ts";
import { flattenMenus } from "./menuTree.ts";

export function TrashDialog({ onClose }: { onClose: () => void }) {
  const { data: items } = useTrash();
  const { data: tree } = useTree();
  const navigate = useNavigate();
  const flat = flattenMenus(tree?.categories ?? []);
  const { run, busy, error } = useAction();
  const [targets, setTargets] = useState<Record<string, string>>({});

  async function restore(item: TrashItem) {
    const exists = flat.some((f) => f.menu.slug === item.menu);
    const to = targets[item.id] ?? (exists ? item.menu : "");
    if (!to) return;
    const r = await run(() => manage.restore(item.id, to));
    if (r) { onClose(); navigate(`/${r.category}/${r.menu}/${r.doc}`); }
  }

  return (
    <Modal title="휴지통" onClose={onClose} wide>
      {!items?.length ? (
        <p className="text-sm text-muted">휴지통이 비어 있습니다.</p>
      ) : (
        <ul className="grid max-h-[60dvh] gap-2 overflow-y-auto">
          {items.map((item) => {
            const exists = flat.some((f) => f.menu.slug === item.menu);
            return (
              <li key={item.id} className="grid gap-2 rounded-md border border-line p-3 sm:grid-cols-[1fr_auto] sm:items-center">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{item.title}</p>
                  <p className="font-mono text-[11px] text-muted">{item.menu}/{item.doc} · 삭제 {item.deletedAt}</p>
                  {!exists && (
                    <select className={`${ui.field} mt-1.5 text-xs`} value={targets[item.id] ?? ""}
                      onChange={(e) => setTargets({ ...targets, [item.id]: e.target.value })}>
                      <option value="">원래 메뉴가 없습니다. 복원할 메뉴를 고르세요</option>
                      {flat.map((f) => <option key={f.menu.slug} value={f.menu.slug}>{f.category.name} › {f.menu.name}</option>)}
                    </select>
                  )}
                </div>
                <div className="flex gap-2">
                  <button className={ui.secondary} disabled={busy || (!exists && !targets[item.id])} onClick={() => restore(item)}>복원</button>
                  <button className={ui.danger} disabled={busy} onClick={() => {
                    if (confirm(`'${item.title}'을(를) 영구 삭제할까요? 되돌릴 수 없습니다(커밋된 적이 있으면 git 이력에는 남습니다).`)) void run(() => manage.purge(item.id));
                  }}>영구 삭제</button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {error && <p className={ui.error}>{error}</p>}
    </Modal>
  );
}
