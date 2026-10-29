import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { env, exports } from "cloudflare:workers";
import { addMember, BASE, call, getJson, json, login, seed, upload, useSession } from "./helpers.ts";

/** 로그인·권한·초대(4.0 P4, REQUIREMENT-4.0 5.9). Google 로그인만, 초대받은 사람만 */

const W = "/api/w/team";
const as = async (email: string, role?: "owner" | "editor" | "viewer") => {
  if (role) await addMember("team", email, role);
  const { cookie } = await login(email);
  useSession(cookie);
  return cookie;
};

beforeEach(async () => { await seed(); });

describe("로그인·세션", () => {
  it("TC-CF-30 로그인 전: /api/me는 user null, 워크스페이스 API는 401", async () => {
    useSession("");
    expect(await getJson("/api/me")).toEqual({ user: null, workspaces: [], superadmin: false, devLogin: true });
    expect((await call(`${W}/tree`)).status).toBe(401);
  });

  it("TC-CF-31 초대 없이 처음 오는 사람은 막고(403), SUPERADMIN은 들어온다. 로그아웃하면 세션이 끝난다", async () => {
    const blocked = await login("stranger@test.com");
    expect(blocked.res.status).toBe(403);
    expect(blocked.cookie).toBe("");
    expect(await blocked.res.text()).toContain("초대받은 사람만");
    const me = await getJson("/api/me");
    expect(me.user.email).toBe("owner@test.com");
    expect(me.superadmin).toBe(true);
    expect(me.workspaces).toContainEqual({ slug: "team", name: "team 팀", role: "owner" });
    expect((await json("POST", "/api/auth/logout")).status).toBe(200);
    expect((await getJson("/api/me")).user).toBeNull();
  });

  it("TC-CF-32 Google 로그인: state·PKCE, 토큰 교환 후 id_token의 aud·iss·이메일 확인, 다른 사이트로 보내는 next는 무시", async () => {
    useSession("");
    const start = await exports.default.fetch(new Request(`${BASE}/api/auth/google?next=//evil.example`, { redirect: "manual" }));
    const to = new URL(start.headers.get("location")!);
    expect(to.origin + to.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(to.searchParams.get("code_challenge_method")).toBe("S256");
    expect(to.searchParams.get("redirect_uri")).toBe(`${BASE}/api/auth/google/callback`);
    const oauth = start.headers.getSetCookie().find((c) => c.startsWith("wf_oauth="))!.split(";")[0];
    const state = to.searchParams.get("state")!;

    const claims = { iss: "https://accounts.google.com", aud: "test-client", sub: "g-1", email: "owner@test.com", email_verified: true, name: "주인", exp: Date.now() / 1000 + 600 };
    const idToken = `x.${btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(claims)))).replace(/=+$/, "")}.y`;
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      expect(String(input)).toBe("https://oauth2.googleapis.com/token");
      expect(String(init?.body)).toContain("code_verifier=");
      return Response.json({ id_token: idToken });
    });
    const bad = await exports.default.fetch(new Request(`${BASE}/api/auth/google/callback?code=c&state=wrong`, { headers: { cookie: oauth }, redirect: "manual" }));
    expect(bad.status).toBe(400);
    const ok = await exports.default.fetch(new Request(`${BASE}/api/auth/google/callback?code=c&state=${state}`, { headers: { cookie: oauth }, redirect: "manual" }));
    spy.mockRestore();
    expect(ok.status).toBe(302);
    expect(ok.headers.get("location")).toBe("/");
    const session = ok.headers.getSetCookie().find((c) => c.startsWith("wf_session="))!;
    expect(session).toMatch(/HttpOnly/i);
    expect(session).toMatch(/SameSite=Lax/i);
    useSession(session.split(";")[0]);
    expect((await getJson("/api/me")).user.name).toBe("주인");
  });
});

describe("권한(5.9)", () => {
  it("TC-CF-33 멤버가 아니면 404, viewer는 읽기만(쓰기 403), editor는 쓰기·휴지통, owner만 영구 삭제·폴더 삭제·대분류·초대", async () => {
    await as("outsider@test.com");
    // outsider는 초대 없이 처음 오는 사람이라 로그인부터 막힌다 → 다른 워크스페이스의 owner로 확인
    await env.DB.prepare("INSERT INTO workspace (slug, name, created_at) VALUES ('solo', '혼자', '2026-10-28') ON CONFLICT DO NOTHING").run();
    await addMember("solo", "solo@test.com", "owner");
    useSession((await login("solo@test.com")).cookie);
    expect((await call(`${W}/tree`)).status).toBe(404);

    await as("viewer@test.com", "viewer");
    expect((await call(`${W}/tree`)).status).toBe(200);
    expect((await call(`${W}/docs/process/guide`)).status).toBe(200);
    expect((await upload("team", { menu: "notes", title: "x" }, [["x.md", "x"]])).status).toBe(403);
    expect((await json("PATCH", `${W}/docs/process/guide`, { title: "x" })).status).toBe(403);
    expect((await call(`${W}/invites`)).status).toBe(403);

    await as("editor@test.com", "editor");
    expect((await upload("team", { menu: "notes", title: "편집자 문서", slug: "ed" }, [["ed.md", "x"]])).status).toBe(200);
    const { id } = await (await json("DELETE", `${W}/docs/notes/ed`)).json<any>();
    expect((await json("DELETE", `${W}/trash/${id}`)).status).toBe(403);
    expect((await json("DELETE", `${W}/menus/notes`)).status).toBe(403);
    expect((await json("POST", `${W}/categories`, { name: "Ops" })).status).toBe(403);
    expect((await json("POST", `${W}/invites`, { role: "viewer" })).status).toBe(403);
    expect((await call(`${W}/members`)).status).toBe(200);

    await as("owner@test.com");
    expect((await json("DELETE", `${W}/trash/${id}`)).status).toBe(200);
    expect((await json("POST", `${W}/categories`, { name: "Ops" })).status).toBe(200);
  });

  it("TC-CF-34 요청 위조 막기: 상태를 바꾸는 요청은 Origin이 앱 주소여야 한다(없거나 다르면 403)", async () => {
    expect((await call(`${W}/menus`, { method: "POST", headers: { origin: "https://evil.example", "content-type": "application/json" }, body: "{}" })).status).toBe(403);
    expect((await exports.default.fetch(new Request(`${BASE}${W}/menus`, { method: "POST", headers: { cookie: "x", "content-type": "application/json" }, body: "{}" }))).status).toBe(403);
    expect((await json("POST", `${W}/menus`, { category: "agent", name: "Ok" })).status).toBe(200);
  });
});

describe("초대·멤버", () => {
  afterEach(() => useSession(""));

  it("TC-CF-35 초대 링크: 로그인 전이면 쿠키에 두고 로그인 → 멤버가 되고 그 워크스페이스로. 한 번 쓰면 410, 이메일 지정 초대는 그 계정만", async () => {
    const inv = await (await json("POST", `${W}/invites`, { role: "editor" })).json<any>();
    expect(inv.url).toMatch(/^http:\/\/app\.test\/api\/invites\/[\w-]{43}$/);
    expect((await getJson(`${W}/invites`)).map((i: any) => i.role)).toEqual(["editor"]);
    const path = new URL(inv.url).pathname;

    useSession("");
    const open = await call(path);
    expect(open.status).toBe(302);
    const inviteCookie = open.headers.getSetCookie().find((c) => c.startsWith("wf_invite="))!.split(";")[0];
    const joined = await login("new@test.com", inviteCookie);
    expect(joined.res.headers.get("location")).toBe("/team/");
    useSession(joined.cookie);
    expect((await getJson("/api/me")).workspaces).toEqual([{ slug: "team", name: "team 팀", role: "editor" }]);
    expect((await call(path)).status).toBe(410);

    await as("owner@test.com");
    const only = await (await json("POST", `${W}/invites`, { role: "viewer", email: "Someone@Test.com" })).json<any>();
    expect(only.email).toBe("someone@test.com");
    useSession("");
    const c2 = (await call(new URL(only.url).pathname)).headers.getSetCookie().find((c) => c.startsWith("wf_invite="))!.split(";")[0];
    const wrong = await login("other@test.com", c2);
    expect(wrong.res.status).toBe(403);
    expect((await login("someone@test.com", c2)).res.headers.get("location")).toBe("/team/");
  });

  it("TC-CF-36 멤버 역할 바꾸기·내보내기, 마지막 owner는 내리거나 뺄 수 없다, 초대 취소", async () => {
    await addMember("team", "e@test.com", "editor");
    const list = await getJson(`${W}/members`);
    const owner = list.find((m: any) => m.email === "owner@test.com");
    const ed = list.find((m: any) => m.email === "e@test.com");
    expect((await json("PATCH", `${W}/members/${owner.id}`, { role: "editor" })).status).toBe(409);
    expect((await json("DELETE", `${W}/members/${owner.id}`)).status).toBe(409);
    expect((await json("PATCH", `${W}/members/${ed.id}`, { role: "boss" })).status).toBe(400);
    expect((await json("PATCH", `${W}/members/${ed.id}`, { role: "owner" })).status).toBe(200);
    expect((await json("PATCH", `${W}/members/${owner.id}`, { role: "viewer" })).status).toBe(200);
    // 이제 owner는 e 한 명. e로 바꿔 자기 자신을 빼려 하면 409
    await as("e@test.com");
    expect((await json("DELETE", `${W}/members/${ed.id}`)).status).toBe(409);
    const inv = await (await json("POST", `${W}/invites`, { role: "viewer" })).json<any>();
    expect((await json("DELETE", `${W}/invites/${inv.id}`)).status).toBe(200);
    expect(await getJson(`${W}/invites`)).toEqual([]);
  });

  it("TC-CF-37 워크스페이스 만들기는 SUPERADMIN만, 만든 사람이 owner, 예약 주소·중복은 거부", async () => {
    expect(await (await json("POST", "/api/workspaces", { slug: "new-team", name: "새 팀" })).json()).toEqual({ slug: "new-team", name: "새 팀" });
    expect((await getJson("/api/me")).workspaces).toContainEqual({ slug: "new-team", name: "새 팀", role: "owner" });
    expect((await getJson("/api/w/new-team/tree")).categories.map((c: any) => c.key)).toEqual(["sdlc"]);
    expect((await json("POST", "/api/workspaces", { slug: "new-team", name: "x" })).status).toBe(409);
    expect((await json("POST", "/api/workspaces", { slug: "api", name: "x" })).status).toBe(400);
    await as("editor2@test.com", "editor");
    expect((await json("POST", "/api/workspaces", { slug: "mine", name: "x" })).status).toBe(403);
  });
});

describe("운영(P8)", () => {
  it("TC-CF-46 요청 수 제한: 같은 IP에서 로그인 요청이 분당 20번을 넘으면 429", async () => {
    const codes: number[] = [];
    for (let i = 0; i < 22; i++) {
      codes.push((await exports.default.fetch(new Request(`${BASE}/api/auth/logout`, { method: "POST", headers: { origin: BASE, "cf-connecting-ip": "203.0.113.9" } }))).status);
    }
    expect(codes.slice(0, 20).every((s) => s === 200)).toBe(true);
    expect(codes.at(-1)).toBe(429);
  });

  it("TC-CF-47 매일 정리: 지난 세션·만료된 초대, 아무 버전도 안 쓰는 하루 지난 blob을 지운다(쓰는 blob·방금 올린 blob은 남긴다)", async () => {
    const { cleanup } = await import("../src/cleanup.ts");
    const wsId = (await env.DB.prepare("SELECT id FROM workspace WHERE slug = 'team'").first<{ id: number }>())!.id;
    await env.DB.prepare("INSERT INTO session (id, user_id, created_at, expires_at) SELECT 'old-session', id, '2020-01-01', '2020-01-02' FROM app_user LIMIT 1").run();
    await env.DB.prepare("INSERT INTO invite (id, workspace_id, role, created_at, expires_at) VALUES ('old-invite', ?, 'viewer', '2020-01-01', '2020-01-08')").bind(wsId).run();
    await env.BLOBS.put(`ws/${wsId}/blobs/${"f".repeat(64)}`, "고아");
    const used = (await getJson(`${W}/docs/process/guide`)).versions[0].files[0].sha256;
    const r = await cleanup(env, Date.now() + 2 * 86400_000);
    expect(r.sessions).toBeGreaterThanOrEqual(1);
    expect(r.invites).toBeGreaterThanOrEqual(1);
    expect(await env.BLOBS.head(`ws/${wsId}/blobs/${"f".repeat(64)}`)).toBeNull();
    expect(await env.BLOBS.head(`ws/${wsId}/blobs/${used}`)).not.toBeNull();
    await env.BLOBS.put(`ws/${wsId}/blobs/${"e".repeat(64)}`, "방금");
    await cleanup(env);
    expect(await env.BLOBS.head(`ws/${wsId}/blobs/${"e".repeat(64)}`)).not.toBeNull();
  });
});
