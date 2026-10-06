// 저장 전 작성 내용을 브라우저에 임시 보관한다. 시크릿 창 등에서는 저장소가 막힐 수 있어 실패해도 무시한다.
const key = (id: string) => `workflow:draft:${id}`;

export function loadDraft(id: string): string | null {
  try { return localStorage.getItem(key(id)); } catch { return null; }
}
export function saveDraft(id: string, text: string) {
  try { localStorage.setItem(key(id), text); } catch { /* 보관 실패는 무시 */ }
}
export function clearDraft(id: string) {
  try { localStorage.removeItem(key(id)); } catch { /* 무시 */ }
}
