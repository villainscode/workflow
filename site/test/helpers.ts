// 테스트 공통 도구. 실제 docs/와 사이트 색인을 건드리지 않도록 임시 폴더에 docs를 만들고 서버를 따로 띄운다.
import { spawn, type ChildProcess } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const SITE = resolve(import.meta.dirname, "..");
export const FIXTURES = join(SITE, "scripts/fixtures");
export const TSX = join(SITE, "node_modules/tsx/dist/cli.mjs");

export const HTML_DOC = `<!doctype html>
<html lang="ko">
<head><meta charset="utf-8"><title>샘플 문서</title><link rel="stylesheet" href="style.css"></head>
<body>
  <h1>샘플 프로세스 문서</h1>
  <p>코드 리뷰는 <strong>D7</strong>에 처음 한다.</p>
  <p>배포는 D14에 한다. &amp; 기호와 &nbsp;공백을 지킨다.</p>
  <pre>첫 줄
  둘째 줄</pre>
  <svg viewBox="0 0 100 20"><title>그림 설명</title><text x="0" y="10">게이트 판정</text></svg>
  <script>document.title = "스크립트";</script>
</body>
</html>
`;

export const MD_DOC = "# 회의록\n\n- 리뷰 담당 정하기\n";

/** 임시 작업 폴더: <tmp>/docs(원본) + <tmp>/data(색인). 대분류 2개, 메뉴 3개, 문서 2개(HTML·Markdown) */
export function makeWorkspace() {
  const root = mkdtempSync(join(tmpdir(), "workflow-test-"));
  const docs = join(root, "docs");
  mkdirSync(join(docs, "_site"), { recursive: true });
  writeFileSync(join(docs, "_site/categories.yaml"),
    "# 상단 메뉴 주석\ncategories:\n  - key: sdlc\n    name: SDLC\n  - key: agent\n    name: Agent\n");
  writeFileSync(join(docs, "_site/menus.yaml"),
    "# 메뉴 트리 주석\nmenus:\n  sdlc:\n    - slug: process\n      name: 개발 프로세스\n      menus:\n        - slug: review\n          name: 코드 리뷰\n    - slug: notes\n      name: 회의록\n  agent: []\n");
  const doc = (menu: string, slug: string, title: string, kind: string, entry: string, body: string) => {
    const dir = join(docs, menu, slug, "v0.0");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, entry), body);
    writeFileSync(join(docs, menu, slug, "meta.yaml"),
      `# 문서 주석\ntitle: ${title}\ncategory: sdlc\nmenu: ${menu}\nkind: ${kind}\nstatus: draft\ncurrent: v0.0\nversions:\n  - version: v0.0\n    entry: ${entry}\n    note: 최초 작성\n    source: upload\n    created: 2026-10-01\nnotion_url:\ngdrive_url:\n`);
    return dir;
  };
  const htmlDir = doc("process", "guide", "샘플 프로세스 가이드", "html", "guide.html", HTML_DOC);
  writeFileSync(join(htmlDir, "style.css"), "body{color:black}");
  doc("notes", "minutes", "주간 회의록", "markdown", "minutes.md", MD_DOC);
  return { root, docs, data: join(root, "data"), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** 오피스 샘플(scripts/fixtures)을 문서로 넣는다 */
export function addFixtureDoc(docs: string, menu: string, slug: string, fixture: string, kind: string) {
  const dir = join(docs, menu, slug, "v0.0");
  mkdirSync(dir, { recursive: true });
  cpSync(join(FIXTURES, fixture), join(dir, fixture));
  writeFileSync(join(docs, menu, slug, "meta.yaml"),
    `title: ${slug} 샘플\ncategory: sdlc\nmenu: ${menu}\nkind: ${kind}\nstatus: draft\ncurrent: v0.0\nversions:\n  - version: v0.0\n    entry: ${fixture}\n    source: upload\n    created: 2026-10-01\n`);
}

export async function freePort(): Promise<number> {
  return new Promise((ok) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => ok(p)); });
  });
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function waitFor<T>(fn: () => Promise<T | undefined | false>, ms = 15_000, label = "조건"): Promise<T> {
  const until = Date.now() + ms;
  let last: unknown;
  while (Date.now() < until) {
    try { const v = await fn(); if (v) return v; } catch (e) { last = e; }
    await sleep(100);
  }
  throw new Error(`${label}을(를) ${ms}ms 안에 만족하지 못했습니다 ${last ? String(last) : ""}`);
}

export interface TestServer { url: string; port: number; proc: ChildProcess; stop: () => Promise<void> }

/** 사이트 API 서버를 임시 docs로 띄운다 */
export async function startServer(ws: { docs: string; data: string }): Promise<TestServer> {
  const port = await freePort();
  const proc = spawn(process.execPath, [TSX, "server/index.ts"], {
    cwd: SITE, env: { ...process.env, PORT: String(port), WORKFLOW_DOCS_ROOT: ws.docs, WORKFLOW_DATA_DIR: ws.data },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let err = "";
  proc.stderr!.on("data", (d) => { err += d; });
  const url = `http://127.0.0.1:${port}`;
  await waitFor(async () => (await fetch(url + "/api/tree")).ok, 20_000, `서버 시작(${err.slice(-500)})`);
  return {
    url, port, proc,
    stop: () => new Promise((ok) => { if (proc.exitCode !== null) return ok(); proc.once("exit", () => ok()); proc.kill("SIGTERM"); }),
  };
}

/** JSON API 호출. 상태 코드와 본문을 함께 돌려준다 */
export async function call<T = any>(base: string, method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
  const res = await fetch(base + path, body === undefined ? { method } : {
    method, headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: unknown = text;
  try { parsed = JSON.parse(text); } catch { /* 텍스트 응답 */ }
  return { status: res.status, body: parsed as T };
}

/** multipart 업로드. files: [상대 경로, 내용] */
export async function upload(base: string, fields: Record<string, string>, files: [string, string | Uint8Array][]) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  form.append("paths", JSON.stringify(files.map(([p]) => p)));
  for (const [p, d] of files) form.append("files", new Blob([typeof d === "string" ? d : new Uint8Array(d)]), p.split("/").pop());
  const res = await fetch(base + "/api/upload", { method: "POST", body: form });
  return { status: res.status, body: (await res.json()) as any };
}

export const readText = (p: string) => readFileSync(p, "utf8");

/** SSE(/api/events)를 열어 두고, 조건에 맞는 이벤트를 기다린다 */
export async function openEvents(base: string) {
  const ctrl = new AbortController();
  const res = await fetch(`${base}/api/events`, { signal: ctrl.signal });
  const reader = res.body!.getReader();
  const events: any[] = [];
  let buf = "";
  void (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += new TextDecoder().decode(value);
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
          const line = chunk.split("\n").find((l) => l.startsWith("data: "));
          if (line) events.push(JSON.parse(line.slice(6)));
        }
      }
    } catch { /* 닫힘 */ }
  })();
  return {
    events,
    next: (pred: (e: any) => boolean, ms = 5000) => waitFor(async () => events.find(pred), ms, "SSE 이벤트"),
    close: () => ctrl.abort(),
  };
}
