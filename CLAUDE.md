# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 이 리포지토리

SDLC(Software Development Life Cycle) 전체에 걸친 업무 및 관리 솔루션을 만들기 위한 **설계 단계 문서(드래프트)**를 관리하는 워크 리포지토리다. 대상은 요구사항, 시퀀스 다이어그램, ERD, 시스템 아키텍처, 개발 도구, 코드 리뷰, 빌드·배포, 운영이고, 의사 결정 기록도 여기에 남긴다. 애플리케이션 코드는 없다. 문서 안의 YAML·셸·워크플로 코드는 대상 팀 저장소에 적용할 예시이고, 이 리포에서 실행하는 코드가 아니다.

- 응답과 문서는 한국어로 쓴다.
- 결과물은 코드보다 설명, 프로세스, 그림, 문서 위주로 만든다.
- 일반 행동 지침은 `.claude/CLAUDE.md`에 있다. 이 파일은 리포 고유 내용만 다룬다.

## 문서 구조와 버전 관리

문서는 **업무명 → 버전** 단위로 만들고 관리한다.

```
docs/
  <업무 slug>/              # 영문 kebab-case. 예: code-review-automation
    CHANGELOG.md            # 버전마다 바뀐 점과 결정 사항을 한 줄씩
    v0.1/
      meta.yaml             # 업무명, 버전, 상태, 문서 목록, 외부 등록 링크
      architecture.html     # 설계 문서 1건 = 파일 1개 (기본 형식 HTML)
      sequence-login.html
      erd.html
      diagrams/             # 편집 가능한 원본: .drawio, .mmd
      exports/              # 파생 산출물: .svg .png .pdf .pptx .xlsx
    v0.2/
```

- **버전 규칙**: `v0.x`는 드래프트, `v1.0` 이상은 확정이다. 내용을 바꿀 때는 이전 버전 폴더를 복사해 새 버전을 만들고 그 안에서 고친다. **Notion에 등록했거나 커밋된 버전 폴더는 수정하지 않는다.** 오타 같은 사소한 수정만 예외로 하고, 고친 내용은 CHANGELOG에 남긴다.
- **업무 slug**: 폴더 이름은 영문 kebab-case로 짓고, 한글 업무명은 `meta.yaml`의 `task`에 적는다.
- **원본과 파생**: 다이어그램의 원본은 `diagrams/`의 `.drawio`·`.mmd` 파일이다. `exports/`와 HTML에 넣은 SVG는 원본에서 다시 만들 수 있는 파생물이므로, 원본을 고친 뒤 다시 export한다.
- **상태**: `meta.yaml`의 문서별 `status`는 `draft`, `review`, `approved` 중 하나다.

```yaml
# docs/<slug>/<version>/meta.yaml
task: 코드 리뷰 자동화
slug: code-review-automation
version: v0.1
updated: 2026-10-06
documents:
  - file: architecture.html
    title: 리뷰 자동화 시스템 아키텍처
    type: architecture        # requirements | sequence | erd | architecture | process | build-deploy | decision
    sdlc: design              # plan | design | develop | test | build-deploy | operate
    status: draft
    sources: [diagrams/architecture.drawio]
    exports: [exports/architecture.pdf]
    notion_url:               # 등록 후 채운다
    gdrive_url:
```

### 현재 업무와 문서

| 업무 (slug) | 최신 버전 | 문서 | 다루는 영역 |
|---|---|---|---|
| 스프린트 Git-flow 프로세스 (`sprint-gitflow`) | v0.1 | `process.html` | 버전 관리·CI, 2주 스프린트 |
| 코드 리뷰 자동화 (`code-review-automation`) | v0.1 | `review-gate.html` | 코드 리뷰 게이트 설치·Slack·Ruleset |
| | | `review-modes.html` | CI 리뷰 실행 방식 (API 키 vs Max 구독) |

문서끼리는 상대 경로로 연결한다. 예: `process.html`에서 `../../code-review-automation/v0.1/review-gate.html`. 새 버전을 만들면 다른 업무 문서에서 이 문서를 가리키는 링크를 새 버전으로 바꿀지 판단한다.

아직 문서가 없는 영역: 개발 도구 가이드, 빌드·배포, 이밸 게이트·골든셋(아래 이전 설계 참고), 시퀀스·ERD·아키텍처.

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
- 리포 구조를 그대로 따라 `tommoro-workspace/<업무 slug>/<버전>/` 아래에 문서를 둔다. 하위 폴더는 처음 내보낼 때 만든다.
- 업로드한 파일 URL은 `meta.yaml`의 `gdrive_url`과 Notion의 `Google Drive` 속성에 적는다. 업로드는 Notion 등록과 마찬가지로 문서마다 확인을 받은 뒤 한다.

## Notion 등록

- 등록 위치: Private 영역 `투모로업무프로세스` 페이지 아래의 데이터베이스 **`SDLC 설계 문서`**.
  - 데이터베이스: `https://app.notion.com/p/4eb6430f2cee4365b7925717f46bfed7`
  - 데이터 소스: `collection://b7c4aa34-0f54-45e1-8e7c-978977041819`
  - 같은 부모 페이지에 수동으로 만든 페이지 `00. 업무 관련`, `01. Github Workflow`, `02. Code Review Workflow`가 있다. 이 페이지들은 건드리지 않는다.
- **설계 문서 1건 = 데이터베이스 페이지 1개**로 등록한다. 업무 하나나 버전 하나를 페이지 하나로 묶지 않는다.
- 속성은 `meta.yaml`에서 채운다.
  - 문서명 ← `title`
  - 업무명 ← `task`. select 옵션이라 새 업무면 옵션이 추가된다
  - 업무 slug, 버전
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

- `code-review-automation/v0.1/review-gate.html`의 워크플로는 `push`로 트리거된다(`feature/code-review` 게이트 브랜치와 `develop` 사후 리뷰). `sprint-gitflow/v0.1/process.html`은 `pull_request`(base가 `develop`·`main`)로 트리거되는 것으로 정했다. code-review-automation 다음 버전에서 이 차이를 맞춘다.
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
DOC="docs/<slug>/<version>/<문서>.html"
"$CHROME" --headless=new --hide-scrollbars --window-size=1280,4000 --screenshot=/tmp/desk.png "file://$PWD/$DOC"
"$CHROME" --headless=new --hide-scrollbars --window-size=500,7000 --screenshot=/tmp/narrow.png "file://$PWD/$DOC"
"$CHROME" --headless=new --no-pdf-header-footer --print-to-pdf="${DOC%/*}/exports/<문서>.pdf" "file://$PWD/$DOC"
```

가로 넘침은 두 가지로 확인한다. 하나는 `document.documentElement.scrollWidth`가 창 너비보다 큰지, 다른 하나는 `overflow-x`가 visible이 아니면서 `scrollWidth > clientWidth`인 요소가 있는지다. 이 측정 스크립트를 문서 사본에 넣고 `--dump-dom`으로 결과를 읽는다.
