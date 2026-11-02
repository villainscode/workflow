import { API } from "./base.ts";

/**
 * 오피스 편집기(6.0 VO, D-59) API. 로컬(docker ONLYOFFICE)과 Cloudflare(Containers)가 같은 경로를 둔다.
 * 편집 설정은 서버가 서명해 주고(JWT), 화면은 오피스 서버의 api.js(DocsAPI)에 그대로 넘긴다.
 */

export interface OfficeSession { apiUrl: string; key: string; rev: number; config: Record<string, unknown>; keepAliveMs: number }

async function send<T>(res: Response): Promise<T> {
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(body.error ?? `${res.status} 오류`);
  return body as T;
}
const D = (menu: string, doc: string) => `${API}/docs/${menu}/${doc}`;

export const officeStatus = async () => send<{ enabled: boolean; ready: boolean }>(await fetch(`${API}/office/status`));
export const openOfficeSession = async (menu: string, doc: string) =>
  send<OfficeSession>(await fetch(`${D(menu, doc)}/office/session`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }));
export const keepOfficeAlive = async (menu: string, doc: string, key: string) =>
  send<{ alive: boolean }>(await fetch(`${D(menu, doc)}/office/keepalive`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key }) }));
/** 잠금 풀기(owner) */
export const unlockOffice = async (menu: string, doc: string) =>
  send<{ released: boolean }>(await fetch(`${D(menu, doc)}/office/unlock`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }));
export const officeState = async (menu: string, doc: string) => send<{ active: boolean; key: string | null; rev: number }>(await fetch(`${D(menu, doc)}/office`));

/** 오피스 서버의 api.js를 한 번만 넣는다 */
const loading = new Map<string, Promise<void>>();
export function loadDocsApi(src: string): Promise<void> {
  let p = loading.get(src);
  if (!p) {
    p = new Promise((ok, fail) => {
      const s = document.createElement("script");
      s.src = src;
      s.onload = () => ok();
      s.onerror = () => { loading.delete(src); fail(new Error("오피스 편집기 스크립트를 불러오지 못했습니다")); };
      document.head.append(s);
    });
    loading.set(src, p);
  }
  return p;
}

export interface DocEditor { destroyEditor(): void }
declare global {
  interface Window { DocsAPI?: { DocEditor: new (id: string, config: Record<string, unknown>) => DocEditor } }
}
