/**
 * 쓴 글자만 남긴 부분 글꼴(5.0 M6). harfbuzz(hb-subset, harfbuzzjs의 harfbuzz-subset.wasm)로 자른다.
 * pdf-lib의 자체 부분 글꼴(fontkit)은 한글 글리프가 빠진다(M0 확인). 글리프 번호를 그대로 두어야(RETAIN_GIDS)
 * fontkit이 잘린 글꼴을 읽는다. wasm은 부르는 쪽이 준다(브라우저는 fetch, 테스트는 파일).
 */

export interface HbSubset {
  memory: WebAssembly.Memory;
  malloc(n: number): number;
  free(p: number): void;
  hb_blob_create(data: number, len: number, mode: number, user: number, destroy: number): number;
  hb_blob_destroy(b: number): void;
  hb_blob_get_data(b: number, len: number): number;
  hb_blob_get_length(b: number): number;
  hb_face_create(blob: number, index: number): number;
  hb_face_destroy(f: number): void;
  hb_face_reference_blob(f: number): number;
  hb_set_add(set: number, cp: number): void;
  hb_subset_input_create_or_fail(): number;
  hb_subset_input_destroy(i: number): void;
  hb_subset_input_unicode_set(i: number): number;
  hb_subset_input_set_flags(i: number, flags: number): void;
  hb_subset_or_fail(face: number, input: number): number;
}

const NO_HINTING = 1, RETAIN_GIDS = 2;

export async function loadHbSubset(wasm: BufferSource | WebAssembly.Module): Promise<HbSubset> {
  const instance = wasm instanceof WebAssembly.Module ? await WebAssembly.instantiate(wasm) : (await WebAssembly.instantiate(wasm)).instance;
  return instance.exports as unknown as HbSubset;
}

/** font(TTF)에서 text에 쓰인 글자(와 공백)만 남긴 TTF */
export function subsetFont(hb: HbSubset, font: Uint8Array, text: string): Uint8Array {
  const heap = () => new Uint8Array(hb.memory.buffer);
  const ptr = hb.malloc(font.byteLength);
  heap().set(font, ptr);
  const blob = hb.hb_blob_create(ptr, font.byteLength, 2, 0, 0);
  const face = hb.hb_face_create(blob, 0);
  hb.hb_blob_destroy(blob);
  const input = hb.hb_subset_input_create_or_fail();
  try {
    if (!input) throw new Error("글꼴 자르기를 시작하지 못했습니다");
    const set = hb.hb_subset_input_unicode_set(input);
    for (const ch of new Set([...text, " "])) hb.hb_set_add(set, ch.codePointAt(0)!);
    hb.hb_subset_input_set_flags(input, NO_HINTING | RETAIN_GIDS);
    const sub = hb.hb_subset_or_fail(face, input);
    if (!sub) throw new Error("글꼴을 자르지 못했습니다");
    const rb = hb.hb_face_reference_blob(sub);
    const off = hb.hb_blob_get_data(rb, 0), len = hb.hb_blob_get_length(rb);
    const out = heap().slice(off, off + len);
    hb.hb_blob_destroy(rb);
    hb.hb_face_destroy(sub);
    return out;
  } finally {
    if (input) hb.hb_subset_input_destroy(input);
    hb.hb_face_destroy(face);
    hb.free(ptr);
  }
}
