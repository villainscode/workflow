// 화면 테스트. 임시 docs로 API 서버와 Vite 화면을 따로 띄우고, 전역 설치된 puppeteer(mermaid-cli에 포함)로 조작한다.
// puppeteer가 없으면 건너뛴다. SSE가 계속 열려 있어 networkidle을 기다리지 않고 요소를 기다린다.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { execSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { parse } from "yaml";
import { freePort, makeWorkspace, readText, SITE, startServer, upload, waitFor, type TestServer } from "./helpers.ts";

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

  test("TC-UI-02 HTML 문서는 sandbox iframe(allow-same-origin 없음)으로 열리고 버전은 draft로 표시", async () => {
    await open("/sdlc/process/guide", "샘플 프로세스 가이드");
    const frame = await page.waitForSelector('iframe[title="문서"]');
    const [src, sandbox] = await frame.evaluate((f: HTMLIFrameElement) => [f.getAttribute("src"), f.getAttribute("sandbox")]);
    assert.match(src, /^\/files\/process\/guide\/v0\.0\/guide\.html\?h=[0-9a-f]{12}$/);
    assert.ok(sandbox.includes("allow-scripts") && !sandbox.includes("allow-same-origin"));
    const option = await page.$eval('select[aria-label="버전"]', (s: HTMLSelectElement) => s.selectedOptions[0].textContent);
    assert.equal(option, "draft (최신)");
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
    await page.waitForFunction(() => document.querySelector(".md-body h1")?.textContent === "회의록", { timeout: 10_000 });
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

  test("TC-UI-12 없는 문서·없는 대분류는 안내 화면", async () => {
    await nav(WEB + "/sdlc/notes/nope");
    await page.waitForFunction(() => document.body.innerText.includes("문서를 열 수 없습니다"), { timeout: 10_000 });
    await nav(WEB + "/ghost");
    await page.waitForFunction(() => document.body.innerText.includes("없는 대분류입니다"), { timeout: 10_000 });
  });
});
