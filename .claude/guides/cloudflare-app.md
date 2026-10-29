# Cloudflare 앱 「문서 탐색 워크플로우」 개발 가이드

4.0(`REQUIREMENT-4.0.md`)에서 로컬 사이트를 Cloudflare 위 팀용 서비스로 옮긴 것. 배포 절차·백업은 `apps/worker/README.md`, 테스트 케이스는 `TESTING.md` 2.7절.

- **`apps/worker`**(4.0 「문서 탐색 워크플로우」, 계획·진행은 `REQUIREMENT-4.0.md`): Hono Worker + D1(원본, `migrations/`) + R2(`ws/<id>/blobs/<sha256>` 내용 주소, `images/`). 같은 화면을 `VITE_CLOUD=1`로 빌드해 정적 파일로 낸다(`npm run build:web`, 주소 `/<워크스페이스>/<대분류>/…`, API `/api/w/<워크스페이스>/…`, `web/src/lib/base.ts`). 사용자 파일은 서명 토큰 경로 `/c/<토큰>/<메뉴>/<상위…>/<문서>/<버전>/<파일>`로 콘텐츠 도메인에서만 준다. 리포 `docs/` 가져오기는 `packages/cli/src/import.ts`(`--owner`로 첫 owner). 로그인은 Google만·초대제(`src/auth.ts`, 역할 owner·editor·viewer 검사는 `src/index.ts` 워크스페이스 미들웨어, 상태를 바꾸는 API는 Origin 검사). 로컬 실행 `cd apps/worker && npm run dev`(비밀값은 `.dev.vars`, `DEV_LOGIN=1`이면 로그인 화면에 개발용 이메일 로그인). 실시간은 워크스페이스 Durable Object(`src/live.ts`), PDF 변환은 Containers(`apps/converter`, LibreOffice), 원격 MCP는 `/mcp`(OAuth, `src/mcp.ts`·`src/consent.ts`). 배포 절차·백업은 `apps/worker/README.md`, CI는 `.github/workflows/workflow-app.yml`(develop → staging, main → production), 테스트 `npm test`(Vitest, Workers 런타임)·`npm run test:ui`. 규칙은 로컬 사이트(`site/server`)와 같게 유지한다: 한쪽을 고치면 다른 쪽과 양쪽 테스트(TESTING.md 2.4·2.7)도 맞춘다.
- **공통 로직 `packages/core`**(`@workflow/core`, 4.0 P1): 런타임 무관 TypeScript(`node:*` 없음). 텍스트 편집 어댑터(`textedit/`, 원래 `site/server/textedit/`), 버전 규칙(`versions`), slug, 조각 참조(`seg`), MIME, 검색 본문 추출. 로컬 사이트(서버·화면·MCP)와 Cloudflare Worker(`apps/`)가 함께 쓴다. 해시는 `@noble/hashes`(동기 sha256)라 Workers·브라우저에서도 그대로 돈다.

## 구성 요약

| 부분 | 파일 | Cloudflare |
|---|---|---|
| 진입점 | `src/index.ts`(OAuthProvider → `/mcp`는 `mcp.ts`, 나머지는 `app.ts`), `scheduled` → `cleanup.ts` | Worker |
| API·권한 | `src/app.ts`(워크스페이스 미들웨어: 로그인·역할·Origin 검사·변경 알림), `src/members.ts` | D1 |
| 로그인 | `src/auth.ts`(Google OIDC + PKCE, 세션 쿠키, 초대, 개발용 로그인, 원격 MCP 내부 호출 머리글) | D1 |
| 쓰기·읽기 | `src/write.ts`, `src/manage.ts`, `src/repo.ts`, `src/search.ts`, `src/export.ts` | D1 + R2 |
| 사용자 콘텐츠 | `src/content.ts`(서명 토큰 `/c/…`, `/i/…`), `src/token.ts` | R2, 콘텐츠 도메인 |
| 실시간 | `src/live.ts` | Durable Object(WebSocket) |
| 변환 | `src/convert.ts`, `apps/converter` | Containers |
| 원격 MCP | `src/mcp.ts`, `src/consent.ts`, `packages/mcp-tools` | OAuthProvider + KV |
| D1 스키마 | `migrations/0001~0003` | |

## 명령

```bash
cd apps/worker
npm run dev        # 화면 빌드(VITE_CLOUD=1) → 로컬 D1 마이그레이션 → wrangler dev(http://127.0.0.1:8787). 비밀값은 .dev.vars
npm run typecheck  # wrangler types + tsc
npm test           # Vitest(@cloudflare/vitest-plugin, Workers 런타임·로컬 D1·R2·DO)
npm run test:ui    # 화면 테스트(전역 puppeteer, 앱 127.0.0.1·콘텐츠 localhost로 출처를 나눔, PDF 변환은 로컬 Docker)
```

리포 `docs/` 가져오기: `npx tsx packages/cli/src/import.ts --url <Worker> --token <ADMIN_TOKEN> --ws <주소> --name <이름> [--owner <이메일>]`.
