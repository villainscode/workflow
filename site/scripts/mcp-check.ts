// workflow-docs MCP 서버 점검: Claude Code와 같은 방식(stdio)으로 띄워 도구를 호출해 본다.
// 사용: cd site && npx tsx scripts/mcp-check.ts <아티팩트 HTML 경로>   (사이트 서버가 켜져 있어야 함)
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "../..");
const client = new Client({ name: "mcp-check", version: "0.0.1" });
await client.connect(new StdioClientTransport({ command: resolve(ROOT, "site/node_modules/.bin/tsx"), args: ["site/mcp/server.ts"], cwd: ROOT, stderr: "ignore" }));

const call = async (name: string, args: Record<string, unknown>) => {
  const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
  return { text: r.content.map((c) => c.text).join("\n"), error: !!r.isError };
};
const show = (label: string, r: { text: string; error: boolean }, lines = 6) =>
  console.log(`\n■ ${label}${r.error ? " [오류]" : ""}\n${r.text.split("\n").slice(0, lines).join("\n")}`);

const tools = await client.listTools();
console.log("도구:", tools.tools.map((t) => t.name).join(", "));
show("list_documents", await call("list_documents", { category: "sdlc" }), 8);
show("find_documents", await call("find_documents", { query: "리뷰 에이전트" }), 4);
show("create_menu", await call("create_menu", { category: "agent", name: "MCP 테스트", slug: "zz-mcp" }));
show("upload_document(아티팩트)", await call("upload_document", { menu: "MCP 테스트", title: "플랫폼팀 개발 환경", slug: "platform-env", filename: "platform-env.html", files: [process.argv[2]], origin: "https://claude.ai/artifact/9w3zrAXkgcpU26gTufpiGw" }));
show("get_document(이름으로)", await call("get_document", { ref: "Agent > MCP 테스트 > 플랫폼팀 개발 환경" }), 9);
const t = await call("get_text", { ref: "agent/zz-mcp/platform-env", limit: 8 });
show("get_text", t, 9);
const firstId = Number(/\[(\d+)\]/.exec(t.text.split("\n")[1])![1]);
const firstText = t.text.split("\n")[1].replace(/^.*?: /, "");
show("edit_text(조각 id)", await call("edit_text", { ref: "agent/zz-mcp/platform-env", changes: [{ segment: firstId, text: firstText + " (Claude 수정)" }], note: "제목 표시 확인" }));
show("edit_text(찾아 바꾸기, 여러 곳 → 거부)", await call("edit_text", { ref: "agent/zz-mcp/platform-env", changes: [{ find: "의", replace: "의" }] }), 2);
show("upload_document(HTML 사본)", await call("upload_document", { menu: "zz-mcp", title: "프로세스 사본", slug: "process-copy", files: ["docs/sprint-gitflow/process/v0.0/process.html"] }));
show("get_text(주소 seg 범위)", await call("get_text", { ref: "http://localhost:8000/agent/zz-mcp/process-copy?seg=1", context: 1 }), 5);
show("edit_text(찾아 바꾸기 1곳)", await call("edit_text", { ref: "http://localhost:8000/agent/zz-mcp/process-copy", changes: [{ find: "Git-flow 스프린트 개발 프로세스", replace: "Git-flow 스프린트 개발 프로세스 (MCP)", all: false }] }), 4);
show("release_document", await call("release_document", { ref: "agent/zz-mcp/process-copy" }));
show("이전 버전 편집 시도", await call("edit_text", { ref: "http://localhost:8000/agent/zz-mcp/process-copy?v=v0.0", changes: [{ segment: 1, text: "x" }] }), 2);
await client.close();
