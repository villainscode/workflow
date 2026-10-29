# 산출물 형식과 도구

문서 산출물을 만드는 방법. HTML 작성·검증 규칙은 `.claude/rules/html-docs.md`.

| 형식 | 만드는 방법 |
|---|---|
| HTML (기본) | 단일 파일로 직접 작성한다. 아래 작성 규칙을 따른다 |
| 다이어그램 (시퀀스, ERD, 아키텍처) | `.drawio` XML을 직접 쓰거나, 빠른 초안은 Mermaid `.mmd`로 쓴다. export: `drawio -x -f svg\|png\|pdf`, `mmdc -i x.mmd -o x.svg` |
| SVG · PNG | draw.io나 mmdc로 export한다. HTML 페이지 이미지는 headless Chrome 스크린샷으로 만든다 |
| PDF | HTML은 headless Chrome `--print-to-pdf`, 다이어그램은 draw.io export로 만든다 |
| PPT · Excel | `pptx` · `xlsx` 스킬을 쓴다. 파이썬은 리포의 `.venv`(python-pptx, openpyxl)를 쓴다 |
| Google Docs · Sheets · Slides | Google Drive MCP(claude.ai 연결됨)로 만든다. 만들 때는 `google-workspace` 스킬을 먼저 읽는다. |

화면 확인: headless Chrome `--screenshot`은 iframe 내용을 그리기 전에 찍혀 빈 화면이 나올 수 있다. 사이트 화면은 Mermaid CLI와 함께 전역 설치된 puppeteer(`$(npm root -g)/@mermaid-js/mermaid-cli/node_modules/puppeteer`)로 찍는다. 실시간 연결(SSE·WebSocket)이 계속 열려 있어 `networkidle0`은 끝나지 않으므로 `domcontentloaded` 후 요소를 기다린다.
