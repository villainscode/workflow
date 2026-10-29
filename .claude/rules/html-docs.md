---
paths:
  - "docs/**/*.html"
  - "docs/**/*.htm"
---

# HTML 문서 작성·검증 규칙

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
