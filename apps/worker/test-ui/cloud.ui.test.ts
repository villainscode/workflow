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
    // 슬라이드 덱(5.0 M4): deck.json + slides/*.html
    mkdirSync(join(ws.docs, "notes/intro-deck/v0.0/slides"), { recursive: true });
    writeFileSync(join(ws.docs, "notes/intro-deck/v0.0/deck.json"), JSON.stringify({ v: 1, title: "팀 소개 덱", order: ["cover", "team"], palette: ["#1c2026", "#0e6b57"] }));
    writeFileSync(join(ws.docs, "notes/intro-deck/v0.0/slides/cover.html"), '<section id="cover" style="background:#1c2026;color:#f7f7f4;padding:128px;display:flex;flex-direction:column;justify-content:center;gap:32px"><h1>팀 소개</h1><p>2026년 10월</p><aside>인사부터</aside></section>');
    writeFileSync(join(ws.docs, "notes/intro-deck/v0.0/slides/team.html"), '<section id="team" style="padding:128px;display:flex;flex-direction:column;gap:48px"><h2>구성원</h2><table style="font-size:28px"><tr><th style="width:30%">이름</th><th style="width:70%">역할</th></tr><tr><td>가</td><td>리뷰 게이트</td></tr></table><p style="position:absolute;left:1400px;top:900px;width:400px;height:60px;font-size:24px">예시 이름</p></section>');
    writeFileSync(join(ws.docs, "notes/intro-deck/meta.yaml"), "title: 팀 소개 덱\ncategory: sdlc\nmenu: notes\nkind: deck\nstatus: draft\ncurrent: v0.0\nversions:\n  - version: v0.0\n    entry: deck.json\n");
    // PDF(5.0 M6): 폭이 다른 3쪽 + 양식 글자 칸
    {
      const { PDFDocument } = await import("pdf-lib");
      const pdf = await PDFDocument.create();
      for (const w of [600, 610, 620]) pdf.addPage([w, 800]);
      pdf.getForm().createTextField("name").addToPage(pdf.getPage(0), { x: 50, y: 600, width: 200, height: 24 });
      mkdirSync(join(ws.docs, "notes/form-pdf/v0.0"), { recursive: true });
      writeFileSync(join(ws.docs, "notes/form-pdf/v0.0/form.pdf"), await pdf.save());
      writeFileSync(join(ws.docs, "notes/form-pdf/meta.yaml"), "title: 신청서 PDF\ncategory: sdlc\nmenu: notes\nkind: pdf\nstatus: draft\ncurrent: v0.0\nversions:\n  - version: v0.0\n    entry: form.pdf\n");
    }
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

  test("TC-CFUI-13 슬라이드 덱 보기: 목록 썸네일, 1920×1080을 창에 맞춰 그리고, →로 다음 슬라이드·노트", async () => {
    await open("/team/sdlc/notes/intro-deck", "팀 소개 덱");
    await page.waitForSelector('ol[aria-label="슬라이드 목록"] li:nth-child(2)', { timeout: 15_000 });
    const main = await page.$$eval(".slide-root", (els: Element[]) => els.map((e) => e.getBoundingClientRect().width));
    assert.equal(main.length, 3, "썸네일 2 + 본문 1");
    assert.ok(await page.evaluate(() => document.body.innerText.includes("노트: 인사부터")));
    await page.focus('[aria-label="슬라이드 덱"]');
    await page.keyboard.press("ArrowRight");
    await page.waitForFunction(() => document.body.innerText.includes("2 / 2"), { timeout: 5000 });
    assert.ok(await page.evaluate(() => [...document.querySelectorAll(".slide-root th")].some((t) => t.textContent === "역할")));
  });

  test("TC-CFUI-14 슬라이드 편집: 한글 조합 입력 → Esc 확정 → 새로 고침 뒤 유지, 고정 요소 끌기(배율 반영), 표 열 넣기·손잡이 끌기(합 100), ⌘Z, 지워진 요소 409 알림, 버전으로 저장", async () => {
    const D = "/docs/notes/intro-deck";
    const openEditor = async () => {
      await open("/team/sdlc/notes/intro-deck", "팀 소개 덱");
      await page.click('button[aria-label="슬라이드 편집"]');
      await page.waitForSelector(".deck-edit-layer [data-eid]", { timeout: 20_000 });
    };
    const status = (t: string) => page.waitForFunction((x: string) => document.body.innerText.includes(x), { timeout: 15_000 }, t);
    const deck = () => api(`${D}/deck`);
    const slideHtml = async (id: string) => (await deck()).slides.find((s: any) => s.id === id).html as string;
    await openEditor();

    // 한글 조합 입력(IME 이벤트) → Esc로 확정 → 800ms 뒤 수정본
    await page.click('.deck-edit-layer [data-eid="e1"]', { count: 2 });
    await page.waitForSelector(".slide-text-editor.ProseMirror-focused");
    await page.evaluate(() => {
      const el = document.querySelector(".slide-text-editor")!;
      const r = document.createRange(); r.selectNodeContents(el);
      const sel = getSelection()!; sel.removeAllRanges(); sel.addRange(r);
    });
    const cdp = await page.createCDPSession();
    await cdp.send("Input.imeSetComposition", { text: "ㅎ", selectionStart: 1, selectionEnd: 1 });
    await cdp.send("Input.imeSetComposition", { text: "하", selectionStart: 1, selectionEnd: 1 });
    await cdp.send("Input.imeSetComposition", { text: "한", selectionStart: 1, selectionEnd: 1 });
    await cdp.send("Input.insertText", { text: "한" });
    await cdp.send("Input.imeSetComposition", { text: "그", selectionStart: 1, selectionEnd: 1 });
    await cdp.send("Input.imeSetComposition", { text: "글", selectionStart: 1, selectionEnd: 1 });
    await cdp.send("Input.insertText", { text: "글" });
    await cdp.send("Input.insertText", { text: " 입력" });
    await page.keyboard.press("Escape");
    await status("수정본 1");
    assert.match(await slideHtml("cover"), /<h1 data-eid="e1">한글 입력<\/h1>/);
    await openEditor();
    assert.equal(await page.$eval('.deck-edit-layer [data-eid="e1"]', (e: Element) => e.textContent), "한글 입력", "새로 고침 뒤에도 유지");

    // 두 번째 슬라이드: 고정 위치 글상자를 끌어 옮긴다(화면 이동량 ÷ 배율 = 캔버스 이동량, 맞춤선·격자 붙음 6px 안)
    await page.click('button[aria-label="2번 슬라이드 편집"]');
    await page.waitForSelector('.deck-edit-layer [data-eid="team"]');
    const pin = (await deck()).slides[1].html.match(/<p data-eid="(e\d+)" style="position:absolute/)[1];
    await page.click(`.deck-edit-layer [data-eid="${pin}"]`);
    await page.waitForSelector(".moveable-control-box");
    const scale = await page.$eval(".deck-edit-layer .slide-root", (e: Element) => e.getBoundingClientRect().width / 1920);
    const b = await page.$eval(`.deck-edit-layer [data-eid="${pin}"]`, (e: Element) => { const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
    await page.mouse.move(b.x, b.y);
    await page.mouse.down();
    for (let i = 1; i <= 10; i++) await page.mouse.move(b.x - 20 * i, b.y - 10 * i);
    await page.mouse.up();
    await status("수정본 2");
    const st = (await slideHtml("team")).match(new RegExp(`data-eid="${pin}" style="[^"]*left:(\\d+)px;top:(\\d+)px`));
    assert.ok(Math.abs(Number(st[1]) - (1400 - 200 / scale)) <= 6, `left ${st[1]} ≈ ${1400 - 200 / scale}`);
    assert.ok(Math.abs(Number(st[2]) - (900 - 100 / scale)) <= 6, `top ${st[2]} ≈ ${900 - 100 / scale}`);

    // 표: 머리 칸을 골라 오른쪽에 열 넣기 → 3열, 너비 합 100
    await page.click(".deck-edit-layer th");
    await clickText("오른쪽에 넣기", "aside");
    await status("수정본 3");
    const widths = (html: string) => [...html.matchAll(/<th data-eid="[^"]+" style="[^"]*width:([\d.]+)%/g)].map((m) => Number(m[1]));
    const w = widths(await slideHtml("team"));
    assert.equal(w.length, 3);
    assert.equal(Math.round(w.reduce((a, c) => a + c, 0)), 100);
    // 표를 고르고 첫 열 경계 손잡이를 오른쪽으로 끈다 → 이웃 두 열만 바뀌고 합 100
    await page.click('.deck-edit-layer table');
    await page.click('[aria-label="요소 경로"] button:last-child').catch(() => {});
    const tableEid = (await slideHtml("team")).match(/<table data-eid="(e\d+)"/)[1];
    await page.evaluate((e: string) => (document.querySelector(`.deck-edit-layer [data-eid="${e}"]`) as HTMLElement).dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })), tableEid);
    await page.waitForSelector("[data-col-handle]", { timeout: 5000 });
    const h = await page.$eval("[data-col-handle]", (e: Element) => { const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + 20 }; });
    await page.mouse.move(h.x, h.y);
    await page.mouse.down();
    await page.mouse.move(h.x + 40, h.y, { steps: 5 });
    await page.mouse.up();
    await status("수정본 4");
    const w2 = widths(await slideHtml("team"));
    assert.ok(w2[0] > w[0] && w2[1] < w[1] && w2[2] === w[2], JSON.stringify([w, w2]));
    assert.equal(Math.round(w2.reduce((a, c) => a + c, 0)), 100);
    // ⌘Z: 손잡이 끌기를 되돌린다
    await page.focus('[aria-label="슬라이드 편집 캔버스"]');
    await page.keyboard.down("Meta"); await page.keyboard.press("z"); await page.keyboard.up("Meta");
    await status("수정본 5");
    assert.deepEqual(widths(await slideHtml("team")), w, "끌기 전 너비로 돌아온다");

    // 다른 사람이 지운 요소를 고치면: 알림 + 최신본
    const cur = (await deck()).rev;
    const gone = (await slideHtml("team")).match(/<h2 data-eid="(e\d+)"/)[1];
    assert.equal((await post(`${D}/deck/slides/team`, JSON.stringify({ baseRev: cur, ops: [{ t: "remove", eid: gone }] }), { "content-type": "application/json" })).status, 200);
    await page.click(`.deck-edit-layer [data-eid="${gone}"]`, { count: 2 });
    await page.waitForSelector(".slide-text-editor.ProseMirror-focused");
    await page.keyboard.type("늦은 수정");
    await page.keyboard.press("Enter");
    await status("다른 사람이 지운 요소라 반영하지 못했습니다");
    await page.waitForFunction((e: string) => !document.querySelector(`.deck-edit-layer [data-eid="${e}"]`), { timeout: 10_000 }, gone);

    // 버전으로 저장
    const before = await api(D);
    await clickText("버전으로 저장", "body");
    await clickConfirm("버전으로 저장");
    await status("버전으로 저장했습니다");
    assert.equal((await api(D)).versions.length, before.versions.length + 1);
  });

  test("TC-CFUI-15 슬라이드에 그림 파일을 끌어 놓으면 자산으로 올라가 고정 위치 그림이 되고, 서명 주소로 그린다", async () => {
    await open("/team/sdlc/notes/intro-deck", "팀 소개 덱");
    await page.click('button[aria-label="슬라이드 편집"]');
    await page.waitForSelector(".deck-edit-layer [data-eid]", { timeout: 20_000 });
    const rev0 = (await api("/docs/notes/intro-deck/deck")).rev;
    await page.evaluate(async () => {
      // 4×2 빨간 PNG
      const c = document.createElement("canvas"); c.width = 400; c.height = 200;
      c.getContext("2d")!.fillStyle = "#c33"; c.getContext("2d")!.fillRect(0, 0, 400, 200);
      const blob: Blob = await new Promise((r) => c.toBlob((b) => r(b!), "image/png"));
      const dt = new DataTransfer();
      dt.items.add(new File([blob], "빨강.png", { type: "image/png" }));
      const target = document.querySelector('[aria-label="슬라이드 편집 캔버스"]')!;
      const r = document.querySelector(".deck-edit-layer .slide-root")!.getBoundingClientRect();
      target.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 }));
    });
    await page.waitForFunction((r: number) => document.body.innerText.includes(`수정본 ${r + 1}`), { timeout: 15_000 }, rev0);
    const html = (await api("/docs/notes/intro-deck/deck")).slides[0].html as string;
    const m = html.match(/<img data-eid="e\d+" src="asset:[0-9a-f]{64}" alt="빨강" style="position:absolute;left:(\d+)px;top:(\d+)px;width:400px;height:200px;object-fit:contain">/);
    assert.ok(m, html);
    // 놓은 자리(가운데)에 그림 가운데가 오도록. 화면 픽셀 반올림 몇 px는 허용
    assert.ok(Math.abs(Number(m[1]) - 760) <= 3 && Math.abs(Number(m[2]) - 440) <= 3, `${m[1]},${m[2]}`);
    const src = await page.waitForFunction(() => document.querySelector<HTMLImageElement>('.deck-edit-layer img[alt="빨강"]')?.src, { timeout: 10_000 });
    assert.match(await src.jsonValue(), /\/c\/[^/]+\/_asset\/[0-9a-f]{64}$/);
    assert.ok(await page.waitForFunction(() => (document.querySelector<HTMLImageElement>('.deck-edit-layer img[alt="빨강"]')?.naturalWidth ?? 0) === 400, { timeout: 10_000 }));
  });

  test("TC-CFUI-16 PDF 편집: 한글 글상자·형광펜을 적용하면 수정본(쓴 글자만 자른 글꼴), 쪽 돌리기·지우기, 한글 양식 채우기, 되돌리기, 버전으로 저장", async () => {
    const { PDFDocument, PDFName } = await import("pdf-lib");
    const D = "/docs/notes/form-pdf";
    const work = async () => {
      const w = await api(`${D}/work`);
      const f = w.files.find((x: any) => x.path === "form.pdf");
      return { rev: w.rev as number, pdf: await PDFDocument.load(new Uint8Array(await (await fetch(f.url)).arrayBuffer())) };
    };
    const status = (t: string) => page.waitForFunction((x: string) => document.body.innerText.includes(x), { timeout: 20_000 }, t);
    await open("/team/sdlc/notes/form-pdf", "신청서 PDF");
    await page.click('button[aria-label="PDF 편집"]');
    await page.waitForSelector('canvas[data-page="0"][data-rendered]', { timeout: 20_000 });

    // 글상자: 도구를 고르고 1쪽을 눌러 한글을 쓴다
    await page.click('button[aria-label="글상자 (쪽을 눌러 놓기)"]');
    const layer = await page.$('[data-layer="0"]');
    const b = await layer.boundingBox();
    await page.mouse.click(b.x + 60, b.y + 60);
    await page.waitForSelector('textarea[aria-label="글상자 글자"]');
    await page.keyboard.type("한글 메모");
    await page.keyboard.press("Escape");
    // 형광펜: 끌어서 칠한다
    await page.click('button[aria-label="형광펜 (끌어서 칠하기)"]');
    await page.mouse.move(b.x + 50, b.y + 120);
    await page.mouse.down();
    await page.mouse.move(b.x + 250, b.y + 140, { steps: 4 });
    await page.mouse.up();
    await clickText("적용 2", "body");
    await status("수정본 1");
    let w = await work();
    assert.equal(w.pdf.getPageCount(), 3);
    const fontFiles = w.pdf.context.enumerateIndirectObjects().filter(([, o]) => (o as any).get?.(PDFName.of("FontFile2")));
    assert.equal(fontFiles.length, 1, "한글 글꼴 하나");
    const ttf = w.pdf.context.lookup((fontFiles[0][1] as any).get(PDFName.of("FontFile2"))) as any;
    assert.ok(ttf.contents.length < 200_000, `잘린 글꼴 ${ttf.contents.length}B`);

    // 2쪽을 오른쪽으로 돌리고, 3쪽을 지운다(확인 창)
    await page.click('button[aria-label="2쪽"]');
    await page.click('button[aria-label="오른쪽으로 돌리기"]');
    await status("수정본 2");
    assert.equal((await work()).pdf.getPage(1).getRotation().angle, 90);
    await page.click('button[aria-label="3쪽"]');
    await page.click('button[aria-label="이 쪽 지우기"]');
    await clickConfirm("지우기");
    await status("수정본 3");
    w = await work();
    assert.deepEqual(w.pdf.getPages().map((p) => p.getWidth()), [600, 610]);

    // 양식 채우기(한글)
    await page.click('button[aria-label="양식 채우기"]');
    await page.waitForSelector('aside[aria-label="양식 채우기"] input');
    await page.type('aside[aria-label="양식 채우기"] input', "홍길동(예시)");
    await clickText("양식 저장 1", "aside");
    await status("수정본 4");
    assert.equal((await work()).pdf.getForm().getTextField("name").getText(), "홍길동(예시)");
    // 되돌리기: 양식 채우기 전(수정본 3)으로
    await page.click('button[aria-label="되돌리기 (이 화면에서 저장한 것)"]');
    await status("수정본 5");
    assert.equal((await work()).pdf.getForm().getTextField("name").getText() ?? "", "");

    const before = await api(D);
    await clickText("버전으로 저장", "body");
    await clickConfirm("버전으로 저장");
    await status("버전으로 저장했습니다");
    assert.equal((await api(D)).versions.length, before.versions.length + 1);
  });

  test("TC-CFUI-17 접속자·실시간 반영·수정본 비교: 다른 사람이 같은 덱을 보거나 고치면 머리에 표시, 그 사람이 저장하면 편집 화면이 최신으로, 이력에서 비교", async () => {
    // 편집자 초대 → 다른 브라우저에서 로그인
    const inv = await (await post("/invites", JSON.stringify({ role: "editor" }), { "content-type": "application/json" })).json() as { url: string };
    const ctx = await browser.createBrowserContext();
    const other = await ctx.newPage();
    await other.setViewport({ width: 1400, height: 900 });
    await other.goto(inv.url, { waitUntil: "domcontentloaded" });
    await other.waitForSelector('input[aria-label="개발용 이메일"]', { timeout: 15_000 });
    await other.type('input[aria-label="개발용 이메일"]', "editor2@example.com");
    for (const b of await other.$$("form button")) if ((await b.evaluate((e: Element) => e.textContent)).includes("개발용 로그인")) await b.click();
    await other.waitForFunction(() => location.pathname.startsWith("/team/"), { timeout: 15_000 });

    await open("/team/sdlc/notes/intro-deck", "팀 소개 덱");
    await other.goto(BASE + "/team/sdlc/notes/intro-deck", { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[aria-label="같이 보는 사람"] [aria-label="editor2 보는 중"]', { timeout: 15_000 });
    await other.waitForSelector('button[aria-label="슬라이드 편집"]', { timeout: 15_000 });
    await other.click('button[aria-label="슬라이드 편집"]');
    await page.waitForSelector('[aria-label="editor2 편집 중"]', { timeout: 15_000 });

    // 나도 편집 화면을 연 뒤, 다른 사람이 표지 제목을 저장하면 내 화면이 최신으로 바뀐다
    // 비교할 앞 수정본이 있도록 내가 먼저 하나 저장(따로 돌려도 되게)
    const d0 = await api("/docs/notes/intro-deck/deck");
    await post("/docs/notes/intro-deck/deck/slides/cover", JSON.stringify({ baseRev: d0.rev, ops: [{ t: "setNotes", text: "비교용 노트" }] }), { "content-type": "application/json" });
    await page.click('button[aria-label="슬라이드 편집"]');
    await page.waitForSelector(".deck-edit-layer [data-eid]", { timeout: 20_000 });
    const deck = await api("/docs/notes/intro-deck/deck");
    const cookie = (await other.cookies(BASE)).map((c: { name: string; value: string }) => `${c.name}=${c.value}`).join("; ");
    const r = await fetch(`${BASE}/api/w/team/docs/notes/intro-deck/deck/slides/cover`, { method: "POST", headers: { cookie, origin: BASE, "content-type": "application/json" },
      body: JSON.stringify({ baseRev: deck.rev, ops: [{ t: "setText", eid: "e1", html: "다른 사람이 고친 제목" }] }) });
    assert.equal(r.status, 200);
    await page.waitForFunction(() => document.body.innerText.includes("다른 사람이 저장해 최신 내용으로 바꿨습니다"), { timeout: 15_000 });
    assert.equal(await page.$eval('.deck-edit-layer [data-eid="e1"]', (e: Element) => e.textContent), "다른 사람이 고친 제목");

    // 수정본 이력에서 바로 앞 수정본과 지금을 비교
    await page.click('button[aria-label="수정본 이력"]');
    await page.waitForSelector(`button[aria-label="r${deck.rev}과 지금 비교"]`, { timeout: 10_000 });
    await page.click(`button[aria-label="r${deck.rev}과 지금 비교"]`);
    await page.waitForFunction(() => [...document.querySelectorAll("dialog[open] div")].some((d) => d.textContent?.startsWith("+ ") && d.textContent.includes("다른 사람이 고친 제목")), { timeout: 10_000 });
    await page.keyboard.press("Escape");
    await ctx.close();
    // 닫힌 창은 접속자에서 빠진다
    await page.waitForFunction(() => !document.querySelector('[aria-label="같이 보는 사람"]'), { timeout: 15_000 });
  });

  test("TC-CFUI-18 HTML 문서 PDF 내보내기(Browser Rendering): A4, 같은 버전은 캐시, 덱에는 PDF 버튼이 없고 슬라이드 PNG(deck_render)는 960×540", async () => {
    const { PDFDocument } = await import("pdf-lib");
    await open("/team/sdlc/process/guide", "샘플 프로세스 가이드");
    await page.waitForSelector('button[data-tip="PDF로 내보내기"]', { timeout: 15_000 });
    // 화면: 확인 창 → 내려받기(오류 없이 끝난다)
    await page.click('button[data-tip="PDF로 내보내기"]');
    await clickConfirm("내보내기");
    await page.waitForFunction(() => !document.body.innerText.includes("PDF를 만드는 중"), { timeout: 90_000 });
    assert.ok(!(await page.evaluate(() => document.body.innerText.includes("내보내지 못했습니다"))), await page.evaluate(() => document.body.innerText.slice(0, 300)));
    // API: A4 쪽, 두 번째는 캐시
    const t0 = Date.now();
    const res = await api("/docs/process/guide/pdf-export", true);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "application/pdf");
    const pdf = await PDFDocument.load(new Uint8Array(await res.arrayBuffer()));
    assert.ok(pdf.getPageCount() >= 1);
    const { width, height } = pdf.getPage(0).getSize();
    assert.ok(Math.abs(width - 595.9) < 2 && Math.abs(height - 842.9) < 2, `${width}×${height}`);
    assert.ok(Date.now() - t0 < 5000, "두 번째는 캐시");
    assert.equal((await api("/docs/notes/intro-deck/pdf-export", true)).status, 400, "HTML이 아닌 문서");
    // 덱 화면에는 PDF 버튼이 없다
    await open("/team/sdlc/notes/intro-deck", "팀 소개 덱");
    await page.waitForSelector('ol[aria-label="슬라이드 목록"] li', { timeout: 15_000 });
    assert.equal(await page.$('button[data-tip="PDF로 내보내기"]'), null);
    // PNG(작업본)
    const png = await api("/docs/notes/intro-deck/deck/png?work=1&slide=cover", true);
    assert.equal(png.headers.get("content-type"), "image/png");
    const b = new Uint8Array(await png.arrayBuffer());
    const dv = new DataView(b.buffer);
    assert.deepEqual([dv.getUint32(16), dv.getUint32(20)], [960, 540]);
  });

  test("TC-CFUI-12 PPTX 구조 편집: 표 끝에 행 넣기 → 수정본, 미리보기는 작업본 PDF(변환 컨테이너), 버전으로 저장", async () => {
    const before = await api("/docs/notes/slides");
    const t0 = (await api("/docs/notes/slides/work/structure")).tables[0];
    await open("/team/sdlc/notes/slides", "slides 샘플");
    await page.click('button[aria-label="구조 편집 (표·그림)"]');
    await page.waitForFunction(() => document.body.innerText.includes("표 1개"), { timeout: 15_000 });
    await clickText("끝에 넣기", "article");
    await page.waitForFunction(() => document.body.innerText.includes("수정본 1"), { timeout: 15_000 });
    const t1 = (await api("/docs/notes/slides/work/structure")).tables[0];
    assert.equal(t1.rows, t0.rows + 1);
    const pdf = await (await page.waitForSelector('main iframe[src*="/work/pdf"], main embed[src*="/work/pdf"], main object[data*="/work/pdf"]', { timeout: 15_000 }))
      .evaluate((e: Element) => e.getAttribute("src") ?? e.getAttribute("data"));
    const res = await api(pdf.replace(/^.*\/api\/w\/team/, "").replace(/#.*$/, ""), true);
    assert.equal(res.status, 200, "작업본 PDF");
    assert.equal(res.headers.get("content-type"), "application/pdf");
    await clickText("버전으로 저장", "body");
    await clickConfirm("버전으로 저장");
    await page.waitForFunction(() => document.body.innerText.includes("버전으로 저장했습니다"), { timeout: 15_000 });
    assert.equal((await api("/docs/notes/slides")).versions.length, before.versions.length + 1);
  });

  test("TC-CFUI-11 구조 편집: 문단 뒤에 표 넣기 → 칸을 골라 행 넣기 → 되돌리기 → 글자 고치기(두 번 누름) → 버전으로 저장. 편집 사본은 스크립트가 돌지 않는다", async () => {
    const before = await api("/docs/process/guide");
    await open("/team/sdlc/process/guide", "샘플 프로세스 가이드");
    await page.click('button[aria-label="구조 편집 (표·그림)"]');
    // 편집 사본은 스크립트를 막아(CSP sandbox) puppeteer가 안에서 못 돈다. 화면처럼 바깥 페이지에서 contentDocument로 다룬다
    const FRAME = 'iframe[title="구조 편집"]';
    const ready = (sel: string) => page.waitForFunction((f: string, s: string) => {
      const d = document.querySelector<HTMLIFrameElement>(f)?.contentDocument;
      return !!d?.querySelector(s) && [...d.querySelectorAll("style")].some((x) => x.textContent?.includes("data-sel"));
    }, { timeout: 20_000 }, FRAME, sel);
    const fire = (sel: string, type: "click" | "dblclick") => page.evaluate((f: string, s: string, t: string) => {
      const el = document.querySelector<HTMLIFrameElement>(f)!.contentDocument!.querySelector(s)!;
      el.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true }));
    }, FRAME, sel, type);
    const status = (t: string) => page.waitForFunction((x: string) => document.body.innerText.includes(x), { timeout: 15_000 }, t);
    const rows = async () => (await api("/docs/process/guide/work/structure")).blocks.find((b: any) => b.tag === "table").table.rows;

    await ready("p[data-eid]");
    assert.equal(await page.evaluate((f: string) => document.querySelector<HTMLIFrameElement>(f)!.contentDocument!.title, FRAME), "샘플 문서",
      "편집 사본에서 문서 스크립트가 돌면 안 된다");
    // 첫 문단을 골라 그 뒤에 3×3 표
    await fire("p[data-eid]", "click");
    await page.waitForSelector('button[aria-label="표 넣기 (3행 3열)"]');
    await page.click('button[aria-label="표 넣기 (3행 3열)"]');
    await status("수정본 1");
    assert.equal(await rows(), 3);
    // 다시 읽힌 사본에서 본문 첫 칸(머리 행 다음, 2행 1열)을 골라 아래에 행 넣기
    await ready("table td[data-eid]");
    await fire("table td[data-eid]", "click");
    await page.waitForFunction(() => document.body.innerText.includes("2행 1열 고름"), { timeout: 5000 });
    await clickText("아래에 넣기", "aside");
    await status("수정본 2");
    assert.equal(await rows(), 4);
    // 되돌리기: 수정본 1 내용으로 새 수정본(3)
    await page.click('button[aria-label="되돌리기"]');
    await status("수정본 3");
    assert.equal(await rows(), 3);
    // 두 번째 문단 글자를 그 자리에서 고친다(Enter로 저장)
    await ready("table");
    const P2 = "body > p:nth-of-type(2)";
    await fire(P2, "dblclick");
    await page.evaluate((f: string) => {
      const w = document.querySelector<HTMLIFrameElement>(f)!.contentWindow!;
      const el = w.document.querySelector<HTMLElement>('[contenteditable="true"]')!;
      const r = w.document.createRange(); r.selectNodeContents(el);
      const sel = w.getSelection()!; sel.removeAllRanges(); sel.addRange(r);
    }, FRAME);
    await page.keyboard.type("배포는 D13에 한다.");
    await page.keyboard.press("Enter");
    await status("수정본 4");
    // 버전으로 저장
    await clickText("버전으로 저장", "body");
    await clickConfirm("버전으로 저장");
    await status("버전으로 저장했습니다");
    const d = await api("/docs/process/guide");
    assert.equal(d.versions.length, before.versions.length + 1);
    const v = d.versions.find((x: any) => x.version === d.currentVersion);
    assert.equal(v.source, "revision");
    const html = await (await fetch(v.files.find((x: any) => x.isEntry).url)).text();
    assert.match(html, /<table[\s\S]*<\/table>/);
    assert.match(html, /<p>배포는 D13에 한다\.<\/p>/);
    assert.match(html, /<script>document\.title = "스크립트";<\/script>/, "스크립트는 원본 그대로 남는다");
  });
});
