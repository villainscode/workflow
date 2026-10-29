import { StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, Navigate, RouterProvider } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { HttpError } from "./lib/api.ts";
import { ConfirmProvider } from "./components/confirm/ConfirmProvider.tsx";
import { Layout } from "./components/Layout.tsx";
import { DocView } from "./components/DocView.tsx";
import { EmptyState } from "./components/EmptyState.tsx";
import { TooltipLayer } from "./components/Tooltip.tsx";
import { BASENAME, CLOUD, WS } from "./lib/base.ts";
import { loadMe, MeContext, type Me, type Role } from "./lib/me.ts";
import { Login } from "./components/account/Login.tsx";
import { NoWorkspace } from "./components/account/NoWorkspace.tsx";
import "./styles.css";

// 개발 모드에서만: 화면 요소를 가리키고 ⌘C로 복사하면 컴포넌트·파일 위치를 코딩 에이전트에 붙여 넣을 수 있다 (react-grab.com)
if (import.meta.env.DEV) void import("react-grab");

const router = createBrowserRouter([
  { path: "/", element: <Navigate to="/sdlc" replace /> },
  {
    path: "/:category",
    element: <Layout />,
    children: [
      { index: true, element: <EmptyState title="문서를 고르세요" body="왼쪽 목록에서 문서를 선택하면 여기에서 열립니다." /> },
      { path: ":menu/:doc", element: <DocView /> },
    ],
  },
], { basename: BASENAME || undefined });

// 404(옮겨지거나 지워진 문서)는 다시 시도해도 같으므로 재시도하지 않는다
const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 30_000, retry: (n, e) => !(e instanceof HttpError && e.status === 404) && n < 1 } },
});

/**
 * Cloudflare(4.0 P4): 화면을 그리기 전에 로그인과 워크스페이스 역할을 확인한다.
 * 로그인 전 → 로그인 화면, 워크스페이스 없이(/) → 첫 워크스페이스로, 멤버가 아닌 주소 → 안내 화면. 로컬 사이트는 로그인 없이 owner
 */
// 워크스페이스 없이(/) 들어오면 마지막에 쓴 워크스페이스로 간다(브라우저마다 기억)
const LAST_WS = "workflow:last-ws";
const lastWs = () => { try { return localStorage.getItem(LAST_WS); } catch { return null; } };
const rememberWs = (ws: string) => { try { localStorage.setItem(LAST_WS, ws); } catch { /* 저장 못 해도 동작 */ } };

let me: Me | null = null;
let role: Role = "owner";
let gate: ReactNode = null;
if (CLOUD) {
  me = await loadMe();
  const here = me.workspaces.find((w) => w.slug === WS);
  if (!me.user) gate = <Login devLogin={me.devLogin} />;
  else if (!WS && me.workspaces[0]) location.replace(`/${(me.workspaces.find((w) => w.slug === lastWs()) ?? me.workspaces[0]).slug}/`);
  else if (!here) gate = <NoWorkspace me={me} missing={WS || undefined} />;
  else { role = here.role; rememberWs(WS); }
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <MeContext.Provider value={{ me, role }}>
        <ConfirmProvider>
          {gate ?? <RouterProvider router={router} />}
        </ConfirmProvider>
        <TooltipLayer />
      </MeContext.Provider>
    </QueryClientProvider>
  </StrictMode>,
);
