# 백엔드 패키지 구조 · 의존 규칙

> 상태: 초안 (2026-10-13) · 관련 문서: [개발 플랜](development-plan.md) · [프론트 레포 구성](frontend-repo-plan.md)
> 다이어그램: [console_cloud_architecture.drawio](console_cloud_architecture.drawio) (배포 구성), [backend_package_dependency.drawio](backend_package_dependency.drawio) (패키지 의존)

## 1. 전제

- **레포 1개, Gradle 모듈 1개, Spring Boot 앱 1개** 를 유지한다. 빌드(`./gradlew`), 이미지(jib → ECR), 배포(CD → ASG instance refresh), 인프라(ALB → EC2 ASG → RDS/Valkey)는 바꾸지 않는다.
- 아키텍처 다이어그램에서 «계정·인증» 과 «워크스페이스» 는 한 점선 박스(=한 배포 단위) 안에 있다. 이 둘을 **패키지 경계로** 나누고, 경계는 테스트로 강제한다(모듈러 모놀리스).
- 나중에 정말 배포를 쪼개야 하면, 패키지 경계가 지켜져 있는 한 Gradle 모듈로 옮기는 기계적 작업이 된다. 이 문서의 규칙은 그 이행 비용을 0 에 가깝게 만드는 것이 목적이다.

## 2. 현재 구조와 문제

현재는 **audience(user/admin) 우선** 구조다.

```
ai.tommoro.habilis_api_server
├─ auth/            로그인·토큰·이메일·Supabase JIT
├─ user/            /me, feature-flags, console-versions, feature-licenses, (deprecated 4종)
├─ admin/           admin/users, feature-flags, console-*, bundle-files, (deprecated 2종)
├─ domain/          모든 엔티티·리포지토리 공유
├─ common/          응답·예외·유틸 + 딜리버리 클라이언트(NewLauncherReleaseClient 등)
└─ configuration/   시큐리티·JWT·로깅·Sentry·서명
```

| 문제 | 근거 |
|---|---|
| 도메인 경계가 패키지에 드러나지 않는다. 콘솔 배포·라이선스 코드가 `user/`, `admin/`, `common/`, `configuration/` 에 흩어져 있다 | `ConsoleVersion*`, `AdminConsole*`, `NewLauncherReleaseClient`, `ConsoleFeatureSigner` |
| 규약으로 금지한 의존이 이미 생겼다 | user → admin(`AddonLatestResolver`), admin → user(`ConsoleVersionResponse`) |
| `domain/` 이 전부 공유라 어떤 컨텍스트가 어떤 테이블을 소유하는지 알 수 없다 | 엔티티 30여 개가 한 패키지 |
| 토큰 **발급과 검증이 한 클래스**에 있다. workspace 가 검증만 하고 싶어도 발급 능력까지 따라온다 | `UserJwtTokenProvider` |
| 메일 발송이 `auth` 에 묶여 있어 workspace 초대 메일이 auth 내부를 참조해야 한다 | `auth/service/email/*` 를 `AdminUserInviteService` 가 사용 |

## 3. 목표 구조: 컨텍스트 우선, audience 는 그 안에서

배포 경계(다이어그램)와 같은 축으로 최상위를 나눈다. user/admin 분리 원칙은 **각 컨텍스트 안의 `api/user`, `api/admin`** 으로 유지한다.

```
ai.tommoro.habilis_api_server
├─ HabilisApiServerApplication.kt
│
├─ shared/                         ── 공유 커널. 도메인 지식 없음. 모든 컨텍스트가 의존 가능
│  ├─ web/                         SingleResponse, PageResponse, CommonPageRequest, ApiExceptionAdvisor
│  ├─ exception/                   DomainException, ErrorMessage(공통분), ExceptionLogLevel
│  ├─ security/                    JwtTokenAuthenticationFilter, AccessTokenVerifier(검증 전용),
│  │                               AuthPrincipal/UserPrincipal, SecurityFilterChain, Swagger allowlist
│  ├─ signedtoken/                 SignedTokenProvider (메일 링크·초대 토큰 — 목적(purpose)별 키 분리)
│  ├─ mail/                        MailSender 포트, SES 어댑터, 템플릿 렌더러, 발송 이벤트 처리
│  ├─ ratelimit/                   RateLimiter, RedisRateLimiter
│  ├─ logging/                     AccessLogFilter, p6spy, SensitiveJsonMasker
│  ├─ observability/               Sentry 설정 일체
│  ├─ config/                      OpenAPI, WebMvc, JPA auditing, Jackson, ApplicationWarmup
│  └─ util/
│
├─ auth/                           ── 계정·인증 컨텍스트 (다이어그램 «계정·인증»)
│  ├─ AuthUserQuery.kt             ★ 공개 API(다른 컨텍스트가 쓸 수 있는 유일한 진입점)
│  ├─ AuthEvents.kt                ★ 공개 이벤트 (UserDeactivatedEvent 등)
│  ├─ api/
│  │  ├─ user/                     AuthController(login/refresh/logout/signup/...), MeController, FeatureFlagController
│  │  └─ admin/                    AdminUserController, AdminFeatureFlagController, (P5) AdminSessionController
│  ├─ application/                 AuthService, UserService, RefreshSessionService, AdminUserService, ...
│  ├─ domain/                      UserEntity, UserRefreshSession, FeatureFlag, UserRole, UserPlan + 리포지토리
│  ├─ token/                       AccessTokenIssuer, RefreshTokenIssuer (발급 전용)
│  └─ migration/supabase/          Supabase JIT (전환 종료 시 통째로 삭제)
│
├─ workspace/                      ── 워크스페이스 컨텍스트 (다이어그램 «워크스페이스», P6 에서 신설)
│  ├─ WorkspaceAccess.kt           ★ 공개 API (다른 컨텍스트가 권한 확인이 필요할 때)
│  ├─ api/{user,admin}/            WorkspaceController, MemberController, InvitationController, CustomerController ...
│  ├─ application/                 WorkspaceService, MemberService, InvitationService, PermissionService, AuditService
│  ├─ domain/                      Workspace, WorkspaceMember, WorkspaceInvitation, WorkspaceRole,
│  │                               WorkspaceRolePermission, Customer, AuditLog + 리포지토리, Permission(enum)
│  └─ tenancy/                     WorkspaceAccessGuard (멀티테넌트 인가), 요청 컨텍스트
│
└─ console/                        ── 콘솔 배포·라이선스 컨텍스트 (기존 기능, 런처·oci_server 가 호출)
   ├─ api/
   │  ├─ external/                 ConsoleVersionController, FeatureLicenseController (무인증)
   │  └─ admin/                    AdminConsoleVersionController, AdminConsoleFeatureController, AdminBundleFileController
   ├─ application/                 ConsoleVersionService, FeatureLicenseService, AdminConsole*Service, AddonLatestResolver ...
   ├─ domain/                      ConsoleVersionBundle, ConsoleFeature, ActivationCode, ConfigOverlay, EnvOverrides ...
   ├─ delivery/                    NewLauncherReleaseClient, AdminDeliveryCatalogClient, OciLayoutDelivery, AddonArchs ...
   └─ signing/                     ConsoleFeatureSigner
```

### 다이어그램과의 대응

| 다이어그램 요소 | 패키지 | 비고 |
|---|---|---|
| «계정·인증 (Auth · Spring Boot)» | `auth` | 현재 서버의 로그인·토큰·유저 기능 |
| «워크스페이스 (Spring Boot)» | `workspace` | 신규. 초대 메일 → SES, 시크릿 → Secrets Manager |
| 점선 박스(두 컴포넌트를 묶음) | 앱 1개 (기존 ASG) | 배포 단위는 지금 그대로 |
| (다이어그램에 없음) | `console` | 런처·oci_server 용 기존 공개 API. 같은 앱에 남는다 |
| «멀티테넌트 Audit» | `workspace/tenancy`, `workspace/domain/AuditLog` | |
| «AWS SES 메일 발송» | `shared/mail` | auth(인증 메일)·workspace(초대 메일) 공용 |
| «AWS Secret Manager» | `shared/config` + 인프라(user-data) | [개발 플랜 P4](development-plan.md#p4-시크릿-관리-정비) |

### 컨텍스트 내부 레이어

```
api (controller, request/response DTO)
  → application (서비스, 트랜잭션 경계, 유스케이스)
    → domain (엔티티, 리포지토리, 도메인 규칙)
  → (컨텍스트 전용 인프라: token/, delivery/, signing/ ...)
```

- 기존 규약을 그대로 유지한다: 서비스는 request DTO 를 받고, **domain 엔티티나 서비스 값 객체를 반환한다(response DTO 반환 금지).** 변환은 api 레이어 몫.
- api 는 리포지토리를 직접 쓰지 않는다. domain 은 api·application 을 모른다.
- 레이어를 Gradle 모듈로 쪼개지 않는다. 패키지 + 아키텍처 테스트로 충분하다.

## 4. 의존 규칙

```
            ┌──────────┐   AuthUserQuery(공개 API)만   ┌──────────────┐
            │ workspace│ ────────────────────────────▶ │     auth     │
            └────┬─────┘ ◀ - - - - - - - - - - - - - - └──────┬───────┘
                 │          UserDeactivatedEvent (이벤트)      │
                 │                                            │
   ┌─────────┐   │                                            │
   │ console │   │                                            │
   └────┬────┘   │                                            │
        ▼        ▼                                            ▼
   ┌──────────────────────────── shared ──────────────────────────────┐
   └──────────────────────────────────────────────────────────────────┘
```

| 규칙 | 허용 | 금지 |
|---|---|---|
| R1. 모든 컨텍스트 → `shared` | ✅ | `shared` → 어떤 컨텍스트든 ❌ |
| R2. `workspace` → `auth` | **최상위 공개 타입만** (`AuthUserQuery`, `AuthEvents`) | `auth.application.*`, `auth.domain.*` 직접 참조 ❌ |
| R3. `auth` → `workspace` | ❌ (순환 금지) | 필요하면 auth 가 **이벤트를 발행**하고 workspace 가 구독 |
| R4. `console` ↔ `auth`/`workspace` | ❌ | 인증 정보는 `shared.security` 의 Principal 로만 |
| R5. 엔티티 연관관계는 컨텍스트 안에서만 | 컨텍스트 내부 `@ManyToOne` 등 | 다른 컨텍스트 엔티티를 JPA 로 참조 ❌ → `userExtId: UUID` 값으로만 참조 |
| R6. 테이블 소유 | 각 컨텍스트가 자기 테이블만 쓴다 | 다른 컨텍스트 테이블 직접 조회·갱신 ❌ |

### 강제 방법

- **Spring Modulith `ApplicationModules.verify()`** 를 테스트로 둔다(최상위 패키지 = 모듈, 하위 패키지 = 내부). R1~R4 를 별도 규칙 작성 없이 검증한다. Boot 4 와 맞는 Modulith 버전(2.x)을 도입 시점에 확인한다.
  - 도입이 어려우면 **ArchUnit** 으로 같은 규칙을 직접 작성한다.
- 컨텍스트 간 이벤트는 Modulith 의 이벤트 발행 기록(event publication registry)을 쓰면 **트랜잭션 커밋 후 발행 + 실패 시 재시도**가 보장된다. 메일 발송(P3)도 같은 장치를 쓴다.
- P0 에서 테스트를 **보고 전용**으로 넣어 현재 위반 목록을 뽑고, P2 에서 위반 0 이 되면 **실패 모드**로 바꾼다.

## 5. 현재 → 목표 이동표

| 현재 | 목표 | 비고 |
|---|---|---|
| `auth/controller/AuthController` | `auth/api/user/` | |
| `auth/service/{AuthService, RefreshSessionService, IssuedTokens}` | `auth/application/` | |
| `auth/service/supabase/*` | `auth/migration/supabase/` | deprecated 테이블 복사 로직은 P1 에서 제거 |
| `auth/service/email/*` | `shared/mail/` (발송) + 각 컨텍스트의 메일 템플릿 | P3 |
| `auth/service/token/SignedTokenProvider` | `shared/signedtoken/` | 목적별 키 분리는 P4 |
| `configuration/auth/configuration/UserJwtTokenProvider` | 발급 → `auth/token/`, 검증 → `shared/security/AccessTokenVerifier` | P2. typ claim 은 P1 |
| `configuration/auth/**` (필터·Principal·SecurityConfig·Swagger) | `shared/security/` | |
| `user/controller/MeController`, `user/service/UserService`, `user/dto/{Me*, SignupRequest, UserResponse}` | `auth/api/user/`, `auth/application/` | auth → user 위임 예외가 사라진다(같은 컨텍스트) |
| `user/controller/FeatureFlagController`, `admin/.../AdminFeatureFlag*` | `auth/api/{user,admin}/` | Supabase 전환 kill switch. 전환 종료 시 삭제 |
| `admin/controller/AdminUserController`, `AdminUserService`, `AdminUserInviteService` | `auth/api/admin/`, `auth/application/` | |
| `user/controller/{ConsoleVersion, FeatureLicense}Controller` 와 서비스·DTO | `console/api/external/`, `console/application/` | |
| `admin/controller/{AdminConsoleVersion, AdminConsoleFeature, AdminBundleFile}Controller` 와 서비스·DTO | `console/api/admin/`, `console/application/` | user↔admin 역의존이 컨텍스트 내부 의존이 되어 해소 |
| `admin/service/{AddonLatestResolver, AddonArchResolver, LauncherOsResolver, Admin*Client}` | `console/application/`, `console/delivery/` | |
| `common/{NewLauncherReleaseClient, OciLayoutDelivery, DeliveryDownloadLinks, AddonArchs, NewLauncherOses}` | `console/delivery/` | 도메인 지식이 있어 `shared` 에 두지 않는다 |
| `configuration/signing/ConsoleFeatureSigner` | `console/signing/` | |
| `domain/{UserEntity, UserRefreshSession*, User*, FeatureFlag*}` | `auth/domain/` | |
| `domain/{ConsoleVersionBundle*, ConsoleFeature*, ActivationCode, BundleFile, ConfigOverlay, EnvOverrides, DeviceSpec, DeviceType, AddonRef, ConsoleChannel}` | `console/domain/` | |
| `common/{SingleResponse, PageResponse, CommonPageRequest}`, `common/exception/*` | `shared/web/`, `shared/exception/` | 컨텍스트 전용 예외(ConsoleVersionExceptions 등)는 각 컨텍스트로 |
| `common/ratelimit/*`, `common/utils/*` | `shared/ratelimit/`, `shared/util/` | |
| `configuration/{logging, sentry, OpenApi*, WebConfig, ...}`, `ApplicationWarmup` | `shared/logging/`, `shared/observability/`, `shared/config/` | |
| `user/controller/{Activity, InstanceQuota, OciSlot, PodmanInstance}Controller`, `admin/controller/{AdminQuota, AdminInsights}Controller` 와 서비스·DTO·엔티티 | **삭제** | P1 |

### 이동 시 지킬 것

- **패키지 이동과 동작 변경을 한 PR 에 섞지 않는다.** 이동 PR 은 리뷰어가 "import 만 바뀌었다"를 확인할 수 있어야 한다.
- JPA 엔티티 이동은 `@EntityScan`/`@EnableJpaRepositories` 의 basePackages 가 루트를 가리키는지만 확인하면 테이블·컬럼에는 영향이 없다(네이밍 전략이 클래스명 기반이므로 **클래스명은 바꾸지 않는다**).
- OpenAPI 그룹(`auth|user|admin`)은 패키지 스캔 기준이라 이동하면 그룹이 바뀐다. 클라이언트(admin_console 코드 생성 등)가 그룹 URL 에 의존하는지 확인하고, 경로(`/api/v1/...`)는 **절대 바꾸지 않는다.**
- 테스트 패키지도 같은 구조로 미러링한다(CLAUDE.md 규칙 유지).
- 이동이 끝나면 CLAUDE.md 의 «패키지 구조» 절을 이 문서 기준으로 갱신한다.

## 6. 테이블 소유

| 컨텍스트 | 테이블 | 상태 |
|---|---|---|
| `auth` | `users`, `user_refresh_session`, `feature_flag` | 기존. P5 에서 컬럼 확장 |
| `console` | `console_version_bundle`, `console_feature` | 기존 |
| `workspace` | `workspace`, `workspace_member`, `workspace_invitation`, `workspace_role`, `workspace_role_permission`, `customer`, `audit_log` | P6 신규 (7개, 초안) |
| (삭제) | `instance_quota`, `podman_instance`, `oci_lease`, `user_page_presence`, `user_daily_usage` | P1 코드 제거 → 다음 릴리스에서 drop |

- 스키마는 지금처럼 `public` 하나를 쓴다(자원 변경 없음). workspace 테이블은 이름 접두사와 패키지 소유로 구분한다.
- workspace 테이블은 사용자를 `user_ext_id uuid` 로 참조하고 **`users` 에 FK 를 걸지 않는다.** 같은 DB 라 FK 를 걸 수는 있지만, 걸면 배포 분리 시 끊어야 할 결합이 하나 더 생긴다.
- 마이그레이션은 기존처럼 `db/migration/ddl` 에 두되 파일명에 컨텍스트를 드러낸다(예: `V20__workspace_core.sql`). blue/green 이므로 expand-contract 를 지킨다.
