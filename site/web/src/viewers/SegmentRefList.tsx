import { useEffect, useRef, useState } from "react";
import { Copy } from "lucide-react";
import { useSegments, type Segment } from "../lib/textedit.ts";
import { copyText, formatSeg, refUrl } from "../lib/seg.ts";
import { EmptyState } from "../components/EmptyState.tsx";
import { IconButton } from "../components/IconButton.tsx";
import { AREA_NAME, head, splitGroup, tail } from "./OfficeTextEditor.tsx";
import { RefBar } from "./RefBar.tsx";

const short = (t: string) => (t.length > 40 ? t.slice(0, 40) + "…" : t);

/**
 * DOCX·PPTX·XLSX 참조 보기(3.2). 편집기와 같은 문단 묶음의 읽기 전용 목록이다.
 * 줄마다 그 조각의 참조 주소를, 문단 번호 버튼은 그 문단 전체(범위)를 복사한다. ?seg= 조각은 강조하고 그 줄로 스크롤한다.
 */
export function SegmentRefList({ category, menu, doc, version, highlight, copy, onExit }: {
  category: string; menu: string; doc: string; version: string; highlight: number[]; copy: boolean; onExit: () => void;
}) {
  const { data, error } = useSegments(menu, doc, version);
  const [copied, setCopied] = useState("");
  const first = useRef<HTMLSpanElement>(null);
  const hit = new Set(highlight);
  useEffect(() => { first.current?.scrollIntoView({ block: "center" }); }, [data, highlight.join(",")]);

  if (error) return <EmptyState title="텍스트를 불러올 수 없습니다" body={String(error)} />;
  if (!data) return <EmptyState title="불러오는 중…" />;

  const doCopy = (segs: Segment[]) => {
    const ids = segs.map((s) => s.id);
    void copyText(refUrl(category, menu, doc, version, ids)).then((ok) =>
      setCopied(ok ? `[${formatSeg(ids)}] ‘${short(segs.map((s) => s.text).join(""))}’` : "복사하지 못했습니다"));
  };

  const paras: { area: string; key: string; segs: Segment[] }[] = [];
  for (const seg of data.segments) {
    const { area, para } = splitGroup(seg.group);
    const last = paras[paras.length - 1];
    if (last && last.key === para) last.segs.push(seg);
    else paras.push({ area, key: para, segs: [seg] });
  }
  let firstSet = false;

  return (
    <div className="grid h-full grid-rows-[auto_minmax(0,1fr)]">
      <RefBar mode={copy ? "copy" : "highlight"} highlight={highlight} copied={copied} onExit={onExit} />
      <div className="min-h-0 overflow-y-auto bg-surface px-5 py-4">
        <div className="mx-auto max-w-4xl">
          {paras.map((p, i) => (
            <div key={p.key}>
              {(i === 0 || head(paras[i - 1].area) !== head(p.area)) && (
                <p className="mt-4 mb-1 border-b border-line pb-1 text-xs font-bold text-muted first:mt-0">{AREA_NAME(head(p.area))}</p>
              )}
              <div className="grid grid-cols-[120px_minmax(0,1fr)] gap-2 border-b border-line/60 py-1.5 text-sm leading-relaxed">
                <span className="flex items-start gap-1 pt-0.5 font-mono text-[11px] text-muted">
                  {copy && <IconButton icon={Copy} label="이 문단 전체 참조 복사" size={14} className="p-0.5" onClick={() => doCopy(p.segs)} />}
                  {tail(p.area) ?? `¶ ${p.key.split(" · 문단 ").pop()}`}
                </span>
                <p className="break-words">
                  {p.segs.map((seg) => {
                    const isHit = hit.has(seg.id);
                    const ref = isHit && !firstSet ? ((firstSet = true), first) : undefined;
                    return (
                      <span key={seg.id} ref={ref} data-seg={seg.id} data-ref-hit={isHit ? "" : undefined}
                        className={`rounded-sm ${isHit ? "bg-med-soft text-med" : ""} ${copy ? "cursor-copy hover:bg-accent-soft hover:outline hover:outline-1 hover:outline-accent" : ""}`}
                        onClick={copy ? () => doCopy([seg]) : undefined}
                        data-tip={copy ? `[${seg.id}] 참조 복사` : undefined}>
                        {seg.text}
                      </span>
                    );
                  })}
                </p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
