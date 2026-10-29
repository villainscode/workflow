---
paths:
  - "site/**"
  - "apps/**"
  - "packages/**"
---

# 테스트 규칙

케이스 목록은 `spec/TESTING.md`. 실행 방법은 `.claude/guides/site-local.md`·`.claude/guides/cloudflare-app.md`.

- 기능을 바꾸면 `spec/TESTING.md`의 케이스(표의 행·건수·상태 줄)도 함께 고친다. 테스트 이름은 케이스 ID(`TC-…`)로 시작한다.
- 버그를 고치면 먼저 그 버그를 재현하는 테스트를 만들어 실패를 확인하고, 고친 뒤 통과시킨다. `spec/TESTING.md` 5절(테스트로 찾아 고친 버그)에 남긴다.
- 테스트는 실제 `docs/`와 켜 둔 사이트·실제 Cloudflare 계정을 건드리지 않는다(임시 폴더·빈 포트·로컬 D1·R2).
- 고친 범위에 맞춰 돌린다:
  - `site/`: `npm test`, 화면을 고쳤으면 `npm run test:ui`, 텍스트 편집 어댑터(`packages/core/src/textedit`)를 고쳤으면 `npm run check:textedit`
  - `apps/worker/`: `npm test`, 화면·연결을 고쳤으면 `npm run test:ui`
  - `packages/core`·`packages/mcp-tools`·`site/web`처럼 양쪽이 쓰는 코드는 로컬과 Cloudflare 테스트를 모두 돌린다
