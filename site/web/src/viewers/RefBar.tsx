import { Crosshair, Link2, X } from "lucide-react";
import { IconButton } from "../components/IconButton.tsx";
import { formatSeg } from "../lib/seg.ts";

/** 참조 보기 상단 막대. 강조 중이면 위치와 "원래 보기로", 복사 모드면 사용법과 마지막 복사 결과 */
export function RefBar({ mode, highlight, copied, onExit }: {
  mode: "highlight" | "copy"; highlight: number[]; copied: string; onExit: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-line bg-accent-soft px-4 py-1.5 text-xs">
      {mode === "copy" ? <Link2 size={18} className="text-accent" aria-hidden /> : <Crosshair size={18} className="text-accent" aria-hidden />}
      {mode === "copy" ? (
        <>
          <span className="text-sm font-medium text-accent">참조 복사</span>
          <span className="text-muted">글자를 누르면 그 조각 주소를 복사합니다 · Alt+클릭은 감싸는 문단(블록) 전체 · Claude Code에 붙여 넣어 수정을 요청하세요</span>
        </>
      ) : (
        <>
          <span className="text-sm font-medium text-accent">참조 위치 [{formatSeg(highlight)}]</span>
          <span className="text-muted">스크립트 없이 보여 주는 화면입니다</span>
        </>
      )}
      {copied && <span role="status" className="min-w-0 truncate rounded-full bg-surface px-2 py-0.5 text-ok">복사함: {copied}</span>}
      <IconButton icon={X} label={mode === "copy" ? "참조 복사 끝내기" : "원래 보기로"} text={mode === "copy" ? undefined : "원래 보기로"}
        className="ml-auto" onClick={onExit} />
    </div>
  );
}
