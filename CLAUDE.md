# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 이 리포지토리

SDLC(Software Development Life Cycle) 전체에 걸친 업무 및 관리 솔루션을 만들기 위한 **설계 단계 문서(드래프트)**를 관리하는 워크 리포지토리다. 대상은 요구사항, 시퀀스 다이어그램, ERD, 시스템 아키텍처, 개발 도구, 코드 리뷰, 빌드·배포, 운영이고, 의사 결정 기록도 여기에 남긴다. 문서 안의 YAML·셸·워크플로 코드는 대상 팀 저장소에 적용할 예시이고, 이 리포에서 실행하는 코드가 아니다.

리포 안의 문서를 메뉴 + 뷰어로 관리하는 로컬 웹사이트를 `site/`에 만들고 있다. 요구사항, 결정 사항, 단계별 계획은 `REQUIREMENT.md`에 있다. 사이트 작업을 할 때는 먼저 그 문서의 현재 단계와 결정 사항(D-n)을 확인하고, 미결정 항목은 진행하기 전에 묻는다.

- 응답과 문서는 한국어로 쓴다.
- 결과물은 코드보다 설명, 프로세스, 그림, 문서 위주로 만든다.
- 일반 행동 지침은 `.claude/CLAUDE.md`에 있다. 이 파일은 리포 고유 내용만 다룬다.

## 문서 구조와 버전 관리

문서는 **메뉴 → 문서 → 버전** 단위로 관리한다. 버전은 문서마다 따로 쌓인다.

```
docs/
  _site/menus.yaml          # 대분류(SDLC · Agent · Image)와 메뉴 트리. 사이트의 메뉴 원본
  <메뉴 slug>/              # 영문 kebab-case. 예: code-review-automation
    <문서 slug>/            # 예: review-gate
      meta.yaml             # 제목, 분류, 상태, 버전 목록, 외부 등록 링크 (문서 정보의 원본)
      v0.1/
        review-gate.html    # 대표 파일(entry). 기본 형식은 HTML
        diagrams/           # 편집 가능한 원본: .drawio, .mmd (필요할 때)
        exports/            # 파생 산출물: .svg .png .pdf .pptx .xlsx (필요할 때)
      v0.2/
```

- **원본은 파일이다.** `menus.yaml`과 문서별 `meta.yaml`, 버전 폴더의 파일이 원본이고 git으로 추적한다. 사이트의 SQLite(`site/data/`)는 이 파일들을 스캔해 다시 만드는 색인이라 git에 넣지 않는다. 문서를 추가하거나 옮길 때는 yaml을 함께 고친다.
- **버전 규칙**: `v0.x`는 드래프트, `v1.0` 이상은 확정이다. 내용을 바꿀 때는 그 문서의 이전 버전 폴더를 복사해 새 버전을 만들고, `meta.yaml`의 `versions`에 메모(`note`)와 함께 추가하고 `current`를 바꾼다. **Notion에 등록했거나 커밋된 버전 폴더는 수정하지 않는다.** 오타 같은 사소한 수정과 구조 이전만 예외로 한다.
- **slug**: 메뉴 slug는 리포 전체에서 하나만 존재한다. 메뉴의 대분류 소속과 상하 관계는 `menus.yaml`에서 정하므로 폴더 경로에 넣지 않는다.
- **원본과 파생**: 다이어그램의 원본은 `diagrams/`의 `.drawio`·`.mmd` 파일이다. `exports/`와 HTML에 넣은 SVG는 원본에서 다시 만들 수 있는 파생물이므로, 원본을 고친 뒤 다시 export한다.

```yaml
# docs/<메뉴>/<문서>/meta.yaml
title: OCR 리뷰 게이트 운영 가이드
category: sdlc            # menus.yaml의 대분류 key
menu: code-review-automation
kind: html                # html | image | pdf | pptx | docx | xlsx | markdown | code | drawio
type: process             # requirements | sequence | erd | architecture | process | build-deploy | decision
sdlc: develop             # plan | design | develop | test | build-deploy | operate
status: draft             # draft | review | approved
current: v0.1
versions:
  - version: v0.1
    entry: review-gate.html
    note: 변경 메모
    source: upload        # upload | edit | scan | release
    created: 2026-10-06
notion_url:               # 등록 후 채운다
gdrive_url:
```

### 현재 메뉴와 문서

| 대분류 | 메뉴 | 문서 | 최신 | 다루는 영역 |
|---|---|---|---|---|
| SDLC | `sprint-gitflow` | `process` | v0.1 | 버전 관리·CI, 2주 스프린트 |
| SDLC | `code-review-automation` | `review-gate` | v0.1 | 코드 리뷰 게이트 설치·Slack·Ruleset |
| SDLC | `code-review-automation` | `review-modes` | v0.1 | CI 리뷰 실행 방식 (API 키 vs Max 구독) |

Agent와 Image 대분류는 아직 비어 있다. 문서끼리는 버전 폴더까지 포함한 상대 경로로 연결한다. 예: `process.html`에서 `../../../code-review-automation/review-gate/v0.1/review-gate.html`. 새 버전을 만들면 다른 문서에서 이 문서를 가리키는 링크를 새 버전으로 바꿀지 판단한다.

아직 문서가 없는 영역: 개발 도구 가이드, 빌드·배포, 이밸 게이트·골든셋(아래 이전 설계 참고), 시퀀스·ERD·아키텍처.

## 업무 문서 사이트 (`site/`)

```bash
cd site
npm run dev        # 5173·5174 포트를 쓰던 프로세스를 먼저 종료(predev)한 뒤 API(Fastify, 127.0.0.1:5174) + 화면(Vite, http://127.0.0.1:5173) 실행
npm run typecheck  # tsc (server + web)
npm run build      # 타입 검사 후 site/dist로 빌드
```

- **server/**: `scan.ts`가 `docs/_site/menus.yaml`과 문서별 `meta.yaml`을 읽어 SQLite 색인(`site/data/index.db`)을 채운다. 서버가 시작하거나 `POST /api/reindex`가 호출될 때마다 테이블을 지우고 처음부터 다시 만든다. 그래서 스키마를 바꿀 때 마이그레이션이 필요 없다. yaml이나 파일에 문제가 있으면 멈추지 않고 경고로 모은다. 경고는 `/api/tree`의 `warnings`와 좌측 목록 하단에 표시된다.
- **API**: `GET /api/tree`(대분류 → 메뉴 → 문서), `GET /api/docs/:menu/:doc`(버전과 파일 목록), `POST /api/upload`(multipart), `POST /api/menus`, `POST /api/reindex`, `GET /api/events`(SSE 변경 알림), `GET /api/convert/:to/<docs 기준 경로>`(변환 결과), `POST /api/docs/:menu/:doc/edit`(Markdown 저장). 관리 API는 메뉴(`/api/menus/:slug` PATCH·DELETE, `/move`), 대분류(`/api/categories`), 문서(`/api/docs/:menu/:doc` PATCH·DELETE, `/move`), 휴지통(`/api/trash`), 검색(`/api/search?q=&category=&kind=`)이다. `docs/` 원본은 `/files/<메뉴>/<문서>/<버전>/<파일>`로 그대로 제공한다. 그래서 HTML 문서의 상대 경로 리소스와 링크가 그대로 동작한다.
- **web/**: React Router 경로는 `/:category/:menu/:doc?v=<버전>`이다. 뷰어는 대표 파일(entry)의 확장자로 고르며, 그 분기는 `web/src/viewers/Viewer.tsx`에 있다. 색은 `styles.css`의 `:root` 토큰(docs HTML과 같은 값)을 Tailwind `@theme inline`으로 연결한다.
- **확인 창** (`components/confirm/ConfirmProvider.tsx`, `useConfirm()`): 저장·수정·삭제·다운로드·업로드·이동·복원·휴지통 이동은 공통 확인 창을 거쳐 실행한다. 브라우저 `confirm()`은 쓰지 않는다.
  - 관리 작업은 `useAction().run(작업, 확인옵션)`으로 넘기면 확인 후 실행된다. 무엇이 바뀌는지는 `details`에 적는다.
  - tone은 일반(`default`, 파랑), 이동(`warning`, 주황), 삭제·휴지통(`danger`, 빨강 `--crit`)이다. danger는 기본 포커스가 "취소"다.
  - 순서 변경(↑↓)과 보기 전환은 확인하지 않는다.
- **정식 버전 확정** (`store.ts`의 `release`, `POST /api/docs/:menu/:doc/release`, `components/ReleaseBadge.tsx`): 문서 상단 상태 배지가 draft·review이면 버튼이 된다. 누르면 "vX.0으로 변경하시겠습니까?" 확인 후 현재 버전 폴더를 다음 major 버전(v0.x → v1.0, v1.2 → v2.0)으로 복사한다. 그리고 `source: release` 버전을 추가하고 `current`와 `status: approved`를 바꾼다. 기존 버전 폴더는 그대로 둔다. 같은 내용 복사라 업로드의 "직전과 같으면 거부" 검사를 거치지 않는 전용 함수다.
- **프레젠테이션 모드** (`viewers/Presentation.tsx`): 문서 상단 버튼으로 문서 영역만 Fullscreen API로 띄운다. HTML·Markdown은 1280px 기준으로 그린 뒤 화면 너비 비율로 `transform: scale` 한다. 그래서 글자와 레이아웃이 함께 커진다. Markdown은 미리보기만 보여준다. 다른 형식은 그대로 넓힌다.
- **아이콘**: 사이트의 기능 버튼은 Lucide(`lucide-react`) 아이콘으로 만들고 `components/IconButton.tsx`를 쓴다. 아이콘만 있는 버튼은 `label`이 aria-label과 title(마우스를 올렸을 때 설명)이 된다. 대화상자의 확인·취소처럼 실수하면 안 되는 버튼과 휴지통의 복원·영구 삭제는 아이콘과 글자를 함께 둔다(`text` prop). 유니코드 기호(✕ ☰ ▾ 등)를 아이콘으로 쓰지 않는다.
- **사이드바** (`components/SidebarResizer.tsx`): 너비는 CSS 변수 `--sidebar-w`로 정한다(200~560px, 기본 272). 손잡이는 `setPointerCapture`로 끌기를 받는다. 덮개 방식으로 바꾸면 iframe 위에서 이벤트를 뺏기거나 더블클릭이 깨진다. 접으면 20px 띠가 된다. 너비와 접힘 상태는 localStorage(`workflow:sidebar-*`)에 둔다. 휴지통은 사이드바 하단 footer에 고정이다.
- **정적 파일**: 로고(`logo.svg`)와 파비콘(`favicon.svg`, `favicon-32.png`, `apple-touch-icon.png`)은 `web/public/`에 있다. 헤더 로고를 누르면 `/`로 간다.
- **react-grab** (개발 모드 전용, devDependency): `web/src/main.tsx`에서 `import.meta.env.DEV`일 때만 불러온다. 화면 요소를 가리키고 ⌘C를 누르면 그 요소의 컴포넌트와 소스 위치가 복사되어, 코딩 에이전트에 붙여 넣고 수정을 요청할 수 있다. 운영 빌드에는 포함되지 않는다.
- **HTML 뷰어**: iframe에 `allow-same-origin` 없이 sandbox를 건다. 문서 안의 스크립트는 동작하지만 사이트 쪽에는 접근하지 못한다. 문서 안의 링크를 누르면 iframe 안에서 이동한다.
- **업로드** (`server/store.ts`): 파일 → `meta.yaml`(주석·순서 유지) → 색인 순서로 쓴다.
  - 버전은 문서마다 다음 번호(`v0.1` → `v0.2`)를 자동으로 정하고, 직접 지정할 수도 있다.
  - 직전 버전과 파일 구성·내용(sha256)이 같으면 409로 거부한다.
  - zip 하나는 풀어서 쓰고, 폴더째 올리면 공통 최상위 폴더 이름을 뗀다.
  - 대표 파일은 `index.html` → 첫 HTML → 가장 얕은 첫 파일 순서로 고른다.
  - `..`나 숨김 파일 경로는 버린다.
  - 새 메뉴는 `menus.yaml`에 추가된다.
- **실시간 반영**: chokidar가 `docs/`를 감시하고, 변경이 생기면 300ms 동안 모았다가 한 번 다시 색인한 뒤 SSE로 알린다. 화면은 `useLiveUpdates`로 목록과 문서 정보를 다시 불러온다. 파일 URL에 `?h=<sha256 앞 12자리>`를 붙여 같은 경로의 내용이 바뀌어도 iframe·이미지가 새로 고쳐진다.
- **변환** (`server/convert.ts`): PPTX·DOCX → PDF는 `soffice --headless`, draw.io → SVG는 `drawio -x`로 변환한다.
  - 결과는 원본 sha256을 이름으로 `site/data/cache/`에 캐시한다. 변환기를 고쳤다면 캐시 파일을 지워야 다시 변환된다.
  - LibreOffice는 한 번에 하나씩 순서대로 돌리고, 별도 프로필(`cache/lo-profile`)을 쓴다.
  - **macOS headless LibreOffice는 기본 상태에서 시스템 폰트를 보지 못해 한글이 빠진 PDF를 만든다.** 그래서 시스템 폰트 폴더를 넣은 `cache/fonts.conf`를 만들어 `FONTCONFIG_FILE`로 넘긴다.
- **뷰어**: 형식별 분기는 `web/src/viewers/Viewer.tsx`에 있다.
  - PDF는 브라우저 내장 뷰어로 연다. Chrome은 sandbox iframe에서 PDF를 열지 않아 sandbox를 걸지 않는다.
  - DOCX는 `docx-preview`로 렌더링하고, PDF 변환으로 볼 수도 있다.
  - XLSX·CSV는 SheetJS로 읽는다. SheetJS는 npm 레지스트리 버전이 오래되어 공식 CDN tgz로 설치했다. CSV는 UTF-8 텍스트로 읽는다.
- **Markdown 편집** (`viewers/MarkdownViewer.tsx`, `store.ts`의 `saveEdit`): 화면은 CodeMirror 편집기와 미리보기를 나란히 둔다.
  - 미리보기는 react-markdown + GFM이고, 코드는 Shiki, `mermaid` 코드 블록은 다이어그램으로 그린다. 상대 경로 이미지·링크는 버전 폴더 기준으로 푼다.
  - 저장은 기준 버전의 파일을 모두 복사하고 대표 `.md`만 바꿔 새 버전(`source: edit`)으로 쓴다. 그사이 최신 버전이 바뀌었으면 409로 거부한다.
  - 저장 전 내용은 localStorage(`workflow:draft:<메뉴>/<문서>@<버전>`)에 임시 보관하고, 다시 열면 복원을 제안한다.
  - 이전 버전은 읽기 전용이다.
  - 새 Markdown 문서는 업로드 대화상자의 "새 Markdown 문서" 탭에서 `# 제목` 한 줄짜리 `.md`를 업로드하는 방식으로 만든다.
- **버전 비교**: 텍스트 형식(md, html, yaml 등)이고 버전이 2개 이상이면 문서 상단에 "비교" 선택이 생긴다(`?cmp=<버전>`). `viewers/DiffViewer.tsx`가 jsdiff로 줄 단위 비교를 보여준다.
- **관리** (`server/manage.ts`): 메뉴를 옮기거나 하위로 넣어도 `menus.yaml`만 바뀌고 폴더(`docs/<메뉴 slug>/`)는 그대로다.
  - 다른 대분류로 옮기면 그 메뉴 문서들의 `meta.yaml` category를 맞춘다.
  - 문서를 다른 메뉴로 옮기면 문서 폴더를 새 메뉴 폴더로 옮긴다.
  - 메뉴·대분류는 비어 있을 때만 지운다.
  - `menus.yaml` 맨 위 `#` 주석은 yaml 라이브러리가 첫 키에 붙여 버리므로, 원문에서 떼어 두었다가 저장할 때 다시 붙인다.
- **휴지통**: 문서 폴더를 `docs/_trash/<로컬 시각 yyyyMMddHHmmss>--<메뉴>--<문서>/`로 옮긴다. 스캔은 `_`로 시작하는 폴더를 건너뛴다. 복원할 때 원래 메뉴가 없으면 메뉴를 고르게 한다.
- **검색**: 색인할 때 각 문서 최신 버전의 대표 파일 본문을 FTS5 trigram 테이블 `search`에 넣는다. HTML은 script·style·svg를 빼고 글자만 넣는다. 질의는 trigram 색인 위의 `LIKE '%q%'`라서 한국어 두 글자 단어와 조사가 붙은 말도 찾는다. 제목에 맞은 문서를 먼저 보여준다.
- **조회 재시도**: 404(옮겨지거나 지워진 문서)는 재시도하지 않는다. 관리 작업 뒤 목록 새로고침은 기다리지 않는다. 기다리면 옛 주소의 404 재시도 때문에 화면 이동이 늦어진다.
- **업로드 진입점**: 모두 `upload/UploadContext.tsx`의 `useOpenUpload()`로 연다.
  - 상단 "업로드" 버튼
  - 메뉴별 `+` 버튼
  - 메뉴에 파일 끌어다 놓기
  - 문서 화면의 "새 버전"
- 화면 확인: headless Chrome `--screenshot`은 iframe 내용을 그리기 전에 찍혀 빈 화면이 나올 수 있다. 사이트 화면은 Mermaid CLI와 함께 전역 설치된 puppeteer(`$(npm root -g)/@mermaid-js/mermaid-cli/node_modules/puppeteer`)로 찍는다. SSE 연결이 계속 열려 있어 `networkidle0`은 끝나지 않으므로 `domcontentloaded` 후 요소를 기다린다.

## 산출물 형식과 도구

| 형식 | 만드는 방법 |
|---|---|
| HTML (기본) | 단일 파일로 직접 작성한다. 아래 작성 규칙을 따른다 |
| 다이어그램 (시퀀스, ERD, 아키텍처) | `.drawio` XML을 직접 쓰거나, 빠른 초안은 Mermaid `.mmd`로 쓴다. export: `drawio -x -f svg\|png\|pdf`, `mmdc -i x.mmd -o x.svg` |
| SVG · PNG | draw.io나 mmdc로 export한다. HTML 페이지 이미지는 headless Chrome 스크린샷으로 만든다 |
| PDF | HTML은 headless Chrome `--print-to-pdf`, 다이어그램은 draw.io export로 만든다 |
| PPT · Excel | `pptx` · `xlsx` 스킬을 쓴다. 파이썬은 리포의 `.venv`(python-pptx, openpyxl)를 쓴다 |
| Google Docs · Sheets · Slides | Google Drive MCP(claude.ai 연결됨)로 만든다. 만들 때는 `google-workspace` 스킬을 먼저 읽는다. 저장 위치는 아래 Google Drive 절을 따른다 |

## Google Drive

- 루트 폴더: 내 드라이브의 `tommoro-workspace` (folder id `1-v4RZ0GcJtHTgI8GxyO4ne0rlavTQBgz`, 계정 villainscode@gmail.com)
- 리포 구조를 그대로 따라 `tommoro-workspace/<메뉴 slug>/<문서 slug>/<버전>/` 아래에 문서를 둔다. 하위 폴더는 처음 내보낼 때 만든다.
- 업로드한 파일 URL은 `meta.yaml`의 `gdrive_url`과 Notion의 `Google Drive` 속성에 적는다. 업로드는 Notion 등록과 마찬가지로 문서마다 확인을 받은 뒤 한다.

## Notion 등록

- 등록 위치: Private 영역 `투모로업무프로세스` 페이지 아래의 데이터베이스 **`SDLC 설계 문서`**.
  - 데이터베이스: `https://app.notion.com/p/4eb6430f2cee4365b7925717f46bfed7`
  - 데이터 소스: `collection://b7c4aa34-0f54-45e1-8e7c-978977041819`
  - 같은 부모 페이지에 수동으로 만든 페이지 `00. 업무 관련`, `01. Github Workflow`, `02. Code Review Workflow`가 있다. 이 페이지들은 건드리지 않는다.
- **설계 문서 1건 = 데이터베이스 페이지 1개**로 등록한다. 업무 하나나 버전 하나를 페이지 하나로 묶지 않는다.
- 속성은 `meta.yaml`에서 채운다.
  - 문서명 ← `title`
  - 업무명 ← `menus.yaml`의 메뉴 이름. select 옵션이라 새 메뉴면 옵션이 추가된다
  - 업무 slug ← `menu`
  - 버전 ← 등록하는 버전 (`current`)
  - 문서 유형 ← `type`
  - SDLC 단계 ← `sdlc`
  - 상태 ← `status`
  - 리포 경로
  - 커밋 ← 등록 시점 SHA
  - 산출물 ← 형식 목록
  - Google Drive ← `gdrive_url`
- 본문에는 문서 요약과 주요 다이어그램(이미지)을 넣는다.
- 등록이 끝나면 페이지 URL을 `meta.yaml`의 `notion_url`에 적고 커밋한다. 이미 `notion_url`이 있는 문서는 새 페이지를 만들지 말고 그 페이지를 갱신한다. 새 버전이면 새 페이지를 만든다.
- 외부 게시에 해당하므로 문서마다 사용자 확인을 받은 뒤 등록한다.
- 연결: MCP 서버 `plugin:design:notion`(`https://mcp.notion.com/mcp`). 인증이 필요하면 `/mcp`에서 인증한다.

## 문서 사이에 공유되는 결정

여러 문서가 같은 결정을 전제로 쓰인다. 하나를 바꾸면 그 결정을 쓰는 다른 문서도 함께 맞춘다.

- **브랜치 모델**: `main` · `develop` · `feature/WF-xxx-*` · `release/x.y.z` · `bugfix/WF-xxx-*`. hotfix 브랜치는 쓰지 않는다. 배포 후 결함은 다음 스프린트 티켓이 된다.
- **2주 스프린트 (D1–D14)**: D1 플래닝, D2–D10 개발, D6 테스트, **D7 첫 코드 리뷰(PR → develop)**, D10 기능 동결과 release 생성, D10–D13 테스트·QA, **D14 리뷰(PR release → main)·배포·데모**.
- **리뷰 두 층**: 로컬 리뷰는 개발자가 매일 한다(Claude Code `/code-review`·`/simplify`·`/security-review`, Codex `/review`). 결과를 기록하지 않고 머지도 막지 않는다. D7·D14 리뷰는 CI의 리뷰 에이전트(Open Code Review, `ocr`)가 자동으로 하고 Slack으로 알린다.
- **게이트 판정**: critical·high가 하나라도 있으면 필수 체크 `ocr-review`가 실패해 머지가 막힌다. medium 이하는 막지 않는다.
- **추적**: Asana 티켓 번호(`WF-201` 형식)를 브랜치 이름, 커밋(`feat(auth): ... [WF-201]`), PR 제목(`WF-201 ...`)에 넣는다.
- **CI 설정 이름**: Secrets `OCR_API_KEY`, `SLACK_WEBHOOK_URL`, `CLAUDE_CODE_OAUTH_TOKEN`(Max 구독 방식). Variables `OCR_PROVIDER`, `OCR_MODEL`, `OCR_EFFORT`, `OCR_VERSION`, `OCR_LANGUAGE`, `OCR_MAX_TOKENS_BUDGET`, `OCR_SLACK_ON_PASS`, `CLAUDE_REVIEW_MODEL`.

### 알려진 불일치

- `code-review-automation/review-gate/v0.1/review-gate.html`의 워크플로는 `push`로 트리거된다(`feature/code-review` 게이트 브랜치와 `develop` 사후 리뷰). `sprint-gitflow/process/v0.1/process.html`은 `pull_request`(base가 `develop`·`main`)로 트리거되는 것으로 정했다. code-review-automation 다음 버전에서 이 차이를 맞춘다.
- `sprint-gitflow` 문서 D7 단계는 `/ocr-triage <id> <판정>` 명령을 쓰는데, 이 명령을 설치하는 방법을 설명한 문서가 아직 없다.

### 이밸 게이트·골든셋 이전 설계 (gitflow 문서 v1에 있던 내용)

새 문서를 쓸 때 출발점으로 쓴다. 확정된 결정은 아니다.

- 리뷰 원장: 고아 브랜치 `review-ledger`. `runs/<YYYY-MM>/<run_id>.jsonl`에 CI 봇이 critical·high 지적을 쌓고, `labels/`에 판정이 쌓인다. Ruleset과 워크플로 트리거에서는 뺀다.
- 판정: PR 코멘트 첫 줄 `/ocr-triage <id> fixed|false_positive|accepted|missed "사유"`. `fixed`를 뺀 판정에는 사유가 필수다. 지적 ID는 `<run_number>.<순번>` 형식이다.
- 골든셋: 매일 밤 원장과 판정을 합쳐 `golden/findings.jsonl`을 다시 만든다. 판정이 붙은 지적만 들어간다.
- 활용: 로컬 에이전트는 AGENTS.md 지침으로, CI는 `--background-file`로 바뀐 파일의 골든 기록을 읽는다. 같은 경로에서 오탐이 2회 이상 나오면 `.opencodereview/rule.json` 규칙으로 승격한다. 모델이나 버전을 바꾸기 전에는 `fixed`·`missed` 기록으로 회귀 평가를 한다.

## HTML 문서 작성 규칙

기존 세 문서가 같은 체계를 쓴다. 새 문서도 맞춘다.

- 외부 스크립트 없이 단일 파일로 만든다. 폰트만 Google Fonts(IBM Plex Sans KR, IBM Plex Mono)에서 불러온다. 다이어그램은 export한 SVG를 인라인으로 넣는다.
- 색은 `:root` 토큰(`--bg`, `--surface`, `--fg`, `--muted`, `--accent`, `--crit`, `--high`, `--med`, `--ok`, `--rel` 등)으로 정의한다. 다크 모드는 `@media (prefers-color-scheme: dark)` 안의 `:root:not([data-theme="light"])`와 `:root[data-theme="dark"]` 두 곳에 똑같이 정의한다.
- 구성: masthead(eyebrow, h1, lede, meta-row에 업무명·버전·상태) → 왼쪽 sticky 목차 + 본문 → 번호 붙은 섹션(`01 · 제목`) → footer(관련 문서 링크).
- **내부 가로 스크롤 금지**: 코드 블록은 `white-space: pre-wrap`으로 줄을 바꾼다. 표는 `table-layout: fixed`로 두고, 640px 이하에서는 `data-l` 속성을 쓰는 카드로 쌓는다. 그림은 `viewBox` SVG에 `width: 100%`를 주고, 좁은 화면에서는 세로 목록으로 바꾼다. `overflow-x: auto`와 `min-width` 표를 쓰지 않는다.
- 사람 이름, 티켓 번호, 고객사는 예시임을 문서에 밝힌다.

## 검증과 export

빌드·린트·테스트는 없다. HTML을 고친 뒤에는 headless Chrome으로 렌더링을 확인한다. headless 창은 500px보다 좁게 만들 수 없으므로, 그보다 좁은 폭은 실제 기기에서 확인한다.

```bash
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
DOC="docs/<메뉴>/<문서>/<버전>/<파일>.html"
"$CHROME" --headless=new --hide-scrollbars --window-size=1280,4000 --screenshot=/tmp/desk.png "file://$PWD/$DOC"
"$CHROME" --headless=new --hide-scrollbars --window-size=500,7000 --screenshot=/tmp/narrow.png "file://$PWD/$DOC"
"$CHROME" --headless=new --no-pdf-header-footer --print-to-pdf="${DOC%/*}/exports/<문서>.pdf" "file://$PWD/$DOC"
```

가로 넘침은 두 가지로 확인한다. 하나는 `document.documentElement.scrollWidth`가 창 너비보다 큰지, 다른 하나는 `overflow-x`가 visible이 아니면서 `scrollWidth > clientWidth`인 요소가 있는지다. 이 측정 스크립트를 문서 사본에 넣고 `--dump-dom`으로 결과를 읽는다.
