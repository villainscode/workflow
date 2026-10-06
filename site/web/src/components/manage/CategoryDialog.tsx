import { useState } from "react";
import { ArrowDown, ArrowUp, Check, Trash2 } from "lucide-react";
import { IconButton } from "../IconButton.tsx";
import { useNavigate, useParams } from "react-router";
import { useTree } from "../../lib/api.ts";
import { slugify } from "../../lib/files.ts";
import { manage } from "../../lib/manage.ts";
import { Modal, ui } from "../Modal.tsx";
import { useAction } from "./useAction.ts";

/** 대분류(상단 메뉴) 추가·이름·순서·삭제 */
export function CategoryDialog({ onClose }: { onClose: () => void }) {
  const { data: tree } = useTree();
  const { category: current } = useParams();
  const navigate = useNavigate();
  const { run, busy, error } = useAction();
  const [names, setNames] = useState<Record<string, string>>({});
  const [newName, setNewName] = useState("");
  const [newKey, setNewKey] = useState("");
  const cats = tree?.categories ?? [];

  return (
    <Modal title="대분류 관리" onClose={onClose}>
      <ul className="grid gap-2">
        {cats.map((c, i) => {
          const name = names[c.key] ?? c.name;
          return (
            <li key={c.key} className="flex items-center gap-1.5">
              <input className={ui.field} value={name} onChange={(e) => setNames({ ...names, [c.key]: e.target.value })} aria-label={`${c.key} 이름`} />
              <span className="w-24 shrink-0 truncate font-mono text-[11px] text-muted">{c.key}</span>
              <IconButton icon={Check} label="이름 저장" disabled={busy || name === c.name || !name.trim()}
                onClick={() => run(() => manage.updateCategory(c.key, { name }), {
                  title: "대분류 이름을 바꿀까요?", confirmText: "저장", details: [`${c.name} → ${name.trim()}`],
                })} />
              <IconButton icon={ArrowUp} label="위로" disabled={busy || i === 0}
                onClick={() => run(() => manage.updateCategory(c.key, { index: i - 1 }))} />
              <IconButton icon={ArrowDown} label="아래로" disabled={busy || i === cats.length - 1}
                onClick={() => run(() => manage.updateCategory(c.key, { index: i + 1 }))} />
              <IconButton icon={Trash2} label={c.menus.length > 0 ? "메뉴가 있는 대분류는 지울 수 없습니다" : "삭제"}
                disabled={busy || c.menus.length > 0}
                onClick={async () => {
                  const ok = await run(() => manage.deleteCategory(c.key), {
                    title: "대분류를 삭제할까요?", tone: "danger", confirmText: "삭제", details: [`대분류: ${c.name} (${c.key})`],
                  });
                  if (ok && current === c.key) navigate("/");
                }} />
            </li>
          );
        })}
      </ul>
      <form className="grid gap-2 border-t border-line pt-3 sm:grid-cols-[1fr_1fr_auto]" onSubmit={async (e) => {
        e.preventDefault();
        const ok = await run(() => manage.addCategory(newName, newKey), {
          title: "대분류를 추가할까요?", confirmText: "추가", details: [`이름: ${newName.trim()}`, `key: ${newKey || slugify(newName)}`],
        });
        if (ok) { setNewName(""); setNewKey(""); }
      }}>
        <input className={ui.field} value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="새 대분류 이름" />
        <input className={ui.field} value={newKey} onChange={(e) => setNewKey(e.target.value)} placeholder={slugify(newName) || "key (영문)"} />
        <button className={ui.primary} disabled={busy || !newName.trim()}>추가</button>
      </form>
      {error && <p className={ui.error}>{error}</p>}
    </Modal>
  );
}
