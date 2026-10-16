import { useState } from "react";
import { Trash2 } from "lucide-react";
import { useNavigate } from "react-router";
import { useTree, type DocDetail } from "../../lib/api.ts";
import { manage } from "../../lib/manage.ts";
import { Modal, ui } from "../Modal.tsx";
import { useAction } from "./useAction.ts";
import { flattenMenus } from "./menuTree.ts";
import { stopComposingEnter } from "../../lib/ime.ts";

/** 문서 제목·상태·메뉴 이동·휴지통 */
export function DocSettingsDialog({ doc, onClose }: { doc: DocDetail; onClose: () => void }) {
  const { data: tree } = useTree();
  const navigate = useNavigate();
  const flat = flattenMenus(tree?.categories ?? []);
  const [title, setTitle] = useState(doc.title);
  const [status, setStatus] = useState(doc.status);
  const [menu, setMenu] = useState(doc.menuSlug);
  const [origin, setOrigin] = useState(doc.originUrl ?? "");
  const originChanged = origin.trim() !== (doc.originUrl ?? "");
  const { run, busy, error } = useAction();

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const changes = [
      ...(title !== doc.title ? [`제목: ${doc.title} → ${title.trim()}`] : []),
      ...(status !== doc.status ? [`상태: ${doc.status} → ${status}`] : []),
      ...(originChanged ? [`출처: ${doc.originUrl || "없음"} → ${origin.trim() || "없음"}`] : []),
      ...(menu !== doc.menuSlug ? [`메뉴: ${flat.find((f) => f.menu.slug === doc.menuSlug)?.menu.name} → ${flat.find((f) => f.menu.slug === menu)?.menu.name}`] : []),
    ];
    if (changes.length === 0) return onClose();
    const ok = await run(async () => {
      if (title !== doc.title || status !== doc.status || originChanged) {
        await manage.updateDoc(doc.menuSlug, doc.slug, { title, status, ...(originChanged ? { origin: origin.trim() } : {}) });
      }
      return menu !== doc.menuSlug ? manage.moveDoc(doc.menuSlug, doc.slug, { menu }) : { menu: doc.menuSlug, doc: doc.slug, category: "" };
    }, {
      title: "문서 정보를 저장할까요?", confirmText: "저장", details: changes,
      tone: menu !== doc.menuSlug ? "warning" : "default",
      message: menu !== doc.menuSlug ? "문서 폴더가 새 메뉴 폴더 바로 아래로 옮겨집니다. 하위 문서도 함께 옮겨집니다." : undefined,
    });
    if (!ok) return;
    onClose();
    if (ok.category) navigate(`/${ok.category}/${ok.menu}/${ok.doc}`);
  }

  async function trash() {
    const owner = flat.find((f) => f.menu.slug === doc.menuSlug)?.category.key ?? "";
    const ok = await run(() => manage.trashDoc(doc.menuSlug, doc.slug), {
      title: "휴지통으로 옮길까요?", tone: "danger", confirmText: "휴지통으로",
      details: [`문서: ${doc.title}`, `버전 ${doc.versions.length}개 모두`], message: "휴지통에서 다시 복원할 수 있습니다.",
    });
    if (ok) { onClose(); navigate(`/${owner}`); }
  }

  return (
    <Modal title="문서 관리" onClose={onClose}>
      <form className="grid gap-3" onKeyDown={stopComposingEnter} onSubmit={save}>
        <label className={ui.label}>제목<input className={ui.field} value={title} onChange={(e) => setTitle(e.target.value)} /></label>
        <label className={ui.label}>상태
          <select className={ui.field} value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="draft">draft · 작성 중</option>
            <option value="review">review · 검토 중</option>
            <option value="approved">approved · 확정</option>
          </select>
        </label>
        <label className={ui.label}>출처 (외부에서 가져온 문서. 있으면 HTML 스크립트를 처음에 끈 채로 보여 줍니다)
          <input className={ui.field} value={origin} onChange={(e) => setOrigin(e.target.value)} placeholder="https://… (없으면 비움)" inputMode="url" />
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
          <button type="button" className={`${ui.danger} inline-flex items-center gap-1.5`} onClick={trash} disabled={busy}>
            <Trash2 size={19} aria-hidden /> 휴지통으로
          </button>
          <div className="flex gap-2">
            <button type="button" className={ui.secondary} onClick={onClose}>취소</button>
            <button className={ui.primary} disabled={busy || !title.trim()}>저장</button>
          </div>
        </div>
      </form>
    </Modal>
  );
}
