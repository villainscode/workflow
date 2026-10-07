const STYLE: Record<string, string> = {
  draft: "bg-sunken text-muted",
  review: "bg-med-soft text-med",
  approved: "bg-ok-soft text-ok",
};

const NAME: Record<string, string> = { draft: "작성 중(draft)", review: "검토 중(review)", approved: "정식(approved)" };

/** 상태 색 배지. label을 주면 글자는 label(예: 현재 버전 v1.0)을 보여주고, 상태는 색과 설명(title)으로 알린다. */
export function StatusBadge({ status, small, label }: { status: string; small?: boolean; label?: string }) {
  return (
    <span
      title={label ? `${label} · ${NAME[status] ?? status}` : NAME[status] ?? status}
      className={`shrink-0 rounded-full font-mono ${small ? "px-1.5 text-[10px] leading-5" : "px-2 text-xs leading-6"} ${
        STYLE[status] ?? STYLE.draft
      }`}
    >
      {label ?? status}
    </span>
  );
}
