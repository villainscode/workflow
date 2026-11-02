import { useEffect, useRef, useState } from "react";

/**
 * draw.io 편집기(6.0 V4, D-56·D-57). 자체 호스팅한 draw.io(apps/drawio, 앱과 다른 출처)를 iframe으로 열고 embed 프로토콜(JSON postMessage)로 주고받는다.
 * - 받는 메시지는 출처(origin)와 보낸 창(source)을 둘 다 확인하고, 보낼 때는 대상 출처를 적는다(V0 스파이크 1: 같은 페이지의 위조 save를 거른다)
 * - 「저장」을 누르면 xmlsvg(편집용 다이어그램 XML을 루트 content에 넣은 SVG)로 내보내 onSave에 넘긴다. 다시 열면 그대로 이어서 고친다
 * - export 응답의 format은 요청과 달리 "svg"로 오므로 보낸 요청 순서로 짝짓는다
 * 문서 내용은 postMessage로만 오가고 draw.io 서버로 나가지 않는다(draw.io 쪽 CSP connect-src 'self').
 */

const BLANK = '<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel>';

/** data:image/svg+xml;base64,… 또는 글 → SVG 글(UTF-8) */
export function decodeExport(data: string): string {
  if (!data.startsWith("data:")) return data;
  const [head, body] = [data.slice(0, data.indexOf(",")), data.slice(data.indexOf(",") + 1)];
  if (!head.includes(";base64")) return decodeURIComponent(body);
  const bin = atob(body);
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

export function DrawioEditor({ origin, svg, title, onSave, onClose }: {
  /** draw.io 출처(예: https://draw.simplite.net) */
  origin: string;
  /** 다시 열 draw.io SVG(없으면 새 그림) */
  svg?: string;
  title: string;
  /** 저장한 SVG. 실패하면 오류를 던지고 편집기는 열린 채로 둔다 */
  onSave: (svg: string) => Promise<void>;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const [status, setStatus] = useState("draw.io를 여는 중…");
  const save = useRef(onSave);
  save.current = onSave;
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => { dialog.current?.showModal(); }, []);

  useEffect(() => {
    // 보낸 export 요청(저장 뒤 닫을지)을 순서대로 둔다
    const pending: { exit: boolean }[] = [];
    const post = (msg: object) => frame.current?.contentWindow?.postMessage(JSON.stringify(msg), origin);
    const onMessage = async (e: MessageEvent) => {
      if (e.origin !== origin || e.source !== frame.current?.contentWindow) return;
      let m: { event?: string; data?: string; exit?: boolean; modified?: boolean };
      try { m = JSON.parse(String(e.data)); } catch { return; }
      if (m.event === "init") { post({ action: "load", xml: svg ?? BLANK, autosave: 0, title }); setStatus(""); }
      else if (m.event === "save") { pending.push({ exit: !!m.exit }); post({ action: "export", format: "xmlsvg", spinKey: "saving" }); }
      else if (m.event === "export") {
        const req = pending.shift();
        if (!req || typeof m.data !== "string") return;
        setStatus("저장하는 중…");
        try {
          await save.current(decodeExport(m.data));
          post({ action: "status", message: "저장했습니다", modified: false });
          setStatus("");
          if (req.exit) close.current();
        } catch (err) {
          setStatus(`저장하지 못했습니다: ${(err as Error).message}`);
        }
      } else if (m.event === "exit") close.current();
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [origin, svg, title]);

  // stealth·lockdown: 아이콘 검색·실시간 캐시 같은 바깥 서비스를 끈다. saveAndExit: 「저장 후 닫기」 버튼
  const src = `${origin}/?embed=1&proto=json&spin=1&stealth=1&lockdown=1&saveAndExit=1&noExitBtn=0&lang=ko`;
  return (
    <dialog ref={dialog} onCancel={(e) => { e.preventDefault(); onClose(); }} aria-label={`draw.io 편집: ${title}`}
      className="m-0 h-dvh max-h-none w-dvw max-w-none border-0 bg-surface p-0 text-fg backdrop:bg-black/40">
      <div className="grid h-full grid-rows-[auto_minmax(0,1fr)]">
        <p role="status" className={status ? "bg-sunken px-3 py-1 text-xs text-muted" : "sr-only"}>{status || "draw.io 편집기"}</p>
        <iframe ref={frame} src={src} title="draw.io 편집기" className="block h-full w-full border-0" />
      </div>
    </dialog>
  );
}
