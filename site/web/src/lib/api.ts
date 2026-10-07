import { useQuery } from "@tanstack/react-query";

export interface DocSummary {
  slug: string; menuSlug: string; title: string; kind: string; status: string; currentVersion: string;
}
export interface MenuNode { slug: string; name: string; documents: DocSummary[]; menus: MenuNode[] }
export interface Category { key: string; name: string; menus: MenuNode[] }
export interface Tree { categories: Category[]; warnings: string[] }

export interface VersionFile { id: number; path: string; mime: string; size: number; sha256: string; isEntry: boolean; url: string }
export interface DocVersion { id: number; version: string; note: string | null; source: string | null; createdAt: string | null; files: VersionFile[] }
export interface DocDetail {
  id: number; menuSlug: string; slug: string; title: string; kind: string; type: string | null; sdlc: string | null;
  status: string; currentVersion: string; notionUrl: string | null; gdriveUrl: string | null; versions: DocVersion[];
}

export class HttpError extends Error {
  constructor(public status: number, url: string) { super(`${status} ${url}`); }
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new HttpError(res.status, url);
  return res.json() as Promise<T>;
}

export const useTree = () => useQuery({ queryKey: ["tree"], queryFn: () => getJson<Tree>("/api/tree") });

export const useDoc = (menu: string, doc: string) =>
  useQuery({
    queryKey: ["doc", menu, doc],
    queryFn: () => getJson<DocDetail>(`/api/docs/${menu}/${doc}`),
    enabled: !!menu && !!doc,
  });

export interface UploadFile { file: File; path: string }
export interface UploadRequest {
  menu: string; doc?: string; title?: string; slug?: string; version?: string; note?: string; entry?: string;
  files: UploadFile[];
}
export interface UploadResult { menu: string; doc: string; version: string; category: string; created: boolean }

async function send<T>(res: Response): Promise<T> {
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(body.error ?? `${res.status} 오류`);
  return body as T;
}

export async function uploadFiles(req: UploadRequest): Promise<UploadResult> {
  const form = new FormData();
  for (const [k, v] of Object.entries(req)) if (k !== "files" && v) form.append(k, String(v));
  form.append("paths", JSON.stringify(req.files.map((f) => f.path)));
  for (const f of req.files) form.append("files", f.file, f.file.name);
  return send(await fetch("/api/upload", { method: "POST", body: form }));
}

export async function createMenu(category: string, name: string, slug?: string): Promise<{ slug: string }> {
  return send(await fetch("/api/menus", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ category, name, slug }),
  }));
}

/** 화면에 보일 버전 이름. 첫 버전(v0.0)은 "draft"로 보여준다 */
export const versionLabel = (v: string) => (v === "v0.0" ? "draft" : v);

/** 다음 버전 번호(서버와 같은 규칙). 처음 만들 때 v0.0, 그 뒤 수정마다 v0.1, v0.2 … */
export function nextVersion(versions: string[]): string {
  const nums = versions.map((v) => /^v(\d+)\.(\d+)$/.exec(v)).filter((m) => m !== null).map((m) => [Number(m[1]), Number(m[2])]);
  if (nums.length === 0) return "v0.0";
  nums.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const [major, minor] = nums[nums.length - 1];
  return `v${major}.${minor + 1}`;
}

/** 파일 내용이 바뀌면 URL도 바뀌게 해서 브라우저 캐시와 iframe을 새로 고친다. */
export const fileSrc = (f: VersionFile) => `${f.url}?h=${f.sha256.slice(0, 12)}`;

/** 변환 결과 URL. 원본 내용이 바뀌면 h 값이 바뀌어 새로 변환된다. */
export const convertSrc = (f: VersionFile, to: "pdf" | "svg") =>
  `/api/convert/${to}/${f.path.replace(/^docs\//, "")}?h=${f.sha256.slice(0, 12)}`;

export async function saveMarkdown(
  menu: string, doc: string, body: { baseVersion: string; content: string; note?: string; version?: string },
): Promise<UploadResult> {
  return send(await fetch(`/api/docs/${menu}/${doc}/edit`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }));
}

/** 텍스트 파일 내용. 편집기·비교에서 같이 쓴다. */
export const useText = (url: string) =>
  useQuery({ queryKey: ["text", url], queryFn: async () => (await fetch(url)).text(), staleTime: Infinity });
