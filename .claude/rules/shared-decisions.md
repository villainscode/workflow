---
paths:
  - "docs/**"
---

# 문서 사이에 공유되는 결정

여러 문서가 같은 결정을 전제로 쓰인다. 하나를 바꾸면 그 결정을 쓰는 다른 문서도 함께 맞춘다.

- **브랜치 모델**: `main` · `develop` · `feature/WF-xxx-*` · `release/x.y.z` · `bugfix/WF-xxx-*`. hotfix 브랜치는 쓰지 않는다. 배포 후 결함은 다음 스프린트 티켓이 된다.
- **2주 스프린트 (D1–D14)**: D1 플래닝, D2–D10 개발, D6 테스트, **D7 첫 코드 리뷰(PR → develop)**, D10 기능 동결과 release 생성, D10–D13 테스트·QA, **D14 리뷰(PR release → main)·배포·데모**.
- **리뷰 두 층**: 로컬 리뷰는 개발자가 매일 한다(Claude Code `/code-review`·`/simplify`·`/security-review`, Codex `/review`). 결과를 기록하지 않고 머지도 막지 않는다. D7·D14 리뷰는 CI의 리뷰 에이전트(Open Code Review, `ocr`)가 자동으로 하고 Slack으로 알린다.
- **게이트 판정**: critical·high가 하나라도 있으면 필수 체크 `ocr-review`가 실패해 머지가 막힌다. medium 이하는 막지 않는다.
- **추적**: Asana 티켓 번호(`WF-201` 형식)를 브랜치 이름, 커밋(`feat(auth): ... [WF-201]`), PR 제목(`WF-201 ...`)에 넣는다.
- **CI 설정 이름**: Secrets `OCR_API_KEY`, `SLACK_WEBHOOK_URL`, `CLAUDE_CODE_OAUTH_TOKEN`(Max 구독 방식). Variables `OCR_PROVIDER`, `OCR_MODEL`, `OCR_EFFORT`, `OCR_VERSION`, `OCR_LANGUAGE`, `OCR_MAX_TOKENS_BUDGET`, `OCR_SLACK_ON_PASS`, `CLAUDE_REVIEW_MODEL`.

## 알려진 불일치

- `code-review-automation/review-gate/v0.0/review-gate.html`의 워크플로는 `push`로 트리거된다(`feature/code-review` 게이트 브랜치와 `develop` 사후 리뷰). `sprint-gitflow/process/v0.0/process.html`은 `pull_request`(base가 `develop`·`main`)로 트리거되는 것으로 정했다. code-review-automation 다음 버전에서 이 차이를 맞춘다.
- `sprint-gitflow` 문서 D7 단계는 `/ocr-triage <id> <판정>` 명령을 쓰는데, 이 명령을 설치하는 방법을 설명한 문서가 아직 없다.

이밸 게이트·골든셋은 아직 확정되지 않은 이전 설계만 있다(`.claude/guides/eval-gate-draft.md`).
