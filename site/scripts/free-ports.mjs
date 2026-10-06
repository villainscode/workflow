// npm run dev 전에 실행된다(predev). 개발 서버 포트를 이미 쓰고 있는 프로세스를 종료한다.
// 먼저 SIGTERM으로 정상 종료를 요청하고, 2초 안에 안 끝나면 SIGKILL로 강제 종료한다. (macOS·Linux의 lsof 사용)
import { execFileSync } from "node:child_process";

const ports = [5173, Number(process.env.PORT ?? 5174)];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function listeners(port) {
  try {
    return execFileSync("lsof", ["-ti", `tcp:${port}`, "-sTCP:LISTEN"], { encoding: "utf8" })
      .split("\n").filter(Boolean).map(Number).filter((pid) => pid !== process.pid);
  } catch {
    return []; // lsof는 찾은 프로세스가 없으면 종료 코드 1을 낸다
  }
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

for (const port of ports) {
  const pids = listeners(port);
  if (pids.length === 0) continue;
  console.log(`[free-ports] ${port} 포트를 쓰는 프로세스 종료: ${pids.join(", ")}`);
  for (const pid of pids) { try { process.kill(pid, "SIGTERM"); } catch { /* 이미 종료됨 */ } }
  for (let i = 0; i < 20 && pids.some(alive); i++) await sleep(100);
  for (const pid of pids.filter(alive)) {
    console.log(`[free-ports] ${pid}가 응답하지 않아 강제 종료합니다`);
    try { process.kill(pid, "SIGKILL"); } catch { /* 이미 종료됨 */ }
  }
}
