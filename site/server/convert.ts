import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { extname, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { StoreError } from "./store.ts";

/**
 * 브라우저가 바로 못 여는 형식을 변환한다. PPTX·DOCX → PDF(LibreOffice), draw.io → SVG(draw.io CLI).
 * 결과는 원본 내용의 sha256으로 캐시하므로 같은 파일은 한 번만 변환한다.
 */

const run = promisify(execFile);
export type Target = "pdf" | "svg";

const SOURCES: Record<Target, Set<string>> = {
  pdf: new Set([".pptx", ".ppt", ".docx", ".doc", ".odp", ".odt"]),
  svg: new Set([".drawio"]),
};

// LibreOffice는 같은 프로필로 동시에 두 번 띄울 수 없으므로 변환을 한 줄로 세운다
let queue: Promise<unknown> = Promise.resolve();
const serial = <T>(job: () => Promise<T>): Promise<T> => {
  const next = queue.then(job, job);
  queue = next.catch(() => {});
  return next;
};

/**
 * macOS의 headless LibreOffice는 fontconfig로 폰트를 찾고, 기본 설정으로는 자체 번들 폰트만 본다.
 * 그러면 한글이 빠진 PDF가 나오므로 시스템 폰트 폴더를 넣은 설정 파일을 만들어 넘긴다.
 */
function fontconfigFile(cacheDir: string): string {
  const path = join(cacheDir, "fonts.conf");
  if (!existsSync(path)) {
    const dirs = ["/System/Library/Fonts", "/Library/Fonts", join(homedir(), "Library/Fonts"), "/Applications/LibreOffice.app/Contents/Resources/fonts"];
    writeFileSync(path, `<?xml version="1.0"?>\n<!DOCTYPE fontconfig SYSTEM "fonts.dtd">\n<fontconfig>\n${
      dirs.map((d) => `  <dir>${d}</dir>`).join("\n")}\n  <cachedir>${join(cacheDir, "fontconfig")}</cachedir>\n</fontconfig>\n`);
  }
  return path;
}

export async function convert(docsRoot: string, cacheDir: string, relPath: string, to: Target): Promise<string> {
  const src = resolve(docsRoot, relPath);
  if (!src.startsWith(docsRoot + sep) || !existsSync(src)) throw new StoreError(404, "파일이 없습니다");
  return convertData(cacheDir, readFileSync(src), extname(src).toLowerCase(), to);
}

/**
 * 파일 내용을 변환한다. docs/에 없는(아직 저장하지 않은) 데이터도 변환할 수 있어 텍스트 편집 미리보기에 쓴다.
 * 결과는 내용 sha256으로 캐시하므로 같은 내용은 한 번만 변환한다.
 */
export async function convertData(cacheDir: string, data: Uint8Array, ext: string, to: Target): Promise<string> {
  if (!SOURCES[to].has(ext)) throw new StoreError(400, `${ext} 파일은 ${to}로 변환하지 않습니다`);
  mkdirSync(cacheDir, { recursive: true });
  const hash = createHash("sha256").update(data).digest("hex");
  const out = join(cacheDir, `${hash}.${to}`);
  if (existsSync(out)) return out;

  return serial(async () => {
    if (existsSync(out)) return out;
    const tmp = mkdtempSync(join(cacheDir, "tmp-"));
    const src = join(tmp, `source${ext}`);
    writeFileSync(src, data);
    try {
      if (to === "pdf") {
        // 사용자가 LibreOffice를 열어 둔 상태여도 충돌하지 않도록 별도 프로필을 쓴다
        await run("soffice", [
          `-env:UserInstallation=file://${join(cacheDir, "lo-profile")}`,
          "--headless", "--convert-to", "pdf", "--outdir", tmp, src,
        ], { timeout: 120_000, env: { ...process.env, FONTCONFIG_FILE: fontconfigFile(cacheDir) } });
        renameSync(join(tmp, "source.pdf"), out);
      } else {
        const target = join(tmp, "out.svg");
        await run("drawio", ["-x", "-f", "svg", "-o", target, src], { timeout: 120_000 });
        renameSync(target, out);
      }
      return out;
    } catch (e) {
      throw new StoreError(500, `변환 실패: ${(e as Error).message.split("\n")[0]}`);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
}
