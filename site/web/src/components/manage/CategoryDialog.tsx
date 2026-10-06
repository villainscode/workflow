import { useState } from "react";
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
              <button className={ui.icon} disabled={busy || name === c.name || !name.trim()}
                onClick={() => run(() => manage.updateCategory(c.key, { name }))}>저장</button>
              <button className={ui.icon} disabled={busy || i === 0} aria-label="위로"
                onClick={() => run(() => manage.updateCategory(c.key, { index: i - 1 }))}>↑</button>
              <button className={ui.icon} disabled={busy || i === cats.length - 1} aria-label="아래로"
                onClick={() => run(() => manage.updateCategory(c.key, { index: i + 1 }))}>↓</button>
              <button className={ui.icon} disabled={busy || c.menus.length > 0} aria-label="삭제"
                title={c.menus.length > 0 ? "메뉴가 있는 대분류는 지울 수 없습니다" : "삭제"}
                onClick={async () => {
                  if (!confirm(`'${c.name}' 대분류를 지울까요?`)) return;
                  if (await run(() => manage.deleteCategory(c.key)) && current === c.key) navigate("/");
                }}>🗑</button>
            </li>
          );
        })}
      </ul>
      <form className="grid gap-2 border-t border-line pt-3 sm:grid-cols-[1fr_1fr_auto]" onSubmit={async (e) => {
        e.preventDefault();
        if (await run(() => manage.addCategory(newName, newKey))) { setNewName(""); setNewKey(""); }
      }}>
        <input className={ui.field} value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="새 대분류 이름" />
        <input className={ui.field} value={newKey} onChange={(e) => setNewKey(e.target.value)} placeholder={slugify(newName) || "key (영문)"} />
        <button className={ui.primary} disabled={busy || !newName.trim()}>추가</button>
      </form>
      {error && <p className={ui.error}>{error}</p>}
    </Modal>
  );
}
