import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { readJson, registerTools, ToolError, type UploadFile } from "@workflow/mcp-tools";
import { app } from "./app.ts";
import { internalToken } from "./auth.ts";
import type { Bindings } from "./env.ts";

/**
 * 원격 MCP(4.0 P6). Claude Code가 `claude mcp add --transport http workflow-docs https://workflow.simplite.net/mcp`로 붙는다.
 * OAuth(index.ts의 OAuthProvider)를 통과한 요청만 오고, ctx.props에 동의 화면에서 고른 사용자·워크스페이스가 있다.
 * 도구는 로컬과 같은 packages/mcp-tools이고, 이 Worker의 앱 API를 그 사용자로 부른다(권한·실시간 알림이 화면과 같다).
 * 상태 없는 Streamable HTTP(JSON 응답)라 요청마다 서버를 새로 만든다.
 */

export interface McpProps { userId: number; email: string; ws: string }

/** 올릴 파일 하나에 너무 큰 내용이 오지 않게(요청 본문 100MB 한도 안에서 여유) */
const MAX_BYTES = 20 * 1024 * 1024;

const FILES = z.array(z.object({
  path: z.string().describe("저장할 상대 경로(예: guide.html, img/a.png)"),
  content: z.string().describe("파일 내용. 글자 파일은 그대로, 이미지·DOCX 같은 이진 파일은 base64"),
  encoding: z.enum(["utf8", "base64"]).optional().describe("content 형식(기본 utf8)"),
})).min(1);

function decodeFiles(input: unknown): UploadFile[] {
  const out = (input as z.infer<typeof FILES>).map((f) => ({
    path: f.path,
    data: f.encoding === "base64" ? Uint8Array.from(atob(f.content), (c) => c.charCodeAt(0)) : new TextEncoder().encode(f.content),
  }));
  if (out.reduce((n, f) => n + f.data.byteLength, 0) > MAX_BYTES) throw new ToolError("한 번에 20MB까지 올릴 수 있습니다. 더 큰 파일은 사이트 화면에서 올리세요");
  return out;
}

export const mcpHandler = {
  async fetch(request: Request, env: Bindings, ctx: ExecutionContext): Promise<Response> {
    // OAuthProvider가 넣는 값: 동의 화면에서 completeAuthorization에 준 props
    const { userId, ws } = ctx.props as McpProps;
    const origin = new URL(request.url).origin;
    const server = new McpServer({ name: "workflow-docs", version: "0.2.0" });
    registerTools(server, {
      webBase: `${origin}/${ws}`,
      async api<T>(path: string, init?: RequestInit) {
        const headers = new Headers(init?.headers);
        headers.set("x-workflow-agent", "claude-code");
        headers.set("x-wf-internal", await internalToken(env.SIGNING_KEY, userId));
        headers.set("origin", origin);
        const res = await app.fetch(new Request(`${origin}/api/w/${ws}${path}`, { ...init, headers }), env, ctx);
        return readJson<T>(res, path);
      },
      files: { schema: FILES, collect: decodeFiles, how: "파일 내용(글자 또는 base64)으로" },
    });
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    return transport.handleRequest(request);
  },
};
