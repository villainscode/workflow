import { useEffect, useState } from "react";
import { ExternalLink, ShieldAlert, ShieldCheck } from "lucide-react";

// 외부 문서의 "스크립트 켜기"를 브라우저에 문서·버전별로 기억한다(D-27). 새 버전은 꺼진 상태로 시작한다
const key = (menu: string, doc: string, version: string) => `workflow:scripts:${menu}/${doc}@${version}`;
const read = (k: string) => { try { return localStorage.getItem(k) === "1"; } catch { return false; } };

/** HTML 문서의 스크립트를 켤지. 출처가 없는(리포에서 만든) 문서는 항상 켠다 */
export function useScripts(menu: string, doc: string, version: string, external: boolean): [boolean, (on: boolean) => void] {
  const k = key(menu, doc, version);
  const [on, setOn] = useState(() => !external || read(k));
  useEffect(() => setOn(!external || read(k)), [k, external]);
  const set = (v: boolean) => {
    try { if (v) localStorage.setItem(k, "1"); else localStorage.removeItem(k); } catch { /* 저장 실패는 무시 */ }
    setOn(v);
  };
  return [on, set];
}

/**
 * 외부에서 가져온 문서(meta.yaml origin_url)의 출처 막대(3.3, D-25).
 * HTML이면 스크립트 상태와 켜기·끄기 버튼을 함께 보여 준다.
 */
export function OriginBar({ origin, html, scripts, setScripts }: {
  origin: string; html: boolean; scripts: boolean; setScripts: (on: boolean) => void;
}) {
  return (
    <div className={`flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-line px-4 py-1.5 text-xs ${html && !scripts ? "bg-med-soft text-med" : "bg-sunken text-muted"}`}>
      {html && !scripts ? <ShieldAlert size={16} aria-hidden /> : <ShieldCheck size={16} aria-hidden />}
      <span className="font-medium">외부 문서</span>
      <span aria-hidden>·</span>
      <a href={origin} target="_blank" rel="noreferrer" className="inline-flex min-w-0 items-center gap-1 underline underline-offset-2" data-tip="출처 열기 (새 탭)">
        <span className="truncate">{origin}</span><ExternalLink size={14} aria-hidden className="shrink-0" />
      </a>
      {html && (
        <>
          <span className="ml-auto">{scripts ? "스크립트 켜짐" : "스크립트 꺼짐 · 접기·탭 같은 동작은 멈춥니다"}</span>
          <button type="button" className="rounded-md border border-current px-2 py-0.5 font-medium hover:bg-surface"
            onClick={() => setScripts(!scripts)}
            data-tip={scripts ? "이 버전의 스크립트를 다시 끕니다" : "이 브라우저에서 이 버전의 스크립트를 켭니다(기억됨)"}>
            {scripts ? "끄기" : "스크립트 켜기"}
          </button>
        </>
      )}
    </div>
  );
}
