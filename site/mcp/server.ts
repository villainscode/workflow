import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readJson, registerTools, ToolError, type UploadFile } from "@workflow/mcp-tools";

/**
 * workflow-docs MCP 서버(로컬, stdio). 도구 정의는 packages/mcp-tools(원격 MCP와 공용)에 있고, 여기는 로컬 사이트 API 호출과
 * 로컬 파일 읽기만 맡는다. 사이트 서버(`cd site && npm run dev`)가 켜져 있어야 한다.
 * stdout은 MCP 통신에 쓰이므로 로그는 stderr로만 남긴다.
 */

const API = (process.env.WORKFLOW_API ?? "http://127.0.0.1:5174").replace(/\/$/, "");
const WEB = (process.env.WORKFLOW_WEB ?? "http://localhost:8000").replace(/\/$/, "");
// 상대 경로 파일은 리포 루트(Claude Code가 이 서버를 띄우는 위치) 기준으로 읽는다
const ROOT = process.env.WORKFLOW_ROOT ?? process.cwd();

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    // 사이트가 Claude Code의 변경을 알아보고 열린 화면에 알리도록 표시한다(3.4)
    res = await fetch(`${API}/api${path}`, { ...init, headers: { ...(init?.headers as Record<string, string> | undefined), "x-workflow-agent": "claude-code" } });
  } catch {
    throw new ToolError(`사이트 서버(${API})에 연결할 수 없습니다. 리포에서 \`cd site && npm run dev\`로 먼저 실행하세요.`);
  }
  return readJson<T>(res, path);
}

/** 파일·폴더 경로를 업로드 목록으로 펼친다. 폴더는 폴더 이름부터의 상대 경로를 유지한다 */
function collectFiles(paths: string[]): UploadFile[] {
  const out: UploadFile[] = [];
  for (const p of paths) {
    const abs = isAbsolute(p) ? p : resolve(ROOT, p);
    let st;
    try { st = statSync(abs); } catch { throw new ToolError(`파일을 찾을 수 없습니다: ${p}`); }
    if (st.isDirectory()) {
      const walk = (dir: string): void => readdirSync(dir, { withFileTypes: true }).forEach((e) => {
        if (e.name.startsWith(".")) return;
        const f = join(dir, e.name);
        if (e.isDirectory()) walk(f); else out.push({ path: join(basename(abs), relative(abs, f)), data: readFileSync(f) });
      });
      walk(abs);
    } else out.push({ path: basename(abs), data: readFileSync(abs) });
  }
  if (out.length === 0) throw new ToolError("올릴 파일이 없습니다");
  return out;
}

const server = new McpServer({ name: "workflow-docs", version: "0.1.0" });
registerTools(server, {
  api, webBase: WEB,
  files: {
    schema: z.array(z.string()).min(1).describe("파일·폴더 경로(리포 루트 기준 상대 경로 또는 절대 경로)"),
    collect: (paths) => collectFiles(paths as string[]),
    how: "로컬 파일(들)이나 폴더로",
  },
});
await server.connect(new StdioServerTransport());
console.error(`workflow-docs MCP 서버 시작 (API ${API})`);
