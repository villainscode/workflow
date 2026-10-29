# 콘솔 클라우드 개발 플랜

> 상태: 초안 (2026-10-13) · 관련 문서: [백엔드 패키지 구조](backend-package-structure.md) · [프론트 레포 구성](frontend-repo-plan.md)
> 배포 구성: [console_cloud_architecture.drawio](console_cloud_architecture.drawio) · 현재 스키마: [../erd/habilis_api_server_erd.drawio](../erd/habilis_api_server_erd.drawio)

## 1. 목표

1. **프론트엔드를 신규 레포로 만든다.** 로그인 웹(`/login`)과 워크스페이스·대시보드 웹(`/workspace`), 초대·멤버 관리를 담는다.
2. **백엔드는 이 레포 하나에서 패키지 구조를 개선한다.** 계정·인증(`auth`)과 워크스페이스(`workspace`)를 패키지 경계로 나누고, 기존 콘솔 배포 기능(`console`)은 그대로 둔다.
3. 이메일 전송, 시크릿 관리, 계정·토큰 관리, 워크스페이스·권한·거래처를 **한 단계씩** 올린다.

## 2. 원칙

| 원칙 | 의미 |
|---|---|
| **기존 자원·파이프라인 불변** | 빌드(Gradle 단일 모듈), 이미지(jib → ECR `habilis-api-api`), CD(workflow_dispatch / `v*` 태그 → ASG instance refresh), ALB·ASG·RDS·Valkey 를 그대로 쓴다 |
| **신규만 새로** | 프론트 레포, S3·CloudFront·Route 53 레코드 등 프론트 배포 자원만 새로 만든다 |
| **단계마다 배포 가능** | 각 단계는 독립적으로 main 에 머지·배포·롤백할 수 있어야 한다. 단계 안에서도 PR 은 작게 |
| **이동과 변경 분리** | 패키지 이동 PR 에는 동작 변경을 넣지 않는다 |
| **API 경로 불변** | 런처·oci_server·admin_console 이 쓰는 `/api/v1/...` 경로와 응답 형태는 바꾸지 않는다 |
| **expand-contract** | blue/green 동시 운영이므로 DB 변경은 구버전 호환으로. 컬럼·테이블 삭제는 코드 제거 다음 릴리스에서 |

## 3. 단계 한눈에 보기

```
백엔드  P0 ─ P1 ─ P2 ─ P3 ─ P4 ─ P5 ─ P6 ─ P7
              │         │              │    │
프론트        └ F0 ─ F1 (로그인) ───────┴ F2 (워크스페이스·초대·멤버) ─ F3 (대시보드·iframe)
```

| 단계 | 이름 | 핵심 산출물 | 영향 자원 |
|---|---|---|---|
| **P0** | 기준선 정비 | 아키텍처 문서, 아키텍처 테스트(보고 전용), 테스트 그린 확인 | 없음 |
| **P1** | 보안 긴급 수정 · 데드 코드 제거 | typ claim, Swagger 우회 제거, JWT secret fail-fast, deprecated 6개 컨트롤러 제거 | 없음 (시크릿 존재 확인만) |
| **P2** | 패키지 재구성 | `shared` / `auth` / `console` 로 이동, 역의존 해소, 토큰 발급·검증 분리, 아키텍처 테스트 실패 모드 | 없음 |
| **P3** | 이메일 전송 공통화 | `shared/mail`, 커밋 후 비동기 발송·재시도, SES API 전환, 반송·수신거부 처리 | 인스턴스 역할에 `ses:SendEmail` 정책 추가 |
| **P4** | 시크릿 관리 정비 | 필수 시크릿 fail-fast, 서명 키 용도별 분리, 시크릿 목록 정리, (선택) 앱 직접 조회 | Secrets Manager 값 추가 |
| **P5** | 계정·토큰 관리 고도화 | 계정 상태·soft delete, 세션 목록·강제 로그아웃, refresh 재사용 탐지, 로그인 rate limit | 없음 (DB 컬럼 추가) |
| **P6** | 워크스페이스 컨텍스트 | 테이블 7개, 워크스페이스·멤버·초대·역할/권한·거래처·감사 로그 API, 멀티테넌트 인가 | 없음 (DB 테이블 추가) |
| **P7** | 프론트 연동 마무리 | CloudFront 경유 시 클라이언트 IP 처리, 웹 쿠키 모드, CORS 축소, iframe 보안 헤더 | 신규 CloudFront 와 연결 |

---

## 4. 단계별 상세

### P0. 기준선 정비

**목표:** 바꾸기 전에 현재 상태를 고정한다.

- [ ] 이 문서들(`docs/architecture/*`)과 ERD 를 레포에 커밋
- [ ] 로컬 기동·`./gradlew test` 그린 확인 (JDK 24, Docker 필요 — README 갱신: Homebrew 에 temurin@24 가 없음, local 포트 8082)
- [ ] 아키텍처 테스트 도입(Spring Modulith `verify()` 또는 ArchUnit) — **보고 전용**으로 현재 위반 목록 산출
- [ ] CLAUDE.md 정리: 존재하지 않는 `docs/migration-plan.md` 등 링크 처리, `application-redis.yaml` import 누락 반영

**완료 기준:** 테스트 그린, 위반 목록이 이슈로 정리됨.

### P1. 보안 긴급 수정 · 데드 코드 제거

**목표:** 구조 개편과 무관하게 지금 운영 중인 위험부터 막는다. 각 항목이 별도 PR.

| PR | 내용 | 검증 |
|---|---|---|
| P1-1 | access/refresh 토큰에 `typ` claim 추가, 검증 시 `typ=access` 만 허용. 전환 기간(access TTL 1.5h)에는 `typ` 없는 토큰도 받되 refresh 고유 claim(`key`, `client`, `jti`)이 있으면 거부 — 유예 중에도 refresh 토큰은 통과하지 못한다 | refresh 토큰으로 API 호출 시 401 테스트 |
| P1-2 | Swagger allowlist 의 `tommoro` 우회(쿼리·Referer) 제거. `forward-headers-strategy` 와 XFF 처리 실측 후 정리 | 우회 요청 403 테스트 |
| P1-3 | `jwt.secret` 기본값을 local/test 프로파일로 한정, 그 외 미설정 시 기동 실패 | prod 프로파일 + 미설정 기동 실패 테스트 |
| P1-4 | deprecated 6개 컨트롤러와 서비스·DTO·예외·엔티티·리포지토리 제거, Supabase JIT 의 해당 테이블 복사 제거 | 테스트 그린 |
| P1-5 | (P1-4 배포 다음 릴리스) deprecated 테이블 5개 drop 마이그레이션 | 마이그레이션 테스트 |

**영향 자원:** prod Secrets Manager 에 `JWT_SECRET` 이 실제로 있는지 메타데이터로 확인(값은 볼 필요 없음).

### P2. 패키지 재구성

**목표:** [패키지 구조 문서](backend-package-structure.md)의 목표 구조로 옮긴다. **동작 변경 없음.**

| PR | 내용 |
|---|---|
| P2-1 | `shared/` 생성 — `common/`, `configuration/` 중 도메인 지식 없는 것 이동 |
| P2-2 | `console/` 생성 — 콘솔 배포·라이선스 코드 이동(user·admin·common·configuration·domain 에 흩어진 것). user↔admin 역의존 해소 |
| P2-3 | `auth/` 재구성 — user(me·가입·feature-flag)·admin(users) 흡수, `api/{user,admin}`·`application`·`domain` 레이어 |
| P2-4 | 토큰 발급(`auth/token`)·검증(`shared/security/AccessTokenVerifier`) 분리, `AuthUserQuery` 공개 API 신설 |
| P2-5 | 아키텍처 테스트 **실패 모드** 전환, CLAUDE.md 패키지 구조 절 갱신, OpenAPI 그룹을 `auth|console|(workspace)` 로 재정의 |

**확인할 것:** OpenAPI 그룹 URL(`/v3/api-docs/{user|admin}`)을 클라이언트 코드 생성이 쓰고 있다면 구 그룹명을 한동안 유지.

**완료 기준:** API 경로·응답 무변경(기존 통합 테스트 전부 그린), 아키텍처 테스트 위반 0.

### P3. 이메일 전송 공통화

**현재:** `auth/service/email` 에서 SES **SMTP** 로 **동기** 발송. SMTP 자격 증명(`MAIL_USERNAME/PASSWORD`)이 시크릿. SES 도메인 인증·configuration set·SNS 이벤트 토픽은 terraform 에 이미 있다.

**목표:** auth(인증·재설정 메일)와 workspace(초대 메일)가 같은 발송 기반을 쓴다.

| PR | 내용 |
|---|---|
| P3-1 | `shared/mail` — `MailSender` 포트 + `log`/`smtp` 어댑터 이동, 공통 레이아웃 템플릿, 컨텍스트별 메일 정의(auth: 인증·재설정, workspace: 초대) |
| P3-2 | **커밋 후 비동기 발송**: 요청 트랜잭션 안에서는 "메일 요청 이벤트"만 기록하고 커밋 후 발송(`@TransactionalEventListener(AFTER_COMMIT)` 또는 Modulith 이벤트 발행 기록). 실패 시 재시도. 지금처럼 커밋 후 발송 실패로 사용자가 메일을 못 받는 일을 없앤다 |
| P3-3 | SES **API(v2) 어댑터** 추가 — 인스턴스 역할 자격으로 발송. 검증 후 기본값 전환, SMTP 자격 증명 시크릿 폐기 |
| P3-4 | 반송·수신거부 처리 — 기존 SNS 토픽을 받아 수신 거부 목록 관리(또는 SES 계정 suppression list 활용), configuration set 지정 |

**영향 자원:** 기존 인스턴스 역할(`terraform/modules/asg`)에 `ses:SendEmail`(대상 identity 한정) 정책 추가 — infra-ci/infra-cd 로 반영. 자원 신규 생성 없음.

### P4. 시크릿 관리 정비

**현재:** 부팅 시 user-data 가 Secrets Manager(`habilis-api/prod/infra`) JSON 을 읽어 `.env` 로 써서 컨테이너에 주입. 키를 추가하면 인스턴스 교체만으로 반영된다. 인스턴스 역할에 `GetSecretValue` 가 있다.

이 방식은 이미 "시크릿은 Secrets Manager 가 원본" 을 만족한다. P4 는 **앱이 시크릿을 안전하게 다루도록** 정비하는 단계다.

| PR | 내용 |
|---|---|
| P4-1 | 필수 시크릿 목록을 코드에 선언(`@ConfigurationProperties` + `@Validated`)하고 누락 시 기동 실패. 기본값은 local/test 프로파일에만 |
| P4-2 | 서명 키 **용도별 분리**: access 토큰, refresh 토큰, 메일 링크·초대 토큰(SignedTokenProvider)을 다른 키로. 키 교체를 위해 `kid` 헤더와 복수 키 검증 지원 |
| P4-3 | 시크릿 목록·소유자·교체 절차 문서화(`docs/architecture/secrets.md`) |
| P4-4 | (선택) 앱이 Secrets Manager 를 직접 읽는 방식(`spring.config.import=aws-secretsmanager:`) 검토. 이점은 인스턴스 교체 없는 갱신·RDS 비밀번호 자동 교체 대응, 비용은 의존성 추가와 로컬 분기. 필요가 확인될 때만 진행 |

**영향 자원:** Secrets Manager 기존 시크릿에 키 추가(`put-secret-value`). user-data·CD 변경 없음.

### P5. 계정·토큰 관리 고도화

**목표:** "유저 계정(토큰) 관리" 요구를 채운다. 워크스페이스 멤버 관리(P6)의 전제.

| PR | 내용 |
|---|---|
| P5-1 | `users` 확장: `status`(ACTIVE/SUSPENDED/DELETED), `deleted_at`, `token_version`. 삭제는 soft delete 로 바꿔 Supabase JIT 재생성 차단 |
| P5-2 | `user_refresh_session` 확장: `device_name`, `user_agent`, `ip`, `last_used_at`, `revoked_at`. 만료 세션 정리 배치 |
| P5-3 | 세션 API: 내 세션 목록·개별/전체 로그아웃, 관리자용 유저 세션 조회·강제 로그아웃 |
| P5-4 | refresh 재사용 탐지(옛 토큰 재사용 시 해당 세션 체인 폐기), 동시 refresh 잠금 |
| P5-5 | 비밀번호 변경·role 변경·정지·삭제 시 세션 폐기 + `token_version` 증가(access 토큰 즉시 무효화) |
| P5-6 | 로그인·가입·메일 재발송 rate limit, 관리자 보호(자기 자신·마지막 admin 강등/삭제 금지), `UserDeactivatedEvent` 발행 |

### P6. 워크스페이스 컨텍스트

**목표:** 다이어그램의 «워크스페이스» 컴포넌트. 멀티테넌트와 감사 로그 포함.

**테이블(초안, 7개):**

| 테이블 | 역할 | 주요 컬럼(초안) |
|---|---|---|
| `workspace` | 테넌트 | `id`, `public_id uuid`, `name`, `customer_id`, `status`, `created_by_ext_id`, `deleted_at` |
| `workspace_member` | 소속 | `workspace_id`, `user_ext_id`, `role_id`, `status`, `joined_at`, 표시용 `email`/`name` 스냅샷 |
| `workspace_invitation` | 초대 | `workspace_id`, `email`, `role_id`, `token_hash`, `invited_by_ext_id`, `expires_at`, `accepted_at`, `revoked_at` |
| `workspace_role` | 역할 | `workspace_id`(null = 시스템 기본 역할), `role_key`, `name`, `is_system` |
| `workspace_role_permission` | 역할-권한 | `role_id`, `permission_key` (권한 목록 자체는 코드 enum) |
| `customer` | 거래처 | `id`, `name`, `business_no`, `contact_*`, `status` |
| `audit_log` | 감사 | `workspace_id`, `actor_ext_id`, `action`, `target_type`, `target_id`, `detail jsonb`, `ip`, `created_at` |

| PR | 내용 |
|---|---|
| P6-1 | 스키마(expand) + 엔티티·리포지토리 |
| P6-2 | 워크스페이스 CRUD, 생성자 = OWNER 멤버 |
| P6-3 | 역할·권한: 시스템 역할(OWNER/ADMIN/MEMBER/VIEWER) 시드, `WorkspaceAccessGuard` 로 요청마다 DB 에서 권한 확인(**권한을 토큰에 넣지 않는다**) |
| P6-4 | 초대: 초대 메일(P3 기반), 수락은 로그인 토큰의 `email` 과 초대 이메일 대조 — auth 를 동기 호출하지 않는다 |
| P6-5 | 멤버 관리: 목록·역할 변경·내보내기, `UserDeactivatedEvent` 구독해 멤버십 정리 |
| P6-6 | 거래처 CRUD, 워크스페이스-거래처 연결. (결정 필요) `console_version_bundle.customer_id` 와의 관계 |
| P6-7 | 감사 로그: 멤버·권한·초대·거래처 변경 기록, 조회 API |

**멀티테넌트 규칙:** workspace 소유 테이블은 모두 `workspace_id` 를 가진다. 모든 조회는 `WorkspaceAccessGuard` 를 통과한 `workspaceId` 로만 한다. 리포지토리 메서드는 `workspaceId` 를 필수 인자로 받는다(전역 조회 금지).

### P7. 프론트 연동 마무리

프론트 레포(F0~F3)와 맞물리는 백엔드 작업. 상세는 [프론트 레포 구성](frontend-repo-plan.md).

| PR | 내용 |
|---|---|
| P7-1 | **CloudFront 경유 시 클라이언트 IP**: CloudFront → ALB 구간에서는 XFF 마지막 값이 CloudFront IP 가 된다. 지금 rate limit·Swagger allowlist·access log 가 "XFF 마지막 값"을 클라이언트 IP 로 쓰므로, CloudFront 경유 요청은 `CloudFront-Viewer-Address` 헤더를 쓰고 CloudFront 만 그 헤더를 넣을 수 있게(오리진 커스텀 헤더 비밀값 검증) 처리 |
| P7-2 | 웹 클라이언트용 토큰 전달 방식: refresh 토큰을 `HttpOnly; Secure; SameSite=Strict; Path=/api/v1/auth` 쿠키로 주는 모드(`client=WEB`). 기존 콘솔·런처의 바디 + `x-access-token` 방식은 유지 |
| P7-3 | prod CORS 축소(`*` + credentials 제거). 웹은 같은 출처라 CORS 불필요 |
| P7-4 | 보안 헤더: 프론트가 로봇 콘솔을 iframe 으로 넣는 쪽이므로 API 는 `frame-ancestors 'none'` 유지, 프론트는 CloudFront 응답 헤더 정책에서 `frame-src` 를 로봇 콘솔 출처로 한정 |
| P7-5 | `ApplicationWarmup` 에 프론트가 기동 직후 부르는 무인증 GET 추가 |

---

## 5. 결정이 필요한 것

| # | 질문 | 제안 | 필요 시점 |
|---|---|---|---|
| D1 | 아키텍처 테스트 도구 | Spring Modulith(이벤트 발행 기록까지 활용) — Boot 4 호환 버전 확인 후, 안 되면 ArchUnit | P0 |
| D2 | OpenAPI 그룹 재정의 시 클라이언트 영향 | admin_console 이 그룹 URL 로 코드 생성하는지 확인 | P2 |
| D3 | `console_version_bundle.customer_id`(자유 문자열)와 신규 `customer`(거래처) 테이블을 연결할지 | 연결한다면 P6-6 에서 매핑 컬럼 추가(expand) | P6 |
| D4 | 워크스페이스 테이블 7개 확정 | 위 초안 기준으로 리뷰 | P6 착수 전 |
| D5 | 로봇 콘솔 iframe 에 무엇을 넘기나("Auth, Workspace") | 장기 토큰 대신 워크스페이스·기기 범위의 단기 토큰 발급 API 를 검토 | F3 착수 전 |
| D6 | 프론트 인프라 terraform 위치 | 이 레포 `terraform/` 에 `modules/web` 추가(ALB·Route 53 출력을 같은 state 에서 참조) | F0 |
| D7 | 프론트 도메인 | 다이어그램의 `console.ai` 는 예시 — 실제 도메인(예: `console.habilis-console.com`) 확정 | F0 |

## 6. 위험과 대응

| 위험 | 대응 |
|---|---|
| 패키지 이동 중 대형 충돌 | P2 를 컨텍스트별 PR 로 쪼개고, 이동 PR 은 하루 안에 머지. 진행 중 다른 기능 PR 은 이동 후로 |
| typ claim 도입 시 기존 클라이언트 로그아웃 | 구 토큰 허용 유예 기간(access TTL) 두고 refresh 시 새 토큰으로 자연 교체 |
| 메일 비동기화로 발송 누락 | 발송 기록 테이블/이벤트 기록 + 재시도 + 실패 알람(Sentry) |
| 워크스페이스 권한 누락으로 테넌트 간 데이터 노출 | 리포지토리에 `workspaceId` 필수, 컨트롤러 통합 테스트에 "다른 워크스페이스 접근 시 403/404" 케이스 필수 |
| CloudFront 도입 후 rate limit 이 한 IP 로 뭉침 | P7-1 을 프론트 공개 전에 완료 |
