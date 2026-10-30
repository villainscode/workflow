import hbWasmUrl from "harfbuzzjs/dist/harfbuzz-subset.wasm?url";
import { applyPdfOps, loadHbSubset, subsetFont, type HbSubset, type PdfOp } from "@workflow/core/pdfedit";
import { API } from "./base.ts";
import { SaveConflict } from "./structedit.ts";

/**
 * PDF 편집(5.0 M6, Cloudflare). 연산은 브라우저에서 pdf-lib로 적용하고(한글은 쓴 글자만 자른 나눔고딕), 결과 PDF를 수정본으로 올린다.
 * 글꼴(2MB)과 harfbuzz wasm은 글자를 쓸 때 처음 한 번만 받는다.
 */

const FONT_URL = "/fonts/NanumGothic-Regular.ttf";
let hb: Promise<HbSubset> | null = null;
let font: Promise<Uint8Array> | null = null;

async function subsetFor(text: string) {
  hb ??= fetch(hbWasmUrl).then((r) => r.arrayBuffer()).then(loadHbSubset);
  font ??= fetch(FONT_URL).then((r) => { if (!r.ok) throw new Error("글꼴을 받지 못했습니다"); return r.arrayBuffer(); }).then((b) => new Uint8Array(b));
  return subsetFont(await hb, await font, text);
}

export const applyPdf = (data: Uint8Array, ops: PdfOp[]) => applyPdfOps(data, ops, { font: subsetFor });

/** 큰 파일도 스택을 넘지 않게 나눠서 base64로 */
function toBase64(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}

/** 작업본 파일 하나를 바꾼 수정본 저장(기준 rev가 다르면 SaveConflict) */
export async function saveWorkFile(menu: string, doc: string, baseRev: number, path: string, data: Uint8Array, summary: string) {
  const res = await fetch(`${API}/docs/${menu}/${doc}/revisions`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ baseRev, put: [{ path, base64: toBase64(data) }], summary }),
  });
  const body = (await res.json().catch(() => ({}))) as { error?: string; rev: number; changed: boolean };
  if (res.status === 409) throw new SaveConflict(body.error ?? "다른 곳에서 먼저 저장했습니다");
  if (!res.ok) throw new Error(body.error ?? `${res.status} 오류`);
  return body;
}

/** 그림 파일 → PDF에 넣을 PNG·JPEG(WebP·GIF는 PNG로 바꾼다) */
export async function imageForPdf(file: File): Promise<{ data: Uint8Array; mime: string; width: number; height: number }> {
  const bmp = await createImageBitmap(file);
  const size = { width: bmp.width, height: bmp.height };
  if (file.type === "image/png" || file.type === "image/jpeg") return { data: new Uint8Array(await file.arrayBuffer()), mime: file.type, ...size };
  const c = new OffscreenCanvas(bmp.width, bmp.height);
  c.getContext("2d")!.drawImage(bmp, 0, 0);
  return { data: new Uint8Array(await (await c.convertToBlob({ type: "image/png" })).arrayBuffer()), mime: "image/png", ...size };
}
