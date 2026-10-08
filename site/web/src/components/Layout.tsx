import { useEffect, useState } from "react";
import { Link, Outlet, useLocation, useParams } from "react-router";
import { Menu, PanelLeftOpen, Upload } from "lucide-react";
import { IconButton } from "./IconButton.tsx";
import { useTree } from "../lib/api.ts";
import { useLiveUpdates } from "../lib/live.ts";
import { useClaudeNotice } from "./LiveNotice.tsx";
import { UploadProvider, useOpenUpload } from "./upload/UploadContext.tsx";
import { Sidebar } from "./Sidebar.tsx";
import { EmptyState } from "./EmptyState.tsx";
import { SearchBox } from "./SearchBox.tsx";
import { TopMenuBar } from "./header/TopMenuBar.tsx";
import { SidebarResizer, useSidebarWidth } from "./SidebarResizer.tsx";

export function Layout() {
  return (
    <UploadProvider>
      <Shell />
    </UploadProvider>
  );
}

function Shell() {
  const claude = useClaudeNotice();
  useLiveUpdates(claude.onEvent);
  const openUpload = useOpenUpload();
  const { category } = useParams();
  const { data: tree, error } = useTree();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const sidebar = useSidebarWidth();
  const location = useLocation();

  // 문서를 고르면 좁은 화면의 서랍을 닫는다
  useEffect(() => setDrawerOpen(false), [location.pathname]);

  const current = tree?.categories.find((c) => c.key === category);

  return (
    <div className="grid h-full grid-rows-[auto_minmax(0,1fr)]">
      <header className="flex flex-wrap items-center gap-x-1 border-b border-line bg-surface px-3 sm:flex-nowrap sm:px-4">
        <IconButton icon={Menu} label="메뉴 열기" size={24} className="mr-1 md:hidden" onClick={() => setDrawerOpen((v) => !v)} />
        {/* 사이트 로고. 누르면 메인(/)으로 간다. 좁은 화면에서는 심볼만 */}
        <Link to="/" className="mr-4 flex shrink-0 items-center rounded-md py-2" aria-label="Workflow 메인으로">
          <img src="/logo.svg" alt="Workflow" className="hidden h-7 w-auto sm:block" />
          <img src="/favicon.svg" alt="Workflow" className="h-7 w-7 sm:hidden" />
        </Link>
        <TopMenuBar categories={tree?.categories ?? []} />
        <SearchBox />
        <IconButton icon={Upload} label="업로드" variant="primary" size={22} className="ml-auto p-2 sm:ml-2" onClick={() => openUpload({ category })} />
      </header>

      {/* 넓은 화면: 사이드바 너비는 --sidebar-w(끌어서 조절). 좁은 화면: 고정 폭 서랍 */}
      <div className="relative grid min-h-0 md:grid-cols-[var(--sidebar-w)_minmax(0,1fr)]" style={sidebar.style}>
        <aside
          className={`absolute inset-y-0 left-0 z-20 w-[272px] flex-col border-r border-line bg-surface md:static md:flex md:w-auto ${
            drawerOpen ? "flex shadow-xl" : "hidden"
          }`}
        >
          {/* 접힌 상태는 넓은 화면에만 적용한다. 좁은 화면의 서랍은 항상 전체 목록을 보여준다 */}
          <div className={sidebar.collapsed ? "contents md:hidden" : "contents"}>
            {current && <Sidebar category={current} warnings={tree?.warnings ?? []} onCollapse={() => sidebar.setCollapsed(true)} />}
          </div>
          {sidebar.collapsed && (
            <button
              className="hidden h-full w-full justify-center pt-3 text-muted hover:bg-sunken hover:text-fg md:flex"
              onClick={() => sidebar.setCollapsed(false)}
              aria-label="사이드바 펼치기"
              data-tip="사이드바 펼치기"
              data-tip-side="right"
            >
              <PanelLeftOpen size={18} aria-hidden />
            </button>
          )}
        </aside>
        {!sidebar.collapsed && <SidebarResizer width={sidebar.width} setWidth={sidebar.setWidth} />}
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
      {claude.view}
    </div>
  );
}
