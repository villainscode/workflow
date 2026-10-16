// npm run dev 전에 실행된다(predev). 개발 서버 포트를 이미 쓰고 있는 node 프로세스(이전에 띄운 개발 서버)를 종료한다.
// 먼저 SIGTERM으로 정상 종료를 요청하고, 2초 안에 안 끝나면 SIGKILL로 강제 종료한다. (macOS·Linux의 lsof 사용)
// node가 아닌 프로세스는 종료하지 않고 알린 뒤 멈춘다.
import { execFileSync } from "node:child_process";

const ports = [Number(process.env.WEB_PORT ?? 8000), Number(process.env.PORT ?? 5174)];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function listeners(port) {
  try {
    return execFileSync("lsof", ["-ti", `tcp:${port}`, "-sTCP:LISTEN"], { encoding: "utf8" })
      .split("\n").filter(Boolean).map(Number).filter((pid) => pid !== process.pid);
  } catch {
    return []; // lsof는 찾은 프로세스가 없으면 종료 코드 1을 낸다
  }
}

const command = (pid) => {
  try { return execFileSync("ps", ["-p", String(pid), "-o", "comm="], { encoding: "utf8" }).trim(); } catch { return ""; }
};
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

let blocked = false;
for (const port of ports) {
  const pids = listeners(port);
  const others = pids.filter((pid) => !/(^|\/)node$/.test(command(pid)));
  if (others.length) {
    blocked = true;
    console.error(`[free-ports] ${port} 포트를 node가 아닌 프로세스가 쓰고 있어 종료하지 않습니다: ${others.map((p) => `${p} ${command(p)}`).join(", ")}`);
  }
  const nodes = pids.filter((pid) => !others.includes(pid));
  if (nodes.length === 0) continue;
  console.log(`[free-ports] ${port} 포트를 쓰는 개발 서버 종료: ${nodes.join(", ")}`);
  for (const pid of nodes) { try { process.kill(pid, "SIGTERM"); } catch { /* 이미 종료됨 */ } }
  for (let i = 0; i < 20 && nodes.some(alive); i++) await sleep(100);
  for (const pid of nodes.filter(alive)) {
    console.log(`[free-ports] ${pid}가 응답하지 않아 강제 종료합니다`);
    try { process.kill(pid, "SIGKILL"); } catch { /* 이미 종료됨 */ }
  }
}
if (blocked) process.exit(1);
