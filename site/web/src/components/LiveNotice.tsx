import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { Bot, X } from "lucide-react";
import { versionLabel } from "../lib/api.ts";
import { formatSeg } from "../lib/seg.ts";
import type { LiveEvent } from "../lib/live.ts";
import { IconButton } from "./IconButton.tsx";

interface Notice { id: number; text: string; open?: string }

/**
 * Claude Code가 MCP로 저장했거나(changed, by=claude-code) 화면 이동을 요청하면(focus) 알림을 띄운다(3.4, D-29).
 * - 같은 문서를 보고 있으면 최신 버전으로 바꾸고 바뀐 조각을 참조 보기로 강조한다(?seg=)
 * - 다른 문서를 보고 있으면 이동하지 않고 알림의 "열기"로 간다
 * - focus는 요청한 문서·버전·조각으로 바로 이동한다
 */
export function useClaudeNotice() {
  const navigate = useNavigate();
  const location = useLocation();
  const path = useRef(location.pathname);
  path.current = location.pathname;
  const [notice, setNotice] = useState<Notice | null>(null);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 8000);
    return () => clearTimeout(t);
  }, [notice]);

  const onEvent = (e: LiveEvent) => {
    if (!e.category || !e.menu || !e.doc) return;
    const docPath = `/${e.category}/${e.menu}/${e.doc}`;
    const seg = e.type === "focus" ? e.seg : e.segs?.length ? formatSeg(e.segs) : undefined;
    const q = new URLSearchParams();
    if (e.type === "focus" && e.version) q.set("v", e.version);
    if (seg) q.set("seg", seg);
    const target = docPath + (q.size ? `?${q}` : "");
    const title = `‘${e.title ?? e.doc}’`;

    if (e.type === "focus") {
      navigate(target);
      setNotice({ id: Date.now(), text: `Claude Code가 ${title}${seg ? ` [${seg}]` : ""}을(를) 가리켰습니다` });
      return;
    }
    if (e.by !== "claude-code") return;
    const v = versionLabel(e.version ?? "");
    const text = e.reason === "release" ? `Claude Code가 ${title} 문서를 ${v} 정식 버전으로 확정했습니다`
      : e.reason === "upload" && e.version === "v0.0" ? `Claude Code가 ${title} 문서를 새로 등록했습니다`
        : `Claude Code가 ${title} 문서를 ${v} 버전으로 저장했습니다`;
    if (path.current === docPath) {
      if (seg) navigate(target, { replace: true });
      setNotice({ id: Date.now(), text });
    } else {
      setNotice({ id: Date.now(), text, open: target });
    }
  };

  const view = notice && (
    <div role="status" key={notice.id}
      className="fixed right-4 bottom-4 z-50 flex max-w-[min(440px,calc(100vw-32px))] items-center gap-2 rounded-lg border border-line bg-surface px-3 py-2 text-sm shadow-xl">
      <Bot size={20} className="shrink-0 text-accent" aria-hidden />
      <span className="min-w-0">{notice.text}</span>
      {notice.open && (
        <button type="button" className="shrink-0 rounded-md bg-accent px-2.5 py-1 text-xs font-medium text-surface hover:opacity-90"
          onClick={() => { navigate(notice.open!); setNotice(null); }}>열기</button>
      )}
      <IconButton icon={X} label="알림 닫기" size={16} className="shrink-0 p-1" onClick={() => setNotice(null)} />
    </div>
  );
  return { onEvent, view };
}
