// Cloudflare 화면 테스트(4.0 P3). 화면을 VITE_CLOUD=1로 빌드하고, 임시 저장소로 wrangler dev를 띄운 뒤,
// 로컬 화면 테스트와 같은 임시 docs를 가져오기 CLI로 워크스페이스 "team"에 넣고 전역 puppeteer로 조작한다.
// 확인은 파일 대신 Worker API로 한다. puppeteer가 없으면 건너뛴다.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, execSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { freePort, makeWorkspace, waitFor } from "../../../site/test/helpers.ts";

const WORKER = resolve(import.meta.dirname, "..");
const ROOT = resolve(WORKER, "../..");
const PUPPETEER = (() => {
  try { return join(execSync("npm root -g", { encoding: "utf8" }).trim(), "@mermaid-js/mermaid-cli/node_modules/puppeteer"); } catch { return ""; }
})();
const skip = !PUPPETEER || !existsSync(PUPPETEER) ? "puppeteer 없음(npm i -g @mermaid-js/mermaid-cli)" : false;

const ws = makeWorkspace();
const persist = mkdtempSync(join(tmpdir(), "workflow-cf-"));
let wrangler: ChildProcess;
let BASE = "";
let browser: any;
let page: any;

/** 다른 곳(다른 사람·Claude Code)에서 바꾸는 것처럼 Worker API를 직접 부른다. 세션은 브라우저 쿠키, Origin은 앱 */
const post = async (path: string, body: BodyInit, headers: Record<string, string> = {}) => {
  const cookie = (await page.cookies(BASE)).map((c: { name: string; value: string }) => `${c.name}=${c.value}`).join("; ");
  return fetch(`${BASE}/api/w/team${path}`, { method: "POST", headers: { cookie, origin: BASE, ...headers }, body });
};

/** Worker API로 확인. 브라우저의 로그인 세션 쿠키를 그대로 쓴다 */
async function api<T = any>(path: string): Promise<T>;
async function api(path: string, raw: true): Promise<Response>;
async function api(path: string, raw?: boolean) {
  const cookie = (await page.cookies(BASE)).map((c: { name: string; value: string }) => `${c.name}=${c.value}`).join("; ");
  const res = await fetch(`${BASE}/api/w/team${path}`, { headers: { cookie } });
  return raw ? res : res.json();
}
const nav = (path: string) => page.goto(BASE + path, { waitUntil: "domcontentloaded", timeout: 15_000 });
async function open(path: string, title: string) {
  await nav(path);
  await page.waitForFunction((t: string) => document.querySelector("h1")?.textContent?.includes(t), { timeout: 15_000 }, title);
}
async function clickConfirm(label: string) {
  await page.waitForSelector("dialog[open] #confirm-title", { timeout: 5000 });
  await new Promise((r) => setTimeout(r, 120));
  // 다른 대화상자(휴지통 등) 위에 뜬 확인 창 안에서만 찾는다
  for (const b of await page.$$("dialog[open]:has(#confirm-title) button")) if ((await b.evaluate((e: Element) => e.textContent)).includes(label)) return b.click();
  throw new Error(`확인 창에 ${label} 버튼이 없습니다`);
}
async function clickText(label: string, scope = "dialog[open]") {
  for (const b of await page.$$(`${scope} button`)) if ((await b.evaluate((e: Element) => e.textContent)).trim() === label) return b.click();
  throw new Error(`${label} 버튼 없음`);
}
const rowMenu = async (key: string, item: string) => {
  const row = await page.waitForSelector(`[data-row="${key}"]`);
  await row.evaluate((el: Element) => {
    const r = el.getBoundingClientRect();
    el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: r.left + 40, clientY: r.bottom }));
  });
  await page.waitForSelector('[role="menu"]');
  for (const b of await page.$$('[role="menuitem"]')) if ((await b.evaluate((e: Element) => e.textContent)).trim() === item) return b.click();
  throw new Error(`메뉴에 ${item} 없음`);
};

describe("Cloudflare 화면", { skip }, () => {
  before(async () => {
    execSync("npm run build:web", { cwd: WORKER, stdio: "ignore" });
    execSync(`npx wrangler d1 migrations apply workflow --local --persist-to ${persist}`, { cwd: WORKER, stdio: "ignore" });
    const port = await freePort();
    BASE = `http://127.0.0.1:${port}`;
    // 변환(PPTX)·draw.io 문서
    const { addFixtureDoc } = await import("../../../site/test/helpers.ts");
    addFixtureDoc(ws.docs, "notes", "slides", "sample-slides.pptx", "pptx");
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(join(ws.docs, "notes/flow/v0.0"), { recursive: true });
    writeFileSync(join(ws.docs, "notes/flow/v0.0/flow.drawio"), '<mxfile><diagram name="p1"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="2" value="시작" vertex="1" parent="1"><mxGeometry x="10" y="10" width="80" height="40" as="geometry"/></mxCell></root></mxGraphModel></diagram></mxfile>');
    writeFileSync(join(ws.docs, "notes/flow/meta.yaml"), "title: 흐름도\ncategory: sdlc\nmenu: notes\nkind: drawio\nstatus: draft\ncurrent: v0.0\nversions:\n  - version: v0.0\n    entry: flow.drawio\n");
    // 운영처럼 앱과 사용자 콘텐츠의 출처를 나눈다: 앱 127.0.0.1, 콘텐츠 localhost(같은 포트, 호스트로 나눔)
    wrangler = spawn("npx", ["wrangler", "dev", "--port", String(port), "--ip", "127.0.0.1", "--persist-to", persist,
      "--var", `APP_ORIGIN:${BASE}`, "--var", `FILES_ORIGIN:http://localhost:${port}`], {
      cwd: WORKER, stdio: "ignore", detached: true,
    });
    await waitFor(async () => (await fetch(BASE + "/api/health")).ok, 60_000, "wrangler dev 시작");
    execFileSync(process.execPath, [join(ROOT, "node_modules/tsx/dist/cli.mjs"), "packages/cli/src/import.ts",
      "--url", BASE, "--token", "dev-admin-token", "--ws", "team", "--name", "팀", "--docs", ws.docs, "--owner", "owner@example.com"], { cwd: ROOT, stdio: "ignore" });
    const puppeteer = createRequire(import.meta.url)(PUPPETEER);
    browser = await puppeteer.launch();
    page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 900 });
    // 로그인 전에는 로그인 화면. 개발용 로그인(.dev.vars DEV_LOGIN=1)으로 owner가 들어간다(TC-CFUI-06)
    await nav("/");
    await page.waitForSelector('input[aria-label="개발용 이메일"]', { timeout: 15_000 });
    assert.ok(await page.$('a[href^="/api/auth/google"]'), "Google 로그인 버튼");
    await page.type('input[aria-label="개발용 이메일"]', "owner@example.com");
    await clickText("개발용 로그인", "form");
    await page.waitForFunction(() => location.pathname.startsWith("/team/"), { timeout: 15_000 });
  });

  after(async () => {
    await browser?.close();
    if (wrangler?.pid) try { process.kill(-wrangler.pid, "SIGTERM"); } catch { /* 이미 종료 */ }
    ws.cleanup();
    rmSync(persist, { recursive: true, force: true });
  });

  test("TC-CFUI-06 로그인 화면(Google·개발용) → 로그인하면 내 워크스페이스로, 계정 메뉴에 멤버 관리·로그아웃", async () => {
    await nav("/");
    await page.waitForFunction(() => location.pathname.startsWith("/team/"), { timeout: 15_000 });
    await (await page.waitForSelector('button[aria-label="계정 메뉴"]')).click();
    const items = await page.$$eval('[role="menuitem"]', (els: Element[]) => els.map((e) => e.textContent?.trim()));
    assert.deepEqual(items, ["멤버·초대 관리", "로그아웃"]);
    await page.keyboard.press("Escape");
  });

  test("TC-CFUI-07 초대 링크를 만들어 다른 브라우저(로그인 전)에서 열면 로그인 후 그 워크스페이스로, viewer는 편집 버튼이 없다", async () => {
    await open("/team/sdlc/process/guide", "샘플 프로세스 가이드");
    await page.click('button[aria-label="계정 메뉴"]');
    for (const b of await page.$$('[role="menuitem"]')) if ((await b.evaluate((e: Element) => e.textContent)).includes("멤버·초대")) await b.click();
    await page.waitForSelector('select[aria-label="초대 역할"]');
    await page.select('select[aria-label="초대 역할"]', "viewer");
    await clickText("초대 링크 만들기");
    const url = await (await page.waitForSelector('[aria-label="만든 초대 링크"]')).evaluate((e: Element) => e.textContent);
    assert.match(url, /\/api\/invites\/[\w-]+$/);
    await page.keyboard.press("Escape");

    const ctx = await browser.createBrowserContext();
    const guest = await ctx.newPage();
    await guest.goto(url, { waitUntil: "domcontentloaded" });
    await guest.waitForSelector('input[aria-label="개발용 이메일"]', { timeout: 15_000 });
    await guest.type('input[aria-label="개발용 이메일"]', "guest@example.com");
    for (const b of await guest.$$("form button")) if ((await b.evaluate((e: Element) => e.textContent)).includes("개발용 로그인")) await b.click();
    await guest.waitForFunction(() => location.pathname.startsWith("/team/") && document.querySelector("nav a"), { timeout: 15_000 });
    await guest.goto(BASE + "/team/sdlc/process/guide", { waitUntil: "domcontentloaded" });
    await guest.waitForFunction(() => document.querySelector("h1")?.textContent?.includes("샘플 프로세스 가이드"), { timeout: 15_000 });
    assert.equal(await guest.$('button[aria-label="업로드"]'), null, "viewer는 업로드 버튼 없음");
    assert.equal(await guest.$('button[aria-label="텍스트 편집"]'), null);
    assert.equal(await guest.$('button[aria-label="폴더 추가"]'), null);
    assert.equal(await guest.$('button[aria-label="대분류 추가"]'), null);
    await ctx.close();
  });

  test("TC-CFUI-08 실시간: 다른 곳에서 새 버전을 올리면 새로 고치지 않아도 보이고(WebSocket), focus는 열린 화면을 그 문서로 옮긴다", async () => {
    await open("/team/sdlc/notes/minutes", "주간 회의록");
    await new Promise((r) => setTimeout(r, 500)); // WebSocket 연결
    const form = new FormData();
    form.append("menu", "notes");
    form.append("title", "실시간으로 생긴 문서");
    form.append("slug", "live-new");
    form.append("paths", JSON.stringify(["live.md"]));
    form.append("files", new File(["# 실시간"], "live.md"));
    assert.equal((await post("/upload", form)).status, 200);
    await page.waitForSelector('[data-row="d:notes/live-new"]', { timeout: 10_000 });
    const r = await (await post("/focus", JSON.stringify({ menu: "process", doc: "guide" }), { "content-type": "application/json", "x-workflow-agent": "claude-code" })).json() as { clients: number };
    assert.ok(r.clients >= 1);
    await page.waitForFunction(() => location.pathname === "/team/sdlc/process/guide", { timeout: 10_000 });
  });

  test("TC-CFUI-09 Markdown은 콘텐츠 도메인에서 fetch로 읽어(CORS) 그리고, PPTX는 변환 컨테이너 PDF, draw.io는 draw.io 뷰어로 연다", async () => {
    await open("/team/sdlc/notes/minutes", "주간 회의록");
    await page.waitForFunction(() => document.querySelector(".mf-preview h1")?.textContent === "회의록", { timeout: 10_000 });
    await open("/team/sdlc/notes/flow", "흐름도");
    const flow = await (await page.waitForSelector('iframe[title="draw.io 다이어그램"]')).evaluate((f: HTMLIFrameElement) => f.src);
    assert.match(flow, /^https:\/\/viewer\.diagrams\.net\/.*#R%3Cmxfile/);
    await open("/team/sdlc/notes/slides", "slides 샘플");
    const pdf = await (await page.waitForSelector("main iframe, main embed, main object")).evaluate((e: Element) => e.getAttribute("src") ?? e.getAttribute("data"));
    assert.match(pdf, /\/api\/w\/team\/convert\/pdf\/[0-9a-f]{64}/);
    const res = await api(pdf.replace(/^.*\/api\/w\/team/, "").replace(/#.*$/, ""), true);
    assert.equal(res.status, 200, "변환 컨테이너(로컬 Docker)");
    assert.equal(res.headers.get("content-type"), "application/pdf");
  });

  test("TC-CFUI-10 내보내기 → 가져오기 왕복: 내보낸 zip을 풀어 가져오기 CLI로 새 워크스페이스에 넣으면 트리와 파일(sha256)이 같다", async () => {
    const res = await api("/export", true);
    assert.equal(res.status, 200);
    const { unzipSync } = await import("fflate");
    const out = mkdtempSync(join(tmpdir(), "workflow-export-"));
    const { mkdirSync: mk, writeFileSync: wf } = await import("node:fs");
    for (const [name, data] of Object.entries(unzipSync(new Uint8Array(await res.arrayBuffer())))) {
      mk(join(out, name, ".."), { recursive: true });
      wf(join(out, name), data);
    }
    execFileSync(process.execPath, [join(ROOT, "node_modules/tsx/dist/cli.mjs"), "packages/cli/src/import.ts",
      "--url", BASE, "--token", "dev-admin-token", "--ws", "copy", "--name", "복사", "--docs", join(out, "docs"), "--owner", "owner@example.com"], { cwd: ROOT, stdio: "ignore" });
    const cookie = (await page.cookies(BASE)).map((c: { name: string; value: string }) => `${c.name}=${c.value}`).join("; ");
    const get = async (ws: string, path: string) => (await fetch(`${BASE}/api/w/${ws}${path}`, { headers: { cookie } })).json() as Promise<any>;
    const [a, b] = [await get("team", "/tree"), await get("copy", "/tree")];
    assert.deepEqual(b.categories, a.categories);
    const docs = (t: any) => t.categories.flatMap((c: any) => { const w = (ms: any[]): any[] => ms.flatMap((m) => [...m.documents, ...w(m.menus)]); return w(c.menus); });
    for (const d of docs(a)) {
      const [x, y] = [await get("team", `/docs/${d.menuSlug}/${d.slug}`), await get("copy", `/docs/${d.menuSlug}/${d.slug}`)];
      const strip = (v: any) => v.versions.map((ver: any) => [ver.version, ver.note, ver.source, ver.createdAt, ver.files.map((f: any) => [f.path, f.sha256, f.isEntry])]);
      assert.deepEqual(strip(y), strip(x), `${d.menuSlug}/${d.slug}`);
      assert.deepEqual([y.title, y.status, y.currentVersion, y.parentSlug], [x.title, x.status, x.currentVersion, x.parentSlug]);
    }
    rmSync(out, { recursive: true, force: true });
  });

  test("TC-CFUI-01 / 는 워크스페이스로 가고, HTML 문서는 콘텐츠 주소(/c/)의 sandbox iframe으로 열려 상대 경로 CSS까지 읽는다", async () => {
    await nav("/");
    await page.waitForFunction(() => location.pathname.startsWith("/team/") && document.querySelector('[data-row="d:process/guide"]'), { timeout: 15_000 });
    await open("/team/sdlc/process/guide", "샘플 프로세스 가이드");
    const frame = await page.waitForSelector("main iframe");
    const [src, sandbox] = await frame.evaluate((f: HTMLIFrameElement) => [f.src, f.getAttribute("sandbox")]);
    assert.match(src, /^http:\/\/localhost:\d+\/c\/\d+\.\d+\.[\w-]+\/process\/guide\/v0\.0\/guide\.html/, "콘텐츠 도메인에서 연다");
    assert.doesNotMatch(sandbox, /allow-same-origin/);
    const doc = await frame.contentFrame();
    await doc.waitForFunction(() => document.querySelector("h1")?.textContent === "샘플 프로세스 문서", { timeout: 10_000 });
    await doc.waitForFunction(() => getComputedStyle(document.body).color === "rgb(0, 0, 0)", { timeout: 10_000 });
  });

  test("TC-CFUI-02 HTML 텍스트 편집: 조각을 고쳐 저장하면 새 버전(text-edit)", async () => {
    await open("/team/sdlc/process/guide", "샘플 프로세스 가이드");
    await page.click('button[aria-label="텍스트 편집"]');
    const frame = await (await page.waitForSelector('iframe[title="텍스트 편집"]')).contentFrame();
    await frame.waitForSelector("span[data-seg][contenteditable]", { timeout: 20_000 });
    await frame.evaluate(() => {
      const el = [...document.querySelectorAll<HTMLElement>("span[data-seg]")].find((s) => s.textContent === "D7")!;
      el.focus();
      const r = document.createRange(); r.selectNodeContents(el);
      const sel = getSelection()!; sel.removeAllRanges(); sel.addRange(r);
    });
    await page.keyboard.type("D8");
    await page.waitForFunction(() => document.body.innerText.includes("변경 1건"), { timeout: 5000 });
    await page.click('button[aria-label="저장 (새 버전)"]');
    await clickConfirm("저장");
    await page.waitForFunction(() => document.body.innerText.includes("버전으로 저장했습니다"), { timeout: 10_000 });
    const d = await api("/docs/process/guide");
    assert.equal(d.currentVersion, "v0.1");
    assert.equal(d.versions[1].source, "text-edit");
    assert.match(await (await fetch(d.versions[1].files.find((f: any) => f.isEntry).url)).text(), /<strong>D8<\/strong>/);
  });

  test("TC-CFUI-03 새 Markdown 문서를 만들고, 이미지를 올리고(앱 API → R2, 설정 창 없음), 저장하면 새 버전", async () => {
    await open("/team/sdlc/process/guide", "샘플 프로세스 가이드");
    await page.click('button[aria-label="업로드"]');
    await page.waitForSelector("dialog[open]");
    await clickText("새 Markdown 문서");
    const selects = await page.$$("dialog[open] select");
    await selects[1].select("notes");
    await page.type('dialog[open] input[placeholder="예: 로그인 시퀀스 다이어그램"]', "Cloud Memo");
    await clickText("만들고 편집하기");
    await clickConfirm("만들기");
    await page.waitForFunction(() => location.pathname === "/team/sdlc/notes/cloud-memo", { timeout: 10_000 });
    await page.waitForFunction(() => document.activeElement?.closest(".cm-editor"), { timeout: 10_000 });
    assert.equal(await page.$('button[aria-label="이미지 업로드 설정"]'), null);
    await page.keyboard.type("본문\n");
    const input = await page.$('input[type="file"][accept^="image"]');
    const png = join(persist, "dot.png");
    execSync(`printf '\\x89PNG\\r\\n\\x1a\\n' > ${png}`);
    await input.uploadFile(png);
    await page.waitForFunction(() => /!\[dot\.png\]\(http:\/\/localhost:\d+\/i\/\d+\/[\w.-]+\.png\)/.test(document.querySelector(".cm-content")?.textContent ?? ""), { timeout: 10_000 });
    await page.click('button[aria-label="저장 (새 버전)"]');
    await clickConfirm("저장");
    await waitFor(async () => (await api("/docs/notes/cloud-memo")).currentVersion === "v0.1", 10_000, "Markdown 저장");
    const d = await api("/docs/notes/cloud-memo");
    const md = await (await fetch(d.versions[1].files[0].url)).text();
    // 편집기 이미지는 콘텐츠 도메인(/i/) 주소로 들어간다
    assert.match(md, /^# Cloud Memo\n\n본문\n!\[dot\.png\]\(http:\/\/localhost:\d+\/i\//);
    const img = md.match(/\((http[^)]+)\)/)![1];
    assert.equal((await fetch(img)).headers.get("content-type"), "image/png");
  });

  test("TC-CFUI-04 사이드바 폴더 추가(한글 이름, slug 자동)·문서 휴지통·복원·폴더 삭제(이름 입력)", async () => {
    await open("/team/sdlc/notes/minutes", "주간 회의록");
    await page.click('button[aria-label="폴더 추가"]');
    await page.type('input[aria-label="새 폴더 이름"]', "클라우드 폴더");
    await page.keyboard.press("Enter");
    await clickConfirm("추가");
    const slug = await waitFor(async () => {
      const t = await api("/tree");
      return t.categories[0].menus.find((m: any) => m.name === "클라우드 폴더")?.slug as string | undefined;
    }, 10_000, "폴더 추가");
    assert.match(slug, /^folder-[a-z0-9]+$/);

    await rowMenu("d:notes/minutes", "휴지통으로");
    await clickConfirm("휴지통");
    await waitFor(async () => (await api("/trash")).some((t: any) => t.doc === "minutes"), 10_000, "휴지통 이동");
    await clickText("휴지통", "aside footer");
    await page.waitForFunction(() => document.querySelector("dialog[open]")?.textContent?.includes("주간 회의록"), { timeout: 10_000 });
    await clickText("복원");
    await clickConfirm("복원");
    await waitFor(async () => (await api("/tree")).categories[0].menus.find((m: any) => m.slug === "notes").documents.some((d: any) => d.slug === "minutes"), 10_000, "복원");

    await page.waitForSelector("dialog[open]", { hidden: true });
    await rowMenu(`m:${slug}`, "폴더 삭제");
    await page.waitForSelector('input[aria-label="삭제할 폴더 이름"]');
    await page.type('input[aria-label="삭제할 폴더 이름"]', "클라우드 폴더");
    await clickText("삭제");
    await waitFor(async () => !(await api("/tree")).categories[0].menus.some((m: any) => m.slug === slug), 10_000, "폴더 삭제");
  });

  test("TC-CFUI-05 검색창으로 본문을 찾고, 상태 배지로 v1.0 확정", async () => {
    await open("/team/sdlc/process/guide", "샘플 프로세스 가이드");
    await page.type('input[aria-label="문서 검색"]', "배포");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => [...document.querySelectorAll("a, button, li")].some((e) => e.textContent?.includes("샘플 프로세스 가이드") && e.textContent?.includes("배포")), { timeout: 10_000 });
    await open("/team/sdlc/process/guide", "샘플 프로세스 가이드");
    await page.click('button[aria-label^="draft 상태. 정식 버전 v1.0"]');
    await clickConfirm("v1.0으로 변경");
    await waitFor(async () => (await api("/docs/process/guide")).currentVersion === "v1.0", 10_000, "정식 확정");
    assert.equal((await api("/docs/process/guide")).status, "approved");
  });
});
