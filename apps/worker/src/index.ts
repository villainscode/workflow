import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { app } from "./app.ts";
import type { Bindings } from "./env.ts";
import { mcpHandler } from "./mcp.ts";
import { cleanup } from "./cleanup.ts";

/**
 * 문서 탐색 워크플로우 Worker 진입점(REQUIREMENT-4.0).
 *   /mcp                      원격 MCP(4.0 P6). OAuth 액세스 토큰이 있어야 하고 mcp.ts가 받는다
 *   /authorize                Claude Code 연결 동의 화면(consent.ts). /oauth/token·/oauth/register·/.well-known/*은 OAuthProvider가 답한다
 *   그 밖                      앱(app.ts: API, 콘텐츠 도메인, 화면 정적 파일)
 * OAuthProvider는 MCP 자원 주소(APP_ORIGIN/mcp)가 필요해 첫 요청 때 환경값으로 만든다.
 */
export { Live } from "./live.ts";
export { Converter } from "./convert.ts";

let provider: OAuthProvider<Bindings> | undefined;

export default {
  fetch(request: Request, env: Bindings, ctx: ExecutionContext) {
    provider ??= new OAuthProvider<Bindings>({
      apiRoute: "/mcp",
      apiHandler: mcpHandler,
      defaultHandler: app as unknown as ExportedHandler<Bindings>,
      authorizeEndpoint: "/authorize",
      tokenEndpoint: "/oauth/token",
      clientRegistrationEndpoint: "/oauth/register",
      scopesSupported: ["mcp"],
      resourceMetadata: { resource: `${env.APP_ORIGIN}/mcp`, authorization_servers: [env.APP_ORIGIN] },
      requiredScopes: ["mcp"],
    });
    return provider.fetch(request, env, ctx);
  },
  // 매일 정리(wrangler.jsonc triggers.crons)
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(cleanup(env));
  },
} satisfies ExportedHandler<Bindings>;
