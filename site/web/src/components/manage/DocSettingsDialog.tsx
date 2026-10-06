import { useState } from "react";
import { useNavigate } from "react-router";
import { useTree, type DocDetail } from "../../lib/api.ts";
import { manage } from "../../lib/manage.ts";
import { Modal, ui } from "../Modal.tsx";
import { useAction } from "./useAction.ts";
import { flattenMenus } from "./menuTree.ts";

/** 문서 제목·상태·메뉴 이동·휴지통 */
export function DocSettingsDialog({ doc, onClose }: { doc: DocDetail; onClose: () => void }) {
  const { data: tree } = useTree();
  const navigate = useNavigate();
  const flat = flattenMenus(tree?.categories ?? []);
  const [title, setTitle] = useState(doc.title);
  const [status, setStatus] = useState(doc.status);
  const [menu, setMenu] = useState(doc.menuSlug);
  const { run, busy, error } = useAction();

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const ok = await run(async () => {
      if (title !== doc.title || status !== doc.status) await manage.updateDoc(doc.menuSlug, doc.slug, { title, status });
      return menu !== doc.menuSlug ? manage.moveDoc(doc.menuSlug, doc.slug, menu) : { menu: doc.menuSlug, doc: doc.slug, category: "" };
    });
    if (!ok) return;
    onClose();
    if (ok.category) navigate(`/${ok.category}/${ok.menu}/${ok.doc}`);
  }

  async function trash() {
    if (!confirm(`'${doc.title}'을(를) 휴지통으로 옮길까요? 휴지통에서 복원할 수 있습니다.`)) return;
    const owner = flat.find((f) => f.menu.slug === doc.menuSlug)?.category.key ?? "";
    if (await run(() => manage.trashDoc(doc.menuSlug, doc.slug))) { onClose(); navigate(`/${owner}`); }
  }

  return (
    <Modal title="문서 관리" onClose={onClose}>
      <form className="grid gap-3" onSubmit={save}>
        <label className={ui.label}>제목<input className={ui.field} value={title} onChange={(e) => setTitle(e.target.value)} /></label>
        <label className={ui.label}>상태
          <select className={ui.field} value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="draft">draft · 작성 중</option>
            <option value="review">review · 검토 중</option>
            <option value="approved">approved · 확정</option>
          </select>
        </label>
        <label className={ui.label}>메뉴 (바꾸면 문서 폴더가 그 메뉴 폴더로 옮겨집니다)
          <select className={ui.field} value={menu} onChange={(e) => setMenu(e.target.value)}>
            {tree?.categories.map((c) => (
              <optgroup key={c.key} label={c.name}>
                {flat.filter((f) => f.category.key === c.key).map((f) => (
                  <option key={f.menu.slug} value={f.menu.slug}>{"　".repeat(f.depth)}{f.menu.name}</option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>
        {error && <p className={ui.error}>{error}</p>}
        <div className="flex flex-wrap justify-between gap-2">
          <button type="button" className={ui.danger} onClick={trash} disabled={busy}>휴지통으로</button>
          <div className="flex gap-2">
            <button type="button" className={ui.secondary} onClick={onClose}>취소</button>
            <button className={ui.primary} disabled={busy || !title.trim()}>저장</button>
          </div>
        </div>
      </form>
    </Modal>
  );
}
