import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { API, CLOUD } from "./base.ts";

/**
 * 서버의 변경 알림(로컬 SSE, Cloudflare WebSocket)을 받으면 목록과 문서 정보를 다시 불러온다. onEvent에는 알림 내용을 넘긴다(3.4 Claude 저장·화면 이동).
 * 페이지를 떠날 때(pagehide) 연결을 닫고, 뒤로 가기 캐시에서 돌아오면(pageshow) 다시 연다.
 * 닫지 않으면 캐시에 남은 페이지들이 연결을 계속 잡고 있어, 같은 호스트 연결 한도(6개)가 차면 사이트가 멈춘다.
 */
export interface LiveEvent {
  type: "changed" | "focus"; reason?: string; by?: string;
  category?: string; menu?: string; doc?: string; title?: string; version?: string;
  segs?: number[]; seg?: string;
}

export function useLiveUpdates(onEvent?: (e: LiveEvent) => void) {
  const qc = useQueryClient();
  const handler = useRef(onEvent);
  handler.current = onEvent;
  useEffect(() => {
    const refresh = () => {
      qc.invalidateQueries({ queryKey: ["tree"] });
      qc.invalidateQueries({ queryKey: ["doc"] });
    };
    const onMessage = (data: string) => {
      if (data === "pong") return;
      let e: LiveEvent | null = null;
      try { e = JSON.parse(data) as LiveEvent; } catch { /* 형식이 다르면 새로 불러오기만 */ }
      if (!e || e.type === "changed") refresh();
      if (e) handler.current?.(e);
    };
    // 로컬은 SSE, Cloudflare(4.0 P5)는 워크스페이스 Durable Object WebSocket. 끊기면 점점 늘려 다시 붙는다(최대 30초)
    let es: EventSource | null = null;
    let ws: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let wait = 1000;
    let closed = false;
    const open = () => {
      closed = false;
      if (!CLOUD) {
        es?.close();
        es = new EventSource(`${API}/events`);
        es.onmessage = (m) => onMessage(m.data);
        return;
      }
      ws?.close();
      ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${API}/live`);
      ws.onopen = () => { wait = 1000; };
      ws.onmessage = (m) => onMessage(String(m.data));
      ws.onclose = () => {
        if (closed) return;
        retry = setTimeout(() => { open(); refresh(); }, wait);
        wait = Math.min(wait * 2, 30_000);
      };
    };
    const close = () => { closed = true; clearTimeout(retry); es?.close(); es = null; ws?.close(); ws = null; };
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
