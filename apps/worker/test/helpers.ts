import { exports } from "cloudflare:workers";

export const BASE = "http://app.test";
export const ADMIN = { authorization: "Bearer test-admin", "content-type": "application/json" };

/** 지금 로그인한 사람의 세션 쿠키. seed()가 owner로 로그인해 둔다 */
let session = "";
export const useSession = (cookie: string) => { session = cookie; };
export const sessionCookie = () => session;

/** 앱 API 호출. 세션 쿠키를 붙이고, 상태를 바꾸는 요청에는 앱 Origin을 붙인다(CSRF 검사). init.headers로 덮어쓸 수 있다 */
export const call = (path: string, init: RequestInit = {}) => {
  const headers = new Headers(init.headers);
  if (session && !headers.has("cookie")) headers.set("cookie", session);
  if (init.method && init.method !== "GET" && !headers.has("origin")) headers.set("origin", BASE);
  return exports.default.fetch(new Request(BASE + path, { ...init, headers, redirect: "manual" }));
};

/** 개발용 로그인으로 세션 쿠키를 얻는다. cookie를 주면 그 쿠키(초대 등)를 함께 보낸다 */
export async function login(email: string, cookie = "") {
  const res = await exports.default.fetch(new Request(BASE + "/api/auth/dev-login", {
    method: "POST", headers: { origin: BASE, "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: JSON.stringify({ email }), redirect: "manual",
  }));
  const set = res.headers.getSetCookie().find((c) => c.startsWith("wf_session="));
  return { res, cookie: set ? set.split(";")[0] : "" };
}

/** 워크스페이스에 멤버를 바로 넣는다(초대 흐름은 auth 테스트에서 따로 본다) */
export async function addMember(ws: string, email: string, role: "owner" | "editor" | "viewer") {
  const { env } = await import("cloudflare:workers");
  const now = new Date().toISOString();
  await env.DB.prepare("INSERT INTO app_user (email, created_at) VALUES (?, ?) ON CONFLICT (email) DO NOTHING").bind(email, now).run();
  await env.DB.prepare(`INSERT INTO member (workspace_id, user_id, role, created_at)
    SELECT w.id, u.id, ?, ? FROM workspace w, app_user u WHERE w.slug = ? AND u.email = ?
    ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = excluded.role`).bind(role, now, ws, email).run();
}
export const admin = (method: string, path: string, body?: unknown) =>
  call("/api/admin" + path, { method, headers: { ...ADMIN, cookie: "" }, body: body === undefined ? undefined : JSON.stringify(body) });

const enc = new TextEncoder();
export async function sha256(data: Uint8Array): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", data))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export interface FileIn { path: string; body: string | Uint8Array; mime?: string }

/** 가져오기 API로 문서 하나를 올린다(blob 먼저) */
export async function importDoc(ws: string, doc: {
  menu: string; slug: string; parent?: string; title: string; kind?: string; order?: number; status?: string;
  versions: { version: string; entry: string; note?: string; files: FileIn[] }[]; search?: string;
}) {
  const versions = [];
  for (const v of doc.versions) {
    const files = [];
    for (const f of v.files) {
      const data = typeof f.body === "string" ? enc.encode(f.body) : f.body;
      const sha = await sha256(data);
      const put = await call(`/api/admin/w/${ws}/blobs/${sha}`, { method: "PUT", headers: { authorization: ADMIN.authorization }, body: data });
      if (!put.ok) throw new Error(`blob ${put.status}`);
      files.push({ path: f.path, size: data.byteLength, sha256: sha, mime: f.mime });
    }
    versions.push({ version: v.version, entry: v.entry, note: v.note, files });
  }
  const res = await admin("POST", `/w/${ws}/docs`, {
    kind: "html", status: "draft", ...doc, current: doc.versions[doc.versions.length - 1].version, versions,
  });
  if (!res.ok) throw new Error(`doc ${res.status} ${await res.text()}`);
  return res.json<{ id: number }>();
}

/** 테스트 워크스페이스: 대분류 2개, 메뉴 트리(하위 메뉴), 문서·하위 문서·상대 링크가 있는 HTML */
export async function seed(ws = "team") {
  await admin("POST", "/workspaces", { slug: ws, name: `${ws} 팀`, reset: true });
  await addMember(ws, "owner@test.com", "owner");
  useSession((await login("owner@test.com")).cookie);
  await admin("POST", `/w/${ws}/site`, {
    categories: [
      { key: "sdlc", name: "SDLC", menus: [{ slug: "process", name: "프로세스", menus: [{ slug: "notes", name: "메모" }] }] },
      { key: "agent", name: "Agent", menus: [] },
    ],
  });
  await importDoc(ws, {
    menu: "process", slug: "guide", title: "가이드", order: 1,
    versions: [
      { version: "v0.0", entry: "guide.html", files: [{ path: "guide.html", body: "<p>첫 판</p>" }] },
      { version: "v0.1", entry: "guide.html", note: "그림 추가", files: [
        { path: "guide.html", body: '<p>둘째 판</p><img src="img/a.png"><a href="../../../notes/memo/v0.0/memo.md">메모</a>' },
        { path: "img/a.png", body: new Uint8Array([137, 80, 78, 71]) },
      ] },
    ],
    search: "둘째 판 메모",
  });
  await importDoc(ws, { menu: "process", slug: "child", parent: "guide", title: "하위", versions: [
    { version: "v0.0", entry: "child.html", files: [{ path: "child.html", body: "<p>하위 문서</p>" }] }] });
  await importDoc(ws, { menu: "process", slug: "alpha", title: "알파", versions: [
    { version: "v0.0", entry: "alpha.md", files: [{ path: "alpha.md", body: "# 알파" }] }] });
  await importDoc(ws, { menu: "notes", slug: "memo", title: "메모", kind: "markdown", versions: [
    { version: "v0.0", entry: "memo.md", files: [{ path: "memo.md", body: "# 메모" }] }] });
}

/** 업로드 API(multipart). files: [경로, 내용] */
export async function upload(ws: string, fields: Record<string, string | undefined>, files: [string, string | Uint8Array][]) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) form.append(k, v);
  form.append("paths", JSON.stringify(files.map(([p]) => p)));
  for (const [p, body] of files) form.append("files", new File([typeof body === "string" ? new TextEncoder().encode(body) : body], p.split("/").pop()!));
  return call(`/api/w/${ws}/upload`, { method: "POST", body: form });
}

export const json = (method: string, path: string, body?: unknown) =>
  call(path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

export const getJson = async <T = any>(path: string) => (await call(path)).json<T>();
