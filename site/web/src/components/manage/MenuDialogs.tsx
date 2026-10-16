import { useState } from "react";
import { useTree, type MenuNode } from "../../lib/api.ts";
import { manage } from "../../lib/manage.ts";
import { Modal, ui } from "../Modal.tsx";
import { useAction } from "./useAction.ts";
import { contains, flattenMenus } from "./menuTree.ts";
import { stopComposingEnter } from "../../lib/ime.ts";

/** 메뉴를 다른 대분류나 다른 메뉴 아래로 옮긴다. 폴더 경로는 바뀌지 않는다. */
export function MoveMenuDialog({ menu, onClose }: { menu: MenuNode; onClose: () => void }) {
  const { data: tree } = useTree();
  const flat = flattenMenus(tree?.categories ?? []);
  const here = flat.find((f) => f.menu.slug === menu.slug);
  const [target, setTarget] = useState(here ? (here.parent ? `m:${here.parent.slug}` : `c:${here.category.key}`) : "");
  const { run, busy, error } = useAction();

  return (
    <Modal title={`'${menu.name}' 옮기기`} onClose={onClose}>
      <form className="grid gap-3" onKeyDown={stopComposingEnter} onSubmit={async (e) => {
        e.preventDefault();
        const [kind, value] = target.split(":");
        const parent = kind === "m" ? flat.find((f) => f.menu.slug === value) : undefined;
        const category = parent ? parent.category.key : value;
        const where = parent ? `${parent.category.name} › ${parent.menu.name} 아래` : `${tree?.categories.find((c) => c.key === category)?.name ?? category} 최상위`;
        const ok = await run(() => manage.moveMenu(menu.slug, { category, parent: parent?.menu.slug ?? null }), {
          title: "메뉴를 옮길까요?", tone: "warning", confirmText: "옮기기",
          details: [`메뉴: ${menu.name}`, `옮길 위치: ${where}`], message: "하위 메뉴와 문서도 함께 옮겨집니다.",
        });
        if (ok) onClose();
      }}>
        <label className={ui.label}>옮길 위치
          <select className={ui.field} value={target} onChange={(e) => setTarget(e.target.value)}>
            {tree?.categories.map((c) => (
              <optgroup key={c.key} label={c.name}>
                <option value={`c:${c.key}`}>{c.name} 최상위</option>
                {flat.filter((f) => f.category.key === c.key && !contains(menu, f.menu.slug)).map((f) => (
                  <option key={f.menu.slug} value={`m:${f.menu.slug}`}>{"　".repeat(f.depth + 1)}{f.menu.name} 아래</option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>
        <p className="text-xs text-muted">메뉴 안의 문서와 하위 메뉴도 함께 옮겨집니다. 파일 위치(docs/{menu.slug}/)는 바뀌지 않습니다.</p>
        {error && <p className={ui.error}>{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" className={ui.secondary} onClick={onClose}>취소</button>
          <button className={ui.primary} disabled={busy}>옮기기</button>
        </div>
      </form>
    </Modal>
  );
}

/**
 * 폴더(메뉴) 삭제. 안의 문서(하위 문서 포함)와 하위 폴더 문서는 모두 휴지통으로 간다.
 * 실수를 막으려고 폴더 이름을 그대로 입력해야 삭제 버튼이 켜진다(이 창이 확인 창을 대신한다)
 */
export function DeleteMenuDialog({ menu, onClose, onDeleted }: { menu: MenuNode; onClose: () => void; onDeleted: () => void }) {
  const [typed, setTyped] = useState("");
  const { run, busy, error } = useAction();
  const count = (m: MenuNode): { docs: number; menus: number } => m.menus.map(count).reduce(
    (a, b) => ({ docs: a.docs + b.docs, menus: a.menus + b.menus + 1 }), { docs: m.documents.length, menus: 0 });
  const { docs, menus } = count(menu);
  return (
    <Modal title="폴더 삭제" onClose={onClose}>
      <form className="grid gap-3" onKeyDown={stopComposingEnter} onSubmit={async (e) => {
        e.preventDefault();
        if (typed !== menu.name) return;
        const ok = await run(() => manage.deleteMenu(menu.slug));
        if (ok) { onClose(); onDeleted(); }
      }}>
        <p className="text-sm text-muted">
          {docs || menus
            ? <>폴더 안의 문서 <b className="text-fg">{docs}개</b>{menus ? <>와 하위 폴더 <b className="text-fg">{menus}개</b></> : null}도 함께 지웁니다. 문서는 휴지통으로 옮겨져 다시 복원할 수 있습니다.</>
            : "빈 폴더입니다."}
        </p>
        <label className={ui.label}>
          <span>확인을 위해 폴더 이름 <b className="text-fg">{menu.name}</b>을(를) 입력하세요</span>
          <input className={ui.field} value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={menu.name} autoFocus aria-label="삭제할 폴더 이름" />
        </label>
        {error && <p className={ui.error}>{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" className={ui.secondary} onClick={onClose}>취소</button>
          <button className="rounded-md bg-crit px-4 py-1.5 text-sm font-medium text-surface disabled:opacity-50" disabled={busy || typed !== menu.name}>삭제</button>
        </div>
      </form>
    </Modal>
  );
}
