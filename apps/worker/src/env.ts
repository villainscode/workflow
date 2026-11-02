export interface Bindings {
  DB: D1Database;
  BLOBS: R2Bucket;
  ASSETS: Fetcher;
  LIVE: DurableObjectNamespace<import("./live.ts").Live>;
  /** 요청 수 제한(없으면 제한하지 않는다) */
  LIMIT_AUTH?: RateLimit;
  LIMIT_WRITE?: RateLimit;
  /** 변환 컨테이너(Workers Paid). 없으면 PDF 변환은 501 */
  CONVERTER?: DurableObjectNamespace<import("./convert.ts").Converter>;
  /** Browser Rendering(5.0 M7 덱 PDF·미리보기). 없으면 501 */
  BROWSER?: BrowserRun;
  /** 앱 주소(예: https://workflow.simplite.net). 원격 MCP OAuth 자원 주소 */
  APP_ORIGIN: string;
  /** 사용자 콘텐츠 출처(예: https://workflow-files.simplite.net). 비면 앱과 같은 출처에서 /c/로 준다(로컬) */
  FILES_ORIGIN: string;
  /** 콘텐츠 주소 서명 키 */
  SIGNING_KEY: string;
  /** 가져오기 API 토큰(운영자용) */
  ADMIN_TOKEN: string;
  /** Google OAuth 클라이언트(P4). GOOGLE_CLIENT_SECRET은 비밀값 */
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  /** 초대 없이 로그인하고 워크스페이스를 만들 수 있는 이메일(쉼표 구분) */
  SUPERADMIN_EMAILS: string;
  /** draw.io 편집기 출처(6.0 V4, 자체 호스팅 apps/drawio, 예: https://draw.simplite.net). 비면 draw.io 버튼을 숨긴다 */
  DRAWIO_ORIGIN?: string;
  /** 오피스 편집 서버(6.0 VO, ONLYOFFICE 컨테이너 apps/office). 없고 OFFICE_ORIGIN만 있으면 그 주소로 바로 간다(로컬 docker) */
  OFFICE?: DurableObjectNamespace<import("./office.ts").Office>;
  /** 편집기 출처(예: https://office.simplite.net, 이 Worker의 별도 도메인). 비면 오피스 편집기 버튼을 숨긴다 */
  OFFICE_ORIGIN?: string;
  /** 오피스 서버가 앱에 닿는 주소(로컬 docker: http://host.docker.internal:8787). 비면 APP_ORIGIN */
  OFFICE_BACKEND_ORIGIN?: string;
  /** 오피스 서버와 나눈 JWT 비밀값(비밀값) */
  ONLYOFFICE_JWT_SECRET?: string;
  /** "1"이면 개발용 로그인(POST /api/auth/dev-login)을 연다. 로컬·테스트에서만 */
  DEV_LOGIN?: string;
}

export type Role = "owner" | "editor" | "viewer";
export interface User { id: number; email: string; name: string | null; picture: string | null }

export interface Workspace { id: number; slug: string; name: string }

export type AppEnv = { Bindings: Bindings; Variables: { ws: Workspace; user: User | null; role: Role } };

/** 원래 로컬 서버의 StoreError와 같은 뜻: status와 사용자에게 보일 메시지. 수정본 층(core work)이 던지는 오류와 같은 클래스다 */
export { WorkError as HttpError } from "@workflow/core/work";

/** R2 키: 워크스페이스별 내용 주소(sha256) 저장. 같은 내용은 한 번만 둔다 */
export const blobKey = (wsId: number, sha256: string) => `ws/${wsId}/blobs/${sha256}`;
