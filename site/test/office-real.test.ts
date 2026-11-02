// 실제 ONLYOFFICE Docs(docker)로 오피스 편집기 왕복(6.0 VO). 자동 테스트 묶음(npm test)에는 넣지 않고 손으로 돌린다:
//   docker run -d --name wf-office -p 18090:80 -e JWT_ENABLED=true -e JWT_SECRET=real-office-secret -e JWT_HEADER=Authorization \
//     -e ALLOW_PRIVATE_IP_ADDRESS=true --add-host=host.docker.internal:host-gateway onlyoffice/documentserver
//   ONLYOFFICE_REAL_URL=http://127.0.0.1:18090 ONLYOFFICE_REAL_SECRET=real-office-secret npm run test:office-real
// 편집 설정(JWT)으로 편집기를 열고 글자를 입력한 뒤 닫으면, 오피스 서버가 서명한 저장 콜백(status 2)으로 받은 파일이 수정본이 된다.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import { join } from "node:path";
import { strFromU8, unzipSync } from "fflate";
import { call, freePort, makeWorkspace, startServer, upload, waitFor, type TestServer } from "./helpers.ts";

const REAL = process.env.ONLYOFFICE_REAL_URL ?? "";
const SECRET = process.env.ONLYOFFICE_REAL_SECRET ?? "";
const PUPPETEER = (() => {
  try { return join(execSync("npm root -g", { encoding: "utf8" }).trim(), "@mermaid-js/mermaid-cli/node_modules/puppeteer"); } catch { return ""; }
})();
const skip = !REAL || !SECRET ? "ONLYOFFICE_REAL_URL·ONLYOFFICE_REAL_SECRET 없음(실제 오피스 서버 docker가 필요)" : !existsSync(PUPPETEER) ? "puppeteer 없음" : false;

const ws = makeWorkspace();
let srv: TestServer;
let page: Server;
let browser: any;

describe("실제 오피스 서버 왕복(6.0 VO)", { skip }, () => {
  before(async () => {
    srv = await startServer(ws, { ONLYOFFICE_URL: REAL, ONLYOFFICE_JWT_SECRET: SECRET });
    browser = await createRequire(import.meta.url)(PUPPETEER).launch({ headless: "new" });
  });
  after(async () => { await browser?.close(); page?.close(); await srv?.stop(); ws.cleanup(); });

  test("TC-VO-12 DOCX를 편집 설정으로 열고 글자를 넣어 닫으면 저장 콜백 → 수정본(office), 저장 파일에 입력한 글자가 있다", async () => {
    const docx = readFileSync(join(import.meta.dirname, "../../packages/core/test/fixtures/struct.docx"));
    assert.equal((await upload(srv.url, { menu: "notes", title: "실제 오피스", slug: "real-office" }, [["report.docx", docx]])).status, 200);
    const D = "/api/docs/notes/real-office";
    const s = (await call(srv.url, "POST", `${D}/office/session`)).body;
    // 앱 화면 대신 편집기만 띄우는 페이지
    const port = await freePort();
    page = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<!doctype html><html><body style="margin:0"><div id="ed"></div><script src="${s.apiUrl}"></script><script>
        window.ed = new DocsAPI.DocEditor("ed", Object.assign(${JSON.stringify(s.config)}, { width: "1200px", height: "800px",
          events: { onDocumentReady: () => { window.ready = true; } } }));
      </script></body></html>`);
    }).listen(port, "127.0.0.1");
    const tab = await browser.newPage();
    await tab.setViewport({ width: 1200, height: 800 });
    await tab.goto(`http://127.0.0.1:${port}/`, { waitUntil: "domcontentloaded" });
    await tab.waitForFunction(() => (window as any).ready === true, { timeout: 90_000 });
    await new Promise((r) => setTimeout(r, 1500));
    await tab.mouse.click(600, 400);
    await tab.keyboard.type("VO round trip 확인");
    await new Promise((r) => setTimeout(r, 3000));
    await tab.evaluate(() => (window as any).ed.destroyEditor());
    await waitFor(async () => (await call(srv.url, "GET", `${D}/office`)).body.rev === 1, 90_000, "저장 콜백");
    const st = (await call(srv.url, "GET", `${D}/office`)).body;
    assert.equal(st.active, false);
    const revs = (await call(srv.url, "GET", `${D}/revisions`)).body;
    assert.equal(revs.revisions[0].source, "office");
    const w = (await call(srv.url, "GET", `${D}/work`)).body;
    const f = w.files.find((x: { path: string }) => x.path === "report.docx");
    const saved = new Uint8Array(await (await fetch(srv.url + f.url)).arrayBuffer());
    assert.match(strFromU8(unzipSync(saved)["word/document.xml"]), /VO round trip/);
  });
});
