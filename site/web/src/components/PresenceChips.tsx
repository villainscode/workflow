import { usePresence } from "../lib/live.ts";
import { useMe } from "../lib/me.ts";

/** 같은 문서를 보고 있거나 고치는 다른 사람(5.0 M7, Cloudflare). 고치는 사람은 테두리를 강조색으로 */
export function PresenceChips({ menu, doc }: { menu: string; doc: string }) {
  const me = useMe().me?.user?.id;
  const others = usePresence().filter((p) => p.menu === menu && p.doc === doc && p.userId !== me);
  if (!others.length) return null;
  return (
    <ul className="flex items-center -space-x-1.5" aria-label="같이 보는 사람">
      {others.map((p) => {
        const who = p.name || p.email;
        const what = p.mode === "edit" ? "편집 중" : "보는 중";
        return (
          <li key={p.userId} data-tip={`${who} · ${what}`} aria-label={`${who} ${what}`}
            className={`flex size-7 items-center justify-center rounded-full border-2 bg-surface text-xs font-semibold ${p.mode === "edit" ? "border-accent text-accent" : "border-line text-muted"}`}>
            {who.slice(0, 1).toUpperCase()}
          </li>
        );
      })}
    </ul>
  );
}
