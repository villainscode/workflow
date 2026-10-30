import { useEffect, useRef, useSyncExternalStore } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { API, CLOUD } from "./base.ts";

/**
 * 서버의 변경 알림(로컬 SSE, Cloudflare WebSocket)을 받으면 목록과 문서 정보를 다시 불러온다. onEvent에는 알림 내용을 넘긴다(3.4 Claude 저장·화면 이동).
 * 페이지를 떠날 때(pagehide) 연결을 닫고, 뒤로 가기 캐시에서 돌아오면(pageshow) 다시 연다.
 * 닫지 않으면 캐시에 남은 페이지들이 연결을 계속 잡고 있어, 같은 호스트 연결 한도(6개)가 차면 사이트가 멈춘다.
 */
export interface LiveEvent {
  type: "changed" | "focus" | "presence"; reason?: string; by?: string; userId?: number; rev?: number;
  category?: string; menu?: string; doc?: string; title?: string; version?: string;
  segs?: number[]; seg?: string;
  list?: PresenceEntry[];
}
/** 접속자(5.0 M7, Cloudflare): 누가 어느 문서를 보고·고치는지 */
export interface PresenceEntry { userId: number; email: string; name: string | null; menu: string; doc: string; mode: "view" | "edit" }

// 열린 연결 하나를 모듈에서 함께 쓴다: 지금 보는 문서 알리기, 접속자 목록, 알림 구독
let socket: WebSocket | null = null;
let here: { menu: string; doc: string; mode: "view" | "edit" } | null = null;
let presence: PresenceEntry[] = [];
const presenceListeners = new Set<() => void>();
const eventListeners = new Set<(e: LiveEvent) => void>();
const sendHere = () => { if (socket?.readyState === WebSocket.OPEN && here) socket.send(JSON.stringify({ type: "here", ...here })); };

/** 이 화면이 보는 문서(편집 중이면 edit)를 알린다. 문서를 떠나면 null */
export function useHere(menu: string, doc: string, mode: "view" | "edit") {
  useEffect(() => {
    if (!CLOUD || !menu || !doc) return;
    here = { menu, doc, mode };
    sendHere();
    return () => { here = { menu: "", doc: "", mode: "view" }; sendHere(); here = null; };
  }, [menu, doc, mode]);
}

/** 접속자 목록 */
export const usePresence = () => useSyncExternalStore(
  (fn) => { presenceListeners.add(fn); return () => presenceListeners.delete(fn); },
  () => presence,
);

/** 변경 알림 구독(편집 화면이 다른 사람의 저장을 안다) */
export function useLiveEvent(fn: (e: LiveEvent) => void) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    const l = (e: LiveEvent) => ref.current(e);
    eventListeners.add(l);
    return () => { eventListeners.delete(l); };
  }, []);
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
      if (e?.type === "presence") { presence = e.list ?? []; presenceListeners.forEach((f) => f()); return; }
      if (!e || e.type === "changed") refresh();
      if (e) { handler.current?.(e); eventListeners.forEach((f) => f(e!)); }
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
      socket = ws;
      ws.onopen = () => { wait = 1000; sendHere(); };
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

/**
 * 같은 문서를 다른 사람(또는 Claude Code)이 수정본으로 저장하면 부른다(편집 화면의 실시간 반영, 5.0 M7).
 * 내 저장은 건너뛴다(같은 사람이어도 에이전트 저장은 남의 저장으로 본다). rev는 지금 화면이 아는 수정본 번호
 */
export function useOtherSave(menu: string, doc: string, myUserId: number | undefined, rev: number | undefined, fn: (e: LiveEvent) => void) {
  useLiveEvent((e) => {
    if (e.type !== "changed" || e.menu !== menu || e.doc !== doc) return;
    if (!["revision", "publish", "upload", "text-edit", "edit", "release"].includes(e.reason ?? "")) return;
    if (e.userId === myUserId && !e.by) return;
    if (e.rev !== undefined && rev !== undefined && e.rev <= rev) return;
    fn(e);
  });
}
