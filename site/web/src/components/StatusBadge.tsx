const STYLE: Record<string, string> = {
  draft: "bg-sunken text-muted",
  review: "bg-med-soft text-med",
  approved: "bg-ok-soft text-ok",
};

export function StatusBadge({ status, small }: { status: string; small?: boolean }) {
  return (
    <span
      className={`shrink-0 rounded-full font-mono ${small ? "px-1.5 text-[10px] leading-5" : "px-2 text-xs leading-6"} ${
        STYLE[status] ?? STYLE.draft
      }`}
    >
      {status}
    </span>
  );
}
