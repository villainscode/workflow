import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ArrowDown, ArrowUp, ChevronRight, CornerLeftUp, FilePlus2, FileText, Folder, FolderInput, FolderOpen, FolderPlus,
  MoreHorizontal, PanelLeftClose, Pencil, Plus, Trash2,
} from "lucide-react";
import { NavLink, useLocation, useNavigate } from "react-router";
import { IconButton } from "./IconButton.tsx";
import { versionLabel, type Category, type DocSummary, type MenuNode } from "../lib/api.ts";
import { buildDocTree, type DocNode } from "../lib/docTree.ts";
import { filesFromDrop } from "../lib/files.ts";
import { manage, useTrash } from "../lib/manage.ts";
import { useOpenUpload } from "./upload/UploadContext.tsx";
import { StatusBadge } from "./StatusBadge.tsx";
import { useAction } from "./manage/useAction.ts";
import { DeleteMenuDialog, MoveMenuDialog } from "./manage/MenuDialogs.tsx";
import { TrashDialog } from "./manage/TrashDialog.tsx";
import { contains } from "./manage/menuTree.ts";
import { ContextMenu, type MenuEntry } from "./sidebar/ContextMenu.tsx";

/*
 * 좌측 폴더 트리(MarkFlow category-tree 방식). 폴더 = 메뉴(menus.yaml), 폴더 안에 하위 폴더와 문서, 문서 안에 하위 문서.
 * - 펼침·접힘은 localStorage에 접힌 항목만 기억한다(처음에는 모두 펼침). 지금 연 문서의 상위는 늘 펼친다.
 * - 오른쪽 클릭이나 ⋯ 버튼으로 메뉴(새 문서·하위 폴더·이름 바꾸기·위아래·옮기기·삭제)를 연다.
 * - 끌어서 놓기: 폴더는 다른 폴더의 앞뒤(순서)나 안(하위 폴더)으로, 문서는 다른 문서의 앞뒤(순서)나 안(하위 문서), 폴더 안으로.
 *   같은 자리 안 순서 바꾸기는 확인 없이, 다른 자리로 옮기기는 확인 창을 거친다. 바깥 파일을 폴더에 놓으면 업로드 창이 열린다.
 */

type Row = { kind: "folder"; menu: MenuNode; parent: string | null; siblings: MenuNode[] } | { kind: "doc"; menu: MenuNode; doc: DocSummary };
type Drag = { kind: "folder"; slug: string; parent: string | null; name: string } | { kind: "doc"; menu: string; slug: string; parent: string | null; title: string };
type Zone = "before" | "after" | "inside";
type Editing = { kind: "rename-folder"; slug: string } | { kind: "rename-doc"; menu: string; doc: string } | { kind: "new-folder"; parent: string | null } | null;
type Open = { kind: "move"; menu: MenuNode } | { kind: "delete"; menu: MenuNode } | { kind: "trash" } | null;

const folderKey = (slug: string) => `m:${slug}`;
const docKey = (menu: string, slug: string) => `d:${menu}/${slug}`;
const COLLAPSED = "workflow:sidebar-collapsed";

function findMenu(list: MenuNode[], slug: string): MenuNode | null {
  for (const m of list) {
    if (m.slug === slug) return m;
    const found = findMenu(m.menus, slug);
    if (found) return found;
  }
  return null;
}

/** slug 문서가 ancestor 문서의 하위(손자 이하 포함)인가 */
function isUnder(docs: DocSummary[], slug: string, ancestor: string): boolean {
  for (let p = docs.find((d) => d.slug === slug)?.parent ?? null; p; p = docs.find((d) => d.slug === p)?.parent ?? null) if (p === ancestor) return true;
  return false;
}

/** 같은 자리(같은 상위)의 문서들. 서버가 준 순서 그대로 */
const siblingsOf = (docs: DocSummary[], parent: string | null) => docs.filter((d) => (d.parent ?? null) === parent);

function useCollapsed() {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem(COLLAPSED) ?? "[]") as string[]); } catch { return new Set(); }
  });
  const change = useCallback((fn: (s: Set<string>) => boolean) => setCollapsed((prev) => {
    const next = new Set(prev);
    if (!fn(next)) return prev;
    try { localStorage.setItem(COLLAPSED, JSON.stringify([...next])); } catch { /* 저장소를 못 쓰는 브라우저 */ }
    return next;
  }), []);
  const toggle = useCallback((k: string) => change((s) => { if (!s.delete(k)) s.add(k); return true; }), [change]);
  const expand = useCallback((keys: string[]) => change((s) => keys.map((k) => s.delete(k)).some(Boolean)), [change]);
  return { collapsed, toggle, expand };
}

interface Ctx {
  category: Category;
  pathname: string;
  collapsed: Set<string>;
  toggle: (k: string) => void;
  drag: Drag | null;
  target: { key: string; zone: Zone } | null;
  startDrag: (e: React.DragEvent, row: Row) => void;
  endDrag: () => void;
  dragOver: (e: React.DragEvent, key: string, row: Row) => void;
  dragLeave: (key: string) => void;
  drop: (e: React.DragEvent, key: string, row: Row) => void;
  openMenu: (x: number, y: number, row: Row) => void;
  editing: Editing;
  setEditing: (e: Editing) => void;
  submitName: (name: string) => Promise<unknown>;
}
const TreeCtx = createContext<Ctx | null>(null);
const useTreeCtx = () => useContext(TreeCtx)!;

export function Sidebar({ category, warnings, onCollapse }: { category: Category; warnings: string[]; onCollapse: () => void }) {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const openUpload = useOpenUpload();
  const { run, error } = useAction();
  const { data: trash } = useTrash();
  const { collapsed, toggle, expand } = useCollapsed();
  const [drag, setDrag] = useState<Drag | null>(null);
  const [target, setTarget] = useState<Ctx["target"]>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; row: Row } | null>(null);
  const [editing, setEditing] = useState<Editing>(null);
  const [open, setOpen] = useState<Open>(null);
  const closeMenu = useCallback(() => setMenu(null), []);

  // 지금 연 문서: /<대분류>/<메뉴>/<문서>
  const [, , curMenu, curDoc] = pathname.split("/").map(decodeURIComponent);

  // 지금 연 문서의 상위 폴더·상위 문서는 펼친다
  useEffect(() => {
    if (!curMenu) return;
    const keys: string[] = [];
    const path = (list: MenuNode[], trail: string[]): string[] | null => {
      for (const m of list) {
        if (m.slug === curMenu) return [...trail, m.slug];
        const found = path(m.menus, [...trail, m.slug]);
        if (found) return found;
      }
      return null;
    };
    const menus = path(category.menus, []) ?? [];
    menus.forEach((s) => keys.push(folderKey(s)));
    const docs = findMenu(category.menus, curMenu)?.documents ?? [];
    for (let p = docs.find((d) => d.slug === curDoc)?.parent ?? null; p; p = docs.find((d) => d.slug === p)?.parent ?? null) keys.push(docKey(curMenu, p));
    expand(keys);
  }, [pathname, category, curMenu, curDoc, expand]);

  /** 지금 연 문서(또는 그 상위)가 옮겨지거나 지워지면 새 주소로 간다 */
  function follow(oldMenu: string, slug: string, to: { menu: string; doc: string; category: string } | null) {
    if (curMenu !== oldMenu || !curDoc) return;
    const docs = findMenu(category.menus, oldMenu)?.documents ?? [];
    if (curDoc !== slug && !isUnder(docs, curDoc, slug)) return;
    if (!to) return navigate(`/${category.key}`);
    if (to.menu !== oldMenu || to.doc !== slug) navigate(`/${to.category}/${to.menu}/${curDoc === slug ? to.doc : curDoc}`);
  }

  function zonesFor(d: Drag, row: Row): { edges: boolean; inside: boolean } | null {
    if (d.kind === "folder") {
      if (row.kind !== "folder") return null;
      const dragged = findMenu(category.menus, d.slug);
      return dragged && !contains(dragged, row.menu.slug) ? { edges: true, inside: true } : null;
    }
    if (row.kind === "folder") return { edges: false, inside: true };
    if (row.menu.slug === d.menu && (row.doc.slug === d.slug || isUnder(row.menu.documents, row.doc.slug, d.slug))) return null;
    return { edges: true, inside: true };
  }

  async function moveFolder(d: Extract<Drag, { kind: "folder" }>, row: Extract<Row, { kind: "folder" }>, zone: Zone) {
    const parentName = (slug: string | null) => (slug ? `${findMenu(category.menus, slug)?.name} 안` : `${category.name} 최상위`);
    const ask = (where: string) => ({
      title: "폴더를 옮길까요?", tone: "warning" as const, confirmText: "옮기기",
      details: [`폴더: ${d.name}`, `옮길 위치: ${where}`], message: "안의 문서와 하위 폴더도 함께 옮겨집니다. 파일 위치(docs/)는 바뀌지 않습니다.",
    });
    if (zone === "inside") return run(() => manage.moveMenu(d.slug, { category: category.key, parent: row.menu.slug }), ask(`${row.menu.name} 안`));
    let index = row.siblings.indexOf(row.menu) + (zone === "after" ? 1 : 0);
    if (d.parent === row.parent) {
      const from = row.siblings.findIndex((m) => m.slug === d.slug);
      if (from < index) index--;
      if (from === index) return;
      return run(() => manage.moveMenu(d.slug, { category: category.key, parent: row.parent, index })); // 순서만 바꾸기: 확인 없음
    }
    return run(() => manage.moveMenu(d.slug, { category: category.key, parent: row.parent, index }), ask(parentName(row.parent)));
  }

  async function moveDoc(d: Extract<Drag, { kind: "doc" }>, row: Row, zone: Zone) {
    let to: { menu: string; parent: string | null; index?: number };
    let where: string;
    let reorderOnly = false;
    if (row.kind === "folder") {
      if (d.menu === row.menu.slug && !d.parent) return;
      to = { menu: row.menu.slug, parent: null };
      where = `${row.menu.name} 폴더`;
    } else if (zone === "inside") {
      if (d.menu === row.menu.slug && d.parent === row.doc.slug) return;
      to = { menu: row.menu.slug, parent: row.doc.slug };
      where = `${row.doc.title} 아래`;
    } else {
      const parent = row.doc.parent ?? null;
      const siblings = siblingsOf(row.menu.documents, parent);
      let index = siblings.indexOf(row.doc) + (zone === "after" ? 1 : 0);
      if (d.menu === row.menu.slug && d.parent === parent) {
        const from = siblings.findIndex((x) => x.slug === d.slug);
        if (from < index) index--;
        if (from === index) return;
        reorderOnly = true;
      }
      to = { menu: row.menu.slug, parent, index };
      where = parent ? `${row.menu.documents.find((x) => x.slug === parent)?.title} 아래` : `${row.menu.name} 폴더`;
    }
    const r = await run(() => manage.moveDoc(d.menu, d.slug, to), reorderOnly ? undefined : {
      title: "문서를 옮길까요?", tone: "warning", confirmText: "옮기기",
      details: [`문서: ${d.title}`, `옮길 위치: ${where}`], message: "문서 폴더가 옮겨지고, 하위 문서도 함께 옮겨집니다.",
    });
    if (r) follow(d.menu, d.slug, r);
  }

  const ctx: Ctx = {
    category, pathname, collapsed, toggle, drag, target, editing, setEditing,
    startDrag(e, row) {
      e.stopPropagation();
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", row.kind === "folder" ? row.menu.name : row.doc.title);
      setMenu(null);
      setDrag(row.kind === "folder"
        ? { kind: "folder", slug: row.menu.slug, parent: row.parent, name: row.menu.name }
        : { kind: "doc", menu: row.menu.slug, slug: row.doc.slug, parent: row.doc.parent ?? null, title: row.doc.title });
    },
    endDrag() { setDrag(null); setTarget(null); },
    dragOver(e, key, row) {
      if (!drag) return;
      const z = zonesFor(drag, row);
      if (!z) { setTarget((t) => (t?.key === key ? null : t)); return; }
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = "move";
      const r = e.currentTarget.getBoundingClientRect();
      const y = (e.clientY - r.top) / r.height;
      const zone: Zone = z.edges && y < 0.28 ? "before" : z.edges && y > 0.72 ? "after" : z.inside ? "inside" : y < 0.5 ? "before" : "after";
      setTarget((t) => (t?.key === key && t.zone === zone ? t : { key, zone }));
    },
    dragLeave(key) { setTarget((t) => (t?.key === key ? null : t)); },
    drop(e, key, row) {
      if (!drag || target?.key !== key) return;
      e.preventDefault();
      e.stopPropagation();
      const d = drag;
      const zone = target.zone;
      setDrag(null);
      setTarget(null);
      if (d.kind === "folder" && row.kind === "folder") void moveFolder(d, row, zone);
      else if (d.kind === "doc") void moveDoc(d, row, zone);
    },
    openMenu(x, y, row) { setMenu({ x, y, row }); },
    async submitName(name) {
      if (!editing) return;
      if (editing.kind === "new-folder") {
        const where = editing.parent ? `${findMenu(category.menus, editing.parent)?.name} 안` : `${category.name} 최상위`;
        return run(() => manage.addMenu(category.key, name, undefined, editing.parent ?? undefined), {
          title: "폴더를 추가할까요?", confirmText: "추가", details: [`이름: ${name}`, `위치: ${where}`],
        });
      }
      if (editing.kind === "rename-folder") {
        const m = findMenu(category.menus, editing.slug);
        return run(() => manage.renameMenu(editing.slug, name), { title: "폴더 이름을 바꿀까요?", confirmText: "저장", details: [`${m?.name} → ${name}`] });
      }
      const doc = findMenu(category.menus, editing.menu)?.documents.find((d) => d.slug === editing.doc);
      return run(() => manage.updateDoc(editing.menu, editing.doc, { title: name }), { title: "문서 제목을 바꿀까요?", confirmText: "저장", details: [`${doc?.title} → ${name}`] });
    },
  };

  function menuItems(row: Row): MenuEntry[] {
    if (row.kind === "folder") {
      const { menu: m, parent, siblings } = row;
      const i = siblings.indexOf(m);
      const reorder = (index: number) => void run(() => manage.moveMenu(m.slug, { category: category.key, parent, index }));
      return [
        { label: "새 문서", icon: FilePlus2, onSelect: () => openUpload({ category: category.key, menu: m.slug }) },
        { label: "하위 폴더 추가", icon: FolderPlus, onSelect: () => { expand([folderKey(m.slug)]); setEditing({ kind: "new-folder", parent: m.slug }); } },
        { label: "이름 바꾸기", icon: Pencil, onSelect: () => setEditing({ kind: "rename-folder", slug: m.slug }) },
        "separator",
        { label: "위로", icon: ArrowUp, disabled: i === 0, onSelect: () => reorder(i - 1) },
        { label: "아래로", icon: ArrowDown, disabled: i === siblings.length - 1, onSelect: () => reorder(i + 1) },
        { label: "다른 위치로 옮기기", icon: FolderInput, onSelect: () => setOpen({ kind: "move", menu: m }) },
        "separator",
        { label: "폴더 삭제", icon: Trash2, danger: true, onSelect: () => setOpen({ kind: "delete", menu: m }) },
      ];
    }
    const { menu: m, doc } = row;
    const parent = doc.parent ?? null;
    const siblings = siblingsOf(m.documents, parent);
    const i = siblings.indexOf(doc);
    const reorder = (index: number) => void run(() => manage.moveDoc(m.slug, doc.slug, { menu: m.slug, parent, index }));
    const subCount = m.documents.filter((d) => isUnder(m.documents, d.slug, doc.slug)).length;
    const up = parent ? m.documents.find((d) => d.slug === parent) : undefined;
    return [
      { label: "하위 문서 추가", icon: FilePlus2, onSelect: () => openUpload({ category: category.key, menu: m.slug, parent: doc.slug }) },
      { label: "이름 바꾸기", icon: Pencil, onSelect: () => setEditing({ kind: "rename-doc", menu: m.slug, doc: doc.slug }) },
      "separator",
      { label: "위로", icon: ArrowUp, disabled: i === 0, onSelect: () => reorder(i - 1) },
      { label: "아래로", icon: ArrowDown, disabled: i === siblings.length - 1, onSelect: () => reorder(i + 1) },
      ...(up ? [{
        label: "상위 문서 밖으로 꺼내기", icon: CornerLeftUp,
        onSelect: async () => {
          const upParent = up.parent ?? null;
          const index = siblingsOf(m.documents, upParent).indexOf(up) + 1;
          const r = await run(() => manage.moveDoc(m.slug, doc.slug, { menu: m.slug, parent: upParent, index }), {
            title: "문서를 옮길까요?", tone: "warning", confirmText: "옮기기",
            details: [`문서: ${doc.title}`, `옮길 위치: ${upParent ? `${m.documents.find((d) => d.slug === upParent)?.title} 아래` : `${m.name} 폴더`} (${up.title} 다음)`],
            message: "문서 폴더가 옮겨지고, 하위 문서도 함께 옮겨집니다.",
          });
          if (r) follow(m.slug, doc.slug, r);
        },
      } satisfies MenuEntry] : []),
      "separator",
      {
        label: "휴지통으로", icon: Trash2, danger: true,
        onSelect: async () => {
          const r = await run(() => manage.trashDoc(m.slug, doc.slug), {
            title: "휴지통으로 옮길까요?", tone: "danger", confirmText: "휴지통으로",
            details: [`문서: ${doc.title}`, ...(subCount ? [`하위 문서 ${subCount}개도 함께`] : [])], message: "휴지통에서 다시 복원할 수 있습니다.",
          });
          if (r) follow(m.slug, doc.slug, null);
        },
      },
    ];
  }

  return (
    <TreeCtx.Provider value={ctx}>
      {/* 목록만 스크롤하고, 아래 footer(휴지통)는 항상 같은 자리에 둔다 */}
      <nav className="grid min-h-0 flex-1 content-start gap-2 overflow-y-auto p-3" aria-label={`${category.name} 메뉴`}>
        <div className="flex items-center justify-between px-2">
          <p className="font-mono text-[15px] tracking-widest text-muted uppercase">{category.name}</p>
          <div className="flex items-center gap-1">
            <IconButton icon={FolderPlus} label="폴더 추가" size={19} className="p-1" onClick={() => setEditing({ kind: "new-folder", parent: null })} />
            <IconButton icon={PanelLeftClose} label="사이드바 접기" size={19} className="hidden p-1 md:inline-flex" onClick={onCollapse} />
          </div>
        </div>

        {editing?.kind === "new-folder" && editing.parent === null && <NewFolderRow depth={0} />}
        {category.menus.length === 0 && editing?.kind !== "new-folder" ? (
          <p className="px-2 text-sm text-muted">
            아직 폴더가 없습니다. 위의 <b>폴더 추가</b>나 상단 업로드 버튼의 "새 메뉴 만들기"로 시작하세요.
          </p>
        ) : (
          <ul className="grid gap-px" aria-label="폴더 트리">
            {category.menus.map((m) => <FolderItem key={m.slug} menu={m} depth={0} parent={null} siblings={category.menus} />)}
          </ul>
        )}
        {error && <p className="mx-2 rounded bg-high-soft px-2 py-1 text-xs text-high" role="alert">{error}</p>}

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
          <Trash2 size={19} aria-hidden />
          <span className="flex-1">휴지통</span>
          {trash?.length ? <span className="rounded-full bg-sunken px-2 font-mono text-xs">{trash.length}</span> : null}
        </button>
      </footer>

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={menuItems(menu.row)} onClose={closeMenu}
          label={menu.row.kind === "folder" ? `${menu.row.menu.name} 폴더 메뉴` : `${menu.row.doc.title} 문서 메뉴`} />
      )}
      {open?.kind === "move" && <MoveMenuDialog menu={open.menu} onClose={() => setOpen(null)} />}
      {open?.kind === "delete" && (
        <DeleteMenuDialog menu={open.menu} onClose={() => setOpen(null)}
          onDeleted={() => { if (curMenu && (open.menu.slug === curMenu || contains(open.menu, curMenu))) navigate(`/${category.key}`); }} />
      )}
      {open?.kind === "trash" && <TrashDialog onClose={() => setOpen(null)} />}
    </TreeCtx.Provider>
  );
}

/** 한 줄(폴더·문서 공통): 끌어서 놓기, 놓을 자리 표시(앞·뒤 선, 안은 배경), 오른쪽 클릭 메뉴 */
function TreeRow({ rowKey, row, depth, draggable, className, children }: {
  rowKey: string; row: Row; depth: number; draggable: boolean; className: string; children: ReactNode;
}) {
  const t = useTreeCtx();
  const zone = t.target?.key === rowKey ? t.target.zone : null;
  const dragging = t.drag && (row.kind === "folder"
    ? t.drag.kind === "folder" && t.drag.slug === row.menu.slug
    : t.drag.kind === "doc" && t.drag.menu === row.menu.slug && t.drag.slug === row.doc.slug);
  return (
    <div
      data-row={rowKey}
      draggable={draggable}
      onDragStart={(e) => t.startDrag(e, row)}
      onDragEnd={t.endDrag}
      onDragOver={(e) => t.dragOver(e, rowKey, row)}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) t.dragLeave(rowKey); }}
      onDrop={(e) => t.drop(e, rowKey, row)}
      onContextMenu={(e) => { e.preventDefault(); t.openMenu(e.clientX, e.clientY, row); }}
      className={`group relative flex items-center gap-1 rounded-md pr-1 ${zone === "inside" ? "bg-accent-soft outline-2 -outline-offset-2 outline-accent" : ""} ${dragging ? "opacity-40" : ""} ${className}`}
      style={{ paddingLeft: 4 + depth * 14 }}
    >
      {zone === "before" && <span aria-hidden className="pointer-events-none absolute inset-x-1 -top-px h-0.5 rounded bg-accent" />}
      {zone === "after" && <span aria-hidden className="pointer-events-none absolute inset-x-1 -bottom-px h-0.5 rounded bg-accent" />}
      {children}
    </div>
  );
}

/** ⋯ 버튼. 마우스가 올라간 줄에서만 보이고(터치 화면은 늘), 키보드 포커스에도 보인다 */
function MoreButton({ label, row }: { label: string; row: Row }) {
  const t = useTreeCtx();
  return (
    <IconButton icon={MoreHorizontal} label={label} size={16} className="p-0.5 md:opacity-0 md:group-hover:opacity-100 md:focus-visible:opacity-100"
      onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); t.openMenu(r.left, r.bottom + 4, row); }} />
  );
}

function Chevron({ open }: { open: boolean }) {
  return <ChevronRight size={14} aria-hidden className={`shrink-0 text-muted transition-transform ${open ? "rotate-90" : ""}`} />;
}

function FolderItem({ menu, depth, parent, siblings }: { menu: MenuNode; depth: number; parent: string | null; siblings: MenuNode[] }) {
  const t = useTreeCtx();
  const openUpload = useOpenUpload();
  const [fileOver, setFileOver] = useState(false);
  const key = folderKey(menu.slug);
  const open = !t.collapsed.has(key);
  const docs = useMemo(() => buildDocTree(menu.documents), [menu.documents]);
  const renaming = t.editing?.kind === "rename-folder" && t.editing.slug === menu.slug;
  const adding = t.editing?.kind === "new-folder" && t.editing.parent === menu.slug;
  const row: Row = { kind: "folder", menu, parent, siblings };
  const Icon = open ? FolderOpen : Folder;

  return (
    <li
      className={`rounded-md ${fileOver ? "bg-accent-soft outline-2 outline-accent outline-dashed" : ""}`}
      // 바깥 파일을 폴더에 놓으면 그 폴더로 업로드 창을 연다(사이드바 안에서 끄는 중이면 무시)
      onDragOver={(e) => { if (t.drag || !e.dataTransfer.types.includes("Files")) return; e.preventDefault(); e.stopPropagation(); setFileOver(true); }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setFileOver(false); }}
      onDrop={async (e) => {
        if (t.drag || !e.dataTransfer.types.includes("Files")) return;
        e.preventDefault(); e.stopPropagation(); setFileOver(false);
        openUpload({ category: t.category.key, menu: menu.slug, files: await filesFromDrop(e.dataTransfer) });
      }}
    >
      <TreeRow rowKey={key} row={row} depth={depth} draggable={!renaming} className="hover:bg-sunken">
        {renaming ? (
          <>
            <Chevron open={open} />
            <Icon size={17} aria-hidden className="shrink-0 text-muted" />
            <InlineName initial={menu.name} label="폴더 이름" />
          </>
        ) : (
          <button className="flex min-w-0 flex-1 items-center gap-1 py-1.5 text-left text-sm font-medium" aria-expanded={open} onClick={() => t.toggle(key)}>
            <Chevron open={open} />
            <Icon size={17} aria-hidden className="shrink-0 text-muted" />
            <span className="min-w-0 flex-1 truncate">{menu.name}</span>
            <span className="font-mono text-[11px] font-normal text-muted">{menu.documents.length}</span>
          </button>
        )}
        <IconButton icon={Plus} label={`${menu.name}에 새 문서`} size={16} className="p-0.5 md:opacity-0 md:group-hover:opacity-100 md:focus-visible:opacity-100"
          onClick={() => openUpload({ category: t.category.key, menu: menu.slug })} />
        <MoreButton label={`${menu.name} 폴더 메뉴`} row={row} />
      </TreeRow>
      {open && (
        <ul className="grid gap-px">
          {adding && <NewFolderRow depth={depth + 1} />}
          {menu.menus.map((m) => <FolderItem key={m.slug} menu={m} depth={depth + 1} parent={menu.slug} siblings={menu.menus} />)}
          {docs.map((n) => <DocItem key={n.doc.slug} menu={menu} node={n} depth={depth + 1} />)}
        </ul>
      )}
    </li>
  );
}

function DocItem({ menu, node, depth }: { menu: MenuNode; node: DocNode; depth: number }) {
  const t = useTreeCtx();
  const { doc, children } = node;
  const key = docKey(menu.slug, doc.slug);
  const open = !t.collapsed.has(key);
  const href = `/${t.category.key}/${menu.slug}/${doc.slug}`;
  const active = t.pathname === href;
  const renaming = t.editing?.kind === "rename-doc" && t.editing.menu === menu.slug && t.editing.doc === doc.slug;
  const row: Row = { kind: "doc", menu, doc };

  return (
    <li>
      <TreeRow rowKey={key} row={row} depth={depth} draggable={!renaming}
        className={active ? "bg-accent-soft text-accent" : "text-muted hover:bg-sunken hover:text-fg"}>
        {children.length > 0 ? (
          <button className="grid size-4 shrink-0 place-items-center rounded hover:text-fg" aria-expanded={open}
            aria-label={`${doc.title} 하위 문서 ${open ? "접기" : "펼치기"}`} onClick={() => t.toggle(key)}>
            <Chevron open={open} />
          </button>
        ) : <span className="size-4 shrink-0" aria-hidden />}
        <FileText size={16} aria-hidden className="shrink-0 opacity-70" />
        {renaming ? <InlineName initial={doc.title} label="문서 제목" /> : (
          // 링크 자체를 끌면 브라우저가 주소를 끌기 시작하므로 끌기는 줄(TreeRow)이 받는다
          <NavLink to={href} draggable={false} className="flex min-w-0 flex-1 items-start gap-2 py-1.5 text-sm leading-snug">
            <span className="min-w-0 flex-1">{doc.title}</span>
            <StatusBadge status={doc.status} label={versionLabel(doc.currentVersion)} small />
          </NavLink>
        )}
        <MoreButton label={`${doc.title} 문서 메뉴`} row={row} />
      </TreeRow>
      {children.length > 0 && open && (
        <ul className="grid gap-px">
          {children.map((c) => <DocItem key={c.doc.slug} menu={menu} node={c} depth={depth + 1} />)}
        </ul>
      )}
    </li>
  );
}

/** 새 폴더 이름 입력 줄 */
function NewFolderRow({ depth }: { depth: number }) {
  return (
    <li className="flex items-center gap-1 rounded-md pr-1" style={{ paddingLeft: 4 + depth * 14 }}>
      <span className="size-3.5 shrink-0" aria-hidden />
      <Folder size={17} aria-hidden className="shrink-0 text-muted" />
      <InlineName initial="" label="새 폴더 이름" placeholder="폴더 이름" />
    </li>
  );
}

/** 그 자리 이름 입력. Enter 저장(확인 창), Esc·바깥 클릭 취소 */
function InlineName({ initial, label, placeholder }: { initial: string; label: string; placeholder?: string }) {
  const t = useTreeCtx();
  const [name, setName] = useState(initial);
  const done = useRef(false);
  const finish = async (save: boolean) => {
    if (done.current) return;
    done.current = true;
    if (save && name.trim() && name.trim() !== initial) await t.submitName(name.trim());
    t.setEditing(null);
  };
  return (
    <input
      className="my-0.5 min-w-0 flex-1 rounded-md border border-accent bg-surface px-2 py-1 text-sm text-fg"
      value={name}
      placeholder={placeholder}
      aria-label={label}
      autoFocus
      onFocus={(e) => e.target.select()}
      onChange={(e) => setName(e.target.value)}
      onKeyDown={(e) => {
        // 한글 조합 중 Enter(isComposing)는 건너뛴다. 맥 크롬은 조합이 끝난 뒤 Enter keydown을 한 번 더 보내는데,
        // 조합 중 Enter로 확인 창을 열면 그 두 번째 Enter가 확인 창의 "취소"를 눌러 버린다
        if (e.nativeEvent.isComposing || e.keyCode === 229) return;
        // Enter 기본 동작을 막아야 확인 창의 버튼이 같은 키 입력을 받아 바로 실행되지 않는다
        if (e.key === "Enter") { e.preventDefault(); void finish(true); }
        if (e.key === "Escape") { e.preventDefault(); void finish(false); }
      }}
      onBlur={() => void finish(false)}
    />
  );
}
