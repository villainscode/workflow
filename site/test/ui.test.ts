// 화면 테스트. 임시 docs로 API 서버와 Vite 화면을 따로 띄우고, 전역 설치된 puppeteer(mermaid-cli에 포함)로 조작한다.
// puppeteer가 없으면 건너뛴다. SSE가 계속 열려 있어 networkidle을 기다리지 않고 요소를 기다린다.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { execSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
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

  test("TC-UI-12 없는 문서·없는 대분류는 안내 화면", async () => {
    await nav(WEB + "/sdlc/notes/nope");
    await page.waitForFunction(() => document.body.innerText.includes("문서를 열 수 없습니다"), { timeout: 10_000 });
    await nav(WEB + "/ghost");
    await page.waitForFunction(() => document.body.innerText.includes("없는 대분류입니다"), { timeout: 10_000 });
  });
});
