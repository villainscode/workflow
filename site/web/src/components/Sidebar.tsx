import { useState } from "react";
import { NavLink } from "react-router";
import type { Category, MenuNode } from "../lib/api.ts";
import { StatusBadge } from "./StatusBadge.tsx";

function MenuItem({ category, menu, depth }: { category: string; menu: MenuNode; depth: number }) {
  const [open, setOpen] = useState(true);
  return (
    <li>
      <button
        className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-sm font-medium hover:bg-sunken"
        style={{ paddingLeft: 8 + depth * 14 }}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="w-3 text-xs text-muted">{open ? "▾" : "▸"}</span>
        <span className="min-w-0 flex-1 truncate">{menu.name}</span>
        <span className="font-mono text-[11px] text-muted">{menu.documents.length}</span>
      </button>
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
        <p className="px-2 text-sm text-muted">아직 메뉴가 없습니다. <code>docs/_site/menus.yaml</code>에 추가하면 여기에 나타납니다.</p>
      ) : (
        <ul className="grid gap-0.5">
          {category.menus.map((m) => <MenuItem key={m.slug} category={category.key} menu={m} depth={0} />)}
        </ul>
      )}
    </nav>
  );
}
