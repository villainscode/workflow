import { useMemo, useState } from "react";
import { diffArrays, diffChars } from "diff";
import { versionLabel } from "../lib/api.ts";
import { useSegments, type Segment } from "../lib/textedit.ts";
import { EmptyState } from "../components/EmptyState.tsx";

/**
 * DOCX·PPTX 버전 비교(2.0, REQUIREMENT-2.0 2.5). 파일이 zip이라 줄 비교 대신 텍스트 조각 목록끼리 비교한다.
 * 조각을 "위치(group)+글자" 순서로 맞추고, 같은 자리에서 글자만 달라진 조각은 이전 → 이후 한 쌍으로 보여 준다.
 */

type Row =
  | { kind: "same"; seg: Segment }
  | { kind: "changed"; from: Segment; to: Segment }
  | { kind: "added"; seg: Segment }
  | { kind: "removed"; seg: Segment };

const key = (s: Segment) => `${s.group}\u0000${s.text}`;

function compare(a: Segment[], b: Segment[]): Row[] {
  const rows: Row[] = [];
  let ai = 0, bi = 0;
  const parts = diffArrays(a.map(key), b.map(key));
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    const n = p.count ?? p.value.length;
    if (!p.added && !p.removed) {
      for (let k = 0; k < n; k++) rows.push({ kind: "same", seg: b[bi + k] });
      ai += n; bi += n;
      continue;
    }
    // 삭제 바로 뒤의 추가는 같은 자리끼리 짝지어 "바뀜"으로 본다(위치가 같으면 글자만 고친 것)
    const next = parts[i + 1];
    if (p.removed && next?.added) {
      const m = next.count ?? next.value.length;
      const removed = a.slice(ai, ai + n), added = b.slice(bi, bi + m);
      const paired = new Set<number>();
      for (const r of removed) {
        const j = added.findIndex((x, idx) => !paired.has(idx) && x.group === r.group);
        if (j >= 0) { paired.add(j); rows.push({ kind: "changed", from: r, to: added[j] }); }
        else rows.push({ kind: "removed", seg: r });
      }
      added.forEach((x, idx) => { if (!paired.has(idx)) rows.push({ kind: "added", seg: x }); });
      ai += n; bi += m; i++;
      continue;
    }
    if (p.removed) { a.slice(ai, ai + n).forEach((seg) => rows.push({ kind: "removed", seg })); ai += n; }
    else { b.slice(bi, bi + n).forEach((seg) => rows.push({ kind: "added", seg })); bi += n; }
  }
  return rows;
}

/**
 * 바뀐 쌍 안에서 글자 단위로 달라진 부분을 강조한다.
 * 공통 글자가 절반에 못 미치면(거의 새로 쓴 글자) 글자 단위 강조가 뒤섞여 읽기 어려우므로 "이전 → 이후"로 통째로 보여 준다.
 */
function CharDiff({ from, to }: { from: string; to: string }) {
  const whole = <><del className="rounded-sm bg-crit-soft text-crit">{from}</del> <span className="text-muted">→</span> <ins className="rounded-sm bg-ok-soft text-ok no-underline">{to}</ins></>;
  if (from.length + to.length > 2000) return whole;
  const parts = diffChars(from, to);
  const common = parts.filter((p) => !p.added && !p.removed).reduce((n, p) => n + p.value.length, 0);
  if (common < Math.max(from.length, to.length) * 0.5) return whole;
  return (
    <>
      {parts.map((p, i) =>
        p.added ? <ins key={i} className="rounded-sm bg-ok-soft text-ok no-underline">{p.value}</ins>
          : p.removed ? <del key={i} className="rounded-sm bg-crit-soft text-crit">{p.value}</del>
            : <span key={i}>{p.value}</span>)}
    </>
  );
}

const place = (group: string) => group.replace(/^document · /, "").replace(/^document$/, "본문").replace(/ · 문단 \d+$/, "");

export function SegmentDiffViewer({ menu, doc, fromVersion, toVersion }: { menu: string; doc: string; fromVersion: string; toVersion: string }) {
  const a = useSegments(menu, doc, fromVersion);
  const b = useSegments(menu, doc, toVersion);
  const [all, setAll] = useState(false);
  const rows = useMemo(() => (a.data && b.data ? compare(a.data.segments, b.data.segments) : []), [a.data, b.data]);

  if (a.error || b.error) return <EmptyState title="비교할 수 없습니다" body={String(a.error ?? b.error)} />;
  if (!a.data || !b.data) return <EmptyState title="불러오는 중…" />;
  if (a.data.format !== b.data.format) return <EmptyState title="형식이 달라 비교할 수 없습니다" body={`${a.data.entry} ↔ ${b.data.entry}`} />;

  const count = (k: Row["kind"]) => rows.filter((r) => r.kind === k).length;
  const shown = all ? rows : rows.filter((r) => r.kind !== "same");

  return (
    <div className="h-full overflow-y-auto p-4">
      <div className="mb-3 flex flex-wrap items-center gap-3 text-xs">
        <span className="font-mono text-muted">{versionLabel(fromVersion)} → {versionLabel(toVersion)}</span>
        <span className="rounded-full bg-med-soft px-2 text-med">바뀜 {count("changed")}</span>
        <span className="rounded-full bg-ok-soft px-2 text-ok">추가 {count("added")}</span>
        <span className="rounded-full bg-crit-soft px-2 text-crit">삭제 {count("removed")}</span>
        <label className="ml-auto flex items-center gap-1.5 text-muted">
          <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> 바뀌지 않은 텍스트도 보기
        </label>
      </div>
      {shown.length === 0 ? (
        <EmptyState title="텍스트가 같습니다" body="두 버전의 글자가 모두 같습니다(서식·그림 등 텍스트 밖의 차이는 여기서 보이지 않습니다)." />
      ) : (
        <ul className="grid gap-1 rounded-lg border border-line bg-surface p-2 text-sm">
          {shown.map((r, i) => {
            const seg = r.kind === "changed" ? r.to : r.seg;
            return (
              <li key={i} className={`grid grid-cols-[140px_minmax(0,1fr)] gap-3 rounded-md px-2 py-1.5 ${
                r.kind === "changed" ? "bg-med-soft/40" : r.kind === "added" ? "bg-ok-soft/50" : r.kind === "removed" ? "bg-crit-soft/50" : ""}`}>
                <span className="pt-0.5 font-mono text-[11px] text-muted">{place(seg.group)}</span>
                <span className="break-words">
                  {r.kind === "changed" ? <CharDiff from={r.from.text} to={r.to.text} />
                    : r.kind === "added" ? <ins className="text-ok no-underline">+ {r.seg.text}</ins>
                      : r.kind === "removed" ? <del className="text-crit">− {r.seg.text}</del>
                        : <span className="text-muted">{r.seg.text}</span>}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
