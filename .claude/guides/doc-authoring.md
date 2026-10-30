# 문서 산출물 만들기

`docs/`에 들어갈 문서(HTML·다이어그램·PDF·PPT·엑셀)를 만드는 방법과, 새 문서의 출발점이 되는 이전 설계. HTML 작성·검증 규칙은 `.claude/rules/html-docs.md`, 시각 산출물·글쓰기 품질 기준은 `.claude/skills/anti-ai-slop`.

## 산출물 형식과 도구

| 형식 | 만드는 방법 |
|---|---|
| HTML (기본) | 단일 파일로 직접 작성한다. 아래 작성 규칙을 따른다 |
| 다이어그램 (시퀀스, ERD, 아키텍처) | `.drawio` XML을 직접 쓰거나, 빠른 초안은 Mermaid `.mmd`로 쓴다. export: `drawio -x -f svg\|png\|pdf`, `mmdc -i x.mmd -o x.svg` |
| SVG · PNG | draw.io나 mmdc로 export한다. HTML 페이지 이미지는 headless Chrome 스크린샷으로 만든다 |
| PDF | HTML은 headless Chrome `--print-to-pdf`, 다이어그램은 draw.io export로 만든다 |
| PPT · Excel | `pptx` · `xlsx` 스킬을 쓴다. 파이썬은 리포의 `.venv`(python-pptx, openpyxl)를 쓴다 |
| Google Docs · Sheets · Slides | Google Drive MCP(claude.ai 연결됨)로 만든다. 만들 때는 `google-workspace` 스킬을 먼저 읽는다. |

화면 확인: headless Chrome `--screenshot`은 iframe 내용을 그리기 전에 찍혀 빈 화면이 나올 수 있다. 사이트 화면은 Mermaid CLI와 함께 전역 설치된 puppeteer(`$(npm root -g)/@mermaid-js/mermaid-cli/node_modules/puppeteer`)로 찍는다. 실시간 연결(SSE·WebSocket)이 계속 열려 있어 `networkidle0`은 끝나지 않으므로 `domcontentloaded` 후 요소를 기다린다.

## 이밸 게이트·골든셋 이전 설계 (gitflow 문서 v1에 있던 내용)

새 문서를 쓸 때 출발점으로 쓴다. 확정된 결정은 아니다.

- 리뷰 원장: 고아 브랜치 `review-ledger`. `runs/<YYYY-MM>/<run_id>.jsonl`에 CI 봇이 critical·high 지적을 쌓고, `labels/`에 판정이 쌓인다. Ruleset과 워크플로 트리거에서는 뺀다.
- 판정: PR 코멘트 첫 줄 `/ocr-triage <id> fixed|false_positive|accepted|missed "사유"`. `fixed`를 뺀 판정에는 사유가 필수다. 지적 ID는 `<run_number>.<순번>` 형식이다.
- 골든셋: 매일 밤 원장과 판정을 합쳐 `golden/findings.jsonl`을 다시 만든다. 판정이 붙은 지적만 들어간다.
- 활용: 로컬 에이전트는 AGENTS.md 지침으로, CI는 `--background-file`로 바뀐 파일의 골든 기록을 읽는다. 같은 경로에서 오탐이 2회 이상 나오면 `.opencodereview/rule.json` 규칙으로 승격한다. 모델이나 버전을 바꾸기 전에는 `fixed`·`missed` 기록으로 회귀 평가를 한다.
