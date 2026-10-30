# 로컬 업무 문서 사이트 (`site/`) 개발 가이드

리포 `docs/`를 메뉴 + 뷰어로 관리하는 로컬 웹사이트(1.x~3.x). 요구사항·결정은 `spec/REQUIREMENT.md`·`spec/REQUIREMENT-2.0.md`·`spec/REQUIREMENT-3.0.md`. 같은 화면 코드를 Cloudflare 앱도 쓴다(`cloudflare-app.md`).

```bash
npm install       # 리포 루트에서. npm workspaces(packages/* · apps/* · site)라 의존성은 루트 node_modules에 모인다
cd site
npm run dev        # 8000·5174 포트를 쓰던 node 프로세스(이전 개발 서버)를 먼저 종료(predev, node가 아닌 프로세스면 종료하지 않고 멈춤)한 뒤 API(Fastify, 127.0.0.1:5174) + 화면(Vite, http://127.0.0.1:8000) 실행
npm run typecheck  # tsc (server + web)
npm run build      # 타입 검사 후 site/dist로 빌드
npm run check:textedit  # 2.0 텍스트 편집 어댑터 검사(바꾼 것 없이 저장하면 바이트 동일 등)
npm test           # 단위·Markdown 편집기·텍스트 편집·API·MCP 자동 테스트(node:test)
npm run test:ui    # 화면 테스트(전역 puppeteer). npm run test:all은 둘 다
```

- **테스트** (`site/test/`): 임시 폴더에 docs를 만들고 빈 포트로 서버를 따로 띄우므로 실제 `docs/`와 켜 둔 사이트를 건드리지 않는다. 서버는 `WORKFLOW_DOCS_ROOT`·`WORKFLOW_DATA_DIR`·`PORT`, Vite는 `WEB_PORT`를 받는다(없으면 리포 `docs/`·`site/data/`·5174·8000). 지켜야 할 것은 `.claude/rules/testing.md`.
- **server/**: `scan.ts`가 `docs/_site/categories.yaml`·`menus.yaml`(읽고 쓰기는 `sitefiles.ts`의 `loadSite`/`saveSite`)과 문서별 `meta.yaml`을 읽어 SQLite 색인(`site/data/index.db`)을 채운다. 서버가 시작하거나 `POST /api/reindex`가 호출될 때마다 테이블을 지우고 처음부터 다시 만든다. 그래서 스키마를 바꿀 때 마이그레이션이 필요 없다. yaml이나 파일에 문제가 있으면 멈추지 않고 경고로 모은다. 경고는 `/api/tree`의 `warnings`와 좌측 목록 하단에 표시된다.
- **API**: `GET /api/tree`(대분류 → 메뉴 → 문서. 메뉴의 `documents`는 하위 문서까지 모두 담고 하위 문서는 `parent`가 있다), `GET /api/docs/:menu/:doc`(버전과 파일 목록), `POST /api/upload`(multipart, 새 하위 문서는 `parent`), `POST /api/menus`, `POST /api/reindex`, `GET /api/events`(SSE 변경 알림), `GET /api/convert/:to/<docs 기준 경로>`(변환 결과), `POST /api/docs/:menu/:doc/edit`(Markdown 저장), `POST /api/focus`(열린 화면 이동, 3.4). 관리 API는 메뉴(`/api/menus/:slug` PATCH·DELETE, `/move`), 대분류(`/api/categories`), 문서(`/api/docs/:menu/:doc` PATCH·DELETE, `/move`는 `{ menu, parent?, index? }`), 휴지통(`/api/trash`), 검색(`/api/search?q=&category=&kind=`)이다. `docs/` 원본은 `/files/<메뉴>/<문서>/<버전>/<파일>`로 그대로 제공한다. 그래서 HTML 문서의 상대 경로 리소스와 링크가 그대로 동작한다.
- **web/**: React Router 경로는 `/:category/:menu/:doc?v=<버전>`이다. 뷰어는 대표 파일(entry)의 확장자로 고르며, 그 분기는 `web/src/viewers/Viewer.tsx`에 있다. 색은 `styles.css`의 `:root` 토큰(docs HTML과 같은 값)을 Tailwind `@theme inline`으로 연결한다.
- **확인 창** (`components/confirm/ConfirmProvider.tsx`, `useConfirm()`, `useAction().run`): 규칙은 `.claude/rules/site-ui.md`.
- **텍스트 편집 2.0** (`packages/core/src/textedit/`, 4.0 P1에서 `site/server/textedit/`에서 옮김, 계획은 `spec/REQUIREMENT-2.0.md`): HTML·DOCX·PPTX의 태그 안 글자만 고친다.
  - 형식별 어댑터가 "텍스트 조각"(id, 글자, 해시)을 뽑는다. 저장할 때는 바뀐 조각의 **원본 구간만** 교체한다. 그래서 구조·서식·속성과 나머지 바이트는 그대로다.
  - HTML은 parse5의 텍스트 노드 원본 위치를 쓴다. 앞뒤 공백(들여쓰기)은 편집 구간 밖에 남기고, `pre` 안만 줄바꿈을 허용한다.
  - DOCX·PPTX는 zip 안 XML의 `<w:t>`·`<a:t>` 위치를 htmlparser2(xmlMode)로 찾는다. 같은 서식이고 사이에 run 경계만 있는 run은 한 조각으로 합치고, 저장할 때 첫 run에 글자를 넣고 나머지를 비운다. 바뀐 파트만 다시 써서 zip을 다시 묶는다.
  - API: `GET /api/docs/:menu/:doc/segments?v=`, `POST /api/docs/:menu/:doc/text-edit`(`{ baseVersion, changes: [{id, hash, text}], note }`). 저장하면 `source: text-edit` 새 버전이 생긴다. 기준 버전이 최신이 아니거나 조각 해시가 다르면 409를 낸다.
  - **HTML 그 자리 편집** (`viewers/HtmlTextEditor.tsx`): 최신 버전 HTML 문서 상단의 "텍스트 편집" 버튼으로 연다.
    - 서버의 `GET /api/docs/:menu/:doc/edit-view?v=`가 조각마다 `<span data-seg>`(SVG 글자는 `<tspan data-seg>`)로 감싸고 `<base>`를 넣은 사본을 준다.
    - 화면은 이 사본을 `sandbox="allow-same-origin"`(스크립트 없음)으로 열어, 각 span에 `contenteditable="plaintext-only"`를 켠다. SVG 글자는 누르면 입력창으로 고친다(title·desc는 감싸지 않는다).
    - Enter는 막고(pre 안만 허용), Esc는 그 조각을 되돌리고, 링크·버튼·폼은 동작하지 않게 한다.
    - 바뀐 조각은 `data-changed`로 표시한다. 작성 중 내용은 localStorage(`workflow:textdraft:*`)에 둔다. 저장은 확인 창을 거쳐 `text-edit` API로 한다.
  - **DOCX 목록 편집** (`viewers/OfficeTextEditor.tsx`): 왼쪽은 영역(본문·머리글·바닥글·표 칸)과 문단별 조각 칸이다. 서식 힌트 `fmt`(b·i·u)로 원래 서식을 보여 준다. 오른쪽은 `POST /api/docs/:menu/:doc/text-preview`(저장 안 함)가 돌려준 파일을 docx-preview로 그린다.
  - **PPTX 목록 편집**(같은 `OfficeTextEditor`): 슬라이드 번호는 `presentation.xml`의 발표 순서다(파일 이름 slideN과 다를 수 있다). 미리보기는 `text-preview?to=pdf`(서버 LibreOffice 변환, `convert.ts`의 `convertData`로 내용 해시 캐시)를 PDF 뷰어로 열고, 고치던 슬라이드 쪽(`#page=n`)을 보여 준다.
  - **SVG 텍스트 편집** (`packages/core/src/textedit/svg.ts`, 화면은 `HtmlTextEditor`): SVG를 htmlparser2(xmlMode)로 읽어 글자 구간만 바꾸고, 특수 문자는 XML 방식으로만 쓴다(HTML 어댑터는 `&nbsp;`를 써서 SVG를 깨뜨린다).
    - draw.io 내보내기는 글자마다 HTML(`foreignObject`)과 예비 `<text>` 두 벌이 있다. HTML 글자만 조각으로 보이고, 저장할 때 예비 글자를 원래 줄 수(`<tspan>`)를 지켜 원래 줄 길이 비율로 다시 나눠 쓴다. 브라우저에 안 보이는 `switch` 뒤 갈래(예: "Text is not SVG")는 조각이 아니다.
    - 편집 사본(`edit-view`)은 `image/svg+xml`로 주고, HTML 글자는 `<span data-seg>`(contenteditable), SVG 글자는 `<tspan data-seg>`(입력창)로 감싼다. 스타일은 `injectStyle`로 SVG 이름공간에 넣는다.
    - 넘침 경고: 화면은 고치기 전 글자를 품던 도형(가장 가까운 `g[data-cell-id]`)에 닿거나 넘치면 경고 막대와 확인 창 ⚠로 알린다. 서버는 예비 글자 줄이 원래 최장 줄보다 15% 넘게 길면 저장 결과 `warnings`로 알린다(MCP는 "주의:"). 상자 크기는 바꾸지 않는다.
    - 내보낼 때 다이어그램 원본을 넣지 않은 `.drawio.svg`는 draw.io로 다시 열 수 없으므로 이 SVG가 원본이다. 앞으로는 `.drawio` 원본을 함께 남긴다.
  - **XLSX 셀 편집** (`packages/core/src/textedit/xlsx.ts`, 같은 `OfficeTextEditor`): 문자 셀만 고친다(숫자·수식 셀 제외). 시트 순서는 `workbook.xml` 기준이다.
    - 공유 문자열(`sharedStrings.xml`)을 그 셀만 쓰면 그 자리에서 고친다. 여러 셀이 함께 쓰면 고친 셀용 `<si>`를 끝에 붙이고 그 셀의 `<v>`만 새 번호로 바꾼다(`uniqueCount` +1). 그래서 같은 글자를 쓰던 다른 셀은 그대로 남는다.
    - 원래 줄바꿈이 있던 셀은 Enter를 허용한다. 미리보기는 기존 `SheetViewer`다.
  - **DOCX·PPTX·XLSX 버전 비교** (`viewers/SegmentDiffViewer.tsx`): 문서 상단 "비교"를 고르면 두 버전의 텍스트 조각을 jsdiff `diffArrays`로 맞춰 바뀜·추가·삭제를 보여 준다. HTML 등 텍스트 형식은 기존 줄 단위 `DiffViewer`를 쓴다.
  - 저장·임시 보관·편집 막대는 `viewers/textedit/session.tsx`의 `useTextSession`과 `EditBar`를 HTML·DOCX 편집기가 함께 쓴다.
  - 어댑터를 고쳤다면 `npm run check:textedit`로 확인한다(검사용 샘플은 `site/scripts/fixtures/`).
- **workflow-docs MCP** (`site/mcp/server.ts`, `.mcp.json`으로 등록, 3.0): 사이트 REST API를 감싼 stdio MCP 서버다. 도구 정의는 `packages/mcp-tools`에 있고 Cloudflare 원격 MCP(`apps/worker/src/mcp.ts`, OAuth, 4.0 P6)와 같이 쓴다. 도구를 고치면 `site/test/mcp.test.ts`와 `apps/worker/test/mcp.test.ts`를 함께 돌린다.
  - 도구: `list_documents`(하위 문서는 들여 씀), `find_documents`, `get_document`, `get_text`, `edit_text`({segment,text} 또는 {find,replace}), `save_markdown`, `upload_document`(origin·filename·parent), `upload_version`, `create_menu`, `release_document`, `focus_in_site`, 슬라이드 덱(5.0 M4) `deck_create`·`deck_get`·`slide_put`·`slide_patch`·`asset_put`, 구조 연산·수정본(5.0 M7) `doc_structure`·`doc_ops`·`revision_list`·`revision_restore`. 덱 쓰기(`slide_*`·`asset_put`)와 구조·수정본 도구는 Cloudflare만이고 로컬은 보기만이라(D-51) 로컬 서버에는 읽기용 `GET /api/docs/:menu/:doc/deck`만 있다.
  - 모든 요청에 `X-Workflow-Agent: claude-code` 헤더를 붙인다. 서버는 이 헤더가 있으면 변경 알림(SSE)에 `by: claude-code`를 담는다.
  - 문서는 사이트 주소(`?v=`, `&seg=`), `대분류/메뉴/문서`, `대분류 > 메뉴 > 제목`, 제목으로 지정한다.
  - 삭제·휴지통 도구는 두지 않는다(D-24). 쓰기 도구는 변경 메모 앞에 "Claude Code:"를 붙인다(D-26). 외부에서 가져온 문서는 `meta.yaml`의 `origin_url`에 출처를 남긴다.
  - stdout은 MCP 통신용이라 로그는 stderr로만 쓴다. 점검은 `npm test`의 `test/mcp.test.ts`(임시 docs 사용)로 한다. `scripts/mcp-check.ts`는 켜 둔 사이트에 임시 메뉴 `zz-mcp`를 만들므로 쓴 뒤 지운다.
- **외부 문서 보기(3.3)** (`components/OriginBar.tsx`): `meta.yaml`에 `origin_url`이 있으면 상단에 출처 막대를 두고 HTML은 스크립트를 끈 sandbox(`allow-scripts` 없음)로 연다(D-25). "스크립트 켜기"는 localStorage `workflow:scripts:<메뉴>/<문서>@<버전>`에 기억하고, 새 버전은 다시 꺼진다(D-27). 출처는 문서 관리 대화상자에서 고친다(`PATCH`의 `origin`).
- **요소 참조(3.2)** (`viewers/HtmlRefView.tsx`, `viewers/SegmentRefList.tsx`, `lib/seg.ts`): 문서 상단 "참조 복사"를 켜면 글자를 눌러 `…?v=<버전>&seg=<id>` 주소를, Alt+클릭은 감싸는 블록 범위를 복사한다. 주소에 `?seg=`(`12`, `12-15`, `3,10-12`)가 있으면 참조 보기로 강조한다(D-28). HTML 참조 보기는 편집 사본(`edit-view`)을 스크립트 없이 읽기 전용으로 연다. seg 해석 규칙은 화면 `lib/seg.ts`와 MCP `parseSeg`가 같다.
- **Claude 실시간 표시(3.4)** (`components/LiveNotice.tsx`): 변경 알림에 `by`, 대분류·메뉴·문서·제목·버전·`segs`를 담는다. Claude가 저장하면 알림을 띄우고, 같은 문서를 보고 있으면 `?seg=`로 바뀐 조각을 강조하며, 다른 문서면 "열기"만 준다(D-29). `POST /api/focus`(`focus_in_site`)는 SSE `focus` 이벤트로 열린 화면을 그 문서·버전·조각으로 옮긴다.
- **정식 버전 확정** (`store.ts`의 `release`, `POST /api/docs/:menu/:doc/release`, `components/ReleaseBadge.tsx`): 문서 상단 상태 배지가 draft·review이면 버튼이 된다. 누르면 "vX.0으로 변경하시겠습니까?" 확인 후 현재 버전 폴더를 다음 major 버전(v0.x → v1.0, v1.2 → v2.0)으로 복사한다. 그리고 `source: release` 버전을 추가하고 `current`와 `status: approved`를 바꾼다. 기존 버전 폴더는 그대로 둔다. 같은 내용 복사라 업로드의 "직전과 같으면 거부" 검사를 거치지 않는 전용 함수다. 정식 문서에 업로드나 편집으로 새 버전이 생기면(v1.0 → v1.1) 상태는 approved 그대로 둔다(D-15). 업로드·저장 코드는 status를 건드리지 않는다.
- **프레젠테이션 모드** (`viewers/Presentation.tsx`): 문서 상단 버튼으로 문서 영역만 Fullscreen API로 띄운다. HTML·Markdown은 1280px 기준으로 그린 뒤 화면 너비 비율로 `transform: scale` 한다. 그래서 글자와 레이아웃이 함께 커진다. Markdown은 미리보기만 보여준다. 다른 형식은 그대로 넓힌다.
- **아이콘·툴팁** (`components/IconButton.tsx`, `components/Tooltip.tsx`): 규칙은 `.claude/rules/site-ui.md`.
- **문서 화면 머리** (`components/DocView.tsx`): 제목(h1, 32px)을 누르면 그 자리 입력칸으로 고친다(Enter 확인 창, Esc·바깥 클릭 취소, 한글 조합 중 Enter는 건너뜀). 제목 오른쪽에 보고 있는 버전의 작성일(12px), 버전 선택, 비교, 상태 배지, 기능 버튼.
- **좌측 폴더 트리** (`components/Sidebar.tsx`, `components/sidebar/ContextMenu.tsx`, 계획은 `spec/REQUIREMENT.md` 5.3): MarkFlow 사이드바 방식. 폴더(메뉴) → 하위 폴더 → 문서 → 하위 문서. 폴더 아이콘은 열림·닫힘, 접힌 항목은 localStorage `workflow:sidebar-collapsed`, 지금 연 문서의 상위는 늘 펼친다.
  - 오른쪽 클릭이나 줄의 ⋯로 메뉴: 폴더는 새 문서·하위 폴더 추가·이름 바꾸기·위로·아래로·다른 위치로 옮기기(`MoveMenuDialog`)·폴더 삭제, 문서는 하위 문서 추가(업로드 창 `parent` 고정)·이름 바꾸기·위로·아래로·상위 문서 밖으로 꺼내기·휴지통으로. 이름 입력은 그 자리 입력칸(Enter 확인 창, Esc·바깥 클릭 취소).
  - 끌어서 놓기(D-36): 줄 위쪽 28% 앞, 아래쪽 28% 뒤, 가운데 안. 같은 자리 순서는 확인 없이, 다른 자리로 옮기기는 확인 창(warning). 자기 자신·하위로는 놓을 수 없다. 링크(`NavLink draggable={false}`)가 아니라 줄(`data-row`)이 끌기를 받는다. 바깥 파일을 폴더에 놓으면 업로드 창.
  - 폴더 삭제(`DeleteMenuDialog`, D-13 개정): 폴더 이름을 입력해야 버튼이 켜지고(이 창이 확인 창을 대신한다), 안의 문서는 하위 폴더 것까지 휴지통으로 간다. 문서 휴지통은 하위 문서째 옮기고, 복원은 메뉴 바로 아래로 한다.
- **사이드바** (`components/SidebarResizer.tsx`): 너비는 CSS 변수 `--sidebar-w`로 정한다(200~560px, 기본 272). 손잡이는 `setPointerCapture`로 끌기를 받는다. 덮개 방식으로 바꾸면 iframe 위에서 이벤트를 뺏기거나 더블클릭이 깨진다. 접으면 20px 띠가 된다. 너비와 접힘 상태는 localStorage(`workflow:sidebar-*`)에 둔다. 휴지통은 사이드바 하단 footer에 고정이다.
- **정적 파일**: 로고(`logo.svg`)와 파비콘(`favicon.svg`, `favicon-32.png`, `apple-touch-icon.png`)은 `web/public/`에 있다. 헤더 로고를 누르면 `/`로 간다.
- **react-grab** (개발 모드 전용, devDependency): `web/src/main.tsx`에서 `import.meta.env.DEV`일 때만 불러온다. 화면 요소를 가리키고 ⌘C를 누르면 그 요소의 컴포넌트와 소스 위치가 복사되어, 코딩 에이전트에 붙여 넣고 수정을 요청할 수 있다. 운영 빌드에는 포함되지 않는다.
- **HTML 뷰어**: iframe에 `allow-same-origin` 없이 sandbox를 건다. 문서 안의 스크립트는 동작하지만 사이트 쪽에는 접근하지 못한다. 문서 안의 링크를 누르면 iframe 안에서 이동한다.
- **업로드** (`server/store.ts`): 파일 → `meta.yaml`(주석·순서 유지) → 색인 순서로 쓴다.
  - 버전은 문서마다 다음 번호(새 문서 `v0.0` → 수정 `v0.1` → `v0.2`)를 자동으로 정하고, 직접 지정할 수도 있다.
  - 직전 버전과 파일 구성·내용(sha256)이 같으면 409로 거부한다.
  - zip 하나는 풀어서 쓰고, 폴더째 올리면 공통 최상위 폴더 이름을 뗀다.
  - 대표 파일은 `index.html` → 첫 HTML → 가장 얕은 첫 파일 순서로 고른다.
  - `..`나 숨김 파일 경로는 버린다.
  - 새 메뉴는 `menus.yaml`에 추가된다.
- **실시간 반영**: chokidar가 `docs/`를 감시하고, 변경이 생기면 300ms 동안 모았다가 한 번 다시 색인한 뒤 SSE로 알린다. 화면은 `useLiveUpdates`로 목록과 문서 정보를 다시 불러온다. SSE는 `pagehide`에서 닫고 `pageshow`(뒤로 가기 캐시 복귀)에서 다시 연다. 닫지 않으면 캐시에 남은 페이지들이 연결을 잡아 같은 호스트 연결 한도(6개)가 차고 사이트가 멈춘다(TC-UI-13). 파일 URL에 `?h=<sha256 앞 12자리>`를 붙여 같은 경로의 내용이 바뀌어도 iframe·이미지가 새로 고쳐진다.
- **변환** (`server/convert.ts`): PPTX·DOCX → PDF는 `soffice --headless`, draw.io → SVG는 `drawio -x`로 변환한다.
  - 결과는 원본 sha256을 이름으로 `site/data/cache/`에 캐시한다. 변환기를 고쳤다면 캐시 파일을 지워야 다시 변환된다.
  - LibreOffice는 한 번에 하나씩 순서대로 돌리고, 별도 프로필(`cache/lo-profile`)을 쓴다.
  - **macOS headless LibreOffice는 기본 상태에서 시스템 폰트를 보지 못해 한글이 빠진 PDF를 만든다.** 그래서 시스템 폰트 폴더를 넣은 `cache/fonts.conf`를 만들어 `FONTCONFIG_FILE`로 넘긴다.
- **뷰어**: 형식별 분기는 `web/src/viewers/Viewer.tsx`에 있다.
  - PDF는 브라우저 내장 뷰어로 연다. Chrome은 sandbox iframe에서 PDF를 열지 않아 sandbox를 걸지 않는다.
  - DOCX는 `docx-preview`로 렌더링하고, PDF 변환으로 볼 수도 있다.
  - XLSX·CSV는 SheetJS로 읽는다. SheetJS는 npm 레지스트리 버전이 오래되어 공식 CDN tgz로 설치했다. CSV는 UTF-8 텍스트로 읽는다.
- **Markdown 편집** (`viewers/MarkdownViewer.tsx`, `viewers/markdown-editor/`, `store.ts`의 `saveEdit`, 계획은 `spec/REQUIREMENT.md` 5.2): MarkFlow 에디터(`~/project/markflow/packages/editor`) 소스를 복사해 고쳐 쓴다(D-30). 원본을 다시 가져올 때는 5.2의 "바꾼 점"을 다시 적용한다.
  - 화면: 서식 툴바(`Toolbar.tsx`, 제목 1~6·굵게·목록·코드 블록·링크·표·수식 등, IconButton) + 보기 방식(편집만·나란히·미리보기만) + 오른쪽 저장 영역(`MarkdownViewer`가 `toolbarEnd`로 넘김), 편집 창(`EditorPane.tsx`, CodeMirror 6, 사이트 다크 모드를 따름)과 미리보기, 상태 표시줄(줄·글자·커서), Markdown 복사. 커서 위쪽 가장 가까운 제목으로 미리보기를 옮긴다.
  - 미리보기(`MarkdownPreview.tsx` + `markdown-editor/parseMarkdown.ts`, D-31): unified(remark-gfm·remark-breaks·remark-math → rehype-highlight·rehype-katex·rehype-raw·rehype-sanitize). 줄바꿈 한 번이 `<br>`, 수식은 KaTeX, 허용 목록 밖 HTML은 지운다. 사이트에서 더한 것: 상대 경로 이미지·링크를 버전 폴더 기준으로 풀기, `#` 링크는 같은 탭(나머지는 새 탭), `mermaid` 블록은 화면에서 다이어그램으로. 편집기·이전 버전·프레젠테이션이 같은 엔진을 쓴다. 스타일은 `markdown-editor/preview.css`(`.mf-preview`, 사이트 토큰).
  - 이미지(D-32): 툴바 "이미지 올리기", 편집 창 끌어 놓기·붙여넣기 → Cloudflare Worker(`site/cloudflare/r2-uploader`, 배포는 그 README) `POST /upload` → R2 공개 주소를 `![이름](주소)`로 넣는다. Worker 주소는 localStorage `mf-cf-worker-url`, 설정 창(`UploadSettingsDialog.tsx`)에서 테스트 업로드가 성공해야 저장된다. 이미지는 리포 밖에 있고 문서에는 주소만 남는다.
  - `[[`(D-33): 사이트 문서 목록(`useTree`)에서 제목·메뉴로 후보를 고르고, 고르면 `[제목](/대분류/메뉴/문서)` 일반 링크가 들어간다.
  - 저장은 기준 버전의 파일을 모두 복사하고 대표 `.md`만 바꿔 새 버전(`source: edit`)으로 쓴다. 그사이 최신 버전이 바뀌었으면 409로 거부한다. 저장 전 내용은 localStorage(`workflow:draft:<메뉴>/<문서>@<버전>`)에 임시 보관하고, 다시 열면 복원을 제안한다. 저장하지 않고 떠나면 경고한다(beforeunload).
  - 이전 버전은 읽기 전용이다(서식 툴바 없음, 편집 창 고칠 수 없음).
  - 새 Markdown 문서는 업로드 대화상자의 "새 Markdown 문서" 탭에서 `# 제목` 한 줄짜리 `.md`를 업로드하는 방식으로 만들고, 만들면 편집 창이 열려 커서가 문서 끝에 있다(라우터 state `edit`).
- **버전 비교**: 텍스트 형식(md, html, yaml 등)이고 버전이 2개 이상이면 문서 상단에 "비교" 선택이 생긴다(`?cmp=<버전>`). `viewers/DiffViewer.tsx`가 jsdiff로 줄 단위 비교를 보여준다.
- **상단 메뉴(대분류)** (D-17, D-18): 원본은 `categories.yaml`이고 색인 테이블은 좌측 `menu`와 분리된 `top_menu`다. 관리는 헤더(`components/header/TopMenuBar.tsx`)에서 한다.
  - ＋로 추가(이름·key), 선택된 탭의 ⋯로 이름 변경(탭 자리 입력, 더블클릭으로도)·왼쪽/오른쪽 이동·삭제를 한다. 탭에 마우스를 올리면 나오는 핸들(⋮⋮)을 잡아 끌면 순서가 바뀐다. 커서가 놓을 탭의 왼쪽·오른쪽 절반 중 어디에 있느냐에 따라 그쪽에 표시선이 나오고, 순서가 바뀌지 않는 자리에는 표시선을 내지 않는다.
  - 삭제는 하위 메뉴가 없을 때만 된다. key는 URL과 meta.yaml에 쓰이므로 바꾸지 않는다.
  - ⋯ 메뉴와 ＋ 팝오버는 탭 줄이 가로로 넘쳐도 잘리지 않도록 화면 기준(fixed)으로 띄운다.
  - `categories.yaml`에 없는 key의 트리가 `menus.yaml`에 있으면 저장할 때 지우지 않고 남기고, 색인 경고로 알린다.
- **관리** (`server/manage.ts`): 메뉴를 옮기거나 하위로 넣어도 `menus.yaml`만 바뀌고 폴더(`docs/<메뉴 slug>/`)는 그대로다.
  - 다른 대분류로 옮기면 그 메뉴 문서들(하위 문서 포함)의 `meta.yaml` category를 맞춘다.
  - 문서를 옮기면(`moveDoc`) 문서 폴더를 새 자리(메뉴 폴더 또는 상위 문서 폴더)로 옮기고, 다른 메뉴면 하위 문서까지 menu·category를 맞춘다. 옮기는 문서 slug가 그 메뉴에 있으면 `-2`, 하위 문서 slug가 겹치면 409. 옮긴 뒤 두 자리의 `order`를 다시 쓴다(`reorderIn`, 정렬은 트리 API와 같은 order → 제목 코드값 순).
  - 대분류는 비어 있을 때만 지운다. 메뉴 삭제는 안의 문서를 휴지통으로 보낸 뒤 지운다.
  - `categories.yaml`·`menus.yaml` 맨 위 `#` 주석은 yaml 라이브러리가 첫 키에 붙여 버리므로, 원문에서 떼어 두었다가 저장할 때 다시 붙인다. 내용이 같으면 파일을 다시 쓰지 않는다.
- **휴지통**: 문서 폴더를 `docs/_trash/<로컬 시각 yyyyMMddHHmmss>--<메뉴>--<문서>/`로 옮긴다. 스캔은 `_`로 시작하는 폴더를 건너뛴다. 복원할 때 원래 메뉴가 없으면 메뉴를 고르게 한다.
- **검색**: 색인할 때 각 문서 최신 버전의 대표 파일 본문을 FTS5 trigram 테이블 `search`에 넣는다. HTML은 script·style·svg를 빼고 글자만 넣는다. 질의는 trigram 색인 위의 `LIKE '%q%'`라서 한국어 두 글자 단어와 조사가 붙은 말도 찾는다. 제목에 맞은 문서를 먼저 보여준다.
- **조회 재시도**: 404(옮겨지거나 지워진 문서)는 재시도하지 않는다. 관리 작업 뒤 목록 새로고침은 기다리지 않는다. 기다리면 옛 주소의 404 재시도 때문에 화면 이동이 늦어진다.
- **업로드 진입점**: 모두 `upload/UploadContext.tsx`의 `useOpenUpload()`로 연다.
  - 상단 "업로드" 버튼
  - 폴더 줄의 `+`(새 문서)·폴더 메뉴 "새 문서", 문서 메뉴 "하위 문서 추가"(`parent`)
  - 메뉴에 파일 끌어다 놓기
  - 문서 화면의 "새 버전"
