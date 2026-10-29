import type { UploadFile } from "./api.ts";

// 끌어다 놓은 항목에서 파일을 꺼낸다. 폴더면 하위 파일을 경로와 함께 모두 꺼낸다.
type Entry = FileSystemEntry;

function readAll(dir: FileSystemDirectoryEntry): Promise<Entry[]> {
  const reader = dir.createReader();
  const out: Entry[] = [];
  return new Promise((resolve, reject) => {
    const next = () => reader.readEntries((batch) => {
      if (batch.length === 0) return resolve(out);
      out.push(...batch);
      next();
    }, reject);
    next();
  });
}

async function walk(entry: Entry, prefix: string): Promise<UploadFile[]> {
  if (entry.name.startsWith(".")) return [];
  if (entry.isFile) {
    const file = await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej));
    return [{ file, path: prefix + entry.name }];
  }
  const children = await readAll(entry as FileSystemDirectoryEntry);
  return (await Promise.all(children.map((c) => walk(c, `${prefix}${entry.name}/`)))).flat();
}

export async function filesFromDrop(dt: DataTransfer): Promise<UploadFile[]> {
  const entries = [...dt.items].map((i) => i.webkitGetAsEntry()).filter((e): e is Entry => e !== null);
  if (entries.length === 0) return [...dt.files].map((file) => ({ file, path: file.name }));
  return (await Promise.all(entries.map((e) => walk(e, "")))).flat();
}

export function filesFromInput(list: FileList | null): UploadFile[] {
  return [...(list ?? [])]
    .filter((f) => !f.name.startsWith("."))
    .map((file) => ({ file, path: file.webkitRelativePath || file.name }));
}

export const formatSize = (n: number) =>
  n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 ** 2).toFixed(1)} MB`;

/** 서버와 같은 규칙으로 대표 파일 후보를 고른다: index.html → 첫 HTML → 가장 얕은 첫 파일 */
export function guessEntry(files: UploadFile[]): string {
  const root = commonRoot(files);
  const rel = files.map((f) => f.path.slice(root.length));
  const byDepth = [...rel].sort((a, b) => a.split("/").length - b.split("/").length);
  return byDepth.find((p) => /(^|\/)index\.html?$/i.test(p)) ?? byDepth.find((p) => /\.html?$/i.test(p)) ?? byDepth[0] ?? "";
}

/** 폴더째 올리면 서버가 공통 최상위 폴더 이름을 뗀다. 화면에서도 같은 기준으로 보여준다. */
export function commonRoot(files: UploadFile[]): string {
  const tops = new Set(files.map((f) => (f.path.includes("/") ? f.path.split("/")[0] : "")));
  return tops.size === 1 && !tops.has("") ? [...tops][0] + "/" : "";
}

export { slugify } from "@workflow/core/slug";
