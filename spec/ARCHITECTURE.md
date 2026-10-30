# 아키텍처·기술 스택

업무 문서 사이트(로컬)와 「문서 탐색 워크플로우」(Cloudflare)의 구성과 쓰는 기술. 리포 구성·기술 선택의 정본이다. 2026-10-29 기준, 버전은 각 `package.json`의 범위다.
설계 결정과 근거는 `spec/REQUIREMENT-4.0.md`(D-37~D-46), 배포 절차는 `apps/worker/README.md`, 작업 방법(명령·규칙)은 `.claude/`.

## 1. 리포 구성

npm workspaces 모노레포. `npm install`은 리포 루트에서 한 번 한다.

| 위치 | 역할 |
|---|---|
| `docs/` | 설계 문서 원본(메뉴 → 문서 → 버전). 구조는 `.claude/guides/docs-structure.md` |
| `spec/` | 요구사항·결정(`REQUIREMENT.md` 1.x, `-2.0` 텍스트 편집, `-3.0` Claude Code 연결, `-4.0` Cloudflare, `-5.0` 문서 편집기 계획), 테스트 케이스(`TESTING.md`), 이 문서 |
| `site/` | 로컬 업무 문서 사이트. 리포 `docs/`가 원본이고 오프라인·원본 편집용으로 남겼다 |
| `apps/worker/` | Cloudflare 앱. D1·R2가 원본 |
| `apps/converter/` | PDF 변환 컨테이너 |
| `packages/core/` | 두 앱이 함께 쓰는 규칙: 텍스트 편집 어댑터, 버전 번호, slug, 업로드 정리 |
| `packages/mcp-tools/` | MCP 도구 정의. 로컬 stdio 서버와 원격 MCP가 같은 코드를 쓴다 |
| `packages/cli/` | 리포 `docs/`를 워크스페이스로 가져오는 CLI |
| `.claude/` | Claude Code 지침·규칙·작업 가이드·스킬·에이전트·훅(7절) |
| `.github/workflows/` | CI·배포(6절) |

공통: TypeScript 7, Node 24(로컬·CI), zod 4, yaml 2.

`packages/core`에는 `node:*` 모듈을 쓰지 않는다. 같은 코드가 Node, Workers, 브라우저에서 돌아야 해서다.

## 2. 화면

로컬과 Cloudflare가 같은 코드를 쓰고, Cloudflare용은 `VITE_CLOUD=1`로 따로 빌드한다(주소 앞에 워크스페이스가 붙는다).

| 분류 | 기술 |
|---|---|
| UI | React 19, React Router 8, TanStack Query 5 |
| 빌드·스타일 | Vite 8, Tailwind CSS 4, 아이콘 Lucide |
| Markdown 편집 | CodeMirror 6. MarkFlow 에디터를 가져와 고쳐 썼다(D-30) |
| PDF 편집(5.0 M6) | 화면 pdf.js(pdfjs-dist 6)로 쪽을 그리고 덧그릴 것을 놓은 뒤, 브라우저에서 pdf-lib로 그려 넣어 수정본으로 올린다. 한글은 나눔고딕(OFL, `web/public/fonts/`)을 harfbuzz wasm(harfbuzzjs)으로 쓴 글자만 잘라 넣는다(pdf-lib 자체 부분 글꼴은 한글이 빠진다, M0). 서버·Worker에는 글꼴·wasm을 싣지 않는다 |
| 슬라이드 편집(5.0 M4) | 렌더러는 노드 트리 → React 요소(innerHTML 없음). 글자 Tiptap 3(한글 IME), 이동·크기·맞춤선 react-moveable, 슬라이드 순서 @dnd-kit. 되돌리기는 core 역연산(immer·zustand 대신), 색은 덱 팔레트 + 브라우저 색 고르기(react-colorful 대신) |
| Markdown 미리보기 | unified(remark·rehype), KaTeX, highlight.js, Mermaid |
| 문서 뷰어 | DOCX는 docx-preview, XLSX·CSV는 SheetJS 0.20(공식 CDN 배포본), 버전 비교는 jsdiff |
| draw.io 보기 | 로컬은 drawio CLI가 SVG로 바꾼다. Cloudflare는 draw.io 공식 뷰어(viewer.diagrams.net)를 iframe으로 연다 |
| 실시간 반영 | 로컬은 SSE, Cloudflare는 WebSocket |

draw.io를 Cloudflare에서 서버 변환하지 않은 이유: draw.io 데스크톱은 Electron과 가상 화면이 필요해 컨테이너 이미지가 지나치게 커진다. 다이어그램 XML은 주소의 `#` 뒤에만 넣어 뷰어 서버로 전송되지 않지만, 뷰어 스크립트는 외부 사이트 것이다.

## 3. 로컬 사이트 서버 (`site/`)

| 분류 | 기술 |
|---|---|
| 서버 | Fastify 5 |
| 원본 | 리포 `docs/` 파일(yaml + 버전 폴더). chokidar가 바뀐 파일을 감시한다 |
| 색인·검색 | SQLite(better-sqlite3) + drizzle-orm. 서버가 켜질 때마다 파일에서 다시 만든다. 검색은 FTS5 trigram |
| 변환 | PPTX·DOCX → PDF는 LibreOffice, draw.io → SVG는 drawio CLI |
| MCP | stdio 서버(`@modelcontextprotocol/sdk` 1.32) |

## 4. Cloudflare 앱 (`apps/worker/`)

| 분류 | 기술 |
|---|---|
| 런타임 | Cloudflare Workers(Paid), compatibility_date 2026-10-01, `nodejs_compat` |
| API | Hono 4. 화면 정적 파일은 Workers Static Assets |
| DB | D1. SQL을 직접 쓰고 마이그레이션은 `migrations/0001~0003` |
| 파일 | R2. 파일은 sha256 이름으로 한 번만 저장한다. 편집기 이미지와 PDF 캐시도 R2 |
| 실시간 | Durable Objects, WebSocket Hibernation(쉬는 연결은 시간 요금 없음). 연결마다 사용자·보는 문서·보기/편집을 붙여(serializeAttachment) 접속자 목록을 보낸다(5.0 M7) |
| PDF 변환 | Cloudflare Containers(`@cloudflare/containers`, durable_object 스케줄링 + `images` 형식이라 `Converter`가 `start()`에 이미지 이름을 넣는다). 이미지는 Node 22(Debian) + LibreOffice + Noto CJK |
| 로그인 | Google OIDC를 직접 구현(인가 코드 + PKCE). 세션은 D1, 쿠키는 HttpOnly·SameSite=Lax |
| 권한 | 초대 링크로만 가입. 역할은 owner·editor·viewer |
| 원격 MCP | `@cloudflare/workers-oauth-provider` 1.2(OAuth 2.1, 동적 클라이언트 등록), MCP SDK의 Streamable HTTP(상태 없음). OAuth 기록은 KV |
| 운영 | 매일 정리 Cron, Workers Logs, Rate Limiting, zip 내보내기, D1 Time Travel(30일) |
| 도구 | wrangler 4 |

### 파일 구성 (`apps/worker/`)

| 부분 | 파일 | Cloudflare |
|---|---|---|
| 진입점 | `src/index.ts`(OAuthProvider → `/mcp`는 `mcp.ts`, 나머지는 `app.ts`), `scheduled` → `cleanup.ts` | Worker |
| API·권한 | `src/app.ts`(워크스페이스 미들웨어: 로그인·역할·Origin 검사·변경 알림), `src/members.ts` | D1 |
| 로그인 | `src/auth.ts`(Google OIDC + PKCE, 세션 쿠키, 초대, 개발용 로그인, 원격 MCP 내부 호출 머리글) | D1 |
| 쓰기·읽기 | `src/write.ts`, `src/manage.ts`, `src/repo.ts`, `src/search.ts`, `src/export.ts` | D1 + R2 |
| 편집기(5.0) | `src/revisions.ts`(수정본·작업본·버전으로 올리기), `src/structedit.ts`(구조 편집 연산 → 수정본), `src/deck.ts`(슬라이드 덱 연산·통째 쓰기·색인, rev 다시 적용), `src/assets.ts`(편집기 이미지) | D1 + R2 |
| 사용자 콘텐츠 | `src/content.ts`(서명 토큰 `/c/…`, `/i/…`), `src/token.ts` | R2, 콘텐츠 도메인 |
| 실시간 | `src/live.ts` | Durable Object(WebSocket) |
| 변환 | `src/convert.ts`, `apps/converter` | Containers |
| 원격 MCP | `src/mcp.ts`, `src/consent.ts`, `packages/mcp-tools` | OAuthProvider + KV |
| D1 스키마 | `migrations/0001~0004` | |

설계에서 바꾼 것과 이유:

- drizzle 대신 D1 SQL을 직접 쓴다. 쿼리가 단순하고 마이그레이션 파일과 1:1로 맞는다.
- Better Auth 대신 Google 로그인을 직접 구현했다. 로그인 수단이 Google 하나다(D-39).
- McpAgent 대신 MCP SDK의 기본 HTTP 연결을 쓴다. 도구가 모두 요청-응답이라 세션 상태가 필요 없다.

### 보안 경계

- 사용자가 올린 파일은 앱과 다른 도메인에서만 준다. 주소에는 12~24시간 유효한 서명 토큰이 들어간다. HTML·SVG에는 sandbox CSP를 붙인다.
- 콘텐츠 도메인은 앱 출처에만 CORS를 연다. 화면이 Markdown·표를 `fetch`로 읽기 때문이다.
- 상태를 바꾸는 API는 Origin이 앱 주소일 때만 받는다. 두 도메인이 같은 사이트(simplite.net)라 SameSite 쿠키만으로는 막히지 않는다.
- 로그인 API는 IP당 분당 20번, 쓰기 API는 분당 120번까지 받는다.

### 배포 환경

| 환경 | 주소 | 배포 시점 |
|---|---|---|
| 운영 | `workflow.simplite.net`(앱), `workflow-files.simplite.net`(사용자 파일) | main 머지 |
| 검증 | `workflow-app-staging.villainscode.workers.dev`(앱·파일 같은 출처) | develop 푸시 |

환경마다 D1·KV·R2를 따로 둔다. 운영 도메인 두 개는 Worker 사용자 지정 도메인이라, 첫 배포 때 DNS 레코드(AAAA `100::`)와 인증서가 자동으로 생겼다.

## 5. 공통 로직 (`packages/core`)

| 분류 | 기술 |
|---|---|
| HTML 텍스트 편집 | parse5. 텍스트 노드의 원본 위치만 바꾼다 |
| DOCX·PPTX·XLSX·SVG 편집 | htmlparser2(XML 모드)로 위치를 찾고, fflate로 zip을 다시 묶는다 |
| HTML 구조 편집(5.0) | parse5. 요소 원본 위치로 표 행·열·열 너비·블록·그림을 바꾸고 나머지 바이트는 그대로 둔다(`structedit/html.ts`) |
| DOCX·PPTX·XLSX 구조 편집(5.0, D-47) | htmlparser2(XML 모드) 위치 트리로 표 행·열·열 너비, 그림 교체, 시트 열 너비. 바뀐 파트만 다시 묶는다(`structedit/ooxml.ts`) |
| PDF 편집 연산(5.0 M6) | pdf-lib + @pdf-lib/fontkit. 글상자·그림·형광펜·펜·쪽 회전·지우기·옮기기·끼워 넣기·양식 채우기, 회전된 쪽은 회전만큼 돌려 그림. 부분 글꼴은 harfbuzz `hb-subset`(글리프 번호 유지). `pdfedit/` |
| 슬라이드 형식(5.0 M4) | parse5로 제한된 HTML(덱 = deck.json + slides/<id>.html)을 읽고 허용 목록·CSS 값 문법을 직접 검사(css-tree 대신, 허용 범위가 좁다). 연산은 역연산을 돌려준다(`slide/`) |
| 해시 | `@noble/hashes`(동기 sha256). Web Crypto는 비동기라 어댑터 API를 그대로 두려고 골랐다 |

## 6. 테스트·CI

| 대상 | 도구 | 건수 |
|---|---|---|
| 로컬 사이트 | node:test(단위·API·MCP) | 170 |
| 로컬 화면 | puppeteer(전역 설치) | 34 |
| 공통 로직 | node:test(구조 편집·슬라이드 형식·PDF) | 23 |
| Cloudflare Worker | Vitest 4 + `@cloudflare/vitest-plugin`(Workers 런타임에서 D1·R2·DO를 로컬로) | 67 |
| Cloudflare 화면 | puppeteer + `wrangler dev`. 앱·파일 출처를 나누고, 변환 컨테이너는 로컬 Docker로 띄운다 | 17 |

GitHub Actions(`.github/workflows/workflow-app.yml`):

- PR마다 타입 검사, 공통 로직 테스트, 로컬 테스트, Worker 테스트를 돌린다.
- develop 푸시는 검증 서버, main 푸시는 운영에 D1 마이그레이션 후 배포한다.
- 배포 작업은 저장소 변수 `DEPLOY_ENABLED=true`일 때만 돈다.

화면 테스트 두 종류는 puppeteer와 Docker가 필요해 CI에서 돌리지 않는다.

케이스 목록은 `spec/TESTING.md`.

## 7. Claude Code 설정 (`.claude/`)

| 위치 | 내용 |
|---|---|
| `CLAUDE.md` | 행동 지침과 규칙·가이드 목차 |
| `rules/` | 규칙 6개. 경로 조건이 있는 규칙은 그 파일을 열 때 읽힌다 |
| `guides/` | 구조·개발 가이드 5개 |
| `skills/` | workflow-docs(사이트 문서 다루기), anti-ai-slop(산출물 품질 기준) |
| `agents/` | 검토용 서브에이전트 4개: best-practice, evaluator, researcher, security |
| `hooks/` | 보호 파일·명령 차단, 포맷, 종료 전 검증 |
