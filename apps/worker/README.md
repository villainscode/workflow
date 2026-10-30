# 문서 탐색 워크플로우 — Cloudflare 앱 (`apps/worker`)

업무 문서 사이트(`site/`)를 Cloudflare 위 팀용 서비스로 옮긴 것. 설계·단계 결과는 `spec/REQUIREMENT-4.0.md`, 테스트 케이스는 `spec/TESTING.md` 2.7절.

구성·파일별 역할·기술 선택은 `spec/ARCHITECTURE.md`. 이 문서는 띄우기·배포·백업 절차만 다룬다.

## 로컬에서 띄우기

```bash
npm install                       # 리포 루트에서
cd apps/worker
npm run dev                       # 화면 빌드 → 로컬 D1 마이그레이션 → wrangler dev (http://127.0.0.1:8787)
```

- 비밀값은 `.dev.vars`(git 제외): `SIGNING_KEY`, `ADMIN_TOKEN`, `GOOGLE_CLIENT_SECRET`, `DEV_LOGIN=1`(로그인 화면에 개발용 이메일 로그인), `SUPERADMIN_EMAILS`.
- 문서 넣기: 리포 루트에서 `npx tsx packages/cli/src/import.ts --url http://127.0.0.1:8787 --token <ADMIN_TOKEN> --ws <주소> --name <이름> --owner <내 이메일>` (리포 `docs/`를 그 워크스페이스로).
- PDF 변환은 로컬 Docker가 있으면 `wrangler dev`가 컨테이너를 띄운다(처음엔 이미지를 만드느라 1분쯤 걸린다).
- 덱 PDF 내보내기·슬라이드 미리보기(Browser Rendering, `BROWSER` 바인딩)는 로컬에서 `wrangler dev`가 Chrome(headless shell)을 내려받아 흉내 낸다. 운영은 Workers Paid의 Browser Rendering을 쓴다(포함 사용량을 넘으면 브라우저 사용 시간만큼 과금).
- 테스트: `npm test`(Workers 런타임, D1·R2·DO 로컬), `npm run test:ui`(전역 puppeteer, 앱·콘텐츠 출처를 나눠 띄움, 변환은 Docker).

## 처음 배포하기 (한 번)

순서대로 한다. ①~④는 Cloudflare·Google 계정에서 사람이 하는 일이다.

1. **Workers Paid**($5/월)를 계정에 켠다. 무료 요금제는 요청당 CPU 10ms라 텍스트 편집·업로드가 실패하고, Containers를 쓸 수 없다(D-37).
2. **도메인**: `simplite.net`이 이 Cloudflare 계정의 영역(zone)이어야 한다. `workflow.simplite.net`·`workflow-files.simplite.net`은 배포할 때 Worker 사용자 지정 도메인으로 자동 연결된다(DNS 레코드를 따로 만들지 않는다).
3. **Google OAuth 클라이언트**: Google Cloud 콘솔 → API 및 서비스 → 사용자 인증 정보 → OAuth 클라이언트 ID(웹 애플리케이션).
   - 승인된 리디렉션 URI: `https://workflow.simplite.net/api/auth/google/callback` (staging: `https://workflow-app-staging.<계정>.workers.dev/api/auth/google/callback`)
   - 동의 화면 범위: `openid`, `email`, `profile`
4. **SUPERADMIN 이메일**을 정한다(초대 없이 들어와 워크스페이스를 만들 수 있는 Google 계정).
5. **자원 만들기**(wrangler, 로그인 필요: `npx wrangler login`):
   ```bash
   cd apps/worker
   npx wrangler d1 create workflow                 # → database_id를 wrangler.jsonc env.production에
   npx wrangler kv namespace create OAUTH_KV       # → id를 env.production에
   npx wrangler r2 bucket create workflow-docs
   # staging도 같은 식: workflow-staging, OAUTH_KV(staging), workflow-docs-staging
   ```
   `wrangler.jsonc`의 `REPLACE_…` 값(D1·KV id, `GOOGLE_CLIENT_ID`, `SUPERADMIN_EMAILS`, staging workers.dev 주소)을 채운다.
6. **비밀값**:
   ```bash
   openssl rand -base64 32 | npx wrangler secret put SIGNING_KEY --env production
   openssl rand -base64 32 | npx wrangler secret put ADMIN_TOKEN --env production
   npx wrangler secret put GOOGLE_CLIENT_SECRET --env production
   ```
7. **배포**:
   ```bash
   npx wrangler d1 migrations apply DB --remote --env production
   npm run deploy -- --env production
   ```
8. **첫 워크스페이스**: 리포 문서를 가져오고 나를 owner로 넣는다.
   ```bash
   cd ../..
   npx tsx packages/cli/src/import.ts --url https://workflow.simplite.net --token <ADMIN_TOKEN> --ws tommoro --name 투모로 --owner <내 Google 이메일>
   ```
   또는 SUPERADMIN으로 로그인해 빈 워크스페이스를 화면에서 만든다.
9. **확인**: 로그인 → 문서 열기(HTML은 `workflow-files.simplite.net`에서 열린다) → 텍스트 편집 저장 → PPTX 문서 PDF 보기 → 멤버 창에서 초대 링크 만들기.
10. **Claude Code 연결**: `claude mcp add --transport http workflow-docs https://workflow.simplite.net/mcp` → 처음 쓸 때 브라우저로 로그인하고 워크스페이스를 고른다.

이후에는 GitHub Actions(`.github/workflows/workflow-app.yml`)가 develop 푸시 → staging, main 푸시 → production으로 마이그레이션·배포한다. 저장소 Secrets에 `CLOUDFLARE_API_TOKEN`·`CLOUDFLARE_ACCOUNT_ID`를 넣고, 저장소 Variables에 `DEPLOY_ENABLED=true`를 넣어야 배포 작업이 돈다(그 전에는 테스트만).

## 백업과 복구

- **D1**: Time Travel로 지난 30일 중 아무 시점으로 되돌린다. `npx wrangler d1 time-travel info DB --env production`으로 시점을 확인하고 `npx wrangler d1 time-travel restore DB --timestamp <ISO 시각> --env production`.
- **파일(R2)**: 내용 주소라 버전 파일을 고치거나 덮어쓰지 않는다. 지워지는 것은 영구 삭제한 문서만 쓰던 blob과 매일 정리의 고아 blob뿐이다.
- **워크스페이스 내보내기**: owner가 `GET /api/w/<주소>/export`로 리포 `docs/`와 같은 모양의 zip을 받는다. 가져오기 CLI(`--docs <풀어 둔 docs 폴더>`)로 다른 워크스페이스·다른 계정에 그대로 다시 넣을 수 있다(TC-CFUI-10 왕복 테스트). 정기 백업은 이 zip을 받아 두거나 리포에 커밋한다.
- **복구 리허설**: staging에서 ① 내보내기 → ② 새 워크스페이스로 가져오기 → ③ 트리·파일 비교(TC-CFUI-10과 같은 절차)를 분기마다 한 번.
