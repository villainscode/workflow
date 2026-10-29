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
  /** "1"이면 개발용 로그인(POST /api/auth/dev-login)을 연다. 로컬·테스트에서만 */
  DEV_LOGIN?: string;
}

export type Role = "owner" | "editor" | "viewer";
export interface User { id: number; email: string; name: string | null; picture: string | null }

export interface Workspace { id: number; slug: string; name: string }

export type AppEnv = { Bindings: Bindings; Variables: { ws: Workspace; user: User | null; role: Role } };

/** 원래 로컬 서버의 StoreError와 같은 뜻: status와 사용자에게 보일 메시지 */
export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

/** R2 키: 워크스페이스별 내용 주소(sha256) 저장. 같은 내용은 한 번만 둔다 */
export const blobKey = (wsId: number, sha256: string) => `ws/${wsId}/blobs/${sha256}`;
