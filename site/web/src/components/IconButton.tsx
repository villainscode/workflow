import type { ButtonHTMLAttributes } from "react";
import type { LucideIcon } from "lucide-react";

type Variant = "ghost" | "outline" | "primary";

const VARIANT: Record<Variant, string> = {
  ghost: "text-muted hover:bg-sunken hover:text-fg",
  outline: "border border-line text-muted hover:bg-sunken hover:text-fg",
  primary: "bg-accent text-surface hover:opacity-90",
};

/**
 * 아이콘 버튼(Lucide). 글자 대신 아이콘을 쓰므로 label은 화면 낭독기 이름(aria-label)과 마우스를 올렸을 때의 툴팁(data-tip, Tooltip.tsx)으로 쓴다.
 * text를 주면 아이콘 옆에 글자도 같이 보여주고, 글자와 label이 같으면 툴팁은 띄우지 않는다.
 */
export function IconButton({
  icon: Icon, label, text, variant = "ghost", active, size = 20, className = "", type = "button", ...rest
}: {
  icon: LucideIcon; label: string; text?: string; variant?: Variant; active?: boolean; size?: number;
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type={type}
      aria-label={text ? undefined : label}
      data-tip={text === label ? undefined : label}
      className={`inline-flex shrink-0 items-center justify-center gap-1.5 rounded-md disabled:pointer-events-none disabled:opacity-30 ${
        text ? "px-2.5 py-1 text-xs font-medium" : "p-1.5"
      } ${active ? "bg-accent-soft text-accent" : VARIANT[variant]} ${className}`}
      {...rest}
    >
      <Icon size={size} aria-hidden strokeWidth={2} />
      {text}
    </button>
  );
}
