import type { KeyboardEvent } from "react";

/** 한글 조합 중 Enter(isComposing, keyCode 229)로 폼이 제출되지 않게 한다. 폼의 onKeyDown에 건다 */
export function stopComposingEnter(e: KeyboardEvent) {
  if (e.key === "Enter" && (e.nativeEvent.isComposing || e.keyCode === 229)) e.preventDefault();
}
