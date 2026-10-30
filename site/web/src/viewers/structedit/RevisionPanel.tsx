import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Bot, GitCompare, RotateCcw, User } from "lucide-react";
import { versionLabel } from "../../lib/api.ts";
import { listRevisions } from "../../lib/structedit.ts";
import { IconButton } from "../../components/IconButton.tsx";
import { RevisionDiff } from "./RevisionDiff.tsx";

const SOURCE: Record<string, string> = { human: "사람", agent: "에이전트", office: "오피스", restore: "되돌림" };
const time = (iso: string) => new Date(iso).toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

/** 수정본 이력(최신 먼저). 고르면 그 내용으로 새 수정본을 만든다. 맨 아래는 작업본이 기준으로 삼는 버전(rev 0) */
export function RevisionPanel({ menu, doc, current, busy, onRestore }: {
  menu: string; doc: string; current: number; busy: boolean; onRestore: (rev: number) => void;
}) {
  const { data, error } = useQuery({ queryKey: ["revisions", menu, doc], queryFn: () => listRevisions(menu, doc) });
  const [compare, setCompare] = useState<number | null>(null);
  const list = data?.revisions ?? [];
  const base = list.find((r) => r.rev === current)?.baseVersion;

  return (
    <aside className="min-h-0 overflow-y-auto border-l border-line bg-surface" aria-label="수정본 이력">
      <h2 className="sticky top-0 border-b border-line bg-surface px-3 py-2 text-xs font-semibold text-muted">수정본 이력</h2>
      {error && <p className="px-3 py-2 text-xs text-crit">{String((error as Error).message)}</p>}
      <ol>
        {list.map((r) => (
          <li key={r.rev} className={`flex items-start gap-2 border-b border-line px-3 py-2 ${r.rev === current ? "bg-accent-soft" : ""}`}>
            {r.source === "agent" ? <Bot size={16} className="mt-0.5 shrink-0 text-muted" aria-label="에이전트" />
              : <User size={16} className="mt-0.5 shrink-0 text-muted" aria-label={SOURCE[r.source] ?? r.source} />}
            <div className="min-w-0 flex-1">
              <p className="flex items-baseline gap-1.5 text-xs">
                <span className="font-mono font-medium">r{r.rev}</span>
                {r.rev === current && <span className="text-accent">지금</span>}
                {r.publishedAs && <span className="rounded bg-ok-soft px-1 text-ok">{versionLabel(r.publishedAs)}</span>}
                <span className="ml-auto shrink-0 text-muted">{time(r.createdAt)}</span>
              </p>
              <p className="truncate text-xs">{r.summary ?? SOURCE[r.source]}</p>
              {r.author && <p className="truncate text-[11px] text-muted">{r.author}</p>}
            </div>
            {r.rev !== current && (
              <div className="flex shrink-0 flex-col">
                <IconButton icon={GitCompare} label={`r${r.rev}과 지금 비교`} size={16} onClick={() => setCompare(r.rev)} />
                <IconButton icon={RotateCcw} label={`r${r.rev}(으)로 되돌리기`} size={16} disabled={busy} onClick={() => onRestore(r.rev)} />
              </div>
            )}
          </li>
        ))}
        {current > 0 && base && (
          <li className="flex items-center gap-2 px-3 py-2 text-xs">
            <span className="flex-1 text-muted">{versionLabel(base)} 원래 내용</span>
            <IconButton icon={RotateCcw} label={`${versionLabel(base)} 내용으로 되돌리기`} size={16} disabled={busy} onClick={() => onRestore(0)} />
          </li>
        )}
        {list.length === 0 && !error && <li className="px-3 py-3 text-xs text-muted">아직 수정본이 없습니다.</li>}
      </ol>
      {compare !== null && <RevisionDiff menu={menu} doc={doc} rev={compare} current={current} onClose={() => setCompare(null)} />}
    </aside>
  );
}
