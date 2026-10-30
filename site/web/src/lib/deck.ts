import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { loadSlide, parseDeckIndex, slidePath, type DeckIndex, type Slide } from "@workflow/core/slide";
import { fileSrc, useDoc } from "./api.ts";
import { API, CLOUD } from "./base.ts";

/**
 * 슬라이드 덱(5.0 M4) 화면 공통: 버전 파일에서 덱 읽기, asset: 그림 주소 풀기, 덱 글꼴 넣기.
 * 덱은 deck.json(색인) + slides/<id>.html. 보기는 버전 파일을 읽고(로컬·Cloudflare 같음), 편집은 작업본 API를 쓴다.
 */

export interface Deck { index: DeckIndex; slides: Slide[] }

/** 버전 파일로 덱 읽기 */
export function useDeckVersion(menu: string, doc: string, version: string) {
  const { data } = useDoc(menu, doc);
  const files = data?.versions.find((v) => v.version === version)?.files;
  return useQuery({
    queryKey: ["deck-version", menu, doc, version, files?.map((f) => f.sha256).join()],
    enabled: !!files,
    staleTime: Infinity,
    queryFn: async (): Promise<Deck> => {
      const get = async (path: string) => {
        const f = files!.find((x) => x.path === path);
        if (!f) throw new Error(`${path} 파일이 없습니다`);
        return (await fetch(fileSrc(f))).text();
      };
      const { index, diagnostics } = parseDeckIndex(await get("deck.json"));
      if (!index) throw new Error(diagnostics[0]?.message ?? "deck.json을 읽을 수 없습니다");
      const slides = await Promise.all(index.order.map(async (id) => loadSlide(await get(slidePath(id)))));
      return { index, slides };
    },
  });
}

/**
 * asset:<sha> → 그릴 주소. Cloudflare는 서명 주소(12~24시간)를 받아 쓰고 10분마다 새로 받는다(주소를 문서에 넣지 않는다).
 * 로컬 사이트에는 자산 저장소가 없어 null(화면은 자리만 그린다)
 */
export function useAssetUrl(src: string | undefined) {
  const sha = src?.startsWith("asset:") ? src.slice(6) : null;
  const q = useQuery({
    queryKey: ["asset-url", sha],
    enabled: CLOUD && !!sha,
    staleTime: 10 * 60_000,
    queryFn: async () => {
      const res = await fetch(`${API}/assets/${sha}/url`);
      if (!res.ok) throw new Error(`${res.status}`);
      return ((await res.json()) as { url: string }).url;
    },
  });
  return q.data ?? null;
}

/** 덱 글꼴(Google Fonts 링크)을 head에 넣는다. 같은 링크는 한 번만 */
export function useDeckFonts(index: DeckIndex | undefined) {
  useEffect(() => {
    for (const f of Object.values(index?.faces ?? {})) {
      if (document.head.querySelector(`link[data-deck-font="${CSS.escape(f.href)}"]`)) continue;
      const l = document.createElement("link");
      l.rel = "stylesheet";
      l.href = f.href;
      l.dataset.deckFont = f.href;
      document.head.appendChild(l);
    }
  }, [index]);
}

/** 덱 기본 글꼴: faces의 첫 글꼴 */
export const deckFamily = (index: DeckIndex | undefined) => {
  const f = Object.values(index?.faces ?? {})[0];
  return f ? `"${f.family}", "IBM Plex Sans KR", sans-serif` : undefined;
};
