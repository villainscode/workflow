import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, Navigate, RouterProvider } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Layout } from "./components/Layout.tsx";
import { DocView } from "./components/DocView.tsx";
import { EmptyState } from "./components/EmptyState.tsx";
import "./styles.css";

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
]);

const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: 30_000, retry: 1 } } });

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
