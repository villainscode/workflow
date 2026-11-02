// draw.io embed 왕복 회귀 시험(6.0 V4, V0 스파이크 1을 옮김). draw.io 버전을 올릴 때 돌린다: npm run fetch && node scripts/check.mjs
// public/을 다른 출처(127.0.0.1:<빈 포트>)로 띄우고, 앱 화면(DrawioEditor)과 같은 순서로 주고받는다:
// init → load(XML) → export xmlsvg(응답 format은 "svg") → 그 SVG를 다시 load → export xml에 처음 상자가 남아 있으면 통과. 바깥 요청이 있으면 실패.
// puppeteer는 사이트 화면 테스트와 같이 전역 mermaid-cli의 것을 쓴다(npm i -g @mermaid-js/mermaid-cli)
import { execSync } from "node:child_process";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const pub = join(dirname(fileURLToPath(import.meta.url)), "..", "public");
if (!existsSync(join(pub, "index.html"))) { console.error("public/이 없습니다. 먼저 npm run fetch"); process.exit(1); }
const puppeteer = createRequire(import.meta.url)(join(execSync("npm root -g", { encoding: "utf8" }).trim(), "@mermaid-js/mermaid-cli/node_modules/puppeteer"));
const headers = Object.fromEntries(readFileSync(join(pub, "_headers"), "utf8").split("\n").filter((l) => /^\s+\S+:/.test(l))
  .map((l) => { const i = l.indexOf(":"); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".gif": "image/gif", ".json": "application/json", ".xml": "application/xml" };
const listen = (srv) => new Promise((ok) => srv.listen(0, "127.0.0.1", () => ok(srv.address().port)));

const drawPort = await listen(http.createServer((q, r) => {
  let p = decodeURIComponent(new URL(q.url, "http://x").pathname); if (p.endsWith("/")) p += "index.html";
  const f = normalize(join(pub, p));
  if (!f.startsWith(pub) || !existsSync(f) || statSync(f).isDirectory()) { r.writeHead(404); return r.end(); }
  r.writeHead(200, { "content-type": TYPES[extname(f)] ?? "application/octet-stream", ...headers }); createReadStream(f).pipe(r);
}));
const DRAW = `http://127.0.0.1:${drawPort}`;
const parent = `<!doctype html><meta charset=utf-8><body style="margin:0"><iframe id=f style="width:1200px;height:800px;border:0" src="${DRAW}/?embed=1&proto=json&spin=1&stealth=1&lockdown=1&saveAndExit=1&lang=ko"></iframe><script>
const DRAW="${DRAW}", f=document.getElementById("f"); window.log=[]; window.rejected=0;
const XML='<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="a" value="원본 상자" style="rounded=1;" vertex="1" parent="1"><mxGeometry x="40" y="40" width="160" height="60" as="geometry"/></mxCell></root></mxGraphModel>';
const post=(m)=>f.contentWindow.postMessage(JSON.stringify(m), DRAW); let step=0;
window.addEventListener("message",(e)=>{ if(e.origin!==DRAW||e.source!==f.contentWindow){window.rejected++;return;}
  const m=JSON.parse(e.data); log.push(m.event+(m.format?":"+m.format:""));
  if(m.event==="init") post({action:"load",xml:XML,autosave:0});
  else if(m.event==="load"&&step===0){step=1;post({action:"export",format:"xmlsvg"});}
  else if(m.event==="export"&&step===1){step=2; const b=atob(m.data.split(",")[1]); window.svg=new TextDecoder().decode(Uint8Array.from(b,(c)=>c.charCodeAt(0))); post({action:"load",xml:window.svg});}
  else if(m.event==="load"&&step===2){step=3;post({action:"export",format:"xml"});}
  else if(m.event==="export"&&step===3){window.xml2=m.data||m.xml;} });
</script>`;
const appPort = await listen(http.createServer((q, r) => { r.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-security-policy": `frame-src ${DRAW}; script-src 'unsafe-inline'; default-src 'self'` }); r.end(parent); }));
const browser = await puppeteer.launch({ headless: "new" });
const external = new Set();
try {
  const page = await browser.newPage();
  const cdp = await page.createCDPSession(); await cdp.send("Network.enable");
  cdp.on("Network.requestWillBeSent", (e) => { if (!/^(http:\/\/127\.0\.0\.1:|data:|blob:|about:)/.test(e.request.url)) external.add(e.request.url.slice(0, 100)); });
  const t0 = Date.now();
  await page.goto(`http://127.0.0.1:${appPort}/`, { waitUntil: "load" });
  await page.waitForFunction(() => window.xml2, { timeout: 60_000 });
  const r = await page.evaluate(() => ({ log, rejected, content: /^<svg[^>]*\scontent="/.test(svg), restored: String(xml2).includes("원본 상자") }));
  const ok = r.content && r.restored && r.rejected === 0 && external.size === 0;
  console.log(JSON.stringify({ ok, ms: Date.now() - t0, ...r, external: [...external] }));
  process.exitCode = ok ? 0 : 1;
} finally { await browser.close(); process.exit(); }
