import { useState } from "react";
import { useTree, type MenuNode } from "../../lib/api.ts";
import { slugify } from "../../lib/files.ts";
import { manage } from "../../lib/manage.ts";
import { Modal, ui } from "../Modal.tsx";
import { useAction } from "./useAction.ts";
import { contains, flattenMenus } from "./menuTree.ts";

/** 메뉴 추가(최상위 또는 하위) */
export function AddMenuDialog({ category, parent, onClose }: { category: string; parent?: MenuNode; onClose: () => void }) {
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const { run, busy, error } = useAction();
  return (
    <Modal title={parent ? `'${parent.name}' 아래에 하위 메뉴` : "메뉴 추가"} onClose={onClose}>
      <form className="grid gap-3" onSubmit={async (e) => {
        e.preventDefault();
        if (await run(() => manage.addMenu(category, name, slug, parent?.slug))) onClose();
      }}>
        <label className={ui.label}>메뉴 이름<input className={ui.field} value={name} onChange={(e) => setName(e.target.value)} autoFocus placeholder="예: 빌드·배포" /></label>
        <label className={ui.label}>메뉴 slug (영문, docs/ 아래 폴더 이름)
          <input className={ui.field} value={slug} onChange={(e) => setSlug(e.target.value)} placeholder={slugify(name) || "build-deploy"} />
        </label>
        {error && <p className={ui.error}>{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" className={ui.secondary} onClick={onClose}>취소</button>
          <button className={ui.primary} disabled={busy || !name.trim()}>추가</button>
        </div>
      </form>
    </Modal>
  );
}

export function RenameMenuDialog({ menu, onClose }: { menu: MenuNode; onClose: () => void }) {
  const [name, setName] = useState(menu.name);
  const { run, busy, error } = useAction();
  return (
    <Modal title="메뉴 이름 바꾸기" onClose={onClose}>
      <form className="grid gap-3" onSubmit={async (e) => {
        e.preventDefault();
        if (await run(() => manage.renameMenu(menu.slug, name))) onClose();
      }}>
        <label className={ui.label}>메뉴 이름<input className={ui.field} value={name} onChange={(e) => setName(e.target.value)} autoFocus /></label>
        <p className="text-xs text-muted">slug(<code>{menu.slug}</code>)와 폴더 이름은 바뀌지 않습니다.</p>
        {error && <p className={ui.error}>{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" className={ui.secondary} onClick={onClose}>취소</button>
          <button className={ui.primary} disabled={busy || !name.trim()}>저장</button>
        </div>
      </form>
    </Modal>
  );
}

/** 메뉴를 다른 대분류나 다른 메뉴 아래로 옮긴다. 폴더 경로는 바뀌지 않는다. */
export function MoveMenuDialog({ menu, onClose }: { menu: MenuNode; onClose: () => void }) {
  const { data: tree } = useTree();
  const flat = flattenMenus(tree?.categories ?? []);
  const here = flat.find((f) => f.menu.slug === menu.slug);
  const [target, setTarget] = useState(here ? (here.parent ? `m:${here.parent.slug}` : `c:${here.category.key}`) : "");
  const { run, busy, error } = useAction();

  return (
    <Modal title={`'${menu.name}' 옮기기`} onClose={onClose}>
      <form className="grid gap-3" onSubmit={async (e) => {
        e.preventDefault();
        const [kind, value] = target.split(":");
        const parent = kind === "m" ? flat.find((f) => f.menu.slug === value) : undefined;
        const category = parent ? parent.category.key : value;
        if (await run(() => manage.moveMenu(menu.slug, { category, parent: parent?.menu.slug ?? null }))) onClose();
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
