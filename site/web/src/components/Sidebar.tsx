import { useState } from "react";
import { NavLink } from "react-router";
import type { Category, MenuNode } from "../lib/api.ts";
import { filesFromDrop } from "../lib/files.ts";
import { useOpenUpload } from "./upload/UploadContext.tsx";
import { StatusBadge } from "./StatusBadge.tsx";

function MenuItem({ category, menu, depth }: { category: string; menu: MenuNode; depth: number }) {
  const [open, setOpen] = useState(true);
  const [dropping, setDropping] = useState(false);
  const openUpload = useOpenUpload();
  return (
    <li
      className={`rounded-md ${dropping ? "bg-accent-soft outline-2 outline-accent outline-dashed" : ""}`}
      onDragOver={(e) => { e.preventDefault(); setDropping(true); }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropping(false); }}
      onDrop={async (e) => {
        e.preventDefault(); e.stopPropagation(); setDropping(false);
        openUpload({ category, menu: menu.slug, files: await filesFromDrop(e.dataTransfer) });
      }}
    >
      <div className="group flex items-center rounded-md hover:bg-sunken">
        <button
          className="flex min-w-0 flex-1 items-center gap-1.5 px-2 py-1.5 text-left text-sm font-medium"
          style={{ paddingLeft: 8 + depth * 14 }}
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
        >
          <span className="w-3 text-xs text-muted">{open ? "▾" : "▸"}</span>
          <span className="min-w-0 flex-1 truncate">{menu.name}</span>
          <span className="font-mono text-[11px] text-muted">{menu.documents.length}</span>
        </button>
        <button
          className="mr-1 rounded px-1.5 text-muted hover:bg-line hover:text-fg"
          onClick={() => openUpload({ category, menu: menu.slug })}
          aria-label={`${menu.name}에 업로드`}
          title={`${menu.name}에 업로드`}
        >
          +
        </button>
      </div>
      {open && (
        <ul>
          {menu.documents.map((d) => (
            <li key={d.slug}>
              <NavLink
                to={`/${category}/${menu.slug}/${d.slug}`}
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
          {menu.menus.map((m) => <MenuItem key={m.slug} category={category} menu={m} depth={depth + 1} />)}
        </ul>
      )}
    </li>
  );
}

export function Sidebar({ category }: { category: Category }) {
  return (
    <nav className="p-3" aria-label={`${category.name} 메뉴`}>
      <p className="px-2 pb-2 font-mono text-[11px] tracking-widest text-muted uppercase">{category.name}</p>
      {category.menus.length === 0 ? (
        <p className="px-2 text-sm text-muted">아직 메뉴가 없습니다. 상단 <b>업로드</b>에서 "새 메뉴 만들기"를 고르면 메뉴를 만들면서 문서를 올릴 수 있습니다.</p>
      ) : (
        <ul className="grid gap-0.5">
          {category.menus.map((m) => <MenuItem key={m.slug} category={category.key} menu={m} depth={0} />)}
        </ul>
      )}
    </nav>
  );
}
