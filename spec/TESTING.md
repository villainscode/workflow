# 업무 문서 사이트 테스트 케이스

`site/`에서 만든 기능(1.x, 2.0, 3.x)을 확인하는 테스트 케이스 목록이다. 케이스마다 ID, 요구사항 근거, 확인 방법(자동·수동)을 적는다. 자동 케이스는 테스트 이름이 ID로 시작하므로, 실패한 테스트 이름으로 이 표를 찾을 수 있다.

> 상태: v0.7 (2026-11-03). 로컬 사이트: 자동 케이스 176개(실제 테스트 225건: `npm test` 183건 + `npm run test:ui` 42건), 수동 확인 23개, 모두 통과(LibreOffice 해당 없음 3건 건너뜀). Cloudflare(4.0, `apps/worker`): Worker 테스트 84건 + Cloudflare 화면 테스트 24건(2.7절), 모두 통과. 5.0 편집기 케이스는 2.8절(공통 구조 편집·슬라이드 형식·PDF `npm test -w @workflow/core` 57건 통과), 6.0 요소 편집기 케이스는 2.9절, 오피스 편집기(VO)는 2.10절, V6 보안 점검 재현 테스트는 2.11절(실제 ONLYOFFICE 왕복 TC-VO-12는 `npm run test:office-real`로 손으로 돌림, 2026-11-02 통과). Cloudflare 화면 테스트는 운영처럼 앱(127.0.0.1)과 콘텐츠(localhost) 출처를 나눠 띄우고, PDF 변환은 로컬 Docker로 변환 컨테이너를 돌린다.

---

## 1. 실행 방법

```bash
cd site
npm test           # 단위·텍스트 편집·API·MCP (약 15초, LibreOffice가 있으면 변환 검사 포함)
npm run test:ui    # 화면 테스트 (Puppeteer, 약 15초)
npm run test:all   # 둘 다
npm run check:textedit   # 실제 docs/의 HTML 문서 전체로 어댑터 왕복 검사(기존 점검 스크립트)

cd apps/worker           # 4.0 Cloudflare(문서 탐색 워크플로우)
npm test                 # Worker 테스트(Vitest + @cloudflare/vitest-plugin, Workers 런타임·로컬 D1·R2)
npm run test:ui          # Cloudflare 화면 테스트(VITE_CLOUD=1 빌드 + 임시 저장소 wrangler dev + 가져오기 CLI + 전역 puppeteer)
```

- **실제 `docs/`와 실행 중인 사이트를 건드리지 않는다.** 테스트마다 임시 폴더(`$TMPDIR/workflow-test-*`)에 `docs/`와 색인을 만들고, 빈 포트로 API 서버(와 화면 테스트는 Vite)를 따로 띄운 뒤 끝나면 지운다.
  - 서버는 `WORKFLOW_DOCS_ROOT`(docs 위치), `WORKFLOW_DATA_DIR`(색인·변환 캐시 위치), `PORT`를 받는다. Vite는 `WEB_PORT`를 받는다. 값을 주지 않으면 원래대로 리포의 `docs/`, `site/data/`, 5174·8000을 쓴다.
- 테스트 도구는 Node 내장 `node:test`다(추가 의존성 없음). 화면 테스트는 Mermaid CLI와 함께 전역 설치된 puppeteer를 쓰고, 없으면 건너뛴다.
- LibreOffice(`soffice`)가 없으면 PDF 변환 케이스(TC-TE-06, TC-TEAPI-04, TC-CONV-02)는 건너뛴다.
- 같은 파일 안의 케이스는 순서대로 실행되고, 앞 케이스가 만든 문서를 이어서 쓴다(예: TC-UP-01이 만든 문서를 TC-UP-07이 수정). 하나만 돌릴 때는 `--test-name-pattern`을 쓰되, 앞 케이스에 기대는 케이스는 함께 돌린다.

| 파일 | 다루는 범위 | 방식 |
|---|---|---|
| `site/test/unit.test.ts` | 버전 번호·slug 규칙, 메뉴 원본 yaml 읽기·쓰기, 색인 경고 | 함수 직접 호출 |
| `site/test/markdown.test.ts` | Markdown 편집기(MarkFlow 이식): 미리보기 엔진, 툴바 서식, Cloudflare 업로드·이미지 검사 | 함수 직접 호출(화면 없이 EditorState, fetch 대역) |
| `site/test/textedit.test.ts` | 2.0 텍스트 편집 어댑터(HTML·DOCX·PPTX·XLSX) | 샘플 파일(`site/scripts/fixtures/`) |
| `site/test/api.test.ts` | 사이트 REST API 전체 | 임시 docs로 서버를 띄우고 응답과 원본 파일(meta.yaml·버전 폴더)을 함께 확인 |
| `site/test/mcp.test.ts` | 3.x workflow-docs MCP 도구 11개 | MCP SDK 클라이언트로 stdio 연결(Claude Code와 같은 방식) |
| `site/test/work.test.ts` | 6.0 VL 로컬 수정본·구조 편집·덱 편집·그림 자산·버전으로 저장 | 임시 docs로 서버를 띄우고 저장 전후 docs/ 파일 전체를 비교 |
| `site/test/ui.test.ts` | 화면 주요 흐름 | Puppeteer로 실제 브라우저 조작 |
| `site/test/helpers.ts` | 임시 작업 폴더, 서버 띄우기, 업로드·호출 도구 | |

### 테스트용 docs 구성 (`helpers.ts`의 `makeWorkspace`)

```
docs/_site/categories.yaml   sdlc(SDLC), agent(Agent)          맨 위 # 주석 포함
docs/_site/menus.yaml        sdlc: process(개발 프로세스) ─ review(코드 리뷰, 하위)
                                   notes(회의록)
                             agent: []
docs/process/guide/v0.0/     guide.html + style.css            HTML 문서(태그 속 글자, &nbsp;, pre, SVG 글자, script 포함)
docs/notes/minutes/v0.0/     minutes.md                        Markdown 문서
(API 테스트만) docs/process/sheet·word                        sample.xlsx · sample.docx
```

---

## 2. 자동 테스트 케이스

### 2.1 버전·slug 규칙 (`unit.test.ts`)

| ID | 확인 내용 | 근거 |
|---|---|---|
| TC-VER-01 | 첫 버전 `v0.0`, 이후 `v0.1`…, 가장 높은 버전 기준으로 다음 번호, 형식이 아닌 이름은 무시 | D-6, D-16 |
| TC-VER-02 | 정식 확정 번호: v0.x → v1.0, v1.x → v2.0 | 1.x 정식 확정 |
| TC-VER-03 | slug: 확장자를 떼고 영문 소문자·숫자·하이픈만, 남는 글자가 없으면 `doc` | 3.2 폴더 구조 |

### 2.2 메뉴 원본과 색인 (`unit.test.ts`)

| ID | 확인 내용 | 근거 |
|---|---|---|
| TC-SITE-01 | `categories.yaml`과 `menus.yaml`을 합쳐 대분류 → 메뉴 트리(하위 포함)로 읽는다 | D-17 |
| TC-SITE-02 | 저장할 때 맨 위 `#` 주석을 유지하고, 내용이 같으면 파일을 다시 쓰지 않는다 | `.claude/guides/site-local.md` 관리 절 |
| TC-SITE-03 | `categories.yaml`에 없는 대분류의 트리는 지우지 않고 남긴다 | D-17 |
| TC-IDX-01 | 메뉴에 없는 폴더, meta.yaml 없음, yaml 오류, 대표 파일 없음, 버전 폴더 없음을 경고로 모으고 정상 문서는 색인한다. `_trash` 등 `_` 폴더는 건너뛴다 | D-8, 3.1 |

### 2.3 텍스트 편집 어댑터 (`textedit.test.ts`)

공통 케이스(TC-TE-01~06)는 HTML 1개, DOCX 2개, PPTX 2개, XLSX 2개, SVG 2개(draw.io 내보내기·일반) 샘플마다 각각 실행한다.

| ID | 확인 내용 | 근거 |
|---|---|---|
| TC-TE-01 | 조각 id가 0부터 순서대로이고, 다시 뽑아도 같다 | 2.0 §3.1 |
| TC-TE-02 | 바꾼 것 없이 저장하면 원본과 바이트까지 같다 | 2.0 2.1 완료 기준 |
| TC-TE-03 | 조각 하나만 바꾸면(특수 문자 `<>&"` 포함) 그 조각만 바뀐다. HTML은 바뀐 구간이 그 조각 근처뿐이고, zip 형식은 바뀐 파트가 하나뿐이다 | 2.0 §2.1·2.3 |
| TC-TE-04 | 원래 글자 해시가 다르거나 없는 조각이면 409 | 2.0 §3.2 |
| TC-TE-05 | 줄바꿈이 허용되지 않은 조각에 줄바꿈을 넣으면 400 | D-22 |
| TC-TE-06 | 고친 DOCX·PPTX·XLSX를 LibreOffice가 연다(PDF 변환 성공) | 2.0 §5 위험 |
| TC-TE-SVG-01 | draw.io SVG는 HTML 글자(foreignObject)만 조각이 되고 예비 글자(`<text>`)와 "Text is not SVG" 안내는 제외, 묶음 이름은 칸 id | 2.0 확장(SVG) |
| TC-TE-SVG-02 | HTML 글자를 고치면 예비 글자도 원래 줄 수(`<tspan>` 수)를 지켜 원래 줄 길이 비율대로 나눠 바뀐다 | 2.0 확장(SVG) |
| TC-TE-SVG-03 | 특수 문자와 U+00A0을 XML 방식으로 쓴다(`&nbsp;` 없음) | 2.0 확장(SVG) |
| TC-TE-SVG-04 | 줄이 원래보다 눈에 띄게 길어지면 경고, 비슷하면 경고 없음 | 2.0 확장(SVG) |
| TC-TE-SVG-05 | 일반 SVG: `<text>`·`<tspan>` 글자가 조각, title·desc·style 제외, 길어지면 경고 | 2.0 확장(SVG) |
| TC-TE-SVG-06 | 편집 사본: HTML 글자는 `<span data-seg>`, SVG 글자는 `<tspan data-seg>`, XML로 유효 | 2.0 확장(SVG) |
| TC-TE-SVG-07 | 줄 나누기 규칙: 줄 수 고정, 폭 비율, 공백에서 끊으면 공백 버림 | 2.0 확장(SVG) |
| TC-TE-07 | md·pdf는 어댑터가 없고, 확장자 대소문자는 무시한다 | 2.0 §1 |
| TC-TE-HTML-01 | head·script 글자는 조각이 아니다. 태그로 나뉜 글자는 각각 조각이 되고 부모 태그가 묶음 이름이다 | 2.0 §2.1 |
| TC-TE-HTML-02 | 앞뒤 공백(들여쓰기)은 편집 구간 밖에 남고 `&nbsp;`·`&amp;`가 지켜진다 | 2.0 §2.1 |
| TC-TE-HTML-03 | `pre` 안은 줄바꿈을 허용한다 | D-22 |
| TC-TE-HTML-04 | SVG 안 글자에는 svg 표시가 붙는다 | D-20 |
| TC-TE-HTML-05 | 편집 화면용 사본: 조각마다 `<span data-seg>`, SVG 글자는 `<tspan data-seg>`, SVG `title`은 감싸지 않음, `<base>` 삽입 | 2.0 §2.2 |
| TC-TE-DOCX-01 | DOCX 조각에 영역·문단 묶음과 서식 힌트(`fmt`)가 있다 | 2.0 §3.3 |
| TC-TE-PPTX-01 | PPTX 조각은 발표 순서의 슬라이드 번호로 묶인다 | `.claude/guides/site-local.md` PPTX 목록 편집 |
| TC-TE-XLSX-01 | 여러 셀이 함께 쓰는 공유 문자열을 한 셀에서 고치면 그 셀만 바뀐다 | D-19, 2.6 |
| TC-TE-XLSX-02 | 원래 줄바꿈이 있던 셀은 줄바꿈을 허용한다 | 2.6 |

### 2.3a Markdown 편집기 (`markdown.test.ts`)

| ID | 확인 내용 | 근거 |
|---|---|---|
| TC-MD-01 | 제목·굵게·기울임·취소선·코드·목록·할 일·인용·표·구분선이 HTML로(GFM) | D-31 |
| TC-MD-02 | 줄바꿈 한 번은 `<br>`(remark-breaks), 빈 문서는 빈 결과 | D-31 |
| TC-MD-03 | 언어를 적은 코드 블록은 highlight.js 색, mermaid 블록은 그대로(화면이 다이어그램으로) | D-31 |
| TC-MD-04 | 수식 `$…$`·`$$…$$`는 KaTeX | D-31 |
| TC-MD-05 | 상대 경로 이미지·링크는 버전 폴더 기준, 외부·절대·`#`은 그대로 | 1.x Markdown 미리보기 |
| TC-MD-06 | 링크는 새 탭(`noopener`), `#` 링크는 같은 탭 | D-31 |
| TC-MD-07 | script·on* 속성·`javascript:` 주소는 지우고 details·kbd는 남긴다 | 보안 |
| TC-MD-08 | 툴바 감싸기(굵게·기울임·취소선·코드·수식), 선택이 없으면 자리표시 글자를 넣고 선택 | 1.x 5.2 |
| TC-MD-09 | 줄 앞 붙이기(제목·목록·번호 목록·할 일·인용), 여러 줄이면 줄마다(원본 버그 회귀 검사) | 1.x 5.2 |
| TC-MD-10 | 블록 넣기(코드·수식 블록·표·구분선·링크·이미지 주소) | 1.x 5.2 |
| TC-MD-11 | Cloudflare Worker `/upload`로 multipart를 보내고 공개 주소를 받는다 | D-32 |
| TC-MD-12 | Worker 주소 없음·실패 응답·형식 오류는 오류 | D-32 |
| TC-MD-13 | 이미지 검사: png·jpeg·gif·webp·svg, 10MB 이하, 빈 파일 거부 | D-32 |
| TC-MD-14 | 단어 수(공백 기준) | 1.x 5.2 |

### 2.4 사이트 API (`api.test.ts`)

| ID | 확인 내용 | 근거 |
|---|---|---|
| TC-API-01 | `/api/tree`: 대분류 순서 → 메뉴(하위 포함) → 문서, 경고 없음 | 1.x §1 |
| TC-API-02 | 문서 정보: 버전·파일·대표 파일·`/files` URL·sha256, 없는 문서는 404 | 3.3 |
| TC-API-03 | `/files/...`로 원본과 상대 경로 리소스(CSS)를 그대로 준다 | 2.1 뷰어 |
| TC-UP-01 | 새 문서 업로드: `v0.0`, kind, status draft, `source: upload`, 출처 `origin_url`, 작성 시각은 로컬 `yyyy-MM-dd HH:mm:ss` | 2.2, D-16, 3.0 D-25 |
| TC-UP-02 | 같은 slug가 있으면 `-2`, 잘못된 slug는 400 | 2.2 |
| TC-UP-03 | 확장자별 kind(md·png·pdf·xlsx·drawio, 그 밖은 code) | 3.2 |
| TC-UP-04 | 폴더째 올리면 공통 최상위 폴더를 떼고, 대표 파일은 index.html 우선 | 2.2 |
| TC-UP-05 | `..` 경로와 숨김 파일은 버리고 docs 밖에 쓰지 않는다 | 보안 |
| TC-UP-06 | zip 하나는 풀어서 쓰고 `__MACOSX`는 뺀다 | 2.2 |
| TC-UP-07 | 새 버전은 다음 번호(v0.1), 직접 지정(v0.5) 가능, 이전 버전 폴더는 그대로 | D-6, 버전 규칙 |
| TC-UP-08 | 직전 버전과 같은 내용·이미 있는 버전은 409, 잘못된 번호 형식은 400 | 2.2 |
| TC-UP-09 | 없는 메뉴·없는 문서·제목 없음·파일 없음·없는 대표 파일 거부 | 2.2 |
| TC-MD-01 | Markdown 저장: `source: edit` 새 버전, 대표 .md만 바뀌고 이전 버전은 그대로 | D-10 |
| TC-MD-02 | 기준 버전이 최신이 아니면 409, Markdown이 아니면 400, 없는 문서 404 | D-10 |
| TC-TEAPI-01 | 조각 목록 API: HTML·XLSX는 조각, Markdown은 400 | 2.0 §3.2 |
| TC-TEAPI-02 | 편집 화면용 사본 API: `data-seg`·`<base>`, `no-store`, HTML만 | 2.0 §2.2 |
| TC-TEAPI-03 | 미리보기 API는 바뀐 파일을 주고 새 버전을 만들지 않는다 | 2.0 §3.2 |
| TC-TEAPI-04 | DOCX 미리보기를 PDF로 변환해 준다(`?to=pdf`) | 2.0 PPTX 미리보기 |
| TC-TEAPI-05 | 텍스트 저장: `source: text-edit` 새 버전, 대표 파일 말고는 그대로 복사 | 2.0 §3.4 |
| TC-TEAPI-06 | 이전 버전 기준·해시 불일치·바뀐 것 없음 409, 줄바꿈 금지 400 | 2.0 §3.2 |
| TC-TEAPI-07 | 이전 버전 조각도 `?v=`로 읽고, 없는 버전은 404 | 2.0 §3.4 |
| TC-TEAPI-08 | XLSX 셀 저장 | 2.6 |
| TC-TEAPI-09 | SVG: 조각 목록 format svg, 편집 사본 `image/svg+xml`, 저장 결과에 경고 목록 | 2.0 확장(SVG) |
| TC-REL-01 | 정식 확정: v0.x → v1.0, approved, `source: release`, 현재 폴더를 복사하고 이전 폴더는 그대로 | 1.x 정식 확정 |
| TC-REL-02 | 이미 approved면 409 | |
| TC-REL-03 | 정식 문서에 새 버전(v1.1)이 생겨도 상태는 approved 그대로 | D-15 |
| TC-REL-04 | review로 바꾼 뒤 확정하면 v2.0, 메모가 없으면 기본 메모 | |
| TC-MNG-01 | 메뉴 만들기: 최상위·하위(상위의 대분류를 따름), slug 검사, 중복 409, 없는 대분류 404 | D-13 |
| TC-MNG-02 | 메뉴 이름 변경·순서 이동, 자기 하위로는 못 옮김 | D-13 |
| TC-MNG-03 | 메뉴를 다른 대분류로 옮기면 문서 meta.yaml의 category가 바뀌고 폴더는 그대로 | D-13 |
| TC-MNG-04 | 메뉴(폴더) 삭제: 안의 문서(하위 문서 포함)와 하위 메뉴 문서를 휴지통으로 옮기고(`{ trashed }`) 메뉴·빈 폴더를 지운다. 없는 메뉴는 404 | D-13(개정) |
| TC-MNG-05 | 대분류 추가·이름 변경·순서, 메뉴가 있으면 삭제 409, 주석 유지 | D-17, D-18 |
| TC-MNG-06 | 문서 제목·상태 변경(주석 유지), 잘못된 상태·빈 제목 400 | 2.3 |
| TC-MNG-08 | 출처(`origin_url`) 고치기·지우기, http(s)가 아니면 400 | 3.0 7.1 |
| TC-MNG-07 | 문서를 다른 메뉴로 옮기면 폴더가 옮겨지고, 같은 slug가 있으면 `-2` | D-13 |
| TC-TR-01 | 휴지통: 목록에서 사라지고 `_trash/<시각>--<메뉴>--<문서>`에 남는다 | D-12 |
| TC-TR-02 | 원래 메뉴가 없으면 409, 메뉴를 고르면 그 메뉴로 복원(category 맞춤) | D-12 |
| TC-TR-03 | 원래 메뉴로 복원, 영구 삭제, 비면 `_trash` 폴더도 지움 | D-12 |
| TC-SRCH-01 | 한국어 두 글자로 본문 검색, 조사 붙은 말도 찾음, 일치 횟수·스니펫, 최신 버전만 색인 | D-14 |
| TC-SRCH-02 | 제목에 맞은 문서가 먼저, 대분류·형식 필터, 빈 검색어는 `[]` | D-14 |
| TC-SRCH-03 | HTML의 script·style 글자는 검색되지 않고, 메뉴 이름으로도 찾는다 | D-14 |
| TC-LIVE-01 | 변경하면 SSE로 `changed` 이벤트를 보낸다 | 2.5 |
| TC-LIVE-02 | 사이트 밖에서 docs를 고쳐도 감시가 다시 색인한다 | 2.5 |
| TC-LIVE-04 | 변경 알림에 대분류·메뉴·문서·제목·버전·바뀐 조각(`segs`)을 담고, `X-Workflow-Agent: claude-code` 헤더가 있으면 `by: claude-code` | 3.0 7.3 |
| TC-LIVE-05 | `POST /api/focus`: 열린 화면에 `focus` 이벤트, 받은 화면 수 반환, 없는 문서·`..`·잘못된 seg 거부 | 3.0 7.3 |
| TC-LIVE-03 | `/api/reindex`가 경고 목록을 돌려준다 | 3.1 |
| TC-CONV-01 | 지원하지 않는 대상·없는 파일·docs 밖 경로·변환 대상이 아닌 형식 거부 | D-4 |
| TC-CONV-02 | DOCX → PDF 변환, 같은 내용은 캐시에서 바로 | D-4 |
| TC-INT-01 | 색인의 sha256이 실제 파일과 같다 | 2.5 |
| TC-TREE-01 | 폴더 이름만 주면 slug 자동: 영문은 이름에서, 한글은 `folder-…`, 겹치면 `-2` | D-35 |
| TC-TREE-02 | 하위 문서: 상위 문서 폴더 안에 만들고 트리에 `parent`, 파일 주소는 실제 폴더 경로, 손자 문서, slug는 메뉴 안에서 하나(`-2`), 하위 문서도 편집 저장, 없는 상위 문서는 404 | D-34 |
| TC-TREE-03 | 문서 옮기기: 다른 문서 아래로, 메뉴 바로 아래로, 자기 자신·자기 하위로는 400 | D-36 |
| TC-TREE-04 | 같은 자리 순서: `index`로 옮기면 그 자리 문서들의 `meta.yaml` `order`를 다시 쓰고 트리가 그 순서 | D-34 |
| TC-TREE-05 | 하위 문서째 다른 메뉴로: 하위 문서 slug가 겹치면 409, 옮기는 문서 slug가 겹치면 `-2`, 하위 문서의 menu·category도 맞춘다 | D-34 |
| TC-API-DECK-01 | 슬라이드 덱 업로드: kind deck·대표 파일 deck.json, 슬라이드는 eid가 붙은 형식으로 저장, 형식 오류는 400(파일:줄:칸 진단). Cloudflare TC-ED-33과 같은 규칙 | 5.0 M4 |

### 2.5 workflow-docs MCP (`mcp.test.ts`)

| ID | 확인 내용 | 근거 |
|---|---|---|
| TC-MCP-01 | 도구 22개(`focus_in_site`, 5.0 덱 도구 `deck_create`·`deck_get`·`slide_put`·`slide_patch`·`asset_put`·`deck_render`, 구조·수정본 도구 `doc_structure`·`doc_ops`·`revision_list`·`revision_restore`, 6.0 `svg_put` 포함)이고 삭제·휴지통 도구는 없다 | D-23, D-24 |
| TC-MCP-02 | 사이트 서버가 꺼져 있으면 `npm run dev` 실행 안내 | 3.0 §4 |
| TC-MCP-03 | `list_documents`: 트리·주소·draft 표시·대분류 필터 | 3.0 §4.2 |
| TC-MCP-04 | `find_documents`: 본문 검색 결과와 "없음" 안내 | 3.0 §4.2 |
| TC-MCP-05 | `get_document`: 주소·`대분류/메뉴/문서`·`메뉴/문서`·`A > B > 제목`·제목·부분 제목으로 지정 | 3.0 §4.1 |
| TC-MCP-06 | 없으면 검색 안내, 여러 개면 후보 목록, 메뉴 이름으로 좁히기 | 3.0 §4.1 |
| TC-MCP-07 | `create_menu`: 대분류 이름·상위 메뉴 이름으로 만들기, 없는 대분류는 목록 안내 | 3.0 §4.2 |
| TC-MCP-08 | `upload_document`: 아티팩트 파일을 `filename`·`origin`으로 등록, 메모 앞 "Claude Code:" | 3.0 §4.3, D-26 |
| TC-MCP-09 | `upload_document`: 폴더째 올리기, 없는 파일·filename 오용·확장자 없음·없는 메뉴 거부 | 3.0 §4.2 |
| TC-MCP-10 | `upload_version`: 다음 버전, 같은 내용이면 서버 거부 메시지 전달 | 3.0 §4.2 |
| TC-MCP-11 | `get_text`: 전체·검색어·개수 제한 | 3.0 §4.2 |
| TC-MCP-12 | `get_text`: 주소의 `seg`(단일·범위)와 앞뒤 문맥, 범위 표시 ▶ | 3.0 §4.1 |
| TC-MCP-13 | `edit_text`: 여러 곳이면 거부, 조각 id·찾아 바꾸기로 새 버전 저장, 메모 앞 "Claude Code:" | 3.0 §4.2, D-26 |
| TC-MCP-14 | `edit_text`: `all: true`, 바뀐 것 없음, 없는 조각·빠진 값·없는 글자·빈 변경 | 3.0 §4.2 |
| TC-MCP-15 | 이전 버전 주소로는 고칠 수 없고, 조회 결과에 이전 버전임을 표시 | 3.0 §4.2 |
| TC-MCP-16 | `save_markdown`: 새 버전, HTML 문서는 서버가 거부 | 3.0 §4.2 |
| TC-MCP-18 | `get_text`: seg 목록 형식(`0,2-3`)을 해석해 그 조각만 ▶로 표시 | 3.0 7.2 |
| TC-MCP-19 | 쓰기 도구의 변경 알림에 `by: claude-code`와 바뀐 조각이 담긴다 | 3.0 7.3, D-29 |
| TC-MCP-20 | `focus_in_site`: 열린 화면이 없으면 주소 안내, 있으면 "열린 사이트 화면 n개" + `focus` 이벤트(버전·seg 포함) | 3.0 7.3 |
| TC-MCP-22 | 로컬에서도 `doc_structure`·`doc_ops`·`revision_list`·`revision_restore`가 동작한다(작업 출처 agent, rev 0으로 되돌리기) | 6.0 VL(D-58, D-51 바꿈) |
| TC-MCP-23 | `svg_put`: 소독해 올리고 지운 것을 진단으로 알린다. `doc_ops`로 인라인 SVG(`{kind:svg,src:asset:…}`)를 넣으면 `doc_structure`가 도형 eid·fill을 보여 주고 `svgAttr`로 고친다 | 6.0 4.5 |
| TC-MCP-24 | 에이전트 시나리오(6.0 V5): `doc_structure`가 색 토큰을 보여 주고, `setStyle`로 글꼴 크기·토큰 색, 허용 밖 스타일(box-shadow)은 fix가 붙은 진단, `svg_put`한 SVG를 `place`로 `(base)` 섹션 자리에 고정해 넣고 `unpin`으로 되돌림 | 6.0 4.5 |
| TC-MCP-25 | `deck_create`: 형식 오류는 파일:줄:칸·fix 진단, 맞으면 덱 생성(메모 "Claude Code:"). `deck_get`은 eid가 붙은 HTML(rev 0), 로컬에서도 `slide_patch`가 수정본(버전 폴더는 그대로), `deck_render`는 Browser Rendering이 없다고 안내 | 5.0 M4, 6.0 VL |
| TC-MCP-21 | SVG 문서도 `get_text`·`edit_text`로 고치고, 넘칠 수 있으면 "주의:"를 함께 알린다 | 2.0 확장(SVG) |
| TC-MCP-17 | `release_document`: v1.0 approved, 메모 앞 "Claude Code:", 두 번째는 거부 | 3.0 §4.2 |

### 2.6 화면 (`ui.test.ts`)

| ID | 확인 내용 | 근거 |
|---|---|---|
| TC-UI-01 | `/`는 첫 대분류로 가고, 헤더 탭·좌측 메뉴 트리·문서가 보인다 | 1.x §1 |
| TC-UI-02 | HTML 문서는 sandbox iframe(allow-same-origin 없음)으로 열리고, 파일 URL에 `?h=` 해시, 버전은 "draft (최신)", 제목 오른쪽에 그 버전 작성일(12px) | 2.1, D-16 |
| TC-UI-03 | 다른 곳에서 문서가 생기면 새로 고치지 않아도 목록에 나온다(SSE) | 2.5 |
| TC-UI-04 | 검색창에서 본문 글자로 문서를 찾는다 | D-14 |
| TC-UI-05 | HTML 텍스트 편집: 편집 iframe은 `sandbox="allow-same-origin"`, 조각을 고치면 "변경 1건", 확인 창을 거쳐 새 버전 저장 | 2.0 2.2 |
| TC-UI-06 | 버전이 2개 이상이면 비교를 골라 바뀐 줄을 본다(`?cmp=`) | 1.x 버전 비교 |
| TC-UI-07 | 상태 배지: 확인 창 취소면 그대로, "v1.0으로 변경"이면 approved | 1.x 정식 확정 |
| TC-UI-08 | 확인 창: 일반 작업은 확인 버튼에 포커스, Esc는 취소 | `.claude/rules/site-ui.md` 확인 창 |
| TC-UI-09 | Markdown 문서는 편집기(CodeMirror)와 미리보기(MarkFlow 엔진 `.mf-preview`)가 보인다 | D-10, D-31 |
| TC-UI-10 | 사이드바 접기 상태를 다시 열어도 기억한다 | `.claude/guides/site-local.md` 사이드바 |
| TC-UI-11 | 1280px·500px에서 사이트 화면에 가로 넘침이 없다 | HTML 작성 규칙 |
| TC-UI-12 | 없는 문서·없는 대분류는 안내 화면 | 조회 재시도 |
| TC-UI-14 | 아이콘에 마우스를 올리면 공통 툴팁(기본 title 아님)이 화면 안에 뜨고, 옆 아이콘으로 옮기면 바로 바뀐다. 대화상자 위에서도 보이고, 누르거나 Esc면 닫힌다. 키보드 포커스(Tab)에도 뜬다 | `.claude/rules/site-ui.md` 아이콘 |
| TC-UI-15 | 외부 문서(출처 있음)는 출처 막대와 함께 스크립트를 끈 채 열리고(`allow-scripts` 없음), 켜기는 버전별로 기억되며 새 버전은 다시 꺼진다. 출처 없는 문서는 막대 없음 | D-25, D-27 |
| TC-UI-16 | HTML 참조 복사: 참조 보기는 스크립트 없음, 글자를 누르면 `…?v=&seg=<id>`, Alt+클릭은 문단 범위 `seg=1-3`을 클립보드로 | 3.0 7.2 |
| TC-UI-17 | 주소의 `?seg=1,4`면 참조 보기로 그 조각을 강조하고, "원래 보기로"를 누르면 seg 없이 일반 보기 | D-28 |
| TC-UI-18 | DOCX 참조 목록: `?seg=` 줄 강조, 참조 복사 모드에서 줄을 누르면 그 조각 주소 복사 | 3.0 7.2 |
| TC-UI-19 | Claude(헤더)가 보고 있는 문서를 고치면 알림 + 바뀐 조각 강조, 다른 문서면 이동하지 않고 알림의 "열기"로 이동 | D-29 |
| TC-UI-20 | focus 요청이 오면 열린 화면이 그 문서·버전·조각으로 이동해 강조하고 알림 | 3.0 7.3 |
| TC-UI-21 | draw.io SVG 텍스트 편집: 그림(SVG 문서) 위에서 고치고, 짧으면 경고 없음, 상자를 넘치면 경고 막대·확인 창 ⚠·저장 후 주의 | 2.0 확장(SVG) |
| TC-UI-22 | Markdown 툴바: 고른 글자에 굵게 → 미리보기 `<strong>`, 보기 방식(편집만·미리보기만·나란히) 전환, 상태 표시줄 | 1.x 5.2 |
| TC-UI-23 | `[[`를 치면 사이트 문서 후보, 고르면 `[제목](/대분류/메뉴/문서)`가 들어가고 미리보기에 새 탭 링크 | D-33 |
| TC-UI-24 | 이미지 올리기: 업로드 서버가 없으면 설정 창, 테스트 업로드 전에는 저장 불가, 저장 후 파일을 올리면 주소가 들어가고 미리보기에 보이며 새 버전으로 저장(가짜 Worker) | D-32 |
| TC-UI-25 | 이전 버전 Markdown은 서식 툴바 없이 보기 방식만, 편집 창 `contenteditable=false`, "읽기 전용" | D-10 |
| TC-UI-26 | 업로드 대화상자 "새 Markdown 문서" → 만들기 확인 → 편집 창에 포커스, 친 글자가 문서 끝에 들어간다 | D-11 |
| TC-UI-27 | 폴더 트리: 폴더 아이콘, 머리의 폴더 추가(한글 이름 → slug 자동), 오른쪽 클릭 메뉴의 이름 바꾸기·하위 폴더 추가를 그 자리 입력칸으로 | 5.3, D-35 |
| TC-UI-28 | 끌어서 놓기: 문서를 다른 문서 안(확인 후 하위 문서, 주소 그대로), 하위 문서 접기·펼치기, 같은 자리 순서(확인 없이), 폴더를 다른 폴더 안·뒤로(확인 후) | D-36 |
| TC-UI-29 | 문서 메뉴 "하위 문서 추가" → 업로드 창 위치 고정 → 새 Markdown 문서가 상위 문서 폴더 안에 생기고 열린다 | D-34 |
| TC-UI-30 | 폴더 삭제: 폴더 이름을 넣기 전에는 삭제 버튼이 꺼짐, 삭제하면 안의 문서가 휴지통에 있고 대분류 첫 화면으로 | D-13(개정) |
| TC-UI-31 | 한글 입력 중 Enter(조합 중 keydown 뒤 Enter keydown이 한 번 더)로 폴더를 만들어도 확인 창이 열린 채 남고, 확인하면 폴더가 생긴다 | 아래 5절 버그의 회귀 검사 |
| TC-UI-32 | 문서 화면 제목을 누르면 그 자리 입력칸, Esc는 취소, Enter → 확인 창 → `meta.yaml` title이 바뀌고 제목에 반영 | 5.3 |
| TC-UI-33 | 업로드 창 "새 Markdown 문서" 제목 칸에서 한글 Enter(조합 중 keydown 뒤 Enter 두 번)를 쳐도 확인 창이 취소되지 않고, 확인하면 문서가 생긴다 | 아래 5절 버그의 회귀 검사 |
| TC-UI-34 | 상단 메뉴 대분류 추가 이름 칸에서 같은 한글 Enter를 쳐도 확인 창이 취소되지 않고, 확인하면 대분류가 생긴다 | 아래 5절 버그의 회귀 검사 |
| TC-UI-35 | 로컬 HTML 구조 편집: 속성 패널로 글자 크기 → 수정본 자동 저장(docs/는 그대로) → 「버전으로 저장」하면 v0.1 폴더에 바뀐 HTML | 6.0 VL |
| TC-UI-36 | 로컬 슬라이드 덱: 보기 화면이 덱으로 그려지고, 슬라이드 편집에서 글자를 고쳐 Esc → 수정본 → 「버전으로 저장」 | 6.0 VL, 아래 5절 버그의 회귀 검사 |
| TC-UI-37 | 로컬 HTML 자유 배치(6.0 V3): 그림 파일을 섹션의 한 점에 놓으면 그 자리 고정 그림(가운데가 놓은 점과 1px 이내), 640px 미리보기에서 고정 요소는 흐름(static)·가로 스크롤 없음, 「버전으로 저장」하면 그림이 새 버전 폴더 `assets/`로 | 6.0 V3·VL |
| TC-UI-13 | 같은 탭에서 전체 페이지 이동을 10번 해도 멈추지 않고, 뒤로 가기로 돌아온 페이지도 실시간 반영된다 | 2.5 (아래 5절 버그의 회귀 검사) |

---

### 2.7 Cloudflare(4.0): Worker (`apps/worker/test/*.test.ts`)와 화면 (`apps/worker/test-ui/cloud.ui.test.ts`)

Worker 테스트는 Workers 런타임(Miniflare) 안에서 돈다. D1 마이그레이션을 적용한 빈 로컬 D1·R2를 쓰고, **같은 파일 안 테스트끼리 저장소를 나누지 않으므로** 테스트마다 `seed()`(가져오기 API로 워크스페이스를 비우고 다시 넣은 뒤 owner@test.com으로 개발용 로그인)로 시작한다. 요청 도우미 `call()`은 세션 쿠키와 앱 `Origin`을 붙인다. 괄호 안은 같은 규칙을 확인하는 로컬 케이스 ID다. 화면 테스트는 가져오기 CLI `--owner owner@example.com`으로 owner를 넣고 개발용 로그인으로 들어간다.

| ID | 확인 내용 | 근거 |
|---|---|---|
| TC-CF-01 | 가져오기 API는 ADMIN_TOKEN이 없으면 401 | 4.0 P2 |
| TC-CF-02 | blob은 내용 sha256이 주소와 같아야 하고, 없는 blob을 알려 주며, blob 없이 문서를 넣으면 409 | 4.0 5.3 |
| TC-CF-03 | 트리: 대분류 순서, 하위 메뉴, 문서 순서(order 먼저, 나머지 제목순), 하위 문서 parent (TC-API-01) | 4.0 5.2 |
| TC-CF-04 | 문서 상세: 버전·파일·대표 파일·상위 문서, 없는 문서·워크스페이스 404, 다른 워크스페이스 문서는 다른 문서 (TC-API-02) | 4.0 5.1 |
| TC-CF-05 | 서명된 콘텐츠 주소: 본문·형식·HTML만 sandbox CSP, HTML 안 상대 경로(같은 문서·다른 메뉴·하위 문서 폴더)가 같은 토큰으로 열림, 상위 경로가 틀리면 404, ETag 304 (TC-API-03) | 4.0 5.5 |
| TC-CF-06 | 토큰 위조 403, 만료 토큰 거부, 다른 워크스페이스 토큰으로는 못 읽음 | 4.0 5.5 |
| TC-CF-07 | FILES_ORIGIN이 있으면 콘텐츠 도메인은 `/c/`만, 앱 도메인은 `/c/`를 주지 않고, 파일 주소는 콘텐츠 도메인 | 4.0 5.5 |
| TC-CF-08 | 같은 내용 파일은 R2에 한 번만(내용 주소) | 4.0 5.3 |
| TC-CF-10 | 새 문서: v0.0·kind(형식별)·출처·작성 시각(서울 시간) (TC-UP-01·03) | 4.0 P3 |
| TC-CF-11 | 같은 slug면 -2, 직접 준 slug 검사 (TC-UP-02) | |
| TC-CF-12 | 폴더 최상위 떼기, 대표 파일(index.html 우선), `..`·숨김 파일 버림, zip 풀기(__MACOSX 제외) (TC-UP-04·05·06) | |
| TC-CF-13 | 새 버전 자동·지정, 같은 내용·있는 버전·잘못된 번호·없는 메뉴·문서·제목·파일·대표 파일 거부 (TC-UP-07·08·09) | |
| TC-CF-14 | 올린 파일 sha256과 R2 본문이 같다 (TC-INT-01) | |
| TC-CF-15 | Markdown 저장: source edit, 대표 .md만 바뀌고 나머지는 같은 blob, 기준 버전 409, Markdown 아니면 400 (TC-MD-01·02) | |
| TC-CF-16 | 정식 확정: v1.0 approved(같은 blob), 이미 approved 409, v1.1에도 approved, review → v2.0 (TC-REL-01~04) | D-15 |
| TC-CF-17 | 텍스트 편집 조각·?v=·Markdown 400, 편집 사본(data-seg, 콘텐츠 주소 `<base>`), 미리보기는 버전을 만들지 않음, PDF 미리보기 501 (TC-TEAPI-01·02·03·07) | 2.0 |
| TC-CF-18 | 텍스트 편집 저장(text-edit, 다른 파일 같은 blob), 해시 불일치·바뀐 것 없음·이전 기준 409, 줄바꿈 400 (TC-TEAPI-05·06) | 2.0 |
| TC-CF-19 | DOCX 문단 저장 | 2.0 |
| TC-CF-20 | 메뉴 만들기(최상위·하위·이름에서 slug, 한글은 folder-…, 겹치면 -2), 중복 409, 이름 변경, 순서 이동 (TC-MNG-01·02, TC-TREE-01) | D-35 |
| TC-CF-21 | 메뉴를 다른 대분류로(하위 메뉴 함께, 검색 결과 대분류도 바뀜), 자기 하위로는 400 (TC-MNG-03) | |
| TC-CF-22 | 폴더 삭제: 안의 문서(하위 문서·하위 메뉴 문서)를 휴지통으로, 같은 slug를 새로 쓸 수 있음, 원래 메뉴가 없으면 409·메뉴를 골라 복원(-2, 순서 유지) (TC-MNG-04, TC-TR-02) | D-13 |
| TC-CF-23 | 대분류 추가·이름·순서·삭제 규칙 (TC-MNG-05) | D-17 |
| TC-CF-24 | 제목·상태·출처, 잘못된 값 400, 제목은 검색에도 반영 (TC-MNG-06·08) | |
| TC-CF-25 | 문서를 다른 메뉴로(하위째, -2), 다른 문서 아래로, 최상위로, 자기 하위로 400, 하위 slug 겹치면 409 (TC-MNG-07, TC-TREE-03·05) | D-34 |
| TC-CF-26 | 같은 자리 순서(index) (TC-TREE-04) | D-36 |
| TC-CF-27 | 휴지통: 하위째 사라지고, 원래 메뉴로 복원(순서 유지), 영구 삭제하면 아무도 안 쓰는 blob을 R2에서 지움 (TC-TR-01·03) | 4.0 5.3 |
| TC-CF-28 | 검색: 한국어 두 글자·조사, 스니펫·횟수, 제목 먼저, 대분류·형식 필터, 빈 검색어, script 글자 제외, 메뉴 이름 (TC-SRCH-01~03) | |
| TC-CF-29 | 편집기 이미지: 앱 API로 올리면 `/i/` 주소, 그 주소로 받음, 이미지가 아니면 400 | D-32 |
| TC-CF-30 | 로그인 전: `/api/me`는 user null(개발용 로그인 표시), 워크스페이스 API는 401 | 4.0 P4 |
| TC-CF-31 | 초대 없이 처음 오는 사람은 403(안내 화면, 세션 없음), SUPERADMIN은 들어온다, 로그아웃하면 세션이 끝난다 | D-39 |
| TC-CF-32 | Google 로그인: PKCE(S256)·state, 콜백 주소, state가 다르면 400, 토큰 교환(code_verifier) 뒤 id_token aud·iss·이메일 확인, 세션 쿠키 HttpOnly·SameSite=Lax, 다른 사이트로 가는 next는 무시 | D-39 |
| TC-CF-33 | 권한: 멤버가 아니면 404, viewer는 읽기만(쓰기·초대 403), editor는 올리기·휴지통(영구 삭제·폴더 삭제·대분류·초대는 403), owner는 모두 | 4.0 5.9 |
| TC-CF-34 | 요청 위조 막기: 상태를 바꾸는 요청은 Origin이 앱 주소여야 한다(다르거나 없으면 403) | 4.0 5.5 |
| TC-CF-35 | 초대 링크: 로그인 전이면 쿠키에 두고 로그인하면 멤버가 되어 그 워크스페이스로, 다시 쓰면 410, 이메일 지정 초대는 그 계정만(다른 계정 403) | 4.0 P4 |
| TC-CF-36 | 멤버 역할 바꾸기·내보내기, 잘못된 역할 400, 마지막 owner는 내리거나 뺄 수 없음(409), 초대 취소 | 4.0 P4 |
| TC-CF-37 | 워크스페이스 만들기는 SUPERADMIN만(만든 사람이 owner, 기본 대분류 SDLC), 중복 409, 예약 주소 400 | 4.0 P4 |
| TC-CF-38 | 실시간: 올리기·텍스트 편집·메뉴·휴지통이 끝나면 WebSocket으로 changed 알림(대분류·메뉴·문서·제목·버전·바뀐 조각), X-Workflow-Agent면 by: claude-code, ping → pong (TC-LIVE-01·04) | 4.0 5.6 |
| TC-CF-39 | focus: 열린 화면들에 문서·버전·조각으로 옮기라고 알리고 받은 화면 수, 없는 문서 404·잘못된 seg 400 (TC-LIVE-05) | 3.4 |
| TC-CF-40 | 실시간 연결도 멤버만(viewer 가능, 로그인 전 401), WebSocket이 아니면 426, 활동 기록(누가·무엇·버전) | 4.0 P5 |
| TC-CF-41 | 원격 MCP: 토큰 없이 `/mcp`는 401(Bearer 안내), 동의 화면은 앱 이름·토큰을 보낼 곳(localhost 경고)·내 워크스페이스 고르기 | 4.0 P6 |
| TC-CF-42 | 동적 등록 → 동의(워크스페이스 고르기) → PKCE 토큰 → 도구 목록이 로컬과 같고(삭제 도구 없음, D-24), list_documents 주소는 워크스페이스 아래, get_text·edit_text(find/replace) 저장, 메모 앞 "Claude Code:"(D-26) | 4.0 P6 |
| TC-CF-43 | upload_document는 파일 내용(글자·base64)으로 새 문서, viewer로 연결하면 쓰기 도구는 권한 오류·읽기 도구는 됨 | 4.0 5.9 |
| TC-CF-45 | 접속자: 화면이 "here"(메뉴·문서·보기/편집)를 보내면 모두에게 접속자 목록(같은 사람·같은 문서는 하나, 편집이 앞섬), 창을 닫으면 빠짐. 저장 알림에 저장한 사람 id (`test/live.test.ts`) | 5.0 M7 |
| TC-CF-46 | `doc_structure`(eid·rev) → `doc_ops`(에이전트 수정본, 메모 "Claude Code:"), 지난 rev는 409 + "→ doc_structure로 다시 읽고", 잘못된 연산은 400 + "→ 쓸 수 있는 연산", `revision_list`(출처·작성자·메모), `revision_restore`(rev 0 = 기준 버전) | 5.0 M7 |
| TC-CF-48 | 보안: 다른 출처(또는 Origin 없이) 연 실시간 WebSocket은 403(교차 사이트 WebSocket 막기), 1000자 넘는 접속자 메시지는 버림 (`test/live.test.ts`) | 5.0 M8 보안 점검 |
| TC-CF-49 | http로 들어온 요청은 APP_ORIGIN이 https인 배포에서 같은 주소의 https로 301(경로·쿼리 유지, 콘텐츠 도메인도), 로컬 http·https 요청은 그대로 (`test/https.test.ts`). 정적 화면은 `main.tsx`가 https로 옮긴다 | 버그 2026-11-02 |
| TC-CF-50 | 콘텐츠 응답은 늘 `Vary: Origin`, 다시 확인(304)에도 앱 출처 CORS를 붙인다(`<img>`로 먼저 받아 캐시된 파일을 편집기가 fetch로 다시 읽을 때) (`test/read.test.ts`) | 버그 2026-11-02 |
| TC-CF-51 | 사용량(owner): 최근 기간 수정본(사람·에이전트·되돌림·오피스)·새 버전·저장 용량(중복 제외)·PDF 변환·렌더링·오피스 편집 세션 횟수(캐시에 없어 실제로 만든 것만 기록), owner 아니면 403 (`test/revisions.test.ts`) | 5.0 M8 |
| TC-CF-44 | 덱 도구: `deck_create` → `deck_get`(eid) → `slide_patch`(수정본 출처 agent, 메모 "Claude Code:") → `slide_put` 형식 오류 진단 → `asset_put`(asset:<sha>·크기) | 5.0 M4 |
| TC-CF-44 | PDF 변환: 결과는 원본 sha256으로 R2에 캐시(캐시가 있으면 컨테이너를 부르지 않음), 다른 워크스페이스 파일 404, svg 대상·Office가 아닌 형식 400 | 4.0 P7 |
| TC-CF-45 | 워크스페이스 내보내기(owner): 리포 `docs/` 모양 zip(categories·menus yaml, 하위 문서는 상위 폴더 안, meta.yaml order, 버전 파일 내용), 휴지통 문서 제외, editor는 403 | 4.0 P8 |
| TC-CF-46 | 요청 수 제한: 같은 IP에서 로그인 API가 분당 20번을 넘으면 429(cf-connecting-ip가 없는 로컬·테스트는 제한 없음) | 4.0 P8 |
| TC-CF-47 | 매일 정리: 지난 세션·만료된 초대, 아무 버전도 안 쓰는 하루 지난 blob 삭제(쓰는 blob·방금 올린 blob은 남김) | 4.0 P8 |
| TC-CFUI-06 | 로그인 화면(Google 버튼·개발용 로그인) → 로그인하면 내 워크스페이스로, 계정 메뉴에 멤버·초대 관리·오픈소스 고지(`/third-party-notices.txt`)·로그아웃 | 4.0 P4·6.0 V5 |
| TC-CFUI-07 | 멤버 창에서 viewer 초대 링크를 만들어, 로그인 전 다른 브라우저에서 열면 로그인 후 그 워크스페이스로 들어가고, viewer에게는 업로드·텍스트 편집·폴더 추가·대분류 추가 버튼이 없다 | 4.0 5.9 |
| TC-CFUI-08 | 실시간: 다른 곳에서 문서를 올리면 열린 화면 사이드바에 새로 고치지 않아도 나타나고, focus는 열린 화면을 그 문서로 옮긴다 | 4.0 5.6 |
| TC-CFUI-09 | 콘텐츠 도메인이 따로일 때 Markdown은 fetch(CORS)로 읽혀 그려지고, PPTX는 변환 컨테이너 PDF(200, application/pdf), draw.io는 draw.io 뷰어(viewer.diagrams.net, `#R` 조각)로 열린다 | 4.0 P7 |
| TC-CFUI-10 | 내보내기 → 가져오기 왕복: 내보낸 zip을 풀어 가져오기 CLI로 새 워크스페이스에 넣으면 트리와 모든 문서의 버전·메모·작성 시각·파일 sha256이 같다. `/`는 마지막에 쓴 워크스페이스로 간다 | 4.0 P8 |
| TC-CFUI-11 | 구조 편집(HTML): 문단 뒤에 표 넣기 → 칸을 골라 행 넣기 → 되돌리기 → 글자 두 번 눌러 고치기 → 버전으로 저장(source revision). 편집 사본에서 문서 스크립트가 돌지 않고, 저장본에는 스크립트가 원본 그대로 | 5.0 M2·M3 |
| TC-CFUI-12 | 구조 편집(PPTX): 표 끝에 행 넣기 → 수정본, 미리보기는 작업본 PDF(`…/work/pdf`, 변환 컨테이너), 버전으로 저장 | 5.0 M5 |
| TC-CFUI-13 | 슬라이드 덱 보기: 목록 썸네일, 1920×1080을 창에 맞춰 그림, →로 다음 슬라이드·발표자 노트 | 5.0 M4 |
| TC-CFUI-14 | 슬라이드 편집: 한글 조합 입력(CDP IME 이벤트) → Esc 확정 → 새로 고침 뒤 유지, 고정 요소 끌기(화면 이동량 ÷ 배율, 맞춤선 6px 안), 표 열 넣기·열 경계 손잡이 끌기(이웃 두 열만, 합 100), ⌘Z, 다른 사람이 지운 요소를 고치면 알림·최신본, 버전으로 저장 | 명세 15절 |
| TC-CFUI-19 | 요소 편집기(6.0 V1): 글자 도구 막대로 고른 글자만 크기 64px·색(막대를 눌러도 글자 편집이 이어짐) → 새로 고침 뒤 유지, 블록 글꼴 칸(덱 faces), 표 행 높이(tr), 고정 상자 3개 위 맞춤·가로 간격 같게, 레이어 패널 아래로(문서 순서), ⌘Z | 6.0 4.1·4.3 |
| TC-CFUI-20 | HTML 속성 편집(6.0 V2): 속성 패널에서 문단 크기 22px·색 고르기 창(react-colorful)의 문서 색 목록으로 토큰 색(`var(--accent)`) → 새로 고침 뒤 패널·화면에 유지, 글자 편집 중 도구 막대로 고른 두 글자만 28px(막대 목록을 써도 편집이 이어짐), 칸을 골라 열 경계 끌기(colgroup·`table-layout:fixed`)·행 높이 손잡이·그림 크기 손잡이(감싸는 상자 대비 %), ⌘Z로 그림 크기 되돌림, ⌘D 제목 복제 | 6.0 4.2 |
| TC-CFUI-21 | HTML 자유 배치(6.0 V3): 문단을 옮기기 손잡이로 끌면 고정 위치(`data-pin`·left %·top px·width %, 섹션 `data-pin-box`·min-height, head 좁은 화면 규칙), 놓기 직전 미리 보기 자리와 저장 뒤 자리가 1px 이내, 첫 전환 안내, 그림 파일을 둘째 섹션 한 점에 놓으면 그 섹션 끝에 고정 그림(가운데 1px 이내), Shift+방향키 이동, 속성 패널 위치 칸(고정 문단 Y=40px, 흐름 문단 X=3%로 바로 고정, 섹션 밖으로 넘치는 X는 너비를 줄임)·방향키 8px 이동 저장, 640px 미리보기는 static·가로 스크롤 없음·손잡이 숨김, 「흐름으로 되돌리기」면 그 섹션은 원래 시작 태그 | 6.0 4.2 |
| TC-CFUI-22 | SVG(6.0 V4): 버전 폴더 SVG 그림을 「SVG 고치기」(svgedit)로 채움 색을 바꿔 저장하면 새 SVG 자산(`assets/<sha16>.svg`)으로 바뀌고 콘텐츠 도메인에서 image/svg+xml·sandbox CSP, viewBox 유지. SVG 파일을 「그림 넣기」로 넣으면 script·이벤트 속성이 지워진 파일 참조 | 6.0 4.4 |
| TC-CFUI-23 | 오피스 편집기(6.0 VO, 대역 오피스 서버): `editor-config` office, 「오피스 편집기로 열기」 확인 창 → 편집기(편집 모드)·세션 active → 「닫고 저장」 → 서명한 저장 콜백 → 수정본(office, 작성자 owner) → 구조 편집 화면, 세션 풀림 | 6.0 D-59 |
| TC-CFUI-24 | HTML 위치 칸 연속 입력: 사본을 900px 스크롤해 흐름 문단을 고르고 X 칸을 마우스로 눌러 30 → Y 칸을 마우스로 누르면 X 저장(left 30%, 너비 70% 이하로 줄임), 저장 뒤에도 Y 칸 포커스·사본 스크롤(±2px)·선택 강조가 남고, 바로 120을 넣고 Enter면 덮어 써서 top 120px | 6.0 4.2 |
| TC-CFUI-18 | HTML 문서 PDF 내보내기(확인 창 → 진행 막대(만드는 중·내려받는 중 %) → 내려받기)·API(A4 쪽, 두 번째는 캐시로 빠름, HTML이 아닌 문서는 400), 덱 화면에는 PDF 버튼 없음, 슬라이드 PNG 960×540(작업본). 로컬은 `wrangler dev`의 Browser Rendering(Chrome) | 5.0 M8 |
| TC-CFUI-17 | 접속자·실시간 반영·수정본 비교: 다른 사람(편집자 초대)이 같은 덱을 보면 「보는 중」, 편집을 열면 「편집 중」, 그 사람이 저장하면 내 편집 화면이 최신으로(알림), 이력에서 앞 수정본과 지금을 비교(+ 줄), 창을 닫으면 표시가 빠짐 | 5.0 M7 |
| TC-CFUI-16 | PDF 편집: 한글 글상자·형광펜을 「적용」하면 수정본(잘린 한글 글꼴 하나), 쪽 돌리기·지우기(확인 창), 한글 양식 채우기, 되돌리기, 버전으로 저장 | 5.0 M6 |
| TC-CFUI-15 | 슬라이드에 그림 파일을 끌어 놓으면 자산으로 올라가 놓은 자리 가운데에 고정 위치 그림, 서명 주소(`/c/…/_asset/…`)로 그림 | 명세 08절 |
| TC-CFUI-01 | `/`는 워크스페이스로, HTML 문서는 콘텐츠 주소 sandbox iframe(allow-same-origin 없음)으로 열리고 상대 경로 CSS까지 읽힘 | 4.0 5.5 |
| TC-CFUI-02 | HTML 텍스트 편집 저장 → text-edit 새 버전 | 2.0 |
| TC-CFUI-03 | 새 Markdown 문서 → 편집기에서 이미지 올리기(설정 창 없음, 앱 API → R2) → 저장하면 새 버전, 이미지 주소가 열림 | D-32 |
| TC-CFUI-04 | 사이드바 폴더 추가(한글 이름, slug 자동) → 문서 휴지통 → 휴지통 창에서 복원 → 폴더 삭제(이름 입력) | D-13, D-35 |
| TC-CFUI-05 | 검색창으로 본문 찾기, 상태 배지로 v1.0 확정 | |

### 2.8 5.0 문서 편집기 (`apps/worker/test/revisions.test.ts`, `packages/core/test/structedit-*.test.ts`)

계획은 `spec/REQUIREMENT-5.0.md`. 마일스톤마다 케이스를 더한다.

| ID | 확인 내용 | 근거 |
|---|---|---|
| TC-ED-01 | 작업본 열기: 수정본이 없으면 지금 버전 파일(rev 0) | 5.0 5.1 |
| TC-ED-02 | 저장하면 수정본(rev 1), 안 바꾼 파일은 같은 blob, 작업본 주소 `/r1/`에서 HTML 상대 경로가 풀리고, 버전은 그대로 | 5.0 5.2 |
| TC-ED-03 | 기준 rev가 다르면 409, 바뀐 것 없으면 수정본을 만들지 않음, 잘못된 경로·없는 대표 파일 400 | 5.0 5.2 |
| TC-ED-04 | 이력: 최신 먼저, 작성자·출처(human·agent)·메모, 작업본 rev, 예전 수정본 파일 읽기 | 5.0 5.1 |
| TC-ED-05 | 되돌리기: 예전 수정본 내용으로 새 수정본, 과거는 남음, 기준이 다르면 409, rev 0은 작업본의 기준 버전 파일 | 5.0 5.1 |
| TC-ED-06 | 버전으로 올리기: R2 복사 없이 새 버전(source revision), 이력에 올린 버전, 같은 내용이면 409, 다른 곳에서 새 버전이 생기면 작업본이 그 버전에서 다시 시작(rev 번호 이어짐) | 5.0 5.1 |
| TC-ED-07 | viewer는 저장·올리기 403·읽기만, 저장하면 활동 기록 `revision` | 4.0 5.9 |
| TC-ED-08 | 이미지 자산: PNG → `asset:<sha>`·가로·세로, 같은 이미지는 한 번, 서명 주소로 받음, SVG가 아닌 글·이미지 아님 400(SVG는 6.0 V4부터 소독해 받는다, TC-VE-27) | 5.0 4.1·5.4 |
| TC-ED-09 | 매일 정리: 30일 지난 수정본 삭제(작업본·버전으로 올린 것은 남김), 남은 수정본·자산의 blob은 남김 | D-50 |
| TC-ED-10 | 수정본 있는 문서 영구 삭제: 그 문서만 쓰던 blob은 지우고, 다른 문서 수정본이 쓰는 blob은 남김 | 5.0 5.2 |
| TC-ED-11 | HTML 요소 목록: 표 행·열 수, 그림 src·alt, 글자 편집 가능 여부. 편집 사본은 `data-eid`와 자유 배치 표시(`data-base`·`data-root`, 6.0 V3)만 더한다 (`packages/core/test/structedit-html.test.ts`) | 5.0 4.1 |
| TC-ED-12 | HTML 표 행 넣기·빼기: 본문 행을 본떠 빈 칸, 넣고 빼면 원본 바이트와 같다 | 5.0 4.1 |
| TC-ED-13 | HTML 표 열 넣기·빼기와 열 너비: 넣고 빼면 원본과 같고, 너비는 colgroup %(합 100)로만 쓴다 | 5.0 4.1 |
| TC-ED-14 | HTML 글자 바꾸기: 인라인 마크만 남기고(script·위험한 링크 제거), 블록이 든 요소는 거부 | 5.0 4.1 |
| TC-ED-15 | HTML 넣기: 표(문서의 표 class를 따름)·그림·문단·제목, 그림 주소는 상대 경로·https만 | 5.0 4.1 |
| TC-ED-16 | HTML 지우기·옮기기·그림 바꾸기·너비: 바뀐 곳 밖은 그대로, 자기 안으로 옮기기·행 직접 지우기는 거부 | 5.0 4.1 |
| TC-ED-17 | HTML 병합 칸이 있는 표는 행·열 편집을 거부하고 열 너비만 허용 | 5.0 4.1 |
| TC-ED-18 | 리포 실제 HTML 문서: 모든 표에서 행·열 넣고 빼기 왕복이 원본과 같고, 열 너비를 바꿔도 그 표 밖 바이트는 그대로 | 5.0 4.1 |
| TC-ED-19 | OOXML 구조 목록: DOCX 표·그림, PPTX 슬라이드 발표 순서, XLSX 시트 열 너비 (`packages/core/test/structedit-ooxml.test.ts`) | D-47 |
| TC-ED-20 | DOCX 표 행·열 넣기·빼기·열 너비: 표 전체 너비·칸 서식(tcW·테두리) 유지, 다른 파트 바이트 동일 | D-47 |
| TC-ED-21 | PPTX 표 행·열: 행을 넣고 빼면 표 틀 높이(cy)가 같이 바뀌고, 새 칸은 txBody를 가진다 | D-47 |
| TC-ED-22 | 그림 교체: 같은 형식은 미디어만, 다른 형식은 새 파트·관계·Content_Types, 여러 그림이 함께 쓰는 미디어는 고친 그림만 새 파트, 가로 유지·세로는 비율 | D-47 |
| TC-ED-23 | XLSX 열 너비: 범위 `<col>`을 나눠 그 열만 바꾸고, `<cols>`가 없으면 sheetData 앞에 만든다 | D-47 |
| TC-ED-24 | OOXML 거부: 병합 칸 표의 행·열(너비는 허용), 마지막 행 빼기, 없는 표 409, 형식 밖 연산·이미지 아님 400, 빈 연산은 원본 그대로 | D-47 |
| TC-ED-25 | 구조 편집 API: HTML 구조 목록(`GET …/work/structure`), 편집 사본(`…/work/edit-view`: data-eid, 작업본 `<base>`, CSP `sandbox allow-same-origin`, 2.0 편집 사본도 같은 CSP), 연산 저장(`POST …/revisions {ops}`)은 수정본 하나·메모 자동 (`apps/worker/test/structedit.test.ts`) | 5.0 5.4 |
| TC-ED-26 | HTML 그림 `asset:<sha>` → 대표 파일 옆 `assets/`에 연결·상대 경로, 에이전트 출처, 없는 자산 400·기준 rev 다름 409·없는 요소 409·빈 ops 400·ops와 put 같이 400, Markdown은 400 | 5.0 5.4 |
| TC-ED-27 | PPTX 구조 목록, 표 행 넣기·그림 교체(asset)를 한 수정본으로, 버전으로 올리면 새 버전 파일에 행·틀 높이·Content_Types 반영, 마지막 행 빼기 400 | D-47 |
| TC-ED-28 | 슬라이드 파싱·직렬화: eid를 붙이고(한 번 붙으면 그대로, 새 요소만 다음 번호), tbody는 건너뛰고, 노트는 aside, 왕복 안정 (`packages/core/test/slide.test.ts`) | 명세 04절 |
| TC-ED-29 | 슬라이드 검증: 허용 밖 태그·속성·CSS마다 진단 하나(줄·칸, margin·z-index·단위 fix), 루트·id·eid 중복 | 명세 03·04절 |
| TC-ED-30 | 슬라이드 연산(setText·setStyle·setAttr·insert·remove·move·toPinned·tableCols·tableRow·tableCol·setNotes, 묶음) 적용 후 역연산을 적용하면 원본과 같고, 결과는 다시 읽어도 진단 없음 | 명세 04·09절 |
| TC-ED-31 | 표: 열 너비 합 100%, 열을 넣으면 똑같이 나눔, 새 행은 본문 칸 스타일을 이음. 잘못된 연산 400, 없는 요소 409 | 명세 07절 |
| TC-ED-32 | 덱 검사: deck.json·order의 슬라이드 파일이 모두 있고 형식에 맞아야 함(글꼴은 Google Fonts만, section id = 파일 이름), 저장본은 eid가 붙은 직렬화 형식 | 5.0 4.3 |
| TC-ED-33 | 덱 업로드(Worker): kind deck, 대표 파일 deck.json, 슬라이드 eid 형식 저장, 형식 오류 400(파일:줄:칸 [코드] → fix), 빠진 슬라이드 400 (`apps/worker/test/deck.test.ts`) | 5.0 M4 |
| TC-ED-34 | 슬라이드 연산 → 수정본(그 슬라이드 파일만 새 blob), 돌려받은 역연산을 보내면 원래 내용, 형식 위반은 400·수정본 그대로, 없는 슬라이드 404 | 명세 10절 |
| TC-ED-35 | rev 충돌: 기준이 지났어도 대상 요소가 있으면 최신본에 다시 적용해 저장(rebased), 지워진 요소면 409 | 명세 10절 |
| TC-ED-36 | 슬라이드 통째 쓰기(새 id면 순서에 추가), 색인 고치기(제목·순서, 빠진 슬라이드 파일 지움, 없는 id 400), 에이전트 출처, 버전으로 올리기, viewer 403 | 명세 10·11절 |
| TC-ED-37 | 덱이 아닌 문서는 덱 API 400 | 5.0 M4 |
| TC-ED-42 | 정적 HTML(인쇄·미리보기): 화면 렌더러와 같은 모양(.slide-root, 표 안 tbody, 링크 새 탭), 그림은 콘텐츠 주소·없으면 자리 표시, eid·노트는 넣지 않음, 덱 글꼴·1920×1080 쪽·기본 스타일 하나 (`packages/core/test/slide.test.ts`) | 명세 12절 |
| TC-ED-43 | 보안: 덱 글꼴 이름(faces.family)에 태그·CSS를 넣으면 진단, 인쇄 HTML은 형식에 맞는 글꼴만 넣음(스크립트 없음), 프로토타입 키 CSS 속성은 진단(예외 아님) | 5.0 M8 보안 점검 |
| TC-ED-44 | 보안: HTML 글자 바꾸기 링크는 http(s)·mailto·#·상대 경로만(제어 문자 제거 뒤 검사, `java\tscript:`·`data:`·`vbscript:` 제거), 그림 주소 역슬래시 외부 주소 거부 (`structedit-html.test.ts`) | 5.0 M8 보안 점검 |
| TC-ED-45 | 보안: 풀면 64MB를 넘는 OOXML(압축 폭탄)은 413, 연산 500개 초과 400 (`structedit-ooxml.test.ts`) | 5.0 M8 보안 점검 |
| TC-ED-46 | 보안: 수정본 파일 저장(put)으로 deck.json·슬라이드를 쓰면 업로드와 같은 덱 검사(글꼴 이름 주입 400, script 400), 25MB·200개 초과 413, 슬라이드 연산 500개 초과 400 (`deck.test.ts`) | 5.0 M8 보안 점검 |
| TC-ED-47 | 매일 정리: 변환·렌더링 캐시는 30일이 지나면 지움(영구 삭제한 문서의 결과 포함) | 5.0 M8 보안 점검 |
| TC-ED-38 | PDF 부분 글꼴: harfbuzz로 쓴 글자만 남겨(원본 2MB의 1/10 미만) 한글 글상자 PDF에 글꼴 하나만, 글꼴 없이 글자를 쓰면 거부 (`packages/core/test/pdfedit.test.ts`) | 5.0 4.5, M0 |
| TC-ED-39 | PDF 덧그리기: 글상자·그림·형광펜(곱하기 섞기, 화면 왼쪽 위 → PDF 좌표)·펜이 그 쪽 내용에 더해지고, 90도 돌린 쪽의 글자는 회전 행렬로 그려 화면에서 똑바로 | 5.0 4.5 |
| TC-ED-40 | PDF 쪽: 회전(누적)·지우기·옮기기·다른 PDF 끼워 넣기, 범위 밖·잘못된 각도·PDF 아닌 파일 400, 마지막 쪽은 못 지움, 빈 연산은 원본 그대로 | 5.0 4.5 |
| TC-ED-41 | PDF 양식: 칸 목록(글자·체크·목록), 한글 글자·체크·목록 채우기(우리 글꼴로 칸 모양), 없는 칸 400 | 5.0 4.5 |

### 2.9 6.0 요소 편집기 (`packages/core/test/slide.test.ts`·`structedit-html.test.ts`·`structedit-pin.test.ts`·`svg.test.ts`, `site/test/unit.test.ts`·`work.test.ts`·`ui.test.ts`(TC-VE-20·29·30·31), `apps/worker/test/structedit.test.ts`, 화면은 TC-CFUI-19·20·21·22, TC-UI-35·36·37)

계획은 `spec/REQUIREMENT-6.0.md`. 마일스톤마다 케이스를 더한다.

| ID | 확인 내용 | 근거 |
|---|---|---|
| TC-VE-01 | 글자 일부 서식: 슬라이드 글자 안 span에 색·글꼴·크기를 함께 쓰고 정해진 순서(color·font-family·font-size)로 정규화, 허용 밖 선언·틀린 단위는 버리고 진단, 글꼴 이름 주입(`;`·`<`) 거부, 직렬화 왕복 안정 (`slide.test.ts`) | 6.0 4.1 |
| TC-VE-02 | 정렬·분배 계산(공통 `editor/align.ts`): 여럿은 감싸는 상자 기준, 하나는 바깥(슬라이드) 기준, 분배는 위치 순으로 처음·끝 고정에 간격 같게, 2개 이하는 그대로 (`unit.test.ts`) | 6.0 4.1 |
| TC-VE-03 | HTML `setStyle`: style 속성만 다시 쓴다(기존 선언 순서 유지, 같은 속성은 제자리, 새 속성은 끝, 빈 값이면 속성 지움, 큰따옴표는 작은따옴표), 넣고 지우면 원본과 같고 같은 값이면 그대로. 허용 밖(position·left·그림자·vw·`url()`·`!important`·틀린 margin·불러오지 않은 글꼴·z-index)은 400과 고칠 방법, 토큰 색·em·rem·margin `auto` 허용 (`structedit-html.test.ts`) | D-55 |
| TC-VE-04 | HTML 글자 일부 서식: span style은 color·font-family·font-size·font-weight만 정해진 순서로 남기고 그 밖 선언·이벤트 속성·불러오지 않은 글꼴은 버린다, setText가 문서 글꼴로 거른다 | 6.0 4.2 |
| TC-VE-05 | HTML 표: 행 높이(`tableRowHeight`, tr `height` px·지우기, 4~2000px 밖·tr 아닌 요소는 400), 표 너비는 setStyle width, 열 너비(`tableCols`)는 `table-layout:fixed`를 한 번만 함께 넣는다(TC-ED-13·18도 맞춤) | 6.0 4.2 |
| TC-VE-06 | HTML 복제(`duplicate`): 바로 뒤에 같은 들여쓰기로, 안의 id는 뺀다, 표 칸은 거부. 고를 수 있는 요소에 div(글자 편집은 안 됨), 블록 목록에 인라인 style·감싸는 블록·깊이 | 6.0 4.2 |
| TC-VE-07 | 문서 견본(`docTheme`): 글꼴은 Google Fonts 링크·`@font-face`·글꼴 변수(일반 계열 빼고 처음 나온 순서), 색은 `:root` 색 변수의 처음 값과 다크 모드 여부 | 6.0 4.2 |
| TC-VE-08 | 리포 실제 HTML 문서 전체: 빈 연산은 바이트 동일, 문서마다 앞 40개 블록에 setStyle을 넣고 지우면 그 시작 태그 밖은 그대로(style이 없던 요소는 원본과 같다) | 6.0 7절 V2 |
| TC-VE-09 | Worker 연결: 구조 응답에 인라인 style·깊이·문서 견본(theme), setStyle·복제는 수정본 하나(메모 「서식 1, 복제 1」), 허용 밖 스타일은 400과 고칠 방법, 같은 값이면 수정본을 만들지 않는다. MCP `doc_structure`가 글꼴·색 토큰 줄을 보여 준다(TC-CF-46) (`structedit.test.ts`) | 6.0 4.5 |
| TC-VE-10 | 로컬 수정본(Worker와 같은 API, 규칙은 core `work`): HTML 구조 연산 → 수정본 1(docs/는 그대로), 지난 baseRev는 409, 작업본 파일·편집 사본은 `work/files/r<rev>/`에서 상대 경로가 풀린다. 「버전으로 저장」하면 docs/ 변화는 새 버전 폴더와 meta.yaml뿐(source: revision), 이력에 올린 버전, 같은 rev로 다시 올리기는 409 (`work.test.ts`) | 6.0 VL(D-58) |
| TC-VE-11 | 로컬 되돌리기: rev 0(기준 버전)·예전 수정본으로 새 수정본, 수정본 파일 목록과 내용, 이력 출처(restore·human) | 6.0 VL |
| TC-VE-12 | 로컬 덱 편집과 그림 자산: 자산은 `asset:<sha>`(크기·주소), 슬라이드 연산이 수정본(inverse), 형식 밖 연산은 400 진단, 「버전으로 저장」하면 가리킨 그림이 버전 폴더 `assets/`로 복사된다 | 6.0 VL |
| TC-VE-13 | 로컬 그림 자산은 PNG·JPEG·WebP·GIF·SVG만(SVG가 아닌 글·그 밖 형식은 400, 6.0 V4부터 SVG는 소독해 받는다), 없는 자산 404 | 6.0 VL·V4 |
| TC-VE-14 | 자유 배치 `toPinned`: 요소 style에 position·left %·top px·width %·margin:0, `data-pin`에 원래 style, 기준 섹션은 relative·min-height(올림)·`data-pin-box`, head에 좁은 화면 규칙 한 번. 다시 옮기면 위치만(오른쪽 끝이 100%를 넘지 않게 left 보정), unpin하면 원본 바이트 (`structedit-pin.test.ts`) | 6.0 4.2(D-54) |
| TC-VE-15 | `place`: 섹션 끝(마지막 요소 다음 줄)에 고정 그림·글상자(글자는 이스케이프). 지우거나 흐름으로 되돌리면 섹션 style·규칙도 정리, 글자 블록·없는 섹션·`javascript:` 그림은 거부 | 6.0 4.2·4.5 |
| TC-VE-16 | 고정할 수 없는 것: 표 안 요소·목록 항목·표 칸·표 자체·섹션 자체는 400, 너비 0·100% 초과·top 음수·minHeight 음수는 400, 고정 아닌 요소 unpin 400, 고정 요소를 다른 섹션으로 move는 400(같은 섹션 안 앞뒤는 된다) | 6.0 4.2 |
| TC-VE-17 | 기준 섹션 판별: section이 없으면 본문 뿌리(main·body, 감싸개 하나면 그 안) 바로 아래 블록, 뿌리 바로 아래 요소는 뿌리. 편집 사본에 `data-base`·`data-root`. head·body 태그를 생략한 문서는 head의 마지막 요소 뒤에 규칙을 넣고 왕복이 원본과 같다 | 6.0 11절 |
| TC-VE-18 | 리포 실제 HTML 전체: 고정할 수 있는 블록(문서마다 앞 12개) toPinned → unpin 왕복이 원본과 같고, 바뀌는 곳은 기준 섹션·요소의 시작 태그와 head 규칙뿐 | 6.0 V3 |
| TC-VE-19 | Worker 연결: 구조에 pinBase·isBase·pinned, 그림 place(asset → `assets/` 상대 경로)·toPinned·unpin이 수정본 하나씩(메모 「자유 배치 넣기 1」·「자유 배치 1」·「흐름으로 되돌림 1」), 표 칸 고정은 400 (`structedit.test.ts`) | 6.0 4.5 |
| TC-VE-20 | 리포 지금 버전 대표 HTML 배치 검사(브라우저): 문서마다 블록 3개를 화면과 같은 함수(`pinBox.ts`)로 재서 고정하면 375·640·641·718(A4 인쇄 폭)·800·1024·1280px 모두 가로 스크롤 없음, 고정 요소가 섹션 밖으로 넘치지 않음 (`site/test/ui.test.ts`) | 6.0 V0 남은 확인 |
| TC-VE-21 | SVG 소독(core `svg.ts`, htmlparser2 허용 목록): V0 공격 18건(script·CDATA script·on*·`javascript:` href·foreignObject 안 img/iframe/script/a·바깥 use/image/feImage·CSS `url()`/`@import`·animate href·`data:` SVG·XXE·embed/object·처리 명령·mXSS·바깥 칠하기·base/meta·엔티티 숨김)을 다시 읽어 위험한 요소·속성이 없고 지운 것이 진단에 남는다. 이름공간 접두어 루트는 400. 두 번 소독해도 같다 (`svg.test.ts`) | 6.0 4.4·11절 |
| TC-VE-22 | 정상 SVG 4개(draw.io xmlsvg·ERD·일러스트·HTML 인라인)는 요소 수가 같고 지운 것이 없으며 draw.io 루트 `content`가 남는다. 크기는 width·height(px), 없으면 viewBox, 그것도 없으면 300×150. 루트가 svg가 아니거나 비면 400 | 6.0 4.4 |
| TC-VE-23 | 인라인 넣기 범위 좁히기(`scopeSvg`): id·`#id`·`url(#id)`·aria 참조에 접두어, 루트 id는 접두어, `<style>` 선택자 앞에 `#접두어`, `@규칙` style은 지움, 잘못된 접두어 400 | D-60 |
| TC-VE-24 | svgedit 출력 정리(`tidySvgEdit`): 빠진 viewBox 다시 넣기(원래 viewBox 우선), 「Layer 1」 묶음 풀기, 소수 좌표 둘째 자리 반올림, `xmlns:svg` 지우기 | 6.0 4.4 |
| TC-VE-25 | HTML 인라인 SVG: insert·place의 kind svg는 소독·범위 좁힘(svg1, svg2…) 뒤 넣고(루트 width·height는 지워 viewBox 비율), 블록 목록 `svg.shapes`·편집 사본 `data-shape`, `svgAttr`로 fill·stroke(색·`var(--토큰)`·none만)·글자(text·tspan만, 이스케이프), 바깥 `url()` 거부, 복제하면 새 접두어 | 6.0 4.4·4.5 |
| TC-VE-26 | 자산 검사(`prepareAsset`, Worker·로컬 공통): SVG는 소독 결과를 저장하고 크기·지운 것·draw.io 여부, svg 아닌 루트·UTF-8 아님·허용 밖 형식은 400 | 6.0 4.4 |
| TC-VE-27 | Worker SVG 자산: 소독한 것만 저장(지운 것 진단), 콘텐츠 도메인 `_asset`은 image/svg+xml·`sandbox` CSP·nosniff. HTML에 파일 참조(`assets/<sha16>.svg`, 버전 파일도 sandbox CSP)·인라인(asset → 글, svg1)·`svgAttr`(메모 「SVG 도형 1」), PNG 자산을 인라인으로 넣기 400, 오피스 그림을 SVG로 바꾸기 400 (`structedit.test.ts`) | 6.0 4.4 |
| TC-VE-28 | 로컬 SVG 자산: 소독해 저장(지운 것), 앱 출처 raw는 `sandbox` CSP, HTML에 파일 참조로 넣고 버전으로 저장하면 버전 폴더 `assets/`에 소독된 SVG (`work.test.ts`) | 6.0 4.4·VL |
| TC-VE-29 | 로컬 화면: SVG 파일을 「그림 넣기」로 넣으면 소독된 파일 참조, 「SVG 고치기」는 svgedit 캔버스(도형 고르기·채움·옮기기) → 저장하면 새 SVG 자산(viewBox 유지, Layer 1 없음)으로 바뀐다 (`ui.test.ts`) | D-56 B안 |
| TC-VE-30 | 로컬 화면 draw.io(대역 페이지 `test/fixtures/fake-drawio.html`, 다른 출처): 「다이어그램」으로 그려 저장하면 draw.io SVG(`content` 보존)가 그림으로, 「SVG 고치기」는 draw.io로 다시 열어 이어서 고친다. 같은 페이지의 위조 save 메시지는 무시. 실제 draw.io 왕복은 `apps/drawio` `npm run check`(draw.io를 올릴 때) | D-56·D-57 |
| TC-VE-31 | 로컬 화면 인라인 SVG: 문서의 도형을 누르면 속성 패널에서 글자(Enter)·채움 색(고르기를 마칠 때 한 번)을 바꾼다, 수정본 하나씩(「SVG 도형」) | 6.0 4.4 |

### 2.10 6.0 오피스 편집기 VO (`packages/core/test/office.test.ts`, `apps/worker/test/office.test.ts`, `site/test/office.test.ts`·`ui.test.ts`(TC-VO-11)·`office-real.test.ts`(TC-VO-12), 화면은 TC-CFUI-23)

| ID | 확인 | 근거 |
|---|---|---|
| TC-VO-01 | JWT(HS256) 서명·검사 왕복, 다른 비밀값·내용 바꿈·만료·`alg: none`은 거부. 파일·콜백 주소 토큰은 쓰임새(file·callback)가 맞아야 한다 | D-59 |
| TC-VO-02 | 편집 세션: 편집으로 열면 작업본 잠금, 같은 내용은 같은 문서 키(공동 편집), 잠긴 동안 다른 쓰기·버전으로 저장 409, 연장·만료(15분), 보기는 잠그지 않음, HTML은 400 | D-59 |
| TC-VO-03 | 편집 설정: documentType·문서 키·파일 주소·콜백(편집일 때만)·한국어, token은 설정 전체의 JWT, 보기는 편집 권한 없음 | D-59 |
| TC-VO-04 | 콜백 검사: 본문 token·`Authorization: Bearer`({payload}) 둘 다 받고 위조는 거부 | D-59 |
| TC-VO-05 | 콜백 저장: status 2는 받은 파일로 대표 파일을 바꾼 수정본(source office)을 쌓고 잠금을 푼다. 다른 키·다른 출처 주소(SSRF)·64MB 초과는 거부, status 4는 저장 없이 닫힘, 저장 뒤 다시 열면 새 키 | D-59 |
| TC-VO-06 | Worker: `editor-config`에 office, 편집 설정 JWT, 파일 주소(서명 토큰)로 원본, 토큰 없거나 위조면 403 | D-59 |
| TC-VO-07 | Worker 콜백: 위조 JWT·다른 키 403, 오피스 서버가 아닌 주소(169.254.169.254) 400(요청하지 않음), status 1은 연장, status 2는 수정본(office, 세션 주인이 작성자)·잠금 풀림 | D-59 |
| TC-VO-08 | Worker 잠금·권한: 편집 세션 동안 같은 문서 저장·버전으로 저장 409, viewer는 편집 세션 403·보기 설정(콜백 없음)만 | D-59 |
| TC-VO-09 | Worker: HTML 문서는 400, 준비 상태는 오피스 서버 healthcheck | D-59 |
| TC-VO-13 | Worker 잠금: 편집 세션 동안 텍스트 편집·새 버전 올리기·정식 확정도 409, 지금 버전은 그대로(오피스 저장이 그 사이 바뀐 대표 파일을 덮어쓰지 않게) | D-59 |
| TC-VO-10 | 로컬 API(대역 오피스 서버): 설정·파일·콜백 → 수정본(office), 잠긴 동안 409, 위조 403·다른 출처 400, 버전으로 저장하면 docs/에 받은 파일 그대로 | D-58·D-59 |
| TC-VO-11 | 로컬 화면(대역 api.js): 「오피스 편집기로 열기」 확인 창 → 깨우는 동안 진행 막대 → 편집기(편집 모드)·다른 쓰기 409 → 「닫고 저장」 → 저장 콜백 → 수정본 안내 → 구조 편집 화면에서 버전으로 저장 | D-59 |
| TC-VO-12 | 실제 ONLYOFFICE Docs 10.0(docker): 편집 설정으로 DOCX를 열고 글자를 넣어 닫으면 오피스 서버가 서명한 저장 콜백(Authorization Bearer) → 수정본, 저장 파일 word/document.xml에 입력한 글자. 손으로 돌린다(`npm run test:office-real`) | D-59 |
| TC-VO-14 | 로컬 잠금(TC-VO-10 안): 편집 세션 동안 텍스트 편집·새 버전 올리기·정식 확정도 409 | D-58·D-59 |

### 2.11 6.0 V6 보안 점검 (`packages/core/test/security.test.ts`, `apps/worker/test/security.test.ts`, `site/test/security.test.ts`)

2026-11-02 보안 점검(높음 0·중간 3·낮음 6)에서 찾은 문제마다 재현 테스트를 먼저 만들어 실패를 확인하고 고쳤다(5절). 실제 ONLYOFFICE 왕복(TC-VO-12)은 편집기가 오피스 서버에 보내는 모든 경로가 프록시 허용 목록 안인지도 본다.

| ID | 내용 | 근거 |
|---|---|---|
| TC-SEC-01 | (중간) SVG CSS의 `image-set()`·`-webkit-image-set()`·`src()`·`cross-fade()`·`local()` 같은 주소 함수와 주석으로 끊은 함수 이름을 지운다(함수 허용 목록). 색·변형·`url(#id)`·따옴표 글꼴은 그대로. SVG 자산 응답 CSP는 `default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; sandbox`(Worker 콘텐츠 도메인·로컬 같게) | V6 보안 점검 |
| TC-SEC-02 | (중간) `font-family` 검사가 지수 시간이 걸리지 않는다: 32자 + 맞지 않는 글자를 덱·HTML(`checkDocStyle`)·글자 span 경로 모두 10ms 안에 거부. 200자 넘는 스타일 값은 거부 | V6 보안 점검 |
| TC-SEC-03 | (중간) svgedit에 올리기 전 SVG를 소독하고 `<style>`을 편집 뿌리(`#svgcontent`) 아래로 좁힌다(앱 화면 전체에 걸리지 않게). 꺼내면 범위를 뗀다 | V6 보안 점검 |
| TC-SEC-04 | (낮음) 인라인 SVG `<style>` 범위 좁히기: 주석으로 접두어를 삼키는 규칙·중첩 규칙·짝이 맞지 않는 중괄호·따옴표 안 중괄호는 그 `<style>`을 비운다 | V6 보안 점검 |
| TC-SEC-05 | (낮음) 오피스 프록시는 편집기 경로(`web-apps`·`sdkjs`·`plugins`·`fonts`·`doc`·`cache/files`… 버전 접두어 포함, `/healthcheck`)만 넘기고 관리·명령·변환 API는 404. 쿠키·Authorization·클라이언트 `X-Forwarded-*`·`Forwarded`를 지운다 | V6 보안 점검 |
| TC-SEC-07 | (낮음) 늦게 온 저장 콜백(세션 끝남·잠금 풀림·그 사이 다른 수정본)은 반영하지 않고 `error: 0`으로 답한 뒤 활동 `office-reject`로 남긴다. 강제 저장(6) 뒤 닫힘(2)은 이어서 저장. 저장 파일 다운로드는 content-length 없이도 읽으며 세어 64MB 상한 | V6 보안 점검 |
| TC-SEC-08 | (낮음) 오피스 편집 세션은 최대 8시간(`MAX_SESSION`)까지만 연장. owner가 잠금을 푼다(`POST …/office/unlock`, editor는 403, 활동 `office-unlock`, 화면 「오피스 잠금 풀기」 확인 창). 로컬도 같은 경로 | V6 보안 점검 |
| TC-SEC-09 | (낮음) JWT는 `exp`가 있어야 받고 편집 설정 JWT에도 `exp`. 로컬 서버: 파일·콜백 토큰 키를 오피스 JWT 비밀값과 분리(`data/office-ticket.key`), Host는 루프백·`host.docker.internal`만(DNS 리바인딩), 상태를 바꾸는 요청은 Origin이 없거나 루프백만(다른 사이트·sandbox 문서 `null`은 403) | V6 보안 점검 |

## 3. 수동 확인 케이스

자동으로 확인하기 어렵거나(끌기, 전체 화면, 외부 프로그램 화면) 결과를 눈으로 봐야 하는 항목이다. 릴리스 전에 실제 사이트(`npm run dev`)에서 확인한다.

| ID | 절차 | 기대 결과 | 근거 |
|---|---|---|---|
| TC-M-01 | 헤더 대분류 탭의 핸들(⋮⋮)을 끌어 다른 탭 왼쪽·오른쪽 절반에 놓는다 | 그쪽에 표시선이 나오고 놓으면 순서가 바뀐다. 순서가 안 바뀌는 자리에는 표시선이 없다 | D-18 |
| TC-M-02 | 대분류 탭 ⋯ → 이름 변경(더블클릭도), 왼쪽/오른쪽 이동, 삭제 | 바로 반영. 메뉴가 있는 대분류는 삭제 안내 | D-18 |
| TC-M-03 | 사이드바 손잡이를 끌고, 더블클릭한다 | 200~560px 사이로 바뀌고, 더블클릭하면 272px. 새로 열어도 유지 | `.claude/guides/site-local.md` 사이드바 |
| TC-M-04 | 메뉴에 파일을 끌어다 놓는다 / 메뉴 `+` / 상단 업로드 / 문서 "새 버전" | 업로드 대화상자가 해당 메뉴·문서로 열린다 | D-9 |
| TC-M-05 | 업로드 대화상자 "새 Markdown 문서" 탭으로 문서를 만든다 | `# 제목` 한 줄짜리 draft 문서가 생기고 편집 화면이 열린다(자동: TC-UI-26) | D-11 |
| TC-M-06 | Markdown 편집 중 저장하지 않고 창을 닫았다 다시 연다 | 이전 작성 내용 복원을 제안한다 | D-10 |
| TC-M-07 | HTML 텍스트 편집에서 SVG 글자를 누른다, Esc를 누른다, 링크를 누른다 | SVG는 입력창으로 고친다. Esc는 그 조각을 되돌린다. 링크는 이동하지 않는다 | D-20, 2.0 §3.3 |
| TC-M-08 | DOCX 문서 "텍스트 편집"에서 조각을 고친다 | 오른쪽 미리보기(docx-preview)에 바로 반영, 굵게·기울임 표시가 원래 서식과 같다 | 2.0 2.3 |
| TC-M-09 | PPTX 문서 "텍스트 편집"에서 3번 슬라이드 글자를 고친다 | PDF 미리보기가 그 슬라이드 쪽으로 열리고 글자가 바뀐다 | 2.0 2.4 |
| TC-M-10 | XLSX 셀 편집에서 공유 문자열 셀 하나만 고쳐 저장한 뒤 Excel·Numbers로 연다 | 고친 셀만 바뀌고 파일이 정상으로 열린다 | 2.6 |
| TC-M-11 | DOCX·PPTX·XLSX 문서에서 "비교"를 고른다 | 조각 단위로 바뀜·추가·삭제가 표시된다 | 2.0 2.5 |
| TC-M-12 | 프레젠테이션 버튼을 누르고 Esc로 나온다 | 문서 영역만 전체 화면, HTML·Markdown은 1280px 기준으로 확대. Esc 뒤 원래 화면 | `.claude/guides/site-local.md` 프레젠테이션 |
| TC-M-13 | PPTX·DOCX·PDF·draw.io·이미지·CSV 문서를 연다 | 각 뷰어로 보인다. PPTX PDF 변환본에 한글이 빠지지 않는다 | D-4, 2.1 |
| TC-M-14 | 다크 모드(시스템 설정)로 사이트와 docs HTML을 본다 | 색 토큰이 다크 값으로 바뀌고 글자가 읽힌다 | 작성 규칙 |
| TC-M-15 | 휴지통 영구 삭제 확인 창에서 Enter를 누른다 | 기본 포커스가 "취소"라 삭제되지 않는다(danger) | `.claude/rules/site-ui.md` 확인 창 |
| TC-M-16 | 개발 모드에서 화면 요소를 가리키고 ⌘C (react-grab) | 컴포넌트·소스 위치가 복사된다. `npm run build` 결과물에는 없다 | `.claude/guides/site-local.md` react-grab |
| TC-M-17 | Claude Code에서 `/mcp` 확인 후 "○○ 문서의 ‘…’를 ‘…’로 바꿔 줘" | workflow-docs 도구가 호출되고 새 버전이 사이트에 바로 보인다 | 3.1 완료 기준 |
| TC-M-19 | 사이드바 폴더·문서 줄의 ＋·⋯ 아이콘, 헤더 대분류 핸들, 사이드바 너비 손잡이, 프레젠테이션 전체 화면 안에서 아이콘에 마우스를 올린다 | 툴팁이 잘리지 않고 화면 안에 뜬다(손잡이·펼치기 버튼은 오른쪽). 다크 모드에서도 읽힌다 | `.claude/rules/site-ui.md` 아이콘 |
| TC-M-20 | Claude Code에서 사이트 "참조 복사"로 Alt+클릭한 주소를 붙여 넣고 "이 문단을 ○○로 바꿔 줘" | 그 문단 조각만 바뀌고, 열린 화면에 알림과 강조가 나온다 | 3.0 7.4 |
| TC-M-21 | 외부 문서에서 "스크립트 켜기" 후 접기·탭 같은 동작을 눌러 본다 | 켜기 전에는 멈춰 있고, 켜면 동작한다 | D-25 |
| TC-M-22 | 실제 Cloudflare Worker를 배포해 설정 창에 넣고, 편집 창에 이미지를 끌어 놓기·붙여넣기 한다. 다크 모드로도 본다 | 테스트 업로드 성공, 올린 이미지가 R2 주소로 들어가 미리보기에 보인다. 편집 창·미리보기 색이 다크 값 | D-32, D-31 |
| TC-M-23 | 사이드바에서 실제 마우스로 문서·폴더를 끌어 다른 줄의 위쪽·가운데·아래쪽에 올린다. 문서 화면(iframe) 위로 끌고 나갔다 돌아온다 | 위쪽·아래쪽이면 선, 가운데면 배경으로 놓을 자리가 보이고, 놓을 수 없는 자리(자기 하위, 문서 위의 폴더)는 표시가 없다. 끄는 중인 줄은 흐리게 | D-36 |
| TC-M-18 | Claude Code에서 claude.ai 아티팩트 주소를 주고 "온보딩 메뉴에 등록해" | Artifact 도구로 읽어 `upload_document`로 등록, 출처가 남는다 | 3.0 §4.3 |

---

## 4. 아직 테스트가 없는 범위

- 업로드 대화상자·메뉴 관리 대화상자의 화면 조작은 API 케이스로 서버 동작만 확인한다(화면은 수동 TC-M-02·04, 새 Markdown 문서 탭은 TC-UI-26, 하위 문서 추가는 TC-UI-29).
- 사이드바 끌어서 놓기 화면 테스트(TC-UI-28)는 DragEvent를 직접 보내 확인한다. 실제 마우스 끌기는 수동 TC-M-23.
- 오피스 편집기(6.0 VO): Cloudflare Containers 위 실제 구동(콜드 스타트·WebSocket 공동 편집·컨테이너 프록시)은 자원을 만들기 전이라 확인하지 못했다. 자동 테스트는 대역 오피스 서버, 실제 ONLYOFFICE는 로컬 docker(TC-VO-12)로만 본다.

---

## 5. 테스트로 찾아 고친 버그

| 날짜 | 증상 | 원인 | 수정 | 회귀 케이스 |
|---|---|---|---|---|
| 2026-10-08 | 같은 탭에서 주소 입력·링크 등으로 전체 페이지 이동을 6번쯤 하면 사이트가 더 열리지 않음(새 탭도 같은 주소는 멈춤) | 떠난 페이지가 뒤로 가기 캐시(bfcache)에 남으면서 SSE(`/api/events`) 연결을 닫지 않아, Chrome의 같은 호스트 연결 한도(6개)가 참 | `web/src/lib/live.ts`: `pagehide`에서 SSE를 닫고, 캐시에서 돌아오면(`pageshow` persisted) 다시 열고 목록을 새로 불러옴 | TC-UI-13 (수정 전 코드에서 실패 확인) |
| 2026-10-13 | 사이드바 폴더 추가에서 한글 이름을 넣고 Enter를 치면 폴더가 생기지 않고 메시지도 없이 입력칸이 닫힘 | 맥 크롬 한글 입력기는 Enter에 조합 중(`isComposing`, keyCode 229) keydown과 조합 끝 Enter keydown을 연달아 보낸다. 첫 keydown이 확인 창을 열고, 두 번째 Enter가 확인 창의 "취소"를 눌러 닫힘 | `Sidebar.tsx`의 이름 입력칸과 같은 구조인 헤더 대분류 이름 입력칸(`TopMenuBar.tsx`)에서 조합 중 keydown은 건너뜀 | TC-UI-31 (수정 전 코드에서 실패 확인) |
| 2026-10-14 | 상단 업로드 창의 새 문서 만들기·대분류 추가에서 Enter를 치면 만들어지기도 하고 안 되기도 함 | 확인 창의 `showModal()`이 첫 버튼("취소")에 바로 포커스를 준다. 60ms 뒤 확인 버튼으로 옮기기 전에 한글 입력기의 두 번째 Enter가 오면 "취소"가 눌림. 입력 속도에 따라 결과가 달라짐 | 확인 창(`ConfirmProvider.tsx`)이 처음엔 창 자체에 포커스를 두고 60ms 전의 Enter·Space는 버림. 폼(업로드·대분류 추가·폴더 옮기기·폴더 삭제·문서 관리)은 조합 중 Enter로 제출되지 않게 함(`lib/ime.ts`) | TC-UI-33·34 (수정 전 코드에서 실패 확인) |
| 2026-10-29 | (Cloudflare) 콘텐츠 도메인을 앱과 나누면 Markdown·코드·표·DOCX 문서가 열리지 않을 것 | 화면이 글자 파일을 `fetch`로 읽는데 콘텐츠 도메인 응답에 CORS 허용이 없었다. 같은 출처로 띄운 테스트에서는 드러나지 않았다 | 콘텐츠 응답에 앱 출처(APP_ORIGIN)만 `Access-Control-Allow-Origin`. 화면 테스트를 운영처럼 출처를 나눠 띄움 | TC-CF-07, TC-CFUI-09 |
| 2026-10-29 | Markdown 저장 직후 다른 문서로 가면 가끔 "저장하지 않은 변경" 경고로 이동이 막힘 | 저장 뒤 새 버전을 다시 불러올 때까지 편집 내용이 원본과 달라 `dirty`가 참으로 남았다(네트워크가 느릴수록 잘 생김) | 방금 저장한 내용(`savedText`)은 변경으로 보지 않음(`MarkdownViewer.tsx`) | TC-CFUI-03 → 04 연속 실행(수정 전 4번 중 2번 실패, 수정 후 4번 모두 통과) |
| 2026-10-29 | (Cloudflare) PPTX·DOCX를 PDF로 바꾸지 못함(`Container failed to start`) | 이 계정은 컨테이너를 `scheduling_policy: durable_object` + `images` 형식으로만 만들 수 있어 배포 때 설정을 바꿨는데, 그 형식에서는 `start()`에 이미지 이름이 있어야 한다. `@cloudflare/containers` 0.3.7은 넘기지 않는다(로그: `Container.start() requires an image or container snapshot`) | `Converter`가 `ctx.container.start`에 `images.base`를 넣는다(`apps/worker/src/convert.ts`) | TC-CFUI-09 (수정 전 실패 확인), TC-CFUI-12 |
| 2026-10-29 | 구조 편집에서 문단을 두 번 눌러도 글자 편집이 켜지지 않을 때가 있음 | 글자를 고칠 수 있는 요소 표시(`data-editable`)를 렌더 뒤 effect에서 칠해서, 편집 사본이 아직 다 읽히기 전이면 빠졌다 | 사본의 `load`에서 칠함(`HtmlStructPane.tsx`) | TC-CFUI-11 |
| 2026-10-30 | 슬라이드 글자를 두 번 눌러 편집기가 열린 직후 친 글자가 들어가지 않음 | Tiptap 편집기 DOM이 붙기 전에 포커스를 요청해 커서가 들어가지 않았다 | `autofocus: "end"` + 다음 프레임에 한 번 더 포커스(`TextEditor.tsx`) | TC-CFUI-14 |
| 2026-10-30 | (보안 점검) 덱 글꼴 이름(`faces.family`)으로 Browser Rendering 문서에 스크립트·임의 주소를 넣을 수 있음(중간) | 글꼴 이름을 문자열인지만 보고 인쇄 HTML의 `<style>`에 그대로 넣었다. 수정본 파일 저장(put)은 덱 검사도 거치지 않았다 | 글꼴 이름 허용 문자(`FAMILY_RE`)로 검사하고 렌더러도 걸러 넣음, 인쇄 문서에 CSP `script-src 'none'`, 헤드리스 브라우저는 콘텐츠 도메인 그림·Google Fonts만 읽게 요청 가로채기, put에도 덱 검사 | TC-ED-43·46 (수정 전 실패 확인), TC-CFUI-18 |
| 2026-10-30 | (보안 점검) 낮음 6건: 실시간 WebSocket에 Origin 검사 없음, viewer가 렌더링을 제한 없이 부름, OOXML 압축 폭탄·연산 수 제한 없음, put 크기 제한 없음, HTML 링크 `java\tscript:`·`data:` 통과, 렌더 캐시가 영구 삭제 뒤에도 남음 | — | WebSocket 업그레이드도 Origin 검사, PDF·PNG 렌더링에 요청 수 제한, 풀린 크기 64MB·연산 500개 상한, put 25MB·200개 상한, 링크 허용 형태만, 캐시 30일 정리 | TC-CF-48, TC-ED-44·45·46·47 |
| 2026-10-30 | PDF 편집에서 글상자 도구로 쪽을 눌러도 글자 칸이 생기지 않음 | 눌렀을 때 생긴 글자 칸이 포커스를 받은 뒤, 같은 누름의 기본 동작(포커스 옮기기)으로 바로 포커스를 잃어 빈 칸으로 지워졌다 | 글상자 도구의 pointerdown 기본 동작을 막음(`PdfEditor.tsx`) | TC-CFUI-16 |
| 2026-10-30 | 가져오기 CLI로 들어온 덱은 슬라이드 파일에 data-eid가 없어 에이전트가 고칠 요소를 가리킬 수 없음 | 가져오기는 업로드 검사(`prepareDeck`)를 거치지 않는다 | 덱 읽기 API(`readDeck`, 로컬·Worker)가 늘 직렬화 형식(eid 붙은)으로 준다. eid는 문서 순서로 정해져 서버·화면이 같다 | TC-CFUI-14, TC-MCP-25 |
| 2026-10-30 | (Cloudflare staging) PDF 내보내기가 「Navigation timeout of 30000 ms exceeded」로 실패 | 렌더링 문서를 열 때 `networkidle0`(0.5초 동안 요청 없음)을 기다렸는데, 실제 Browser Rendering에서는 이 신호가 오지 않아 거의 매번 30초를 넘겼다. 로컬 `wrangler dev`는 로컬 Chrome이라 드러나지 않았다 | `load`까지만 기다리고 그 뒤 글꼴·그림을 기다림(`apps/worker/src/render.ts`) | 실제 Browser Rendering(원격 바인딩 시험 Worker)에서 `networkidle0` 3번 모두 시간 초과·`load` 3번 모두 4~5초 성공 확인, TC-CFUI-18 |
| 2026-11-02 | 로컬 사이트에서 슬라이드 덱이 덱으로 그려지지 않고(대표 파일이 JSON 글로 보임) 슬라이드 편집 버튼도 나오지 않음 | 화면이 대표 파일을 `path === "deck.json"`으로 알아보는데, 로컬 색인의 파일 경로는 리포 기준(`docs/<메뉴>/…/vN.N/deck.json`)이다. Cloudflare만 버전 안 상대 경로라 드러나지 않았다 | 버전 안 상대 경로 `relPath`·`isDeck`(`web/src/lib/api.ts`)로 보기·발표·편집 버튼·덱 파일 읽기를 맞춤 | TC-UI-36 (수정 전 슬라이드 편집 버튼 없음으로 실패 확인) |
| 2026-11-02 | (production) `http://workflow.simplite.net`으로 열고 로그인하면 Google이 「400 redirect_uri_mismatch」 | 콜백 주소를 요청 주소의 출처로 만드는데, http로 열면 https로 옮기는 곳이 없어 `http://…/api/auth/google/callback`을 보냈다(Google에는 https만 등록). 같은 이유로 세션 쿠키에 Secure도 빠질 수 있었다 | Worker 진입점에서 APP_ORIGIN이 https면 http 요청을 https로 301(`apps/worker/src/https.ts`), Worker를 거치지 않는 정적 화면은 `main.tsx`에서 https로 이동 | TC-CF-49 (수정 전 실패 확인) |
| 2026-11-02 | (Cloudflare 화면 테스트) 구조 편집에서 「SVG 고치기」가 「Failed to fetch」 | 편집 사본의 `<img>`가 먼저 받은 SVG(CORS 헤더 없음)가 브라우저 캐시에 있으면, 편집기의 fetch가 같은 주소를 다시 확인(If-None-Match)하고 Worker가 CORS·Vary 없는 304를 돌려줘 CORS로 막혔다 | 콘텐츠 응답에 `Vary: Origin`을 늘 붙이고 304에도 앱 출처 CORS를 붙임(`apps/worker/src/content.ts`) | TC-CF-50 (수정 전 실패 확인), TC-CFUI-22 |
| 2026-11-02 | (6.0 VO 작업 중) Cloudflare에서 `GET /api/w/:ws/editor-config`가 늘 404라 draw.io 버튼이 숨음 | V4에서 라우트 등록(`ws.get("/editor-config")`)이 그림 주소 핸들러 안 `return` 뒤에 들어가 한 번도 등록되지 않았다. 로컬 서버와 화면 테스트(대역)는 다른 경로라 드러나지 않았다 | 핸들러 밖으로 옮기고 office 칸을 더함(`apps/worker/src/app.ts`) | TC-VO-06 (예전 코드로 되돌려 실패 확인) |
| 2026-11-02 | (6.0 V5 점검) 오피스 편집 세션 중에도 텍스트 편집·Markdown 저장·새 버전 올리기·정식 확정이 막히지 않아, 그 사이 바뀐 대표 파일을 오피스 저장이 덮어쓸 수 있음 | 잠금은 수정본 층(`DocStore.locked`)에만 있었고, 이 쓰기들은 수정본 층을 거치지 않고 바로 새 버전을 쓴다 | Worker `write.ts`(`needUnlocked`, upload의 기존 문서·saveEdit·saveTextEdit·release)와 로컬 `server/index.ts`(같은 라우트) 앞에서 세션이면 409. 문구는 core `work.LOCKED` | TC-VO-13·14 (수정 전 실패 확인) |
| 2026-11-02 | (V6 보안 점검, 중간) SVG CSS의 `image-set()`·`src()` 등으로 바깥 주소 요청(열람 추적) | 소독기가 `url()`만 바꾸고 문자열 주소를 받는 다른 CSS 함수를 몰랐다. 자산 응답 CSP도 `sandbox`뿐이었다 | CSS 함수 허용 목록(주석 먼저 제거), 자산 응답 CSP `default-src 'none'; img-src data:; …; sandbox` | TC-SEC-01 (수정 전 실패 확인) |
| 2026-11-02 | (V6 보안 점검, 중간) `font-family` 정규식 ReDoS(32자에 54초): 편집자·에이전트가 Worker CPU·로컬 서버를 멈출 수 있음 | 이름 안 공백과 선택적 쉼표 구분자가 겹쳐 맞지 않는 값에서 되짚기가 지수로 늘었다 | 쉼표를 필수 구분자로 둔 모호하지 않은 식, 스타일 값 200자 상한을 먼저 검사 | TC-SEC-02 (수정 전 24자 878ms 확인) |
| 2026-11-02 | (V6 보안 점검, 중간) svgedit이 소독하지 않은 SVG를 앱 문서에 붙임(`<style>`이 앱 화면 전체에 걸림) | 버전 업로드로 들어온 SVG는 소독 전인데, 편집 진입 때 다시 소독하지 않았고 svgcanvas 허용 목록은 `<style>`을 남긴다 | 편집 진입 때 core 소독 + `<style>`을 `#svgcontent` 아래로 좁힘(`svgForEditor`), 꺼낼 때 범위를 뗌. 버전 업로드 SVG는 원본 바이트 보존 원칙 때문에 업로드 때 소독하지 않는다(콘텐츠 도메인 sandbox로 열린다) | TC-SEC-03 |
| 2026-11-02 | (V6 보안 점검, 낮음) 인라인 SVG `<style>` 범위 좁히기 우회(주석으로 접두어 삼키기·중첩) | 정규식으로 규칙을 찾아 주석·중첩을 몰랐다 | 주석 제거 뒤 중괄호 짝을 직접 읽고(`flatRules`), 중첩·@규칙·따옴표 안 중괄호는 그 `<style>`을 비움 | TC-SEC-04 (수정 전 실패 확인) |
| 2026-11-02 | (V6 보안 점검, 낮음) 오피스 프록시가 모든 경로·Authorization·X-Forwarded-*를 컨테이너로 넘김, 로컬 compose가 모든 인터페이스에 열림 | 편집기 출처 전체를 넘겼다 | 편집기 경로 허용 목록(`officeProxyPath`, 실제 ONLYOFFICE 10 경로로 확인), 헤더 정리, compose `127.0.0.1:8090:80` | TC-SEC-05, TC-VO-12 |
| 2026-11-02 | (V6 보안 점검, 낮음) 늦게 온 저장 콜백이 그 사이의 변경을 덮어씀, 다운로드는 content-length만 봄 | 콜백 키만 티켓과 비교하고 세션·지금 rev와 비교하지 않았다 | 세션이 살아 있고 세션 rev가 지금 rev일 때만 저장, 아니면 거부를 기록. 다운로드는 읽으며 세어 상한(`readCapped`) | TC-SEC-07 |
| 2026-11-02 | (V6 보안 점검, 낮음) 편집자가 연장만 보내 오피스 잠금을 무기한 유지, 풀 방법 없음 | 연장에 상한이 없었다 | 세션 최대 8시간(`started_at`), owner 잠금 풀기 API·화면 | TC-SEC-08 |
| 2026-11-02 | (V6 보안 점검, 낮음) 로컬 서버: 티켓·JWT 키 공유, 만료 없는 JWT 허용, Host·Origin 검사 없음 | 로컬은 사용자가 하나라 검사를 두지 않았다 | 티켓 키 분리, JWT `exp` 필수(오피스 서버 토큰에도 있음을 실제 왕복으로 확인), Host 허용 목록·쓰기 Origin 검사 | TC-SEC-09, TC-VO-12 |
| 2026-11-03 | (사용자 보고) HTML 구조 편집에서 위치 값을 바꿀 때마다 문서가 새로 고쳐지듯 맨 위로 가고, 위치 칸을 눌러도 안 먹힘 | ① 저장마다 사본 iframe을 새로 만들며(key=rev) 스크롤을 잇지 않았고, 고른 eid가 같으면 강조 effect가 돌지 않았다 ② 저장으로 eid(원본 바이트 위치)가 바뀌어 새 사본이 열릴 때까지 고른 요소를 잃고 패널이 사라졌다 ③ 위치 칸 key에 값이 들어 있어 값이 바뀌면 칸을 새로 만들었고, 저장 중에는 칸이 꺼졌다 ④ X가 `100-너비`로 조용히 깎였다 | 스크롤 기억·새 사본에서 되돌림·강조 다시 칠함, 구조가 바뀌면 같은 순번 블록으로 바로 고름을 이음, 칸 key는 고를 때만 바뀌고 저장 중에도 켜 둠(저장 중 넣은 값은 새 사본이 열리면 이어서 저장), 값을 다시 채우면 전체 선택 유지, 넘치는 X는 너비를 줄임(`HtmlStructPane.tsx`) | TC-CFUI-24 (수정 전 실패 확인) |
