# 문서(docs/) 다루기 규칙

모든 작업에 적용한다(파일을 열기 전에 지켜야 해서 경로 조건 없음). 구조와 meta.yaml 예시는 `.claude/guides/project-structure.md`.

- **사이트 문서는 `docs/` 파일을 직접 고치지 말고 workflow-docs MCP 도구를 쓴다**(`.mcp.json`, 사용법은 `.claude/skills/workflow-docs/SKILL.md`). 로컬 사이트 서버(`cd site && npm run dev`)가 켜져 있어야 한다. Cloudflare 워크스페이스는 원격 MCP(`https://workflow.simplite.net/mcp`)로 다룬다.
- 사이트에서 사람이 만들거나 바꾼 `docs/` 파일을 커밋할 때는 먼저 사용자에게 알리고, 넣을지 확인한다.
- **원본은 파일이다.** `categories.yaml`, `menus.yaml`, 문서별 `meta.yaml`, 버전 폴더의 파일이 원본이고 git으로 추적한다. 사이트의 SQLite(`site/data/`)는 이 파일들을 스캔해 다시 만드는 색인이라 git에 넣지 않는다. 문서를 추가하거나 옮길 때는 yaml을 함께 고친다.
- **버전 규칙**: 최초 작성·업로드는 `v0.0`이고 화면에는 **draft**로 표시한다(`versionLabel()`). 수정할 때마다 `v0.1`, `v0.2` …로 올라가고, 정식 확정하면 `v1.0`(이후 `v2.0`)이 된다. `v0.x`는 드래프트, `v1.0` 이상은 확정이다. 내용을 바꿀 때는 그 문서의 이전 버전 폴더를 복사해 새 버전을 만들고, `meta.yaml`의 `versions`에 메모(`note`)와 함께 추가하고 `current`를 바꾼다. **Notion에 등록했거나 커밋된 버전 폴더는 수정하지 않는다.** 오타 같은 사소한 수정과 구조 이전만 예외로 한다.
- **slug**: 메뉴 slug는 리포 전체에서 하나만 존재한다. 메뉴의 대분류 소속과 상하 관계는 `menus.yaml`(`menus: { <대분류 key>: [트리] }`)에서 정하므로 폴더 경로에 넣지 않는다. 사이트에서 이름만 주고 만든 메뉴는 slug가 자동이다(영문이 없으면 `folder-<난수>`, D-35).
- **하위 문서**(D-34): 문서 폴더 안에서 버전 폴더(`vN.N`)가 아니고 `meta.yaml`이 있는 폴더가 하위 문서다(`docs/<메뉴>/<상위>/<하위>/`). 문서 slug는 메뉴 안에서 깊이와 상관없이 하나뿐이라 주소는 `대분류/메뉴/문서` 그대로이고, 서버는 `server/docpath.ts`의 `findDocDir`로 실제 폴더를 찾는다. 같은 자리 안 문서 순서는 `meta.yaml`의 `order`이고, 없으면 제목순으로 뒤에 온다.
- **원본과 파생**: 다이어그램의 원본은 `diagrams/`의 `.drawio`·`.mmd` 파일이다. `exports/`와 HTML에 넣은 SVG는 원본에서 다시 만들 수 있는 파생물이므로, 원본을 고친 뒤 다시 export한다.
- 새 버전을 만들면 다른 문서에서 이 문서를 가리키는 상대 링크(버전 폴더까지 포함)를 새 버전으로 바꿀지 판단한다.
- Notion·Google Drive 등록은 외부 게시라 문서마다 사용자 확인을 받은 뒤 한다.
