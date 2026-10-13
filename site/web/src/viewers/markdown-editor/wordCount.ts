// MarkFlow 에디터에서 가져온 코드.
/**
 * Count words in a text string.
 * Handles English, Korean, mixed content, and markdown syntax.
 */
export function countWords(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).filter((w) => w.length > 0).length;
}
