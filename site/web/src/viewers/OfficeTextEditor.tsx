import { useEffect, useRef, useState } from "react";
import { EmptyState } from "../components/EmptyState.tsx";
import type { Segment } from "../lib/textedit.ts";
import { SheetViewer } from "./SheetViewer.tsx";
import { EditBar, useTextSession, type TextSession } from "./textedit/session.tsx";

/**
 * DOCX·PPTX 텍스트 편집(2.0, REQUIREMENT-2.0 2.3·2.4).
 * 렌더링된 문서에서는 글자가 원본의 어느 run인지 알 수 없으므로, 왼쪽에 문단별 텍스트 목록을 두고 고친다.
 * 오른쪽 미리보기는 서버가 바뀐 조각을 반영해 돌려준 파일(text-preview, 저장하지 않음)로 그린다.
 */

type Format = "docx" | "pptx" | "xlsx";

/** 조각 group("document · 표 1 2행 1열 · 문단 5")을 영역(앞부분)과 문단 번호로 나눈다 */
export function splitGroup(group: string) {
  const i = group.lastIndexOf(" · 문단 ");
  return i < 0 ? { area: group, para: group } : { area: group.slice(0, i), para: group };
}

/** 영역 "슬라이드 2 · 도형 1"·"document · 표 1 1행 2열"의 앞부분(제목)과 나머지(줄 앞 표시) */
export const head = (area: string) => area.split(" · ")[0];
export const tail = (area: string) => (area.includes(" · ") ? area.slice(area.indexOf(" · ") + 3) : undefined);

export const AREA_NAME = (area: string) =>
  area.replace(/^document/, "본문").replace(/^header(\d*)/, "머리글 $1").replace(/^footer(\d*)/, "바닥글 $1").trim();

/** 한 조각: 그 자리에서 고치는 칸. 글자는 처음 한 번만 넣고 이후로는 브라우저가 관리한다(커서가 튀지 않게) */
function SegField({ seg, s, register, onFocus }: {
  seg: Segment; s: TextSession; register: (id: number, el: HTMLSpanElement | null) => void; onFocus: (seg: Segment) => void;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.textContent = seg.text;
    register(seg.id, ref.current);
    return () => register(seg.id, null);
  }, [seg, register]);
  const fmt = seg.fmt ?? "";
  return (
    <span
      ref={ref}
      contentEditable="plaintext-only"
      suppressContentEditableWarning
      spellCheck={false}
      data-seg={seg.id}
      className={`rounded-sm px-px outline-1 ${seg.multiline ? "whitespace-pre-wrap" : ""} outline-transparent outline-dashed hover:outline-accent/60 focus:bg-accent-soft focus:outline-2 focus:outline-accent focus:outline-solid
        data-[changed]:bg-med-soft data-[changed]:shadow-[inset_0_-2px_0_var(--med)]
        ${fmt.includes("b") ? "font-bold" : ""} ${fmt.includes("i") ? "italic" : ""} ${fmt.includes("u") ? "underline" : ""}`}
      onFocus={() => onFocus(seg)}
      onInput={(e) => {
        let text = e.currentTarget.textContent ?? "";
        if (!seg.multiline && /[\r\n]/.test(text)) { text = text.replace(/\r?\n/g, " "); e.currentTarget.textContent = text; }
        // 줄 끝에서 Enter를 치면 브라우저가 커서 자리용 줄바꿈을 하나 더 둔다. 화면은 두고(커서가 튀지 않게) 저장할 값에서만 뗀다
        if (seg.multiline && !seg.text.endsWith("\n")) text = text.replace(/\n$/, "");
        e.currentTarget.toggleAttribute("data-changed", text !== seg.text);
        s.change(seg.id, text);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" && !seg.multiline) e.preventDefault();
        if (e.key === "Escape") { e.preventDefault(); s.set(seg.id, seg.text); e.currentTarget.blur(); }
      }}
    />
  );
}

/** 바뀐 조각을 반영한 파일을 서버에서 받아 온다(입력이 멈추면 갱신) */
function usePreviewFile(menu: string, doc: string, version: string, s: TextSession, delay: number, toPdf: boolean) {
  const [blob, setBlob] = useState<Blob | null>(null);
  const [loading, setLoading] = useState(false);
  const key = JSON.stringify([...s.changes]);
  useEffect(() => {
    if (!s.segments) return;
    let cancelled = false;
    const t = setTimeout(async () => {
      setLoading(true);
      try {
        const changes = [...s.changes].map(([id, text]) => ({ id, hash: s.segs.get(id)!.hash, text }));
        const res = await fetch(`/api/docs/${menu}/${doc}/text-preview${toPdf ? "?to=pdf" : ""}`, {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ baseVersion: version, changes }),
        });
        if (res.ok && !cancelled) setBlob(await res.blob());
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, delay);
    return () => { cancelled = true; clearTimeout(t); };
    // key가 바뀔 때(변경 내용이 바뀔 때)만 다시 받는다
  }, [key, s.segments, menu, doc, version, delay, toPdf]); // eslint-disable-line react-hooks/exhaustive-deps
  return { blob, loading };
}

function DocxPreview({ blob }: { blob: Blob | null }) {
  const box = useRef<HTMLDivElement>(null);
  const [error, setError] = useState("");
  // 페이지(A4 등)가 미리보기 칸보다 넓으면 칸 너비에 맞춰 줄인다(잘리거나 가로 스크롤이 생기지 않게)
  const fit = () => {
    const wrap = box.current?.querySelector<HTMLElement>(".docx-wrapper");
    const page = wrap?.querySelector<HTMLElement>("section.docx");
    if (!box.current || !wrap || !page) return;
    wrap.style.zoom = "1";
    const scale = Math.min(1, (box.current.clientWidth - 32) / page.offsetWidth);
    wrap.style.zoom = String(scale);
  };
  useEffect(() => {
    if (!box.current) return;
    const ro = new ResizeObserver(() => fit());
    ro.observe(box.current);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    if (!blob || !box.current) return;
    let cancelled = false;
    (async () => {
      try {
        const { renderAsync } = await import("docx-preview");
        if (cancelled || !box.current) return;
        // 다시 그려도 스크롤 위치를 지킨다
        const scroll = box.current.scrollTop;
        const next = document.createElement("div");
        await renderAsync(blob, next, undefined, { inWrapper: true, breakPages: true, ignoreLastRenderedPageBreak: true });
        if (cancelled || !box.current) return;
        box.current.replaceChildren(next);
        fit();
        box.current.scrollTop = scroll;
        setError("");
      } catch (e) {
        setError((e as Error).message);
      }
    })();
    return () => { cancelled = true; };
  }, [blob]);
  if (error) return <EmptyState title="미리보기를 그릴 수 없습니다" body={error} />;
  return <div ref={box} className="docx-host h-full overflow-y-auto" />;
}

/** XLSX 미리보기: 바뀐 내용을 반영한 파일을 기존 엑셀 뷰어(시트 탭 + 표)로 보여 준다 */
function SheetPreview({ blob }: { blob: Blob | null }) {
  const [url, setUrl] = useState("");
  useEffect(() => {
    if (!blob) return;
    const u = URL.createObjectURL(blob);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [blob]);
  return url ? <SheetViewer url={url} /> : <EmptyState title="불러오는 중…" />;
}

/** PPTX 미리보기: 서버가 LibreOffice로 변환한 PDF를 브라우저 내장 PDF 뷰어로 연다 */
function PdfPreview({ blob, page }: { blob: Blob | null; page: number }) {
  const [url, setUrl] = useState("");
  useEffect(() => {
    if (!blob) return;
    const u = URL.createObjectURL(blob);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [blob]);
  if (!url) return <EmptyState title="미리보기를 만드는 중…" body="LibreOffice로 변환하고 있습니다." />;
  // #page로 지금 고치는 슬라이드를 연다(갱신될 때마다 1쪽으로 돌아가지 않게)
  return <iframe key={`${url}#${page}`} src={`${url}#page=${page}`} title="슬라이드 미리보기" className="block h-full w-full border-0 bg-surface" />;
}

export function OfficeTextEditor({ menu, doc, version, format, onExit }: {
  menu: string; doc: string; version: string; format: Format; onExit: (savedVersion?: string) => void;
}) {
  const fields = useRef(new Map<number, HTMLSpanElement>());
  const register = useRef((id: number, el: HTMLSpanElement | null) => {
    if (el) fields.current.set(id, el); else fields.current.delete(id);
  }).current;
  const [tab, setTab] = useState<"text" | "preview">("text");
  // PPTX 미리보기에서 열어 둘 쪽: 마지막으로 고치던 칸의 슬라이드 번호(발표 순서 = PDF 쪽 순서)
  const [page, setPage] = useState(1);
  const onFocusSeg = (seg: Segment) => {
    const n = Number(/^슬라이드 (\d+)/.exec(seg.group)?.[1]);
    if (n) setPage(n);
  };

  const s = useTextSession({
    menu, doc, version, onExit,
    write: (id, text, changed) => {
      const el = fields.current.get(id);
      if (!el) return;
      el.textContent = text;
      el.toggleAttribute("data-changed", changed);
    },
  });
  const preview = usePreviewFile(menu, doc, version, s, format === "pptx" ? 1000 : 400, format === "pptx");

  if (s.error) return <EmptyState title="텍스트를 불러올 수 없습니다" body={String(s.error)} />;
  if (!s.segments) return <EmptyState title="불러오는 중…" />;

  // 문단(group)별로 묶고, 영역이 바뀌는 곳에 제목을 단다
  const paras: { area: string; key: string; segs: Segment[] }[] = [];
  for (const seg of s.segments) {
    const { area, para } = splitGroup(seg.group);
    const last = paras[paras.length - 1];
    if (last && last.key === para) last.segs.push(seg);
    else paras.push({ area, key: para, segs: [seg] });
  }

  const tabBtn = (t: "text" | "preview", label: string) => (
    <button className={`rounded-md px-3 py-1 text-xs ${tab === t ? "bg-accent-soft text-accent" : "text-muted"}`} onClick={() => setTab(t)}>{label}</button>
  );

  return (
    <div className="grid h-full grid-rows-[auto_auto_minmax(0,1fr)]">
      <EditBar s={s} hint={`${format === "xlsx" ? "셀" : format === "pptx" ? "슬라이드" : "문단"}별 텍스트를 고치면 오른쪽 미리보기에 반영됩니다 · 서식이 다른 부분은 칸이 나뉩니다 · Esc는 되돌리기`}
        notice={format === "pptx" ? "미리보기는 LibreOffice로 변환해 1~2초 늦게 갱신됩니다."
          : format === "xlsx" ? "문자 셀만 고칠 수 있습니다(숫자·수식 셀 제외). 같은 글자를 쓰는 다른 셀은 바뀌지 않습니다."
            : "줄·문단을 추가하거나 서식을 바꿀 수는 없습니다."} />
      <div className="flex gap-1 border-b border-line bg-surface px-4 py-1 lg:hidden">
        {tabBtn("text", "텍스트")}{tabBtn("preview", "미리보기")}
      </div>
      <div className="grid min-h-0 lg:grid-cols-2">
        <div className={`min-h-0 overflow-y-auto border-r border-line bg-surface px-5 py-4 ${tab === "text" ? "block" : "hidden"} lg:block`}>
          {paras.map((p, i) => (
            <div key={p.key}>
              {(i === 0 || head(paras[i - 1].area) !== head(p.area)) && (
                <p className="mt-4 mb-1 border-b border-line pb-1 text-xs font-bold text-muted first:mt-0">{AREA_NAME(head(p.area))}</p>
              )}
              <div className="grid grid-cols-[96px_minmax(0,1fr)] gap-2 border-b border-line/60 py-1.5 text-sm leading-relaxed">
                <span className="pt-0.5 font-mono text-[11px] text-muted">{tail(p.area) ?? `¶ ${p.key.split(" · 문단 ").pop()}`}</span>
                <p className="break-words">
                  {p.segs.map((seg) => <SegField key={seg.id} seg={seg} s={s} register={register} onFocus={onFocusSeg} />)}
                </p>
              </div>
            </div>
          ))}
        </div>
        <div className={`relative min-h-0 bg-bg ${tab === "preview" ? "block" : "hidden"} lg:block`}>
          {preview.loading && <span className="absolute top-2 right-3 z-10 rounded-full bg-surface px-2 text-[11px] text-muted shadow">미리보기 갱신 중…</span>}
          {format === "docx" ? <DocxPreview blob={preview.blob} />
            : format === "xlsx" ? <SheetPreview blob={preview.blob} />
              : <PdfPreview blob={preview.blob} page={page} />}
        </div>
      </div>
    </div>
  );
}
