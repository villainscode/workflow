# Cloudflare 앱 작업 방법

구성·파일별 역할·기술 선택은 `spec/ARCHITECTURE.md`, 결정·단계 결과는 `spec/REQUIREMENT-4.0.md`, 배포·백업 절차는 `apps/worker/README.md`, 테스트 케이스는 `spec/TESTING.md` 2.7절. 로컬 사이트와 규칙을 맞추는 법은 `.claude/rules/local-cloud-parity.md`.

- 화면은 `site/web` 코드를 `VITE_CLOUD=1`로 빌드해 정적 파일로 낸다(`npm run build:web`). 주소는 `/<워크스페이스>/<대분류>/…`, API는 `/api/w/<워크스페이스>/…`(`web/src/lib/base.ts`).
- 사용자 파일은 서명 토큰 경로 `/c/<토큰>/<메뉴>/<상위…>/<문서>/<버전>/<파일>`로 콘텐츠 도메인에서만 준다.
- 권한 검사는 `src/app.ts`의 워크스페이스 미들웨어(로그인·역할·Origin)에 모여 있다. 새 API는 그 아래(`ws.*`)에 붙인다. owner만 쓸 API는 `OWNER_ONLY` 목록에 더한다.
- D1 스키마를 바꾸면 `migrations/`에 새 번호 파일을 더한다(기존 파일은 고치지 않는다). 배포 CI가 원격에 적용한다.

## 명령

```bash
cd apps/worker
npm run dev        # 화면 빌드(VITE_CLOUD=1) → 로컬 D1 마이그레이션 → wrangler dev(http://127.0.0.1:8787). 비밀값은 .dev.vars
npm run typecheck  # wrangler types + tsc
npm test           # Vitest(@cloudflare/vitest-plugin, Workers 런타임·로컬 D1·R2·DO)
npm run test:ui    # 화면 테스트(전역 puppeteer, 앱 127.0.0.1·콘텐츠 localhost로 출처를 나눔, PDF 변환은 로컬 Docker)
```

리포 `docs/` 가져오기: `npx tsx packages/cli/src/import.ts --url <Worker> --token <ADMIN_TOKEN> --ws <주소> --name <이름> [--owner <이메일>]`.
