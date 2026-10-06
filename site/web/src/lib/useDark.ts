import { useSyncExternalStore } from "react";

const query = "(prefers-color-scheme: dark)";

/** 사이트의 다크 모드 여부. data-theme가 있으면 그것을, 없으면 시스템 설정을 따른다. */
export function useDark(): boolean {
  return useSyncExternalStore(
    (cb) => { const m = matchMedia(query); m.addEventListener("change", cb); return () => m.removeEventListener("change", cb); },
    () => {
      const t = document.documentElement.dataset.theme;
      return t ? t === "dark" : matchMedia(query).matches;
    },
  );
}
