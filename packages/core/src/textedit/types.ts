import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";

/**
 * 텍스트 편집(2.0)의 공통 모델. 형식마다 어댑터가 원본에서 "텍스트 조각"을 뽑고,
 * 바뀐 조각의 원본 구간만 교체해 새 파일을 만든다. 구조·서식·속성은 건드리지 않는다.
 */

export interface Segment {
  /** 같은 파일을 같은 방식으로 뽑으면 항상 같은 id (뽑은 순서) */
  id: number;
  /** 화면에 보여 줄 글자(엔티티를 푼 값) */
  text: string;
  /** 원래 글자의 해시. 저장할 때 그사이 파일이 바뀌지 않았는지 확인한다 */
  hash: string;
  /** 줄바꿈을 넣을 수 있는가(HTML pre 안, D-22) */
  multiline: boolean;
  /** 화면 묶음 표시용: HTML은 부모 태그, DOCX는 문단·표 칸, PPTX는 슬라이드·도형 */
  group: string;
  /** HTML의 SVG 다이어그램 글자(그 자리 편집 대신 입력창으로 고친다, D-20) */
  svg?: boolean;
  /** DOCX·PPTX 조각의 서식 힌트(굵게 b · 기울임 i · 밑줄 u). 목록 편집기에서 원래 서식을 보여 주는 데만 쓴다 */
  fmt?: string;
}

export interface Change { id: number; hash: string; text: string }

export interface Adapter {
  extract(data: Uint8Array): Segment[];
  /** 바뀐 조각만 반영한 새 파일. 실제로 바뀐 글자가 없으면 원본을 그대로 돌려준다. warnings는 저장은 하되 알릴 것(SVG 글자 넘침 등) */
  apply(data: Uint8Array, changes: Change[]): { data: Uint8Array; changed: number; warnings?: string[] };
}

export const textHash = (t: string) => bytesToHex(sha256(utf8ToBytes(t))).slice(0, 16);

export class EditError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

/** 조각 목록과 변경 요청을 맞춰 보고, 실제로 바뀌는 것만 돌려준다 */
export function resolveChanges(segments: Segment[], changes: Change[]): Map<number, string> {
  const byId = new Map(segments.map((s) => [s.id, s]));
  const out = new Map<number, string>();
  for (const c of changes) {
    const seg = byId.get(c.id);
    if (!seg) throw new EditError(409, `텍스트 조각 ${c.id}을(를) 찾을 수 없습니다. 문서를 새로 불러오세요`);
    if (seg.hash !== c.hash) throw new EditError(409, "그사이 원본 문서가 바뀌었습니다. 문서를 새로 불러오세요");
    if (!seg.multiline && /[\r\n]/.test(c.text)) throw new EditError(400, `조각 ${c.id}에는 줄바꿈을 넣을 수 없습니다`);
    if (c.text !== seg.text) out.set(c.id, c.text);
  }
  return out;
}
