# 프로젝트 구조

리포 전체 배치와 `docs/` 문서 원본 구조. 문서를 다루는 규칙(버전·slug·원본)은 `.claude/rules/docs-workflow.md`.

## 리포 배치

| 경로 | 내용 | 가이드 |
|---|---|---|
| `docs/` | 설계 문서 원본(메뉴 → 문서 → 버전). 아래 구조 | 이 문서 |
| `site/` | 로컬 업무 문서 사이트(Fastify API + React 화면 + SQLite 색인 + stdio MCP) | `site-local.md` |
| `apps/worker/` | Cloudflare 「문서 탐색 워크플로우」(Hono Worker + D1 + R2 + DO + 원격 MCP) | `cloudflare-app.md` |
| `apps/converter/` | PDF 변환 컨테이너(LibreOffice) | `cloudflare-app.md` |
| `packages/core/` | 로컬·Cloudflare 공통 로직(텍스트 편집 어댑터, 버전 규칙, slug, 업로드 규칙) | `cloudflare-app.md` |
| `packages/mcp-tools/` | workflow-docs MCP 도구 정의(로컬·원격 공용) | `site-local.md` MCP 절 |
| `packages/cli/` | 리포 `docs/` → Cloudflare 워크스페이스 가져오기 | `cloudflare-app.md` |
| `REQUIREMENT*.md` | 요구사항·결정(D-n)·단계 계획: 1.x, 2.0(텍스트 편집), 3.0(Claude Code 연결), 4.0(Cloudflare) | |
| `TESTING.md` | 테스트 케이스 목록(자동·수동)과 테스트로 찾은 버그 | `.claude/rules/testing.md` |
| `.claude/` | 이 지침(`CLAUDE.md`), 규칙(`rules/`), 가이드(`guides/`), 스킬(`skills/workflow-docs`) | |

npm workspaces(`packages/*` · `apps/*` · `site`)라 `npm install`은 리포 루트에서 한 번 하고, 의존성은 루트 `node_modules`에 모인다.

## 문서 원본 구조 (`docs/`)

문서는 **메뉴 → 문서 → 버전** 단위로 관리한다. 버전은 문서마다 따로 쌓인다.

```
docs/
  _site/categories.yaml     # 상단 메뉴(대분류: SDLC · Agent · Image)와 순서. 원본
  _site/menus.yaml          # 대분류 key별 좌측 메뉴 트리. 원본
  <메뉴 slug>/              # 영문 kebab-case. 예: code-review-automation
    <문서 slug>/            # 예: review-gate
      meta.yaml             # 제목, 분류, 상태, 버전 목록, 외부 등록 링크 (문서 정보의 원본)
      v0.0/                 # 최초 작성·업로드본. 화면에는 draft로 표시
        review-gate.html    # 대표 파일(entry). 기본 형식은 HTML
        diagrams/           # 편집 가능한 원본: .drawio, .mmd (필요할 때)
        exports/            # 파생 산출물: .svg .png .pdf .pptx .xlsx (필요할 때)
      v0.1/                 # 첫 수정. 이후 수정마다 v0.2, v0.3 …
      v1.0/                 # 정식 확정
      <하위 문서 slug>/     # 하위 문서(9단계): meta.yaml과 버전 폴더를 가진 문서 폴더가 상위 문서 폴더 안에 들어간다
```

```yaml
# docs/<메뉴>/<문서>/meta.yaml
title: OCR 리뷰 게이트 운영 가이드
category: sdlc            # categories.yaml의 대분류 key
menu: code-review-automation
kind: html                # html | image | pdf | pptx | docx | xlsx | markdown | code | drawio
type: process             # requirements | sequence | erd | architecture | process | build-deploy | decision
sdlc: develop             # plan | design | develop | test | build-deploy | operate
status: draft             # draft | review | approved
current: v0.0
versions:
  - version: v0.0
    entry: review-gate.html
    note: 변경 메모
    source: upload        # upload | edit | text-edit | scan | release
    created: 2026-10-13 14:05:33   # 작성 시각(로컬). 2026-10-13 이전 버전은 날짜만 있다. 문서 화면 제목 오른쪽에 보인다
order: 0                  # 같은 자리 안 순서(사이드바에서 끌어 놓으면 생긴다). 없으면 제목순
notion_url:               # 등록 후 채운다
gdrive_url:
```

### 현재 메뉴와 문서

| 대분류 | 메뉴 | 문서 | 최신 | 다루는 영역 |
|---|---|---|---|---|
| SDLC | `sprint-gitflow` | `process` | draft | 버전 관리·CI, 2주 스프린트 |
| SDLC | `code-review-automation` | `review-gate` | draft | 코드 리뷰 게이트 설치·Slack·Ruleset |
| SDLC | `code-review-automation` | `review-modes` | v1.0 | CI 리뷰 실행 방식 (API 키 vs Max 구독) |
| SDLC | `onboarding` | `platform-env` | v1.0 | 플랫폼팀 개발 환경. 외부 claude.ai 아티팩트를 MCP로 가져와 시험한 문서(`origin_url`에 출처) |


Agent와 Image 대분류는 아직 비어 있다. 문서끼리는 버전 폴더까지 포함한 상대 경로로 연결한다. 예: `process.html`에서 `../../../code-review-automation/review-gate/v0.0/review-gate.html`.

아직 문서가 없는 영역: 개발 도구 가이드, 빌드·배포, 이밸 게이트·골든셋(`eval-gate-draft.md`), 시퀀스·ERD·아키텍처.
