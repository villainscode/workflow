import { useEffect, useRef, useState } from "react";
import { Search } from "lucide-react";
import { useNavigate, useParams } from "react-router";
import { useSearch, type SearchHit } from "../lib/manage.ts";
import { versionLabel } from "../lib/api.ts";
import { StatusBadge } from "./StatusBadge.tsx";

/** 검색어를 굵게 표시한다 */
function Highlight({ text, q }: { text: string; q: string }) {
  if (!q) return <>{text}</>;
  const parts = text.split(new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi"));
  return <>{parts.map((p, i) => (p.toLowerCase() === q.toLowerCase() ? <mark key={i} className="rounded bg-med-soft px-0.5 text-fg">{p}</mark> : p))}</>;
}

/** 상단 검색: 제목·메뉴·본문(최신 버전)을 부분 일치로 찾는다 */
export function SearchBox() {
  const { category } = useParams();
  const navigate = useNavigate();
  const [input, setInput] = useState("");
  const [q, setQ] = useState("");
  const [onlyHere, setOnlyHere] = useState(false);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const searchNow = () => { setQ(input.trim()); setOpen(true); inputRef.current?.focus(); };

  // 입력이 멈추면 검색한다
  useEffect(() => { const t = setTimeout(() => setQ(input.trim()), 200); return () => clearTimeout(t); }, [input]);
  useEffect(() => setActive(0), [q, onlyHere]);
  useEffect(() => {
    const away = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, []);

  const { data: hits, isFetching } = useSearch(q, onlyHere ? category : undefined);
  const go = (h: SearchHit) => { setOpen(false); navigate(`/${h.category}/${h.menuSlug}/${h.slug}`); };

  return (
    <div ref={box} className="relative order-last mb-2 w-full min-w-0 sm:order-none sm:mb-0 sm:ml-auto sm:max-w-72">
      <input
        ref={inputRef}
        type="search"
        className="w-full rounded-md border border-line bg-bg py-1.5 pr-9 pl-3 text-sm"
        placeholder="제목·본문 검색"
        value={input}
        onChange={(e) => { setInput(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          // 결과가 아직 없으면 Enter는 돋보기 버튼과 같이 바로 검색한다
          if (e.key === "Enter" && !hits?.length) return searchNow();
          if (!hits?.length) return;
          if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(a + 1, hits.length - 1)); }
          if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
          if (e.key === "Enter") go(hits[active]);
          if (e.key === "Escape") setOpen(false);
        }}
        aria-label="문서 검색"
      />
      <button
        type="button"
        className="absolute inset-y-0 right-0 flex w-9 items-center justify-center rounded-r-md text-muted hover:text-accent"
        onClick={searchNow}
        aria-label="검색"
        title="검색"
      >
        <Search size={20} aria-hidden />
      </button>
      {open && q && (
        <div className="absolute top-full right-0 z-30 mt-1 w-[min(520px,calc(100vw-24px))] rounded-lg border border-line bg-surface shadow-xl">
          <div className="flex items-center justify-between border-b border-line px-3 py-1.5 text-xs text-muted">
            <span>{isFetching ? "찾는 중…" : `${hits?.length ?? 0}건${hits?.length === 50 ? " (상위 50건)" : ""}`}</span>
            <label className="flex items-center gap-1">
              <input type="checkbox" checked={onlyHere} onChange={(e) => setOnlyHere(e.target.checked)} /> 현재 대분류만
            </label>
          </div>
          <ul className="max-h-[60dvh] overflow-y-auto">
            {hits?.map((h, i) => (
              <li key={`${h.menuSlug}/${h.slug}`}>
                <button
                  className={`grid w-full gap-0.5 px-3 py-2 text-left ${i === active ? "bg-accent-soft" : "hover:bg-sunken"}`}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => go(h)}
                >
                  <span className="flex items-center gap-2 text-sm font-medium">
                    <span className="min-w-0 flex-1 truncate"><Highlight text={h.title} q={q} /></span>
                    <StatusBadge status={h.status} label={versionLabel(h.currentVersion)} small />
                  </span>
                  <span className="font-mono text-[11px] text-muted">
                    {h.category} › {h.menuName} · {h.kind}{h.matches ? ` · 본문 ${h.matches}곳` : ""}
                  </span>
                  {h.snippet && <span className="line-clamp-2 text-xs text-muted"><Highlight text={h.snippet} q={q} /></span>}
                </button>
              </li>
            ))}
            {hits && hits.length === 0 && !isFetching && <li className="px-3 py-4 text-center text-sm text-muted">찾은 문서가 없습니다</li>}
          </ul>
        </div>
      )}
    </div>
  );
}
