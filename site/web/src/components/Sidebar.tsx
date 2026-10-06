import { useState } from "react";
import { NavLink } from "react-router";
import type { Category, MenuNode } from "../lib/api.ts";
import { filesFromDrop } from "../lib/files.ts";
import { manage, useTrash } from "../lib/manage.ts";
import { useOpenUpload } from "./upload/UploadContext.tsx";
import { StatusBadge } from "./StatusBadge.tsx";
import { ui } from "./Modal.tsx";
import { useAction } from "./manage/useAction.ts";
import { AddMenuDialog, MoveMenuDialog, RenameMenuDialog } from "./manage/MenuDialogs.tsx";
import { CategoryDialog } from "./manage/CategoryDialog.tsx";
import { TrashDialog } from "./manage/TrashDialog.tsx";

type Open =
  | { kind: "add"; parent?: MenuNode } | { kind: "rename"; menu: MenuNode } | { kind: "move"; menu: MenuNode }
  | { kind: "categories" } | { kind: "trash" } | null;

interface ItemProps {
  category: Category; menu: MenuNode; depth: number; siblings: MenuNode[]; index: number;
  managing: boolean; setOpen: (o: Open) => void; parentSlug: string | null;
}

function MenuItem({ category, menu, depth, siblings, index, managing, setOpen, parentSlug }: ItemProps) {
  const [expanded, setExpanded] = useState(true);
  const [dropping, setDropping] = useState(false);
  const openUpload = useOpenUpload();
  const { run, busy, error } = useAction();
  const reorder = (to: number) => run(() => manage.moveMenu(menu.slug, { category: category.key, parent: parentSlug, index: to }));
  const empty = menu.documents.length === 0 && menu.menus.length === 0;

  return (
    <li
      className={`rounded-md ${dropping ? "bg-accent-soft outline-2 outline-accent outline-dashed" : ""}`}
      onDragOver={(e) => { e.preventDefault(); setDropping(true); }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropping(false); }}
      onDrop={async (e) => {
        e.preventDefault(); e.stopPropagation(); setDropping(false);
        openUpload({ category: category.key, menu: menu.slug, files: await filesFromDrop(e.dataTransfer) });
      }}
    >
      <div className="flex items-center rounded-md hover:bg-sunken">
        <button
          className="flex min-w-0 flex-1 items-center gap-1.5 px-2 py-1.5 text-left text-sm font-medium"
          style={{ paddingLeft: 8 + depth * 14 }}
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
        >
          <span className="w-3 text-xs text-muted">{expanded ? "▾" : "▸"}</span>
          <span className="min-w-0 flex-1 truncate">{menu.name}</span>
          {!managing && <span className="font-mono text-[11px] text-muted">{menu.documents.length}</span>}
        </button>
        {managing ? (
          <div className="mr-1 flex shrink-0">
            <button className={ui.icon} disabled={busy || index === 0} onClick={() => reorder(index - 1)} aria-label="위로">↑</button>
            <button className={ui.icon} disabled={busy || index === siblings.length - 1} onClick={() => reorder(index + 1)} aria-label="아래로">↓</button>
            <button className={ui.icon} onClick={() => setOpen({ kind: "rename", menu })} aria-label="이름 바꾸기" title="이름 바꾸기">✎</button>
            <button className={ui.icon} onClick={() => setOpen({ kind: "move", menu })} aria-label="옮기기" title="옮기기">⇄</button>
            <button className={ui.icon} onClick={() => setOpen({ kind: "add", parent: menu })} aria-label="하위 메뉴 추가" title="하위 메뉴 추가">⊕</button>
            <button className={ui.icon} disabled={busy || !empty} aria-label="삭제"
              title={empty ? "삭제" : "문서나 하위 메뉴가 있으면 지울 수 없습니다"}
              onClick={() => { if (confirm(`'${menu.name}' 메뉴를 지울까요?`)) void run(() => manage.deleteMenu(menu.slug)); }}>🗑</button>
          </div>
        ) : (
          <button
            className="mr-1 rounded px-1.5 text-muted hover:bg-line hover:text-fg"
            onClick={() => openUpload({ category: category.key, menu: menu.slug })}
            aria-label={`${menu.name}에 업로드`}
            title={`${menu.name}에 업로드`}
          >
            +
          </button>
        )}
      </div>
      {error && <p className="mx-2 my-1 rounded bg-high-soft px-2 py-1 text-xs text-high">{error}</p>}
      {expanded && (
        <ul>
          {menu.documents.map((d) => (
            <li key={d.slug}>
              <NavLink
                to={`/${category.key}/${menu.slug}/${d.slug}`}
                className={({ isActive }) =>
                  `flex items-start gap-2 rounded-md py-1.5 pr-2 text-sm ${
                    isActive ? "bg-accent-soft text-accent" : "text-muted hover:bg-sunken hover:text-fg"
                  }`
                }
                style={{ paddingLeft: 30 + depth * 14 }}
              >
                <span className="min-w-0 flex-1 leading-snug">{d.title}</span>
                <StatusBadge status={d.status} small />
              </NavLink>
            </li>
          ))}
          {menu.menus.map((m, i) => (
            <MenuItem key={m.slug} category={category} menu={m} depth={depth + 1} siblings={menu.menus} index={i}
              managing={managing} setOpen={setOpen} parentSlug={menu.slug} />
          ))}
        </ul>
      )}
    </li>
  );
}

export function Sidebar({ category, warnings, onCollapse }: { category: Category; warnings: string[]; onCollapse: () => void }) {
  const [managing, setManaging] = useState(false);
  const [open, setOpen] = useState<Open>(null);
  const { data: trash } = useTrash();
  const close = () => setOpen(null);

  return (
    <>
    {/* 목록만 스크롤하고, 아래 footer(휴지통)는 항상 같은 자리에 둔다 */}
    <nav className="grid min-h-0 flex-1 content-start gap-2 overflow-y-auto p-3" aria-label={`${category.name} 메뉴`}>
      <div className="flex items-center justify-between px-2">
        <p className="font-mono text-[11px] tracking-widest text-muted uppercase">{category.name}</p>
        <div className="flex items-center gap-1">
          <button
            className={`rounded-md px-2 py-0.5 text-xs ${managing ? "bg-accent-soft text-accent" : "text-muted hover:bg-sunken"}`}
            onClick={() => setManaging((v) => !v)}
            aria-pressed={managing}
          >
            {managing ? "관리 끝내기" : "관리"}
          </button>
          <button
            className="hidden rounded-md px-1.5 py-0.5 text-sm text-muted hover:bg-sunken hover:text-fg md:inline"
            onClick={onCollapse}
            aria-label="사이드바 접기"
            title="사이드바 접기"
          >
            «
          </button>
        </div>
      </div>

      {category.menus.length === 0 ? (
        <p className="px-2 text-sm text-muted">
          아직 메뉴가 없습니다. 아래 <b>메뉴 추가</b>나 상단 <b>업로드</b>의 "새 메뉴 만들기"로 시작하세요.
        </p>
      ) : (
        <ul className="grid gap-0.5">
          {category.menus.map((m, i) => (
            <MenuItem key={m.slug} category={category} menu={m} depth={0} siblings={category.menus} index={i}
              managing={managing} setOpen={setOpen} parentSlug={null} />
          ))}
        </ul>
      )}

      {(managing || category.menus.length === 0) && (
        <div className="mt-2 grid gap-1 border-t border-line pt-2 text-sm">
          <button className="rounded-md px-2 py-1 text-left text-muted hover:bg-sunken hover:text-fg" onClick={() => setOpen({ kind: "add" })}>
            ＋ 메뉴 추가
          </button>
          {managing && (
            <button className="rounded-md px-2 py-1 text-left text-muted hover:bg-sunken hover:text-fg" onClick={() => setOpen({ kind: "categories" })}>
              대분류 관리
            </button>
          )}
        </div>
      )}

      {warnings.length > 0 && (
        <details className="mx-2 rounded-md bg-high-soft p-2 text-xs text-high">
          <summary className="cursor-pointer">색인 경고 {warnings.length}건</summary>
          <ul className="mt-1 list-disc pl-4">{warnings.map((w) => <li key={w}>{w}</li>)}</ul>
        </details>
      )}
    </nav>

    <footer className="shrink-0 border-t border-line p-2">
      <button
        className="flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-left text-sm text-muted hover:bg-sunken hover:text-fg"
        onClick={() => setOpen({ kind: "trash" })}
      >
        <span aria-hidden>🗑</span>
        <span className="flex-1">휴지통</span>
        {trash?.length ? <span className="rounded-full bg-sunken px-2 font-mono text-xs">{trash.length}</span> : null}
      </button>
    </footer>

      {open?.kind === "add" && <AddMenuDialog category={category.key} parent={open.parent} onClose={close} />}
      {open?.kind === "rename" && <RenameMenuDialog menu={open.menu} onClose={close} />}
      {open?.kind === "move" && <MoveMenuDialog menu={open.menu} onClose={close} />}
      {open?.kind === "categories" && <CategoryDialog onClose={close} />}
      {open?.kind === "trash" && <TrashDialog onClose={close} />}
    </>
  );
}
