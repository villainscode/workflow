import { useQuery } from "@tanstack/react-query";
import { API } from "./base.ts";

/**
 * 편집기 설정(6.0 V4·VO): draw.io 편집기 출처(자체 호스팅, D-57)와 오피스 편집기(D-59)를 쓸 수 있는지. 없으면 버튼을 숨긴다.
 * Cloudflare는 Worker 환경값 DRAWIO_ORIGIN, 로컬은 서버 환경값 DRAWIO_ORIGIN(apps/drawio의 npm run serve 주소).
 */
export function useEditorConfig() {
  return useQuery({
    queryKey: ["editor-config"],
    staleTime: Infinity,
    queryFn: async () => {
      const res = await fetch(`${API}/editor-config`);
      if (!res.ok) return { drawio: null, office: false };
      return (await res.json()) as { drawio: string | null; office?: boolean };
    },
  }).data ?? { drawio: null, office: false };
}
