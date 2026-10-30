# 프론트엔드 레포 구성 (신규)

> 상태: 초안 (2026-10-13) · 관련 문서: [개발 플랜](development-plan.md) · [백엔드 패키지 구조](backend-package-structure.md)
> 배포 구성: [console_cloud_architecture.drawio](console_cloud_architecture.drawio)

## 1. 범위

아키텍처 다이어그램의 사용자 쪽 컴포넌트 두 개를 담는다.

| 컴포넌트 | 경로 | 기능 |
|---|---|---|
| 로그인 웹 | `/login` | 로그인, 가입, 이메일 인증, 비밀번호 찾기·재설정, 초대 수락 진입 |
| 워크스페이스·대시보드 웹 | `/workspace` | 워크스페이스 선택·생성, 멤버·초대 관리, 역할·권한, 거래처, 감사 로그, 로봇 콘솔(iframe) 대시보드 |

admin_console(플랫폼 관리자용)은 이 레포에 넣지 않는다. 사용 주체와 배포 주기가 다르다.

## 2. 레포 구조

정적 번들이 두 개(`login-web`, `workspace-web`)라 하나의 레포 안에 앱 두 개 + 공유 패키지를 두는 모노레포로 구성한다.

```
habilis-console-web/                  (레포 이름은 확정 필요)
├─ apps/
│  ├─ login-web/                      /login 정적 번들
│  └─ workspace-web/                  /workspace 정적 번들
├─ packages/
│  ├─ api-client/                     백엔드 OpenAPI(/v3/api-docs/{auth|workspace})에서 생성한 타입·클라이언트
│  ├─ auth-session/                   토큰 저장·갱신·로그아웃, 401 처리, 두 앱 공용
│  ├─ ui/                             공용 컴포넌트·디자인 토큰
│  └─ config/                         eslint·tsconfig·빌드 공통 설정
├─ .github/workflows/                 CI(타입체크·테스트·빌드), CD(S3 업로드 + CloudFront 무효화)
└─ package.json / pnpm-workspace.yaml (패키지 매니저·빌드 도구는 admin_console 스택에 맞춰 확정)
```

- **API 타입은 손으로 쓰지 않는다.** 백엔드 OpenAPI 그룹에서 생성하고, CI 에서 스펙 변경을 감지한다. 백엔드의 응답 규약(신규 객체는 bare, 스칼라는 `SingleResponse`, 목록은 `PageResponse`)을 `api-client` 가 한곳에서 처리한다.
- 두 앱이 같은 도메인의 다른 경로이므로 저장소(쿠키·스토리지)를 공유한다. 로그인 후 `/workspace` 로 이동만 하면 된다.

## 3. 배포 자원 (신규)

기존 백엔드 자원(ALB·ASG·RDS·Valkey·ECR·CD)은 건드리지 않는다. 아래만 새로 만든다.

```
사용자 ─ Route 53 (console 도메인)
          └─ CloudFront
               ├─ /login/*      → S3 (login-web 번들)
               ├─ /workspace/*  → S3 (workspace-web 번들)
               └─ /api/*        → 기존 ALB (오리진 커스텀 헤더 부착)
```

| 자원 | 비고 |
|---|---|
| S3 버킷 1개 (경로 접두사로 두 번들 구분) | 퍼블릭 차단, CloudFront OAC 로만 접근 |
| CloudFront 배포 1개 | 경로별 behavior, SPA 라우팅용 404→`index.html` 처리(앱별), 응답 헤더 정책(CSP·HSTS) |
| ACM 인증서 (us-east-1) | CloudFront 용 |
| Route 53 레코드 | 기존 호스팅 영역에 레코드 추가 |
| GitHub Actions 배포 역할 (OIDC) | 해당 버킷 쓰기 + 해당 배포 무효화 권한만 |

- terraform 은 이 백엔드 레포의 `terraform/` 에 `modules/web` 으로 추가하는 것을 제안한다(ALB DNS·호스팅 영역을 같은 state 에서 참조). 프론트 레포는 산출물 업로드만 한다. → [개발 플랜 D6](development-plan.md#5-결정이-필요한-것)
- `/api/*` 를 같은 CloudFront 로 받으면 프론트와 API 가 **같은 출처**가 되어 CORS 가 필요 없다. ALB 의 기존 도메인(`api.habilis-console.com`)은 런처·oci_server·admin_console 용으로 그대로 둔다.
- CloudFront 경유 시 클라이언트 IP 처리는 백엔드 [P7-1](development-plan.md#p7-프론트-연동-마무리) 이 선행돼야 한다.

## 4. 인증 흐름

| 구간 | 방식 |
|---|---|
| 로그인 | `POST /api/v1/auth/login` (`client=WEB`) |
| access 토큰 | 메모리 보관, 요청마다 `x-access-token` 헤더 |
| refresh 토큰 | 1단계: 기존처럼 응답 바디(백엔드 변경 없음, F1 착수 가능)<br>2단계: 백엔드 P7-2 이후 `HttpOnly` 쿠키로 전환 — 스크립트가 refresh 토큰을 읽을 수 없게 |
| 만료 | 401 → `auth-session` 이 한 번만 refresh 후 재시도, 실패 시 `/login` |
| 초대 수락 | 메일 링크 `/login?invitation=...` → 로그인/가입 → 워크스페이스 API 로 수락 |

## 5. 로봇 콘솔 iframe

다이어그램에서 대시보드는 로봇 콘솔을 iframe 으로 넣고, iframe 안의 콘솔은 LAN 의 기기와 중계서버(WebRTC)에 직접 붙는다.

- 대시보드 → iframe 으로 넘기는 값("Auth, Workspace")은 `postMessage` 로 전달하고, **양쪽 모두 상대 출처를 검증**한다.
- iframe 에 사용자의 access 토큰을 그대로 넘기지 않는 것을 권한다. 워크스페이스·기기 범위의 짧은 토큰을 발급하는 API 를 별도로 검토한다(개발 플랜 D5).
- CloudFront 응답 헤더 정책의 CSP `frame-src` 를 로봇 콘솔 출처로 한정한다.

## 6. 단계

| 단계 | 내용 | 백엔드 의존 |
|---|---|---|
| **F0** | 레포·CI·인프라(S3·CloudFront·Route 53·OIDC 역할), 빈 앱 두 개 배포, OpenAPI 클라이언트 생성 파이프라인 | 없음 (기존 API 스펙만 필요) |
| **F1** | 로그인 웹: 로그인·가입·이메일 인증·비밀번호 재설정 | 기존 auth API 그대로 사용 가능. P3(메일) 완료 시 메일 링크가 새 경로를 가리키도록 `CONSOLE_BASE_URL` 조정 |
| **F2** | 워크스페이스 웹: 워크스페이스·멤버·초대·역할·거래처·감사 로그 화면 | P5, P6 |
| **F3** | 대시보드 + 로봇 콘솔 iframe | P7, D5 결정 |

F0·F1 은 백엔드 P2 와 병행할 수 있다(API 경로가 바뀌지 않으므로).
