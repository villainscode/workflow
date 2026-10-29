import { DurableObject } from "cloudflare:workers";
import type { Context } from "hono";
import type { AppEnv } from "./env.ts";

/**
 * 실시간 반영(4.0 P5, 로컬의 SSE /api/events 대신). 워크스페이스마다 Durable Object 하나가 열린 화면들의 WebSocket을 들고,
 * 쓰기 API가 끝나면 변경 알림(changed)이나 화면 이동(focus)을 모두에게 보낸다. 알림 모양은 로컬 SSE와 같다.
 * WebSocket Hibernation API(acceptWebSocket)라 쉬는 연결은 DO가 잠들어 시간 요금이 없다. "ping"에는 DO를 깨우지 않고 "pong"으로 답한다.
 */
export class Live extends DurableObject {
  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env as never);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  async fetch(): Promise<Response> {
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  /** 모두에게 보내고, 받은 화면 수를 돌려준다 */
  async broadcast(event: object): Promise<number> {
    const msg = JSON.stringify(event);
    let n = 0;
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.send(msg); n++; } catch { /* 닫히는 중 */ }
    }
    return n;
  }

  async webSocketClose(ws: WebSocket, code: number) {
    try { ws.close(code === 1005 ? 1000 : code, "closed"); } catch { /* 이미 닫힘 */ }
  }
}

export const liveStub = (env: AppEnv["Bindings"], wsId: number) => env.LIVE.get(env.LIVE.idFromName(String(wsId)));

/** MCP(Claude Code)가 보낸 요청: 로컬과 같은 X-Workflow-Agent 헤더(3.4) */
export const agentOf = (c: Context<AppEnv>) => (c.req.header("x-workflow-agent") === "claude-code" ? "claude-code" : undefined);

/** 상태를 바꾼 API 경로 → 알림 이유(로컬 SSE의 reason과 같은 말). null이면 알리지 않는다 */
export function reasonOf(method: string, path: string): string | null {
  if (method === "GET" || /\/text-preview$|^\/images$|^\/focus$|^\/(members|invites)(\/|$)/.test(path)) return null;
  if (path === "/assets") return null;
  if (/\/revisions(\/\d+\/restore)?$/.test(path)) return "revision";
  if (/\/publish$/.test(path)) return "publish";
  if (path === "/upload") return "upload";
  if (/\/edit$/.test(path)) return "edit";
  if (/\/text-edit$/.test(path)) return "text-edit";
  if (/\/release$/.test(path)) return "release";
  if (/^\/menus/.test(path)) return "menu";
  if (/^\/categories/.test(path)) return "category";
  if (/^\/trash\/[^/]+\/restore$/.test(path)) return "restore";
  if (/^\/trash\//.test(path)) return "purge";
  if (method === "DELETE" && /^\/docs\//.test(path)) return "trash";
  if (/^\/docs\//.test(path)) return "doc";
  return null;
}
