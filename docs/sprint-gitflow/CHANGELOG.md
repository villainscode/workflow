# 스프린트 Git-flow 프로세스 · CHANGELOG

## v0.1 · 2026-10-06
- 2주 스프린트(D1–D14) 기준으로 다시 작성: D7 첫 코드 리뷰(PR → develop), D10 기능 동결과 release 생성, D14 리뷰(PR release → main)·배포·데모.
- 리뷰를 두 층으로 정리: 로컬 리뷰는 개발자가 매일, CI 리뷰 에이전트는 D7·D14에 자동 실행 + Slack 알림.
- CI 트리거를 `push`에서 `pull_request`(base가 develop·main)로 변경.
- hotfix 브랜치, 고객사 라이선스·패키지, 리뷰 원장·골든셋 내용 제외 (골든셋은 code-review-automation에서 다룰 예정).
