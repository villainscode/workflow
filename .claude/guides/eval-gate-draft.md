# 이밸 게이트·골든셋 이전 설계 (gitflow 문서 v1에 있던 내용)

새 문서를 쓸 때 출발점으로 쓴다. 확정된 결정은 아니다.

- 리뷰 원장: 고아 브랜치 `review-ledger`. `runs/<YYYY-MM>/<run_id>.jsonl`에 CI 봇이 critical·high 지적을 쌓고, `labels/`에 판정이 쌓인다. Ruleset과 워크플로 트리거에서는 뺀다.
- 판정: PR 코멘트 첫 줄 `/ocr-triage <id> fixed|false_positive|accepted|missed "사유"`. `fixed`를 뺀 판정에는 사유가 필수다. 지적 ID는 `<run_number>.<순번>` 형식이다.
- 골든셋: 매일 밤 원장과 판정을 합쳐 `golden/findings.jsonl`을 다시 만든다. 판정이 붙은 지적만 들어간다.
- 활용: 로컬 에이전트는 AGENTS.md 지침으로, CI는 `--background-file`로 바뀐 파일의 골든 기록을 읽는다. 같은 경로에서 오탐이 2회 이상 나오면 `.opencodereview/rule.json` 규칙으로 승격한다. 모델이나 버전을 바꾸기 전에는 `fixed`·`missed` 기록으로 회귀 평가를 한다.
