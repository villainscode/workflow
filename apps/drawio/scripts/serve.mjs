// 로컬 draw.io 서버(6.0 V4): public/을 앱과 다른 포트(=다른 출처)로 준다. public/_headers의 헤더를 그대로 붙인다.
// 사용: npm run fetch && npm run serve   (PORT 기본 8010) → 로컬 사이트를 DRAWIO_ORIGIN=http://127.0.0.1:8010 으로 켠다
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import http from "node:http";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const pub = join(dirname(fileURLToPath(import.meta.url)), "..", "public");
if (!existsSync(join(pub, "index.html"))) { console.error("public/이 없습니다. 먼저 npm run fetch"); process.exit(1); }
const headers = Object.fromEntries(readFileSync(join(pub, "_headers"), "utf8").split("\n").filter((l) => /^\s+\S+:/.test(l))
  .map((l) => { const i = l.indexOf(":"); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".gif": "image/gif",
  ".json": "application/json", ".xml": "application/xml", ".txt": "text/plain", ".ico": "image/x-icon", ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".map": "application/json" };
const port = Number(process.env.PORT ?? 8010);
http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
  if (p.endsWith("/")) p += "index.html";
  const f = normalize(join(pub, p));
  if (!f.startsWith(pub) || !existsSync(f) || statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { "content-type": TYPES[extname(f)] ?? "application/octet-stream", ...headers });
  createReadStream(f).pipe(res);
}).listen(port, "127.0.0.1", () => console.log(`draw.io: http://127.0.0.1:${port}`));
