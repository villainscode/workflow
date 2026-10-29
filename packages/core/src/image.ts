/** 이미지 파일 머리 읽기(런타임 무관). 편집기 자산(Worker)과 OOXML 이미지 교체가 함께 쓴다 */

/** 이미지 머리에서 가로·세로를 읽는다(PNG·GIF·JPEG·WebP). 못 읽으면 null */
export function imageSize(b: Uint8Array): { width: number; height: number } | null {
  const u32 = (o: number) => (b[o] << 24 | b[o + 1] << 16 | b[o + 2] << 8 | b[o + 3]) >>> 0;
  const u16be = (o: number) => b[o] << 8 | b[o + 1];
  const u16le = (o: number) => b[o] | b[o + 1] << 8;
  const ascii = (o: number, n: number) => String.fromCharCode(...b.subarray(o, o + n));
  if (b.length > 24 && b[0] === 0x89 && ascii(1, 3) === "PNG") return { width: u32(16), height: u32(20) };
  if (b.length > 10 && ascii(0, 3) === "GIF") return { width: u16le(6), height: u16le(8) };
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    for (let o = 2; o + 9 < b.length;) {
      if (b[o] !== 0xff) { o++; continue; }
      const marker = b[o + 1];
      const len = u16be(o + 2);
      // SOF0~SOF15(DHT·JPG·DAC 제외)에 크기가 있다
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { height: u16be(o + 5), width: u16be(o + 7) };
      o += 2 + len;
    }
    return null;
  }
  if (b.length > 30 && ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") {
    const kind = ascii(12, 4);
    if (kind === "VP8X") return { width: 1 + (b[24] | b[25] << 8 | b[26] << 16), height: 1 + (b[27] | b[28] << 8 | b[29] << 16) };
    if (kind === "VP8 ") return { width: u16le(26) & 0x3fff, height: u16le(28) & 0x3fff };
    if (kind === "VP8L") {
      const v = b[21] | b[22] << 8 | b[23] << 16 | b[24] << 24;
      return { width: 1 + (v & 0x3fff), height: 1 + ((v >> 14) & 0x3fff) };
    }
  }
  return null;
}
