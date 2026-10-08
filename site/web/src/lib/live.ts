import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";

/**
 * 서버의 변경 알림(SSE)을 받으면 목록과 문서 정보를 다시 불러온다.
 * 페이지를 떠날 때(pagehide) 연결을 닫고, 뒤로 가기 캐시에서 돌아오면(pageshow) 다시 연다.
 * 닫지 않으면 캐시에 남은 페이지들이 연결을 계속 잡고 있어, 같은 호스트 연결 한도(6개)가 차면 사이트가 멈춘다.
 */
export function useLiveUpdates() {
  const qc = useQueryClient();
  useEffect(() => {
    let es: EventSource | null = null;
    const refresh = () => {
      qc.invalidateQueries({ queryKey: ["tree"] });
      qc.invalidateQueries({ queryKey: ["doc"] });
    };
    const open = () => {
      es?.close();
      es = new EventSource("/api/events");
      es.onmessage = refresh;
    };
    const close = () => { es?.close(); es = null; };
    const onShow = (e: PageTransitionEvent) => { if (e.persisted) { open(); refresh(); } };
    open();
    addEventListener("pagehide", close);
    addEventListener("pageshow", onShow);
    return () => {
      close();
      removeEventListener("pagehide", close);
      removeEventListener("pageshow", onShow);
    };
  }, [qc]);
}
