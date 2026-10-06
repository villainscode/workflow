import { diffLines } from "diff";
import { useText, fileSrc, type VersionFile } from "../lib/api.ts";
import { EmptyState } from "../components/EmptyState.tsx";

/** 두 버전의 대표 파일을 줄 단위로 비교한다. 바뀌지 않은 긴 구간은 접어서 보여준다. */
export function DiffViewer({ from, to, fromLabel, toLabel }: { from: VersionFile; to: VersionFile; fromLabel: string; toLabel: string }) {
  const a = useText(fileSrc(from));
  const b = useText(fileSrc(to));
  if (a.data === undefined || b.data === undefined) return <EmptyState title="불러오는 중…" />;

  const parts = diffLines(a.data, b.data);
  const added = parts.filter((p) => p.added).reduce((n, p) => n + (p.count ?? 0), 0);
  const removed = parts.filter((p) => p.removed).reduce((n, p) => n + (p.count ?? 0), 0);

  return (
    <div className="h-full overflow-y-auto p-4">
      <p className="mb-2 font-mono text-xs text-muted">
        {fromLabel} → {toLabel} · <span className="text-ok">+{added}</span> <span className="text-high">−{removed}</span>
        {added + removed === 0 && " · 대표 파일 내용이 같습니다"}
      </p>
      <div className="rounded-lg border border-line bg-surface font-mono text-[12.5px] leading-relaxed">
        {parts.map((p, i) => {
          const lines = p.value.replace(/\n$/, "").split("\n");
          if (!p.added && !p.removed && lines.length > 8) {
            return (
              <details key={i} className="border-y border-line bg-sunken/60 text-muted">
                <summary className="cursor-pointer px-3 py-1 text-xs">변경 없는 {lines.length}줄</summary>
                {lines.map((l, j) => <div key={j} className="px-3 whitespace-pre-wrap break-all">  {l}</div>)}
              </details>
            );
          }
          const cls = p.added ? "bg-ok-soft text-ok" : p.removed ? "bg-high-soft text-high" : "";
          const sign = p.added ? "+ " : p.removed ? "− " : "  ";
          return lines.map((l, j) => (
            <div key={`${i}-${j}`} className={`px-3 whitespace-pre-wrap break-all ${cls}`}>{sign}{l}</div>
          ));
        })}
      </div>
    </div>
  );
}
