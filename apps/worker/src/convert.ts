import { Container, getRandom } from "@cloudflare/containers";
import { HttpError, type Bindings } from "./env.ts";

/**
 * 변환(4.0 P7): PPTX·DOCX·XLSX → PDF는 LibreOffice 컨테이너(apps/converter)가 한다. 결과는 원본 sha256으로 R2에 캐시한다
 * (로컬 site/server/convert.ts의 캐시 규칙과 같다). draw.io는 화면이 draw.io 뷰어로 그린다(서버 변환 없음).
 */
export class Converter extends Container {
  defaultPort = 8080;
  sleepAfter = "5m";
  enableInternet = false;
}

const OFFICE = /\.(pptx?|docx?|odt|odp|xlsx?|ods)$/i;
const cacheKey = (wsId: number, sha: string) => `ws/${wsId}/cache/pdf/${sha}`;

/** PDF로 바꾼다(캐시가 있으면 그대로). 컨테이너가 없는 환경(무료 요금제·테스트)은 501 */
export async function toPdf(env: Bindings, wsId: number, data: Uint8Array | null, ext: string, sha: string): Promise<ReadableStream | ArrayBuffer> {
  const hit = await env.BLOBS.get(cacheKey(wsId, sha));
  if (hit) return hit.body;
  if (!OFFICE.test(ext)) throw new HttpError(400, `${ext} 파일은 PDF로 바꿀 수 없습니다`);
  if (!env.CONVERTER) throw new HttpError(501, "PDF 변환을 쓸 수 없는 환경입니다");
  if (!data) {
    const obj = await env.BLOBS.get(`ws/${wsId}/blobs/${sha}`);
    if (!obj) throw new HttpError(404, "파일 본문이 없습니다");
    data = new Uint8Array(await obj.arrayBuffer());
  }
  const box = await getRandom(env.CONVERTER as never, 2);
  const res = await box.fetch(new Request(`http://converter/convert?ext=${encodeURIComponent(ext)}`, { method: "POST", body: data }));
  if (!res.ok) throw new HttpError(502, `변환에 실패했습니다: ${(await res.text()).slice(0, 200)}`);
  const pdf = await res.arrayBuffer();
  await env.BLOBS.put(cacheKey(wsId, sha), pdf, { httpMetadata: { contentType: "application/pdf" } });
  return pdf;
}
