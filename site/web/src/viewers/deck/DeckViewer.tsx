import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { deckFamily, useDeckFonts, useDeckVersion, type Deck } from "../../lib/deck.ts";
import { EmptyState } from "../../components/EmptyState.tsx";
import { IconButton } from "../../components/IconButton.tsx";
import { SlideCanvas, SlideRenderer } from "./SlideRenderer.tsx";

/** 덱 보기(버전 파일): 왼쪽 슬라이드 목록, 가운데 슬라이드(창에 맞춤), 아래 발표자 노트. ←→로 넘긴다 */
export function DeckViewer({ menu, doc, version }: { menu: string; doc: string; version: string }) {
  const { data, error } = useDeckVersion(menu, doc, version);
  const [cur, setCur] = useState(0);
  useDeckFonts(data?.index);
  if (error) return <EmptyState title="덱을 열 수 없습니다" body={String((error as Error).message)} />;
  if (!data) return <EmptyState title="불러오는 중…" />;
  return <DeckLayout deck={data} cur={Math.min(cur, data.slides.length - 1)} setCur={setCur} />;
}

export function DeckLayout({ deck, cur, setCur }: { deck: Deck; cur: number; setCur: (n: number) => void }) {
  const family = deckFamily(deck.index);
  const n = deck.slides.length;
  const go = (d: number) => setCur(Math.max(0, Math.min(n - 1, cur + d)));
  const slide = deck.slides[cur];
  return (
    <div className="grid h-full grid-cols-[13rem_minmax(0,1fr)] outline-none focus-visible:ring-2 focus-visible:ring-accent" tabIndex={0} aria-label="슬라이드 덱"
      onKeyDown={(e) => {
        if (e.key === "ArrowRight" || e.key === "PageDown") { e.preventDefault(); go(1); }
        if (e.key === "ArrowLeft" || e.key === "PageUp") { e.preventDefault(); go(-1); }
      }}>
      <ol className="min-h-0 space-y-2 overflow-y-auto border-r border-line bg-surface p-2" aria-label="슬라이드 목록">
        {deck.slides.map((s, i) => (
          <li key={s.id}>
            <button type="button" onClick={() => setCur(i)} aria-current={i === cur ? "true" : undefined} aria-label={`${i + 1}번 슬라이드`}
              className={`flex w-full items-start gap-1.5 rounded-md p-1 text-left ${i === cur ? "bg-accent-soft" : "hover:bg-sunken"}`}>
              <span className="w-4 shrink-0 pt-0.5 text-right font-mono text-[11px] text-muted">{i + 1}</span>
              <span className={`block overflow-hidden rounded border ${i === cur ? "border-accent" : "border-line"}`}>
                <SlideCanvas width={160}><SlideRenderer slide={s} family={family} /></SlideCanvas>
              </span>
            </button>
          </li>
        ))}
      </ol>
      <div className="flex min-h-0 flex-col">
        <FitSlide>{(w) => <div className="shadow-sm ring-1 ring-line"><SlideCanvas width={w}><SlideRenderer slide={slide} family={family} /></SlideCanvas></div>}</FitSlide>
        <div className="flex items-center gap-2 border-t border-line bg-surface px-3 py-1.5">
          <IconButton icon={ChevronLeft} label="이전 슬라이드 (←)" disabled={cur === 0} onClick={() => go(-1)} />
          <span className="font-mono text-xs text-muted">{cur + 1} / {n}</span>
          <IconButton icon={ChevronRight} label="다음 슬라이드 (→)" disabled={cur === n - 1} onClick={() => go(1)} />
          <p className="min-w-0 flex-1 truncate text-xs text-muted" data-tip={slide.notes || undefined}>{slide.notes ? `노트: ${slide.notes}` : ""}</p>
        </div>
      </div>
    </div>
  );
}

/** 남은 자리에 16:9를 꽉 차게(가로·세로 중 작은 쪽에 맞춤) */
export function FitSlide({ children, pad = 24 }: { children: (width: number) => React.ReactNode; pad?: number }) {
  const box = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const fit = () => setW(Math.max(0, Math.min(el.clientWidth - pad * 2, ((el.clientHeight - pad * 2) * 16) / 9)));
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    fit();
    return () => ro.disconnect();
  }, [pad]);
  return <div ref={box} className="flex min-h-0 flex-1 items-center justify-center bg-bg">{w > 0 && children(Math.floor(w))}</div>;
}

/** 발표(전체 화면): 슬라이드 하나를 화면에 맞추고 ←→·스페이스·클릭으로 넘긴다 */
export function DeckShow({ menu, doc, version }: { menu: string; doc: string; version: string }) {
  const { data } = useDeckVersion(menu, doc, version);
  const [cur, setCur] = useState(0);
  useDeckFonts(data?.index);
  const n = data?.slides.length ?? 0;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (["ArrowRight", "PageDown", " "].includes(e.key)) { e.preventDefault(); setCur((c) => Math.min(n - 1, c + 1)); }
      if (["ArrowLeft", "PageUp"].includes(e.key)) { e.preventDefault(); setCur((c) => Math.max(0, c - 1)); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [n]);
  if (!data) return null;
  return (
    <div className="flex h-full flex-col bg-black" onClick={() => setCur((c) => Math.min(n - 1, c + 1))}>
      <FitSlide pad={0}>{(w) => <SlideCanvas width={w}><SlideRenderer slide={data.slides[cur]} family={deckFamily(data.index)} /></SlideCanvas>}</FitSlide>
      <p className="absolute bottom-3 left-4 font-mono text-xs text-white/70">{cur + 1} / {n}</p>
    </div>
  );
}
