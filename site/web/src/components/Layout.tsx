import { useEffect, useState } from "react";
import { NavLink, Outlet, useLocation, useParams } from "react-router";
import { useTree } from "../lib/api.ts";
import { useLiveUpdates } from "../lib/live.ts";
import { UploadProvider, useOpenUpload } from "./upload/UploadContext.tsx";
import { Sidebar } from "./Sidebar.tsx";
import { EmptyState } from "./EmptyState.tsx";
import { SearchBox } from "./SearchBox.tsx";

export function Layout() {
  return (
    <UploadProvider>
      <Shell />
    </UploadProvider>
  );
}

function Shell() {
  useLiveUpdates();
  const openUpload = useOpenUpload();
  const { category } = useParams();
  const { data: tree, error } = useTree();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const location = useLocation();

  // 문서를 고르면 좁은 화면의 서랍을 닫는다
  useEffect(() => setDrawerOpen(false), [location.pathname]);

  const current = tree?.categories.find((c) => c.key === category);

  return (
    <div className="grid h-full grid-rows-[auto_minmax(0,1fr)]">
      <header className="flex flex-wrap items-center gap-x-1 border-b border-line bg-surface px-3 sm:flex-nowrap sm:px-4">
        <button
          className="mr-1 rounded-md px-2 py-1 text-muted hover:bg-sunken md:hidden"
          onClick={() => setDrawerOpen((v) => !v)}
          aria-label="메뉴 열기"
        >
          ☰
        </button>
        <span className="mr-4 hidden font-mono text-xs tracking-widest text-muted uppercase sm:inline">Workflow</span>
        <nav className="flex min-w-0 gap-1 overflow-hidden" aria-label="대분류">
          {tree?.categories.map((c) => (
            <NavLink
              key={c.key}
              to={`/${c.key}`}
              className={({ isActive }) =>
                `border-b-2 px-3 py-3 text-sm font-medium whitespace-nowrap ${
                  isActive ? "border-accent text-fg" : "border-transparent text-muted hover:text-fg"
                }`
              }
            >
              {c.name}
            </NavLink>
          ))}
        </nav>
        <SearchBox />
        <button
          className="ml-auto shrink-0 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-surface hover:opacity-90 sm:ml-2"
          onClick={() => openUpload({ category })}
        >
          업로드
        </button>
      </header>

      <div className="relative grid min-h-0 md:grid-cols-[272px_minmax(0,1fr)]">
        <aside
          className={`absolute inset-y-0 left-0 z-20 w-[272px] overflow-y-auto border-r border-line bg-surface md:static md:block ${
            drawerOpen ? "block shadow-xl" : "hidden"
          }`}
        >
          {current && <Sidebar category={current} />}
          {tree && tree.warnings.length > 0 && (
            <details className="m-3 rounded-md bg-high-soft p-2 text-xs text-high">
              <summary className="cursor-pointer">색인 경고 {tree.warnings.length}건</summary>
              <ul className="mt-1 list-disc pl-4">{tree.warnings.map((w) => <li key={w}>{w}</li>)}</ul>
            </details>
          )}
        </aside>
        {drawerOpen && <div className="absolute inset-0 z-10 bg-black/30 md:hidden" onClick={() => setDrawerOpen(false)} />}

        <main className="min-h-0 min-w-0">
          {error ? (
            <EmptyState title="서버에 연결할 수 없습니다" body={String(error)} />
          ) : tree && !current ? (
            <EmptyState title="없는 대분류입니다" body={`'${category}' 대분류가 menus.yaml에 없습니다.`} />
          ) : (
            <Outlet />
          )}
        </main>
      </div>
    </div>
  );
}
