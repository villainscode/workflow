import { useText } from "../lib/api.ts";
import { EmptyState } from "../components/EmptyState.tsx";

/**
 * draw.io(.drawio) 보기 — Cloudflare(4.0 P7). 서버에서 SVG로 바꾸지 않고 draw.io 공식 뷰어(viewer.diagrams.net)로 그린다.
 * 다이어그램 XML은 주소 뒤 #R 조각에만 넣으므로 그 서버로 보내지지 않는다(브라우저 안에서만 쓰인다). 로컬 사이트는 drawio CLI로 SVG 변환.
 */
export function DrawioViewer({ url }: { url: string }) {
  const { data, error } = useText(url);
  if (error) return <EmptyState title="다이어그램을 읽지 못했습니다" body={String(error)} />;
  if (data === undefined) return <p className="p-4 text-sm text-muted">불러오는 중…</p>;
  const src = `https://viewer.diagrams.net/?lightbox=0&nav=1&layers=1&toolbar=zoom%20layers&highlight=2563eb#R${encodeURIComponent(data)}`;
  return <iframe title="draw.io 다이어그램" src={src} className="h-full w-full border-0 bg-white" sandbox="allow-scripts allow-same-origin allow-popups" />;
}
