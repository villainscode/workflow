import { beforeEach, describe, expect, it } from "vitest";
import { addMember, BASE, call, getJson, json, login, seed, sessionCookie, upload, useSession } from "./helpers.ts";
import { exports } from "cloudflare:workers";

/** 실시간 반영(4.0 P5): 워크스페이스 Durable Object WebSocket. 로컬 TC-LIVE-01·04·05와 같은 알림 모양 */

const W = "/api/w/team";

/** 실시간 연결을 열고 받은 알림을 모은다 */
async function connect(cookie = sessionCookie()) {
  const res = await exports.default.fetch(new Request(`${BASE}${W}/live`, { headers: { upgrade: "websocket", cookie } }));
  if (res.status !== 101) return { status: res.status, events: [] as any[], next: async () => null as any, close: () => {} };
  const socket = res.webSocket!;
  socket.accept();
  const events: any[] = [];
  const waiters: ((e: any) => void)[] = [];
  socket.addEventListener("message", (m) => {
    const e = m.data === "pong" ? "pong" : JSON.parse(String(m.data));
    const w = waiters.shift();
    if (w) w(e); else events.push(e);
  });
  return {
    status: 101, events,
    next: () => (events.length ? Promise.resolve(events.shift()) : new Promise<any>((ok, no) => { waiters.push(ok); setTimeout(() => no(new Error("알림 없음")), 3000); })),
    send: (s: string) => socket.send(s),
    close: () => socket.close(),
  };
}

beforeEach(async () => { await seed(); });

describe("실시간 반영", () => {
  it("TC-CF-38 (TC-LIVE-01·04) 올리기·텍스트 편집·관리가 끝나면 changed 알림(대분류·메뉴·문서·제목·버전·바뀐 조각), X-Workflow-Agent면 by: claude-code", async () => {
    const live = await connect();
    expect(live.status).toBe(101);
    await upload("team", { menu: "notes", title: "실시간 문서", slug: "rt" }, [["rt.html", "<p>하나</p>"]]);
    expect(await live.next()).toMatchObject({ type: "changed", reason: "upload", category: "sdlc", menu: "notes", doc: "rt", title: "실시간 문서", version: "v0.0" });

    const s = await getJson(`${W}/docs/notes/rt/segments`);
    await call(`${W}/docs/notes/rt/text-edit`, { method: "POST", headers: { "content-type": "application/json", "x-workflow-agent": "claude-code" },
      body: JSON.stringify({ baseVersion: "v0.0", changes: [{ id: s.segments[0].id, hash: s.segments[0].hash, text: "둘" }] }) });
    expect(await live.next()).toMatchObject({ reason: "text-edit", by: "claude-code", doc: "rt", version: "v0.1", segs: [s.segments[0].id] });

    await json("PATCH", `${W}/menus/notes`, { name: "메모장" });
    expect(await live.next()).toMatchObject({ reason: "menu" });
    await json("DELETE", `${W}/docs/notes/rt`);
    expect(await live.next()).toMatchObject({ reason: "trash", menu: "notes", doc: "rt" });
    // 미리보기·이미지는 바꾸는 게 아니라 알리지 않는다
    live.send!("ping");
    expect(await live.next()).toBe("pong");
    live.close();
  });

  it("TC-CF-39 (TC-LIVE-05) focus: 열린 화면에 문서·버전·조각으로 옮기라고 알리고 받은 화면 수를 돌려준다, 잘못된 값은 거부", async () => {
    const a = await connect();
    const b = await connect();
    const r = await (await call(`${W}/focus`, { method: "POST", headers: { "content-type": "application/json", "x-workflow-agent": "claude-code" },
      body: JSON.stringify({ menu: "process", doc: "guide", version: "v0.1", seg: "1-2" }) })).json<any>();
    expect(r.clients).toBeGreaterThanOrEqual(2); // 앞 테스트의 연결이 아직 닫히는 중일 수 있다
    expect(await a.next()).toEqual({ type: "focus", by: "claude-code", category: "sdlc", menu: "process", doc: "guide", title: "가이드", version: "v0.1", seg: "1-2" });
    expect((await b.next()).type).toBe("focus");
    expect((await json("POST", `${W}/focus`, { menu: "process", doc: "nope" })).status).toBe(404);
    expect((await json("POST", `${W}/focus`, { menu: "process", doc: "guide", seg: "x;" })).status).toBe(400);
    a.close(); b.close();
  });

  it("TC-CF-40 실시간 연결도 멤버만(viewer 가능, 로그인 전 401), WebSocket이 아니면 426. 활동 기록에 누가 무엇을", async () => {
    await addMember("team", "v@test.com", "viewer");
    const viewer = await login("v@test.com");
    expect((await connect(viewer.cookie)).status).toBe(101);
    expect((await connect("")).status).toBe(401);
    expect((await call(`${W}/live`)).status).toBe(426);
    await upload("team", { menu: "notes", title: "기록", slug: "log" }, [["log.md", "# 기록"]]);
    await new Promise((r) => setTimeout(r, 50));
    const act = await getJson(`${W}/activity`);
    expect(act[0]).toMatchObject({ action: "upload", target: "notes/log", version: "v0.0", email: "owner@test.com" });
    useSession(viewer.cookie);
    expect((await getJson(`${W}/activity`)).length).toBeGreaterThan(0);
  });
});
