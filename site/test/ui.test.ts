// 화면 테스트. 임시 docs로 API 서버와 Vite 화면을 따로 띄우고, 전역 설치된 puppeteer(mermaid-cli에 포함)로 조작한다.
// puppeteer가 없으면 건너뛴다. SSE가 계속 열려 있어 networkidle을 기다리지 않고 요소를 기다린다.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { execSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createRequire } from "node:module";
import { join } from "node:path";
import { parse } from "yaml";
import { call, freePort, makeWorkspace, readText, SITE, startServer, upload, waitFor, type TestServer } from "./helpers.ts";

const PUPPETEER = (() => {
  try { return join(execSync("npm root -g", { encoding: "utf8" }).trim(), "@mermaid-js/mermaid-cli/node_modules/puppeteer"); } catch { return ""; }
})();
const skip = !PUPPETEER || !existsSync(PUPPETEER) ? "puppeteer 없음(npm i -g @mermaid-js/mermaid-cli)" : false;

const ws = makeWorkspace();
let srv: TestServer;
let vite: ChildProcess;
let WEB = "";
let browser: any;
let page: any;
const meta = (menu: string, doc: string) => parse(readText(join(ws.docs, menu, doc, "meta.yaml")));

/** 페이지 이동. SSE가 계속 열려 있어 networkidle 대신 domcontentloaded까지만 기다린다 */
async function nav(url: string) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 10_000 });
}

/** 문서 화면을 열고 제목(h1)이 나올 때까지 기다린다 */
async function open(path: string, title?: string) {
  await nav(WEB + path);
  if (title) await page.waitForFunction((t: string) => document.querySelector("main h1, h1")?.textContent?.includes(t), { timeout: 15_000 }, title);
}
const text = () => page.evaluate(() => document.body.innerText) as Promise<string>;
async function clickConfirm(label?: string) {
  await page.waitForSelector("dialog[open]", { timeout: 5000 });
  await new Promise((r) => setTimeout(r, 120)); // 포커스 지연(60ms) 뒤
  const buttons = await page.$$("dialog[open] button");
  if (label) {
    for (const b of buttons) if ((await b.evaluate((e: Element) => e.textContent)).includes(label)) return b.click();
    throw new Error(`확인 창에 ${label} 버튼이 없습니다`);
  }
  await buttons[buttons.length - 1].click();
}

describe("화면", { skip }, () => {
  before(async () => {
    srv = await startServer(ws);
    const webPort = await freePort();
    vite = spawn(process.execPath, [join(SITE, "node_modules/vite/bin/vite.js")], {
      cwd: SITE, env: { ...process.env, PORT: String(srv.port), WEB_PORT: String(webPort) }, stdio: "ignore",
    });
    WEB = `http://127.0.0.1:${webPort}`;
    await waitFor(async () => (await fetch(WEB)).ok, 30_000, "Vite 시작");
    const puppeteer = createRequire(import.meta.url)(PUPPETEER);
    // 외부 호스트(Google Fonts, react-grab 버전 확인)는 이름 풀이 단계에서 막는다. 느린 외부 응답 때문에 페이지 로드가 멈추지 않게 한다.
    // puppeteer의 요청 가로채기(setRequestInterception)는 가끔 페이지 이동을 멈추게 해서 쓰지 않는다
    browser = await puppeteer.launch({ headless: "new", args: ["--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1"] });
    page = await browser.newPage();
    // Markdown 편집기는 저장하지 않은 변경이 있으면 떠날 때 묻는다(beforeunload). 테스트에서는 그냥 떠난다
    page.on("dialog", (d: any) => { if (d.type() === "beforeunload") void d.accept(); });
    await page.setViewport({ width: 1280, height: 900 });
  });
  after(async () => {
    await browser?.close();
    vite?.kill("SIGTERM");
    await srv?.stop();
    ws.cleanup();
  });

  test("TC-UI-01 / 는 첫 대분류로 가고, 헤더 탭과 좌측 메뉴 트리·문서가 보인다", async () => {
    await nav(WEB + "/");
    await page.waitForSelector('nav[aria-label="SDLC 메뉴"]');
    assert.ok(page.url().endsWith("/sdlc"));
    const body = await text();
    for (const t of ["SDLC", "Agent", "개발 프로세스", "코드 리뷰", "회의록", "샘플 프로세스 가이드", "주간 회의록"]) assert.ok(body.includes(t), t);
  });

  test("TC-UI-02 HTML 문서는 sandbox iframe(allow-same-origin 없음)으로 열리고 버전은 draft로 표시, 제목 오른쪽에 작성일", async () => {
    await open("/sdlc/process/guide", "샘플 프로세스 가이드");
    const frame = await page.waitForSelector('iframe[title="문서"]');
    const [src, sandbox] = await frame.evaluate((f: HTMLIFrameElement) => [f.getAttribute("src"), f.getAttribute("sandbox")]);
    assert.match(src, /^\/files\/process\/guide\/v0\.0\/guide\.html\?h=[0-9a-f]{12}$/);
    assert.ok(sandbox.includes("allow-scripts") && !sandbox.includes("allow-same-origin"));
    const option = await page.$eval('select[aria-label="버전"]', (s: HTMLSelectElement) => s.selectedOptions[0].textContent);
    assert.equal(option, "draft (최신)");
    // 제목 오른쪽에 이 버전 작성일(12px)
    const created = await page.$eval('[data-tip="draft 작성일"]', (e: HTMLElement) => [e.textContent, getComputedStyle(e).fontSize]);
    assert.deepEqual(created, ["2026-10-01", "12px"]);
  });

  test("TC-UI-03 다른 곳에서 문서가 바뀌면 새로 고치지 않아도 목록에 반영(SSE)", async () => {
    await upload(srv.url, { menu: "notes", title: "실시간 추가 문서", slug: "live" }, [["live.html", "<p>live</p>"]]);
    await page.waitForFunction(() => document.body.innerText.includes("실시간 추가 문서"), { timeout: 10_000 });
  });

  test("TC-UI-04 검색창에서 본문 글자로 문서를 찾는다", async () => {
    await page.type('input[aria-label="문서 검색"]', "배포");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => [...document.querySelectorAll("a, button, li")].some((e) => e.textContent?.includes("샘플 프로세스 가이드") && e.textContent?.includes("배포")), { timeout: 10_000 });
  });

  test("TC-UI-05 HTML 텍스트 편집: 조각을 고쳐 확인 창을 거쳐 새 버전으로 저장", async () => {
    await open("/sdlc/process/guide", "샘플 프로세스 가이드");
    await page.click('button[aria-label="텍스트 편집"]');
    const handle = await page.waitForSelector('iframe[title="텍스트 편집"]');
    const sandbox = await handle.evaluate((f: HTMLIFrameElement) => f.getAttribute("sandbox"));
    assert.equal(sandbox, "allow-same-origin", "편집 화면은 스크립트 없음");
    const frame = await handle.contentFrame();
    const span = await frame.waitForSelector('span[data-seg][contenteditable]', { timeout: 30_000 }); // 첫 편집 화면은 Vite가 모듈을 처음 변환해 느릴 수 있다
    // 그 조각의 글자 전체를 선택한 뒤 입력한다
    await frame.evaluate(() => {
      const el = [...document.querySelectorAll<HTMLElement>("span[data-seg]")].find((s) => s.textContent === "D7")!;
      el.focus();
      const r = document.createRange(); r.selectNodeContents(el);
      const sel = getSelection()!; sel.removeAllRanges(); sel.addRange(r);
    });
    await page.keyboard.type("D8");
    await page.waitForFunction(() => document.body.innerText.includes("변경 1건"), { timeout: 5000 });
    assert.ok(span);
    await page.click('button[aria-label="저장 (새 버전)"]');
    await clickConfirm("저장");
    await page.waitForFunction(() => document.body.innerText.includes("버전으로 저장했습니다"), { timeout: 10_000 });
    assert.equal(meta("process", "guide").current, "v0.1");
    assert.match(readText(join(ws.docs, "process/guide/v0.1/guide.html")), /<strong>D8<\/strong>/);
  });

  test("TC-UI-06 버전이 2개 이상이면 비교를 고를 수 있고 바뀐 줄을 보여 준다", async () => {
    await open("/sdlc/process/guide", "샘플 프로세스 가이드");
    await page.select('select[aria-label="비교할 버전"]', "v0.0");
    await page.waitForFunction(() => document.body.innerText.includes("D7") && document.body.innerText.includes("D8"), { timeout: 10_000 });
    assert.match(page.url(), /cmp=v0\.0/);
  });

  test("TC-UI-07 상태 배지: 확인 창에서 취소하면 그대로, 확인하면 v1.0 approved", async () => {
    await open("/sdlc/process/guide", "샘플 프로세스 가이드");
    await page.click('button[aria-label^="draft 상태. 정식 버전 v1.0"]');
    await page.waitForSelector("dialog[open]");
    assert.match(await page.$eval("#confirm-title", (e: Element) => e.textContent), /v1\.0으로 변경하시겠습니까\?/);
    await clickConfirm("취소");
    await page.waitForSelector("dialog[open]", { hidden: true });
    assert.equal(meta("process", "guide").status, "draft");
    await page.click('button[aria-label^="draft 상태. 정식 버전 v1.0"]');
    await clickConfirm("v1.0으로 변경");
    await page.waitForFunction(() => document.body.innerText.includes("approved"), { timeout: 10_000 });
    assert.equal(meta("process", "guide").current, "v1.0");
  });

  test("TC-UI-08 확인 창의 포커스: 일반은 확인 버튼, Esc는 취소", async () => {
    await open("/sdlc/notes/live", "실시간 추가 문서");
    await page.click('button[aria-label^="draft 상태"]');
    await page.waitForSelector("dialog[open]");
    await new Promise((r) => setTimeout(r, 150));
    const focused = await page.evaluate(() => document.activeElement?.textContent);
    assert.match(focused, /v1\.0으로 변경/);
    await page.keyboard.press("Escape");
    await page.waitForSelector("dialog[open]", { hidden: true });
    assert.equal(meta("notes", "live").status, "draft");
  });

  test("TC-UI-09 Markdown 문서는 편집기와 미리보기가 보인다", async () => {
    await open("/sdlc/notes/minutes", "주간 회의록");
    await page.waitForSelector(".cm-editor", { timeout: 10_000 });
    await page.waitForFunction(() => document.querySelector(".mf-preview h1")?.textContent === "회의록", { timeout: 10_000 });
  });

  test("TC-UI-10 사이드바 접기 상태를 기억한다", async () => {
    await open("/sdlc/process/guide", "샘플 프로세스 가이드");
    await page.click('button[aria-label="사이드바 접기"]');
    await page.waitForSelector('button[aria-label="사이드바 펼치기"]');
    await nav(page.url()); // reload()는 열린 SSE 때문에 끝나지 않는다
    await page.waitForSelector('button[aria-label="사이드바 펼치기"]', { timeout: 10_000 });
    await page.click('button[aria-label="사이드바 펼치기"]');
    await page.waitForSelector('nav[aria-label="SDLC 메뉴"]');
  });

  test("TC-UI-11 사이트 화면에 가로 넘침이 없다(1280px·500px)", async () => {
    for (const width of [1280, 500]) {
      await page.setViewport({ width, height: 900 });
      await open("/sdlc/process/guide", "샘플 프로세스 가이드");
      const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      assert.ok(over <= 0, `${width}px에서 ${over}px 넘침`);
    }
    await page.setViewport({ width: 1280, height: 900 });
  });

  test("TC-UI-13 같은 탭에서 전체 페이지 이동을 여러 번 해도 멈추지 않고, 뒤로 가기로 돌아와도 실시간 반영이 된다", async () => {
    // 뒤로 가기 캐시에 남은 페이지가 SSE 연결을 닫지 않으면 같은 호스트 연결 한도(6개)가 차서 이동이 멈추던 버그의 회귀 검사
    for (let i = 0; i < 10; i++) await open(i % 2 ? "/sdlc/notes/minutes" : "/sdlc/process/guide", i % 2 ? "주간 회의록" : "샘플 프로세스 가이드");
    await page.goBack({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => document.body.innerText.includes("주간 회의록"), { timeout: 10_000 });
    await upload(srv.url, { menu: "notes", title: "뒤로 가기 후 추가", slug: "after-back" }, [["b.html", "<p>b</p>"]]);
    await page.waitForFunction(() => document.body.innerText.includes("뒤로 가기 후 추가"), { timeout: 10_000 });
  });

  test("TC-UI-14 아이콘에 마우스를 올리거나 키보드로 포커스하면 툴팁, 대화상자 위에서도 보이고 누르거나 Esc면 닫힌다", async () => {
    await open("/sdlc/process/guide", "샘플 프로세스 가이드");
    const tip = async () => page.evaluate(() => {
      const el = document.querySelector<HTMLElement>('[role="tooltip"]')!;
      const r = el.getBoundingClientRect();
      return { open: el.matches(":popover-open") && getComputedStyle(el).opacity === "1", text: el.textContent, inView: r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight };
    });
    const waitTip = (text: string) => page.waitForFunction((t: string) => {
      const el = document.querySelector<HTMLElement>('[role="tooltip"]');
      return el?.matches(":popover-open") && el.textContent === t && getComputedStyle(el).opacity === "1";
    }, { timeout: 3000 }, text);

    assert.equal(await page.$eval('button[aria-label="다운로드"]', (b: Element) => b.getAttribute("title")), null, "기본 title 툴팁은 쓰지 않음");
    await page.hover('button[aria-label="다운로드"]');
    await waitTip("다운로드");
    assert.ok((await tip()).inView);
    await page.hover('button[aria-label="문서 관리"]');
    const t0 = Date.now();
    await waitTip("문서 관리");
    assert.ok(Date.now() - t0 < 300, "떠 있는 상태에서 옆 아이콘으로 옮기면 기다리지 않고 바뀜");
    await page.keyboard.press("Escape");
    assert.equal((await tip()).open, false, "Esc로 닫힘");

    await page.click('button[aria-label="문서 관리"]');                    // 대화상자(showModal) 위에서도 보임
    await page.waitForSelector("dialog[open]");
    await page.hover('dialog[open] button[aria-label="닫기"]');
    await waitTip("닫기");
    const onTop = await page.evaluate(() => {
      const el = document.querySelector<HTMLElement>('[role="tooltip"]')!;
      const r = el.getBoundingClientRect();
      return document.elementsFromPoint(r.left + r.width / 2, r.top + r.height / 2).includes(el) || getComputedStyle(el).pointerEvents === "none";
    });
    assert.ok(onTop);
    await page.mouse.down(); await page.mouse.up();
    assert.equal((await tip()).open, false, "누르면 닫힘");

    await page.keyboard.press("Escape");                                   // 대화상자 닫기
    await page.waitForSelector("dialog[open]", { hidden: true });
    await page.click('input[aria-label="문서 검색"]');
    await page.keyboard.press("Tab");                                      // 키보드로 옮긴 포커스에도 뜬다
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("aria-label")), "검색");
    await waitTip("검색");
  });

  test("TC-UI-15 외부 문서는 스크립트를 끈 채 출처와 함께 열리고, 켜기는 버전별로 기억된다(D-25, D-27)", async () => {
    await upload(srv.url, { menu: "notes", title: "외부 아티팩트", slug: "ext", origin: "https://claude.ai/artifact/abc" },
      [["ext.html", "<p id=t>원래 글자</p><script>document.getElementById('t').textContent='스크립트 실행됨'</script>"]]);
    const sandbox = () => page.$eval('iframe[title="문서"]', (f: HTMLIFrameElement) => f.getAttribute("sandbox"));
    await open("/sdlc/notes/ext", "외부 아티팩트");
    await page.waitForFunction(() => document.body.innerText.includes("외부 문서") && document.body.innerText.includes("스크립트 꺼짐"));
    assert.ok(await page.$('a[href="https://claude.ai/artifact/abc"]'), "출처 링크");
    assert.doesNotMatch(await sandbox(), /allow-scripts/);
    assert.doesNotMatch(await sandbox(), /allow-same-origin/);

    await page.evaluate(() => [...document.querySelectorAll("button")].find((b) => b.textContent === "스크립트 켜기")!.click());
    await page.waitForFunction(() => document.querySelector('iframe[title="문서"]')?.getAttribute("sandbox")?.includes("allow-scripts"));
    assert.match(await sandbox(), /allow-scripts/);
    await open("/sdlc/notes/ext", "외부 아티팩트");                         // 다시 열어도 켜진 채(기억)
    await page.waitForFunction(() => document.body.innerText.includes("스크립트 켜짐"));
    assert.match(await sandbox(), /allow-scripts/);

    await upload(srv.url, { menu: "notes", doc: "ext" }, [["ext.html", "<p>새 버전</p>"]]);   // 새 버전은 다시 꺼짐
    await open("/sdlc/notes/ext", "외부 아티팩트");
    await page.waitForFunction(() => document.body.innerText.includes("스크립트 꺼짐"));
    assert.doesNotMatch(await sandbox(), /allow-scripts/);

    await open("/sdlc/process/guide", "샘플 프로세스 가이드");             // 출처 없는 문서는 막대 없음, 스크립트 켜짐
    assert.ok(!(await text()).includes("외부 문서"));
    assert.match(await sandbox(), /allow-scripts/);
  });

  test("TC-UI-16 HTML 참조 복사: 글자를 누르면 조각 주소, Alt+클릭은 문단 범위를 복사한다(3.2)", async () => {
    await browser.defaultBrowserContext().overridePermissions(WEB, ["clipboard-read", "clipboard-write", "clipboard-sanitized-write"]);
    await upload(srv.url, { menu: "notes", title: "참조 시험", slug: "ref" }, [["ref.html", "<h1>제목</h1><p>첫 <b>굵은</b> 문장</p><ul><li>항목 하나</li></ul>"]]);
    await open("/sdlc/notes/ref", "참조 시험");
    await page.click('button[aria-label^="참조 복사"]');
    const handle = await page.waitForSelector('iframe[title="참조 보기"]');
    assert.equal(await handle.evaluate((f: HTMLIFrameElement) => f.getAttribute("sandbox")), "allow-same-origin", "스크립트 없음");
    const frame = await handle.contentFrame();
    await frame.waitForSelector('span[data-seg="2"]');
    const clip = () => page.evaluate(() => navigator.clipboard.readText());

    await (await frame.$('span[data-seg="2"]')).click();
    await page.waitForFunction(() => document.body.innerText.includes("복사함: [2]"));
    assert.equal(await clip(), `${WEB}/sdlc/notes/ref?v=v0.0&seg=2`);

    await page.keyboard.down("Alt");
    await (await frame.$('span[data-seg="1"]')).click();
    await page.keyboard.up("Alt");
    await page.waitForFunction(() => document.body.innerText.includes("복사함: [1-3]"));
    assert.equal(await clip(), `${WEB}/sdlc/notes/ref?v=v0.0&seg=1-3`);
  });

  test("TC-UI-17 주소에 ?seg=가 있으면 참조 보기로 그 조각을 강조하고, 원래 보기로 돌아간다(3.2, D-28)", async () => {
    await open("/sdlc/notes/ref?seg=1,4", "참조 시험");
    const frame = await (await page.waitForSelector('iframe[title="참조 보기"]')).contentFrame();
    await frame.waitForSelector("[data-ref-hit]");
    assert.deepEqual(await frame.$$eval("[data-ref-hit]", (els: Element[]) => els.map((e) => e.textContent)), ["첫", "항목 하나"]);
    assert.ok((await text()).includes("참조 위치 [1,4]"));
    await page.evaluate(() => [...document.querySelectorAll("button")].find((b) => b.textContent?.includes("원래 보기로"))?.click());
    await page.waitForSelector('iframe[title="문서"]');
    assert.doesNotMatch(page.url(), /seg=/);
  });

  test("TC-UI-18 DOCX 참조: ?seg= 줄을 강조하고, 줄을 누르면 그 조각 주소를 복사한다(3.2)", async () => {
    await upload(srv.url, { menu: "notes", title: "워드 참조", slug: "word-ref" }, [["sample.docx", readFileSync(join(SITE, "scripts/fixtures/sample.docx"))]]);
    await open("/sdlc/notes/word-ref?seg=1", "워드 참조");
    await page.waitForSelector('span[data-seg="1"][data-ref-hit]');
    await page.click('button[aria-label^="참조 복사"]');
    await page.click('span[data-seg="0"]');
    await page.waitForFunction(() => document.body.innerText.includes("복사함: [0]"));
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), `${WEB}/sdlc/notes/word-ref?v=v0.0&seg=0`);
  });

  /** MCP(Claude Code)처럼 X-Workflow-Agent 헤더를 붙여 조각 하나를 고친다 */
  async function claudeEdit(menu: string, doc: string, index: number, text: string) {
    const d = await (await fetch(`${srv.url}/api/docs/${menu}/${doc}`)).json();
    const seg = (await (await fetch(`${srv.url}/api/docs/${menu}/${doc}/segments`)).json()).segments[index];
    const res = await fetch(`${srv.url}/api/docs/${menu}/${doc}/text-edit`, {
      method: "POST", headers: { "content-type": "application/json", "x-workflow-agent": "claude-code" },
      body: JSON.stringify({ baseVersion: d.currentVersion, changes: [{ id: seg.id, hash: seg.hash, text }], note: "Claude Code: 시험" }),
    });
    assert.equal(res.status, 200);
    return seg.id as number;
  }

  test("TC-UI-19 Claude가 보고 있는 문서를 고치면 알림과 함께 바뀐 조각을 강조하고, 다른 문서면 알림의 열기로 간다(3.4, D-29)", async () => {
    await open("/sdlc/notes/ref", "참조 시험");
    const id = await claudeEdit("notes", "ref", 4, "항목 하나 (Claude)");
    await page.waitForFunction(() => document.querySelector('[role="status"]')?.textContent?.includes("Claude Code가 ‘참조 시험’ 문서를 v0.1 버전으로 저장했습니다"), { timeout: 10_000 });
    await page.waitForFunction((i: number) => location.search.includes(`seg=${i}`), {}, id);
    const frame = await (await page.waitForSelector('iframe[title="참조 보기"]')).contentFrame();
    await frame.waitForFunction(() => document.querySelector("[data-ref-hit]")?.textContent === "항목 하나 (Claude)", { timeout: 10_000 });

    const gid = await claudeEdit("process", "guide", 0, "샘플 프로세스 문서 (Claude)");   // 다른 문서: 이동하지 않고 "열기"
    await page.waitForFunction(() => [...document.querySelectorAll('[role="status"] button')].some((b) => b.textContent === "열기"), { timeout: 10_000 });
    assert.match(page.url(), /\/sdlc\/notes\/ref/);
    await page.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>('[role="status"] button')].find((b) => b.textContent === "열기")!.click());
    await page.waitForFunction((i: number) => location.pathname === "/sdlc/process/guide" && location.search.includes(`seg=${i}`), {}, gid);
  });

  test("TC-UI-20 focus 요청이 오면 열린 화면이 그 문서·버전·조각으로 이동해 강조한다(3.4 focus_in_site)", async () => {
    await open("/sdlc/notes/minutes", "주간 회의록");
    const r = await fetch(`${srv.url}/api/focus`, {
      method: "POST", headers: { "content-type": "application/json", "x-workflow-agent": "claude-code" },
      body: JSON.stringify({ menu: "notes", doc: "ref", version: "v0.0", seg: "1-3" }),
    });
    assert.ok((await r.json()).clients >= 1);
    await page.waitForFunction(() => location.pathname === "/sdlc/notes/ref" && location.search.includes("v=v0.0") && location.search.includes("seg=1-3"), { timeout: 10_000 });
    const frame = await (await page.waitForSelector('iframe[title="참조 보기"]')).contentFrame();
    await frame.waitForFunction(() => document.querySelectorAll("[data-ref-hit]").length === 3, { timeout: 10_000 });
    assert.ok((await text()).includes("가리켰습니다"));
  });

  test("TC-UI-21 SVG(draw.io) 텍스트 편집: 그림 위에서 고치고, 상자를 넘치면 경고하고 확인 창에도 보인다", async () => {
    await upload(srv.url, { menu: "notes", title: "ERD 그림", slug: "erd" }, [["erd.drawio.svg", readFileSync(join(SITE, "scripts/fixtures/sample-drawio.svg"))]]);
    await open("/sdlc/notes/erd", "ERD 그림");
    await page.click('button[aria-label="텍스트 편집"]');
    await page.waitForFunction(() => document.querySelector<HTMLIFrameElement>('iframe[title="텍스트 편집"]')?.contentDocument?.querySelector("span[data-seg][contenteditable]"), { timeout: 30_000 });
    assert.equal(await page.evaluate(() => document.querySelector<HTMLIFrameElement>('iframe[title="텍스트 편집"]')!.contentDocument!.documentElement.localName), "svg");
    const typeInto = async (id: number, text: string) => {
      await page.evaluate((i: number) => {
        const d = document.querySelector<HTMLIFrameElement>('iframe[title="텍스트 편집"]')!.contentDocument!;
        const el = d.querySelector<HTMLElement>(`span[data-seg="${i}"]`)!;
        el.focus();
        const r = d.createRange(); r.selectNodeContents(el);
        const sel = d.getSelection()!; sel.removeAllRanges(); sel.addRange(r);
      }, id);
      await page.keyboard.type(text);
    };
    const desc = await page.evaluate(() => [...document.querySelector<HTMLIFrameElement>('iframe[title="텍스트 편집"]')!.contentDocument!.querySelectorAll("span[data-seg]")]
      .find((s) => s.textContent?.startsWith("iframe 로그인의"))!.getAttribute("data-seg"));
    await typeInto(Number(desc), "iframe 로그인 1회용 코드(60초)");                        // 짧으면 경고 없음
    await page.waitForFunction(() => document.body.innerText.includes("변경 1건"));
    assert.equal(await page.$('[role="alert"]'), null);
    await typeInto(Number(desc), "아주 긴 설명 ".repeat(14));                               // 길면 경고
    await page.waitForSelector('[role="alert"]', { timeout: 5000 });
    assert.match(await page.$eval('[role="alert"]', (e: Element) => e.textContent), /글자가 상자를 넘치는 곳 1곳/);
    await page.click('button[aria-label="저장 (새 버전)"]');
    await page.waitForSelector("dialog[open]");
    assert.match(await page.$eval("dialog[open]", (e: Element) => e.textContent), /상자를 넘치는 곳이 1곳[\s\S]*⚠/);
    await clickConfirm("저장");
    await page.waitForFunction(() => document.body.innerText.includes("v0.1 버전으로 저장했습니다"), { timeout: 10_000 });
    assert.match(await text(), /주의: \[\d+\].*넘칠 수 있습니다/);
  });

  // ── Markdown 편집기(MarkFlow) ──
  const MOD = process.platform === "darwin" ? "Meta" : "Control";
  const editorText = () => page.evaluate(() => [...document.querySelectorAll(".cm-line")].map((l) => l.textContent).join("\n")) as Promise<string>;
  /** 편집 창 문서 끝에 커서를 두고 글자를 친다 */
  async function typeAtEnd(s: string) {
    await page.click(".cm-content");
    await page.keyboard.down(MOD); await page.keyboard.press("End"); await page.keyboard.up(MOD);
    await page.keyboard.type(s);
  }

  test("TC-UI-22 Markdown 툴바: 고른 글자에 서식을 넣고 미리보기에 보이며, 보기 방식(편집만·나란히·미리보기만)을 바꾼다", async () => {
    await open("/sdlc/notes/minutes", "주간 회의록");
    await page.waitForSelector('[role="toolbar"][aria-label="Markdown 서식"]');
    await typeAtEnd("\n중요");
    for (let i = 0; i < 2; i++) await page.keyboard.down("Shift"), await page.keyboard.press("ArrowLeft"), await page.keyboard.up("Shift");
    await page.click('button[aria-label="굵게"]');
    assert.ok((await editorText()).endsWith("**중요**"));
    await page.waitForFunction(() => document.querySelector(".mf-preview strong")?.textContent === "중요", { timeout: 5000 });
    await page.click('button[aria-label="편집만"]');
    await page.waitForFunction(() => !document.querySelector('section[aria-label="미리보기"]') && document.querySelector('section[aria-label="편집"]'));
    await page.click('button[aria-label="미리보기만"]');
    await page.waitForFunction(() => !document.querySelector('section[aria-label="편집"]') && document.querySelector('section[aria-label="미리보기"]'));
    await page.click('button[aria-label="나란히 보기"]');
    await page.waitForSelector('section[aria-label="편집"] .cm-editor');
    assert.match(await page.$eval("[data-md-status]", (e: Element) => e.textContent), /\d+줄 · \d+자/);
  });

  test("TC-UI-23 [[ 를 치면 사이트 문서 후보가 나오고, 고르면 문서 링크가 들어간다", async () => {
    await typeAtEnd("\n[[샘플");
    await page.waitForFunction(() => [...document.querySelectorAll(".cm-tooltip-autocomplete li")].some((l) => l.textContent?.includes("샘플 프로세스 가이드")), { timeout: 5000 });
    await new Promise((r) => setTimeout(r, 150)); // 후보 창이 뜬 직후의 Enter는 무시된다(CodeMirror interactionDelay)
    await page.keyboard.press("Enter");
    const t = await editorText();
    assert.ok(t.endsWith("[샘플 프로세스 가이드](/sdlc/process/guide)"), t);
    await page.waitForSelector('.mf-preview a[href="/sdlc/process/guide"][target="_blank"]', { timeout: 5000 });
  });

  test("TC-UI-24 이미지 올리기: 업로드 서버가 없으면 설정 창, 테스트 업로드가 되면 저장하고, 올린 이미지 주소가 문서에 들어가 새 버전으로 저장된다", async () => {
    const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==";
    // 가짜 Cloudflare Worker
    let uploads = 0;
    const worker = createServer((req, res) => {
      res.setHeader("Access-Control-Allow-Origin", "*");
      if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }
      if (req.method === "GET") { res.setHeader("Content-Type", "image/png"); return res.end(Buffer.from(PNG, "base64")); }  // 미리보기가 읽는 이미지
      req.resume();
      req.on("end", () => {
        uploads++;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ success: true, url: `http://127.0.0.1:${(worker.address() as AddressInfo).port}/images/${uploads}.png` }));
      });
    });
    await new Promise<void>((r) => worker.listen(0, "127.0.0.1", r));
    const workerUrl = `http://127.0.0.1:${(worker.address() as AddressInfo).port}`;
    try {
      await page.evaluate(() => localStorage.removeItem("mf-cf-worker-url"));
      await open("/sdlc/notes/minutes", "주간 회의록");
      await page.waitForSelector('button[aria-label="이미지 올리기 (Cloudflare R2)"]');
      await page.click('button[aria-label="이미지 올리기 (Cloudflare R2)"]');
      await page.waitForFunction(() => document.querySelector("dialog[open] h2")?.textContent === "이미지 업로드 설정");
      await page.type('dialog[open] input[type="url"]', workerUrl);
      const save = 'dialog[open] button[type="submit"]';
      assert.equal(await page.$eval(save, (b: HTMLButtonElement) => b.disabled), true);  // 테스트 전에는 저장 불가
      for (const b of await page.$$("dialog[open] button")) if ((await b.evaluate((e: Element) => e.textContent)).includes("테스트 업로드")) await b.click();
      await page.waitForFunction(() => document.querySelector("dialog[open]")?.textContent?.includes("연결됨"), { timeout: 5000 });
      await page.click(save);
      await page.waitForSelector("dialog[open]", { hidden: true });
      assert.equal(await page.evaluate(() => localStorage.getItem("mf-cf-worker-url")), workerUrl);

      const png = join(ws.root, "shot.png");
      writeFileSync(png, Buffer.from(PNG, "base64"));
      await page.click(".cm-content");
      await (await page.$('input[type="file"]')).uploadFile(png);
      await page.waitForFunction((u: string) => document.querySelector(".mf-preview img")?.getAttribute("src") === `${u}/images/2.png`, { timeout: 5000 }, workerUrl);
      assert.ok((await editorText()).includes(`![shot.png](${workerUrl}/images/2.png)`));
      assert.equal(uploads, 2);  // 테스트 업로드 1 + 이미지 1

      await page.click('button[aria-label="저장 (새 버전)"]');
      await clickConfirm("저장");
      await page.waitForFunction(() => document.body.innerText.includes("v0.1 버전으로 저장했습니다"), { timeout: 10_000 });
      assert.ok(readText(join(ws.docs, "notes/minutes/v0.1/minutes.md")).includes(`![shot.png](${workerUrl}/images/2.png)`));
    } finally {
      worker.close();
    }
  });

  test("TC-UI-25 이전 버전 Markdown은 읽기 전용: 서식 툴바 없이 보기 방식만, 편집 창은 고칠 수 없다", async () => {
    await open("/sdlc/notes/minutes?v=v0.0", "주간 회의록");
    await page.waitForSelector(".cm-content");
    assert.equal(await page.$('button[aria-label="굵게"]'), null);
    assert.ok(await page.$('button[aria-label="미리보기만"]'));
    assert.equal(await page.$eval(".cm-content", (e: Element) => e.getAttribute("contenteditable")), "false");
    assert.match(await page.$eval("[data-md-status]", (e: Element) => e.textContent), /읽기 전용/);
  });

  test("TC-UI-26 새 Markdown 문서를 만들면 편집 화면이 열리고 커서가 편집 창 끝에 있다", async () => {
    await open("/sdlc/process/guide", "샘플 프로세스 가이드");
    await page.click('button[aria-label="업로드"]');
    await page.waitForSelector("dialog[open]");
    const clickText = async (t: string) => {
      for (const b of await page.$$("dialog[open] button")) if ((await b.evaluate((e: Element) => e.textContent)).trim() === t) return b.click();
      throw new Error(`${t} 버튼 없음`);
    };
    await clickText("새 Markdown 문서");
    const selects = await page.$$("dialog[open] select");
    await selects[1].select("notes");
    await page.type('dialog[open] input[placeholder="예: 로그인 시퀀스 다이어그램"]', "New Memo");
    await clickText("만들고 편집하기");
    await clickConfirm("만들기");
    await page.waitForFunction(() => location.pathname === "/sdlc/notes/new-memo", { timeout: 10_000 });
    await page.waitForFunction(() => document.activeElement?.closest(".cm-editor"), { timeout: 10_000 });
    await page.keyboard.type("본문");
    assert.equal(await editorText(), "# New Memo\n\n본문");
  });

  /** 사이드바 줄(data-row)끼리 끌어서 놓기. zone: 앞(before)·안(inside)·뒤(after) */
  async function dnd(from: string, to: string, zone: "before" | "inside" | "after") {
    const fire = (key: string, type: string, z?: string) => page.evaluate((k: string, t: string, zz?: string) => {
      const el = document.querySelector(`[data-row="${k}"]`)!;
      const r = el.getBoundingClientRect();
      const w = window as unknown as { __dt?: DataTransfer };
      if (t === "dragstart") w.__dt = new DataTransfer();
      const y = r.top + r.height * (zz === "before" ? 0.1 : zz === "after" ? 0.9 : 0.5);
      el.dispatchEvent(new DragEvent(t, { bubbles: true, cancelable: true, dataTransfer: w.__dt, clientX: r.left + 30, clientY: y }));
    }, key, type, z);
    const tick = () => new Promise((r) => setTimeout(r, 60)); // 이벤트 사이에 React가 상태를 반영하도록
    await fire(from, "dragstart"); await tick();
    await fire(to, "dragover", zone); await tick();
    await fire(to, "drop", zone); await tick();
    await fire(from, "dragend").catch(() => {});
  }
  const rowMenu = async (key: string, item: string) => {
    // 좌표로 누르면 목록이 다시 그려지는 순간 다른 줄을 누를 수 있어, 그 줄에 직접 contextmenu 이벤트를 보낸다
    const row = await page.waitForSelector(`[data-row="${key}"]`);
    await row.evaluate((el: Element) => {
      const r = el.getBoundingClientRect();
      el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: r.left + 40, clientY: r.bottom }));
    });
    await page.waitForSelector('[role="menu"]');
    for (const b of await page.$$('[role="menuitem"]')) if ((await b.evaluate((e: Element) => e.textContent)).trim() === item) return b.click();
    throw new Error(`메뉴에 ${item} 없음`);
  };
  const menusYaml = () => readText(join(ws.docs, "_site/menus.yaml"));

  test("TC-UI-27 폴더 트리: 폴더 아이콘, 폴더 추가(한글 이름이면 slug 자동)·이름 바꾸기·하위 폴더를 그 자리에서", async () => {
    await open("/sdlc/process/guide", "샘플 프로세스 가이드");
    assert.ok(await page.$('[data-row="m:process"] svg.lucide-folder-open'), "펼친 폴더 아이콘");
    await page.click('button[aria-label="폴더 추가"]');
    await page.type('input[aria-label="새 폴더 이름"]', "임시 폴더");
    await page.keyboard.press("Enter");
    await clickConfirm("추가");
    await waitFor(async () => /name: 임시 폴더/.test(menusYaml()), 5000, "menus.yaml에 폴더");
    const slug = /slug: (folder-[a-z0-9]+)\n\s+name: 임시 폴더/.exec(menusYaml())![1];
    await page.waitForSelector(`[data-row="m:${slug}"]`, { timeout: 10_000 });

    await rowMenu(`m:${slug}`, "이름 바꾸기");
    const input = await page.waitForSelector('input[aria-label="폴더 이름"]');
    await input.evaluate((e: HTMLInputElement) => e.select());
    await page.keyboard.type("바뀐 폴더");
    await page.keyboard.press("Enter");
    await clickConfirm("저장");
    await waitFor(async () => /name: 바뀐 폴더/.test(menusYaml()), 5000, "이름 변경");
    await page.waitForSelector('input[aria-label="폴더 이름"]', { hidden: true });

    await rowMenu(`m:${slug}`, "하위 폴더 추가");
    await page.type('input[aria-label="새 폴더 이름"]', "Sub Folder");
    await page.keyboard.press("Enter");
    await clickConfirm("추가");
    await page.waitForSelector('[data-row="m:sub-folder"]', { timeout: 10_000 });
    assert.match(menusYaml(), new RegExp(`slug: ${slug}\\n\\s+name: 바뀐 폴더\\n\\s+menus:\\n\\s+- slug: sub-folder`));
  });

  test("TC-UI-28 끌어서 놓기: 문서를 다른 문서 안(하위 문서)으로는 확인 후, 같은 자리 순서는 바로, 폴더는 다른 폴더 안으로", async () => {
    await upload(srv.url, { menu: "notes", title: "트리 상위", slug: "tree-1" }, [["t1.md", "# 상위"]]);
    await upload(srv.url, { menu: "notes", title: "트리 하위", slug: "tree-2" }, [["t2.md", "# 하위"]]);
    await open("/sdlc/notes/tree-2", "하위");
    await page.waitForSelector('[data-row="d:notes/tree-1"]');
    await dnd("d:notes/tree-2", "d:notes/tree-1", "inside");
    await clickConfirm("옮기기");
    await waitFor(async () => existsSync(join(ws.docs, "notes/tree-1/tree-2/meta.yaml")), 5000, "하위 문서 폴더로 옮김");
    // 옮긴 문서는 상위 문서 아래 줄에 들여 쓰여 보이고, 주소는 그대로
    await page.waitForFunction(() => {
      const p = document.querySelector('[data-row="d:notes/tree-1"]')?.closest("li");
      return !!p?.querySelector('[data-row="d:notes/tree-2"]');
    }, { timeout: 10_000 });
    assert.equal(new URL(page.url()).pathname, "/sdlc/notes/tree-2");
    // 하위 문서 접기
    await page.click('button[aria-label="트리 상위 하위 문서 접기"]');
    await page.waitForSelector('[data-row="d:notes/tree-2"]', { hidden: true });
    await page.click('button[aria-label="트리 상위 하위 문서 펼치기"]');

    // 같은 자리 순서: 확인 창 없이 바로
    await dnd("d:notes/tree-1", "d:notes/minutes", "before");
    await waitFor(async () => meta("notes", "tree-1").order === meta("notes", "minutes").order - 1, 5000, "순서 저장(주간 회의록 바로 앞)");
    assert.equal(await page.$("dialog[open]"), null);
    await page.waitForFunction(() => {
      const rows = [...document.querySelectorAll('[data-row^="d:notes/"]')].map((e) => e.getAttribute("data-row"));
      return rows.indexOf("d:notes/tree-1") < rows.indexOf("d:notes/minutes");
    }, { timeout: 10_000 });

    // 폴더를 다른 폴더 안으로
    await dnd("m:notes", "m:process", "inside");
    await clickConfirm("옮기기");
    await waitFor(async () => /\n {8}- slug: notes/.test(menusYaml()), 5000, "하위 폴더로");
    await page.waitForFunction(() => !!document.querySelector('[data-row="m:process"]')?.closest("li")?.querySelector('[data-row="m:notes"]'), { timeout: 10_000 });
    await dnd("m:notes", "m:process", "after");
    await clickConfirm("옮기기");
    await waitFor(async () => /\n {4}- slug: notes/.test(menusYaml()), 5000, "최상위로 되돌림");
  });

  test("TC-UI-29 문서 메뉴의 하위 문서 추가: 업로드 창에 위치가 고정되고, 만든 문서는 상위 문서 폴더 안에", async () => {
    await open("/sdlc/notes/tree-1", "상위");
    await rowMenu("d:notes/tree-1", "하위 문서 추가");
    await page.waitForSelector("dialog[open]");
    for (const b of await page.$$("dialog[open] button")) if ((await b.evaluate((e: Element) => e.textContent)).trim() === "새 Markdown 문서") await b.click();
    const where = await page.$$eval("dialog[open] select", (ss: HTMLSelectElement[]) => ss.map((s) => [s.value, s.disabled]));
    assert.deepEqual(where.find(([v]: [string, boolean]) => v === "tree-1"), ["tree-1", true], "위치: 트리 상위 아래(바꿀 수 없음)");
    await page.type('dialog[open] input[placeholder="예: 로그인 시퀀스 다이어그램"]', "Child Memo");
    for (const b of await page.$$("dialog[open] button")) if ((await b.evaluate((e: Element) => e.textContent)).trim() === "만들고 편집하기") { await b.click(); break; }
    await clickConfirm("만들기");
    await page.waitForFunction(() => location.pathname === "/sdlc/notes/child-memo", { timeout: 10_000 });
    assert.ok(existsSync(join(ws.docs, "notes/tree-1/child-memo/meta.yaml")));
  });

  test("TC-UI-30 폴더 삭제: 폴더 이름을 입력해야 삭제되고, 안의 문서는 휴지통으로 간다", async () => {
    await call(srv.url, "POST", "/api/menus", { category: "sdlc", name: "Del Me" });
    await upload(srv.url, { menu: "del-me", title: "지울 문서", slug: "gone" }, [["g.md", "# g"]]);
    await open("/sdlc/del-me/gone", "지울 문서");
    await rowMenu("m:del-me", "폴더 삭제");
    await page.waitForSelector('input[aria-label="삭제할 폴더 이름"]');
    const del = async () => {
      for (const b of await page.$$("dialog[open] button")) if ((await b.evaluate((e: Element) => e.textContent)).trim() === "삭제") return b;
    };
    assert.equal(await (await del()).evaluate((b: HTMLButtonElement) => b.disabled), true, "이름을 넣기 전에는 꺼짐");
    await page.type('input[aria-label="삭제할 폴더 이름"]', "Del Me");
    await (await del()).click();
    await page.waitForFunction(() => location.pathname === "/sdlc", { timeout: 10_000 });
    assert.doesNotMatch(menusYaml(), /del-me/);
    assert.ok((await call(srv.url, "GET", "/api/trash")).body.some((x: any) => x.doc === "gone"));
  });

  test("TC-UI-31 한글 입력 중 Enter(조합 중 keydown + 조합 끝 keydown 두 번)로 폴더를 만들어도 확인 창이 취소되지 않는다", async () => {
    await open("/sdlc/process/guide", "샘플 프로세스 가이드");
    await page.click('button[aria-label="폴더 추가"]');
    await page.type('input[aria-label="새 폴더 이름"]', "한글이름");
    // 맥 크롬 한글 입력기: Enter를 치면 조합 중(isComposing, keyCode 229) keydown이 먼저 오고, 조합이 끝난 뒤 Enter keydown이 한 번 더 온다
    await page.$eval('input[aria-label="새 폴더 이름"]', (el: HTMLInputElement) =>
      el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", keyCode: 229, isComposing: true, bubbles: true, cancelable: true })));
    await new Promise((r) => setTimeout(r, 30));
    await page.keyboard.press("Enter");
    await new Promise((r) => setTimeout(r, 200));
    assert.ok(await page.$("dialog[open]"), "확인 창이 열려 있어야 한다");
    await clickConfirm("추가");
    await waitFor(async () => /name: 한글이름/.test(menusYaml()), 5000, "폴더 생성");
  });

  test("TC-UI-12 없는 문서·없는 대분류는 안내 화면", async () => {
    await nav(WEB + "/sdlc/notes/nope");
    await page.waitForFunction(() => document.body.innerText.includes("문서를 열 수 없습니다"), { timeout: 10_000 });
    await nav(WEB + "/ghost");
    await page.waitForFunction(() => document.body.innerText.includes("없는 대분류입니다"), { timeout: 10_000 });
  });
});
