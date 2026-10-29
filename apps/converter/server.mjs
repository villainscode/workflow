// 변환 서버(컨테이너 안). POST /convert?ext=.pptx 본문 = 원본 파일 → PDF. GET /ping → ok
// LibreOffice는 한 번에 하나씩 돌린다(같은 프로필을 동시에 쓰면 실패한다). 의존성 없이 node 기본 모듈만 쓴다.
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const EXT = new Set([".pptx", ".ppt", ".docx", ".doc", ".odt", ".odp", ".xlsx", ".xls", ".ods"]);
const MAX = 50 * 1024 * 1024;
let queue = Promise.resolve();

function convert(data, ext) {
  const run = queue.then(async () => {
    const dir = await mkdtemp(join(tmpdir(), "conv-"));
    try {
      const src = join(dir, `in${ext}`);
      await writeFile(src, data);
      await new Promise((ok, no) => execFile("soffice", ["--headless", "--norestore", `-env:UserInstallation=file:///tmp/lo-profile`,
        "--convert-to", "pdf", "--outdir", dir, src], { timeout: 120_000 }, (err, _o, stderr) => (err ? no(new Error(stderr || err.message)) : ok())));
      return await readFile(join(dir, "in.pdf"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  queue = run.catch(() => {});
  return run;
}

createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  if (req.method === "GET" && url.pathname === "/ping") return res.end("ok");
  if (req.method !== "POST" || url.pathname !== "/convert") { res.statusCode = 404; return res.end("not found"); }
  const ext = (url.searchParams.get("ext") ?? "").toLowerCase();
  if (!EXT.has(ext)) { res.statusCode = 400; return res.end(`지원하지 않는 형식: ${ext}`); }
  const chunks = [];
  let size = 0;
  for await (const c of req) { size += c.length; if (size > MAX) { res.statusCode = 413; return res.end("too large"); } chunks.push(c); }
  try {
    const pdf = await convert(Buffer.concat(chunks), ext);
    res.writeHead(200, { "content-type": "application/pdf", "content-length": pdf.length });
    res.end(pdf);
  } catch (e) {
    res.statusCode = 500;
    res.end(String(e.message).slice(0, 500));
  }
}).listen(8080, () => console.log("converter :8080"));
