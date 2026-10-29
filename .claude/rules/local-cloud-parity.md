---
paths:
  - "site/server/**"
  - "site/mcp/**"
  - "apps/worker/**"
  - "packages/**"
---

# 로컬 사이트와 Cloudflare 앱 맞추기

같은 기능이 두 곳에 있다: 로컬 `site/server`(파일 원본)와 Cloudflare `apps/worker`(D1·R2 원본). 구조는 `.claude/guides/cloudflare-app.md`.

- 버전·slug·업로드·텍스트 편집·휴지통·정렬 같은 규칙은 두 곳이 같게 동작해야 한다. 한쪽을 고치면 다른 쪽도 고치고, 양쪽 테스트(`TESTING.md` 2.4·2.7)를 맞춘다.
- 두 곳이 함께 쓸 수 있는 규칙은 `packages/core`(런타임 무관, `node:*` 금지)에 둔다. MCP 도구는 `packages/mcp-tools` 하나로 로컬·원격이 같이 쓴다.
- MCP 서버의 stdout은 MCP 통신용이라 로그는 stderr로만 쓴다. MCP에는 삭제·휴지통 도구를 두지 않고(D-24), 쓰기 도구는 변경 메모 앞에 "Claude Code:"를 붙인다(D-26).
- Cloudflare에서 사용자 파일은 콘텐츠 도메인에서만 준다. 앱 도메인에서 사용자 HTML을 열지 않는다(5.5). 상태를 바꾸는 API는 Origin 검사를 거친다.
- 실제 Cloudflare 계정에 자원을 만들거나 배포·비밀값 설정을 하기 전에는 사용자 확인을 받는다.
