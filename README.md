# workflow — SDLC 설계 문서 리포와 업무 문서 사이트

SDLC(요구사항 → 설계 → 개발 → 리뷰 → 빌드·배포 → 운영) 업무·관리 솔루션을 만들기 위한 설계 문서를 모아 두는 리포입니다. 문서는 `docs/`에 **메뉴 → 문서 → 버전** 단위로 쌓고, `site/`의 로컬 웹사이트에서 메뉴와 뷰어로 보고 고칩니다.

| 경로 | 내용 |
|---|---|
| `docs/` | 문서 원본(`_site/*.yaml` 메뉴 정의, 문서별 `meta.yaml`, 버전 폴더) |
| `site/` | 업무 문서 사이트(React + Vite 화면, Fastify API, SQLite 색인, workflow-docs MCP) |
| `REQUIREMENT*.md` | 사이트 요구사항·결정 사항(D-n)·단계별 계획 |
| `TESTING.md` | 테스트 케이스 목록 |
| `.claude/` | Claude Code 지침(`CLAUDE.md`), 규칙(`rules/`), 구조·개발 가이드(`guides/`) |

## 로컬에서 띄우기

### 준비물

- **Node.js 22 이상**(24에서 확인), npm
- 선택: 형식 변환이 필요할 때만
  - **LibreOffice**(`soffice`): PPTX·DOCX → PDF 미리보기. macOS는 `brew install --cask libreoffice`
  - **draw.io 데스크톱**(`drawio`): `.drawio` → SVG 보기. `brew install --cask drawio`
  - 없어도 사이트는 뜨고, 해당 변환만 실패합니다.

### 실행

```bash
git clone https://github.com/villainscode/workflow.git
cd workflow
npm install        # 루트에서 한 번(npm workspaces)
cd site
npm run dev
```

- 화면: http://localhost:8000 (Vite, 포트 고정)
- API: http://127.0.0.1:5174 (Fastify)
- `npm run dev`는 8000·5174 포트를 쓰던 개발 서버(node 프로세스)를 먼저 종료한 뒤 두 서버를 함께 띄웁니다. node가 아닌 프로세스가 포트를 쓰고 있으면 종료하지 않고 멈춥니다.
- 처음 시작하면 `docs/`를 읽어 `site/data/index.db`(SQLite 색인)를 만듭니다. 색인은 git에 넣지 않고, 서버를 켤 때마다 다시 만듭니다.
- `docs/` 파일이 바뀌면 자동으로 다시 색인해 열린 화면에 반영됩니다.

### 그 밖의 명령 (`site/`에서)

```bash
npm run typecheck   # 타입 검사
npm run build       # site/dist로 빌드
npm test            # 단위·API·MCP 자동 테스트 (임시 폴더 사용, 실제 docs/ 안 건드림)
npm run test:ui     # 화면 테스트 (전역 puppeteer 필요)
```

화면 테스트는 전역 설치된 puppeteer를 씁니다(`npm i -g @mermaid-js/mermaid-cli`에 포함).

## 사용 방법

### 화면 구성

- **상단 메뉴(대분류)**: SDLC · Agent · Image 등. ＋로 추가, 탭의 ⋯로 이름 바꾸기·이동·삭제, 탭을 끌어 순서 변경.
- **좌측 폴더 트리**: 폴더(메뉴) → 하위 폴더 → 문서 → 하위 문서.
  - 줄을 오른쪽 클릭하거나 ⋯를 누르면 새 문서, 하위 폴더·하위 문서 추가, 이름 바꾸기, 이동, 삭제(휴지통) 메뉴가 나옵니다.
  - 끌어서 놓기로 위치를 바꿉니다. 줄 위쪽에 놓으면 앞, 아래쪽은 뒤, 가운데는 안으로 들어갑니다.
  - 바깥 파일을 폴더에 끌어 놓으면 업로드 창이 열립니다.
  - 폴더 삭제는 폴더 이름을 입력해야 하고, 안의 문서는 휴지통으로 갑니다. 휴지통은 사이드바 아래에 있습니다.
- **문서 화면**: 제목을 누르면 그 자리에서 고칩니다. 오른쪽에 작성일, 버전 선택, 버전 비교, 상태 배지, 기능 버튼이 있습니다.
- 저장·이동·삭제 같은 작업은 모두 확인 창을 거칩니다.

### 문서 올리기

상단 **업로드** 버튼(또는 폴더의 ＋, 문서 화면의 "새 버전")으로 올립니다.

- 파일 하나, 여러 파일, 폴더, zip 모두 됩니다. 대표 파일은 `index.html` → 첫 HTML → 가장 얕은 파일 순으로 정해집니다.
- 지원 형식: HTML, Markdown, PDF, 이미지, DOCX, PPTX, XLSX·CSV, draw.io, 코드·텍스트
- **새 Markdown 문서**는 업로드 창의 "새 Markdown 문서" 탭에서 제목만 넣고 만듭니다.

### 버전 규칙

| 버전 | 의미 |
|---|---|
| `v0.0` | 최초 작성·업로드. 화면에는 **draft** |
| `v0.1`, `v0.2` … | 수정할 때마다 자동으로 올라감 |
| `v1.0`, `v2.0` … | 정식 확정. 상태 배지(draft·review)를 눌러 확정 |

- 수정하면 이전 버전 폴더를 복사해 새 버전 폴더를 만듭니다. 기존 버전은 바뀌지 않습니다.
- 직전 버전과 내용이 같으면 올라가지 않습니다.
- 텍스트 형식과 DOCX·PPTX·XLSX는 "비교"로 두 버전의 차이를 봅니다.

### 문서 고치기

| 형식 | 방법 |
|---|---|
| Markdown | 문서 화면의 편집기(서식 툴바, 나란히 미리보기, 수식·Mermaid). 저장하면 새 버전 |
| HTML·SVG | 상단 "텍스트 편집" → 화면에서 글자를 바로 고침(태그 안 글자만 바뀌고 구조는 그대로) |
| DOCX·PPTX·XLSX | "텍스트 편집" → 왼쪽 목록에서 문단·셀을 고치고 오른쪽 미리보기로 확인 |

**Markdown 이미지**: 편집기 툴바의 "이미지 올리기", 끌어 놓기, 붙여넣기로 Cloudflare R2에 올리고 주소를 넣습니다. 처음 한 번 툴바 설정(톱니바퀴)에 Worker 주소를 넣고 "테스트 업로드"가 성공하면 저장됩니다. 주소는 브라우저마다 저장되므로 브라우저마다 한 번씩 넣습니다. Worker 배포는 [`site/cloudflare/r2-uploader/README.md`](site/cloudflare/r2-uploader/README.md)를 보세요.

### 그 밖의 기능

- **검색**: 제목과 본문(한국어 두 글자 단어 포함)을 찾습니다.
- **프레젠테이션 모드**: 문서 영역만 전체 화면으로 띄웁니다.
- **참조 복사**: 글자를 눌러 `…?v=<버전>&seg=<id>` 주소를 복사합니다. Claude Code에 붙여 넣어 그 부분을 고치게 할 수 있습니다.

## Claude Code로 문서 다루기 (workflow-docs MCP)

리포 루트의 `.mcp.json`에 `workflow-docs` MCP 서버가 등록되어 있습니다. 사이트(`npm run dev`)를 켠 상태에서 리포 루트에서 Claude Code를 열면, Claude Code가 사이트 문서를 찾고, 고치고, 올리고, 확정할 수 있습니다.

- 사이트 주소나 "대분류 > 메뉴 > 문서 제목"으로 문서를 가리키면 됩니다.
- Claude Code가 저장하면 열린 사이트 화면에 알림이 뜨고, 바뀐 부분이 강조됩니다.
- 삭제·휴지통 도구는 없습니다. 지우는 일은 사이트 화면에서 합니다.
- 사용법 상세: `.claude/skills/workflow-docs/SKILL.md`

## 문서 원본 구조

```
docs/
  _site/categories.yaml     # 상단 메뉴(대분류)
  _site/menus.yaml          # 대분류별 좌측 메뉴 트리
  <메뉴 slug>/
    <문서 slug>/
      meta.yaml             # 제목·분류·상태·버전 목록
      v0.0/ v0.1/ v1.0/     # 버전 폴더
      <하위 문서 slug>/     # 하위 문서
  _trash/                   # 휴지통
```

원본은 파일(yaml과 버전 폴더)이고 git으로 추적합니다. 사이트에서 한 작업도 이 파일들에 그대로 기록되므로, 사이트에서 바꾼 뒤 커밋하면 됩니다. 상세 규칙은 [`.claude/rules/docs-workflow.md`](.claude/rules/docs-workflow.md), 구조는 [`.claude/guides/project-structure.md`](.claude/guides/project-structure.md)에 있습니다.
