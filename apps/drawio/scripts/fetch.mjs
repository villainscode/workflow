// draw.io 정적 웹앱 준비(6.0 V4): GitHub 릴리스의 draw.war(zip)를 받아 public/에 풀고, Workers 정적 자산 한도와 응답 헤더를 맞춘다.
// 사용: node scripts/fetch.mjs [--env local|staging|production]   (DRAWIO_WAR=<파일>이면 받지 않고 그 파일을 쓴다)
// - 버전과 sha256을 고정한다(올릴 때는 아래 두 값을 바꾸고 apps/worker/README.md "draw.io 편집기"의 확인을 다시 한다)
// - Workers 정적 자산: 파일 20,000개, 파일당 25MiB까지(v32.6.1의 가장 큰 파일 js/integrate.min.js 20.2MB)
// - public/_headers: frame-ancestors(앱 출처만), connect-src 'self'(문서 내용이 draw.io 밖으로 나가지 않게), draw.io가 쓰는 unsafe-eval
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { unzipSync } from "fflate";

const VERSION = "v32.6.1";
const SHA256 = "44dd56958c8408963457dc98f04d2228408ac145c7aa1d8e6895d9c88d5e42aa";
const MAX_FILES = 20_000, MAX_FILE = 25 * 1024 * 1024;
// 이 출처의 화면만 draw.io를 iframe으로 열 수 있다
const ANCESTORS = {
  local: "http://127.0.0.1:* http://localhost:*",
  staging: "https://workflow-app-staging.villainscode.workers.dev",
  production: "https://workflow.simplite.net",
};

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const env = process.argv.includes("--env") ? process.argv[process.argv.indexOf("--env") + 1] : "local";
if (!ANCESTORS[env]) { console.error(`--env는 ${Object.keys(ANCESTORS).join("·")}`); process.exit(2); }

async function war() {
  if (process.env.DRAWIO_WAR) return readFileSync(process.env.DRAWIO_WAR);
  const cache = join(root, ".cache", `draw-${VERSION}.war`);
  if (existsSync(cache)) return readFileSync(cache);
  const url = `https://github.com/jgraph/drawio/releases/download/${VERSION}/draw.war`;
  console.log(`받는 중: ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`draw.war를 받지 못했습니다: ${res.status}`);
  const data = Buffer.from(await res.arrayBuffer());
  mkdirSync(dirname(cache), { recursive: true });
  writeFileSync(cache, data);
  return data;
}

const data = await war();
const sha = createHash("sha256").update(data).digest("hex");
if (sha !== SHA256) throw new Error(`draw.war sha256이 다릅니다: ${sha} (고정값 ${SHA256})`);
const files = Object.entries(unzipSync(new Uint8Array(data)))
  .filter(([p, d]) => !p.endsWith("/") && !/^(WEB-INF|META-INF)\//.test(p) && d.length >= 0);
if (files.length > MAX_FILES) throw new Error(`파일이 ${files.length}개로 Workers 정적 자산 한도(${MAX_FILES})를 넘습니다`);
const big = files.filter(([, d]) => d.length > MAX_FILE);
if (big.length) throw new Error(`25MiB를 넘는 파일: ${big.map(([p, d]) => `${p} ${(d.length / 1048576).toFixed(1)}MB`).join(", ")}`);

const out = join(root, "public");
rmSync(out, { recursive: true, force: true });
for (const [p, d] of files) {
  const f = join(out, p);
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, d);
}
const csp = [
  "default-src 'self'", "script-src 'self' 'unsafe-inline' 'unsafe-eval'", "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:", "font-src 'self' data:", "connect-src 'self'", "frame-src 'self'", "worker-src 'self' blob:",
  `frame-ancestors ${ANCESTORS[env]}`,
].join("; ");
writeFileSync(join(out, "_headers"), `/*\n  Content-Security-Policy: ${csp}\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: no-referrer\n`);
const largest = files.reduce((a, b) => (b[1].length > a[1].length ? b : a));
console.log(`draw.io ${VERSION} → public/ (${env}): 파일 ${files.length}개, 가장 큰 파일 ${largest[0]} ${(largest[1].length / 1048576).toFixed(1)}MB`);
