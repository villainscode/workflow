import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { Download, ExternalLink, FilePlus2, LayoutPanelTop, Link2, Minimize, PenLine, Presentation, Settings2, TextCursorInput } from "lucide-react";
import { HtmlTextEditor } from "../viewers/HtmlTextEditor.tsx";
import { OfficeTextEditor } from "../viewers/OfficeTextEditor.tsx";
import { PresentationContent } from "../viewers/Presentation.tsx";
import { IconButton } from "./IconButton.tsx";
import { useParams, useSearchParams } from "react-router";
import { DocSettingsDialog } from "./manage/DocSettingsDialog.tsx";
import { fileSrc, useDoc, versionLabel } from "../lib/api.ts";
import { useOpenUpload } from "./upload/UploadContext.tsx";
import { useConfirm } from "./confirm/ConfirmProvider.tsx";
import { EmptyState } from "./EmptyState.tsx";
import { ReleaseBadge } from "./ReleaseBadge.tsx";
import { OriginBar, useScripts } from "./OriginBar.tsx";
import { Viewer } from "../viewers/Viewer.tsx";
import { DiffViewer } from "../viewers/DiffViewer.tsx";
import { SegmentDiffViewer } from "../viewers/SegmentDiffViewer.tsx";
import { HtmlRefView } from "../viewers/HtmlRefView.tsx";
import { SegmentRefList } from "../viewers/SegmentRefList.tsx";
import { parseSeg } from "../lib/seg.ts";
import { manage } from "../lib/manage.ts";
import { useAction } from "./manage/useAction.ts";
import { CLOUD, useCan } from "../lib/me.ts";
import { STRUCT_EDITABLE } from "../lib/structedit.ts";
import { StatusBadge } from "./StatusBadge.tsx";
import { PresenceChips } from "./PresenceChips.tsx";
import { useHere } from "../lib/live.ts";

// 구조 편집(5.0, Cloudflare 전용). 보기 화면에는 싣지 않는다
const StructEditor = lazy(() => import("../viewers/structedit/StructEditor.tsx").then((m) => ({ default: m.StructEditor })));
const DeckEditor = lazy(() => import("../viewers/deck/editor/DeckEditor.tsx").then((m) => ({ default: m.DeckEditor })));
const PdfEditor = lazy(() => import("../viewers/pdf/PdfEditor.tsx").then((m) => ({ default: m.PdfEditor })));

// 줄 단위 비교가 의미 있는 텍스트 형식
const TEXT = /\.(md|markdown|html?|svg|ya?ml|json|txt|mmd|csv|xml|ts|tsx|js|sh|py|sql)$/i;
// zip 형식이라 줄 대신 텍스트 조각 목록으로 비교하는 형식(2.0)
const SEGMENT_DIFF = /\.(docx|pptx|xlsx)$/i;

export function DocView() {
  const { category = "", menu = "", doc = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const { data, error, isLoading } = useDoc(menu, doc);
  const openUpload = useOpenUpload();
  const can = useCan();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const confirm = useConfirm();
  // 프레젠테이션 모드: 문서 영역(stage)만 브라우저 전체 화면으로 띄운다. Esc로 나가도 이벤트로 상태를 맞춘다
  const stage = useRef<HTMLDivElement>(null);
  const [presenting, setPresenting] = useState(false);
  // 텍스트 편집(2.0): 최신 버전의 HTML을 그 자리에서 고친다. 저장하면 새 버전 안내를 잠깐 보여 준다
  const [textEditing, setTextEditing] = useState(false);
  const [savedNotice, setSavedNotice] = useState("");
  // 참조 복사 모드(3.2): 글자를 눌러 참조 주소를 복사한다
  const [refCopy, setRefCopy] = useState(false);
  // 구조 편집(5.0): 표·그림·블록을 고쳐 수정본으로 자동 저장하고, 버전으로 저장하면 새 버전
  const [structEditing, setStructEditing] = useState(false);
  useEffect(() => { setTextEditing(false); setRefCopy(false); setStructEditing(false); }, [menu, doc]);
  useEffect(() => {
    if (!savedNotice) return;
    const t = setTimeout(() => setSavedNotice(""), 5000);
    return () => clearTimeout(t);
  }, [savedNotice]);
  useEffect(() => {
    const sync = () => setPresenting(document.fullscreenElement !== null && document.fullscreenElement === stage.current);
    document.addEventListener("fullscreenchange", sync);
    return () => document.removeEventListener("fullscreenchange", sync);
  }, []);

  // 접속자 표시(5.0 M7): 이 문서를 보고 있다(편집 화면이면 편집 중)고 알린다
  useHere(menu, doc, textEditing || structEditing ? "edit" : "view");
  // 외부 문서(출처 있음)의 HTML 스크립트 켜기 상태(3.3). 훅이라 아래 조기 반환보다 먼저 부른다
  const [scripts, setScripts] = useScripts(menu, doc, params.get("v") ?? data?.currentVersion ?? "", !!data?.originUrl);

  if (isLoading) return <EmptyState title="불러오는 중…" />;
  if (error || !data) return <EmptyState title="문서를 열 수 없습니다" body={String(error ?? "")} />;

  const versionKey = params.get("v") ?? data.currentVersion;
  const version = data.versions.find((v) => v.version === versionKey);
  if (!version) return <EmptyState title={`${versionKey} 버전이 없습니다`} />;
  const entry = version.files.find((f) => f.isEntry);
  const cmpKey = params.get("cmp");
  const cmpVersion = data.versions.find((v) => v.version === cmpKey && v.version !== version.version);
  const cmpEntry = cmpVersion?.files.find((f) => f.isEntry);
  const comparable = !!entry && (TEXT.test(entry.path) || SEGMENT_DIFF.test(entry.path)) && data.versions.length > 1;
  // 참조 보기(3.2): 주소의 ?seg= 조각을 강조하거나 참조 복사 모드일 때. HTML·DOCX·PPTX·XLSX만
  const referable = !!entry && /\.(html?|svg|docx|pptx|xlsx)$/i.test(entry.path);
  const highlight = referable ? parseSeg(params.get("seg")) : [];
  const exitRef = () => { setRefCopy(false); setParam("seg", null); };
  const onTextEditExit = (saved?: string, warnings?: string[]) => {
    setTextEditing(false);
    if (saved) {
      setParam("v", null);
      setSavedNotice(`${versionLabel(saved)} 버전으로 저장했습니다${warnings?.length ? ` · 주의: ${warnings.join(" · ")}` : ""}`);
    }
  };
  const onStructExit = (saved?: string) => {
    setStructEditing(false);
    if (saved) { setParam("v", null); setSavedNotice(`${versionLabel(saved)} 버전으로 저장했습니다`); }
  };
  const setParam = (k: string, v: string | null) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v); else next.delete(k);
    setParams(next);
  };

  return (
    <div className="grid h-full grid-rows-[auto_auto_minmax(0,1fr)]">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line bg-surface px-4 py-2">
        {can.edit ? <DocTitle key={data.title} menu={menu} doc={doc} title={data.title} />
          : <h1 className="min-w-0 flex-1 text-[2em] leading-tight font-bold">{data.title}</h1>}
        <PresenceChips menu={menu} doc={doc} />
        {version.createdAt && (
          <span className="font-mono text-xs text-muted" data-tip={`${versionLabel(version.version)} 작성일`}>{version.createdAt}</span>
        )}
        <select
          className="rounded-md border border-line bg-surface px-2 py-1 font-mono text-xs"
          value={version.version}
          onChange={(e) => setParam("v", e.target.value === data.currentVersion ? null : e.target.value)}
          aria-label="버전"
        >
          {data.versions.map((v) => (
            <option key={v.version} value={v.version}>
              {versionLabel(v.version)}{v.version === data.currentVersion ? " (최신)" : ""}
            </option>
          ))}
        </select>
        {comparable && (
          <select
            className="rounded-md border border-line bg-surface px-2 py-1 text-xs"
            value={cmpVersion?.version ?? ""}
            onChange={(e) => setParam("cmp", e.target.value || null)}
            aria-label="비교할 버전"
          >
            <option value="">비교 안 함</option>
            {data.versions.filter((v) => v.version !== version.version).map((v) => (
              <option key={v.version} value={v.version}>비교: {versionLabel(v.version)}</option>
            ))}
          </select>
        )}
        {can.edit ? <ReleaseBadge doc={data} /> : <StatusBadge status={data.status} />}
        <div className="flex items-center gap-0.5">
          {entry && (
            <IconButton icon={Download} label="다운로드" onClick={async () => {
              const name = entry.path.split("/").pop()!;
              const ok = await confirm({
                title: "다운로드할까요?", confirmText: "다운로드",
                details: [`파일: ${name}`, `버전: ${versionLabel(version.version)}`, `크기: ${(entry.size / 1024).toFixed(1)} KB`],
              });
              if (!ok) return;
              const a = document.createElement("a");
              a.href = entry.url;
              a.download = name;
              a.click();
            }} />
          )}
          {can.edit && <IconButton icon={FilePlus2} label="새 버전 올리기" onClick={() => openUpload({ menu, doc })} />}
          {can.edit && entry && /\.(html?|svg|docx|pptx|xlsx)$/i.test(entry.path) && version.version === data.currentVersion && !cmpVersion && (
            <IconButton icon={TextCursorInput} label="텍스트 편집" active={textEditing} disabled={textEditing || structEditing}
              onClick={() => { setRefCopy(false); setParam("seg", null); setTextEditing(true); }} />
          )}
          {CLOUD && can.edit && entry && STRUCT_EDITABLE.test(entry.path) && version.version === data.currentVersion && !cmpVersion && (
            <IconButton icon={LayoutPanelTop} label="구조 편집 (표·그림)" active={structEditing} disabled={structEditing || textEditing}
              onClick={() => { setRefCopy(false); setParam("seg", null); setStructEditing(true); }} />
          )}
          {CLOUD && can.edit && entry?.path === "deck.json" && version.version === data.currentVersion && (
            <IconButton icon={PenLine} label="슬라이드 편집" active={structEditing} disabled={structEditing}
              onClick={() => setStructEditing(true)} />
          )}
          {CLOUD && can.edit && entry && /\.pdf$/i.test(entry.path) && version.version === data.currentVersion && (
            <IconButton icon={PenLine} label="PDF 편집" active={structEditing} disabled={structEditing}
              onClick={() => setStructEditing(true)} />
          )}
          {referable && !cmpVersion && !textEditing && !structEditing && (
            <IconButton icon={Link2} label="참조 복사 (글자를 눌러 Claude Code에 붙여 넣을 주소 복사)" active={refCopy}
              onClick={() => setRefCopy((v) => !v)} />
          )}
          <IconButton icon={Presentation} label="프레젠테이션 (전체 화면)" disabled={!entry}
            onClick={() => void stage.current?.requestFullscreen()} />
          {can.edit && <IconButton icon={Settings2} label="문서 관리" onClick={() => setSettingsOpen(true)} />}
          {data.notionUrl && (
            <a className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-xs text-muted hover:bg-sunken hover:text-fg" href={data.notionUrl} target="_blank" rel="noreferrer" data-tip="Notion에서 열기">
              Notion <ExternalLink size={16} aria-hidden />
            </a>
          )}
          {data.gdriveUrl && (
            <a className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-xs text-muted hover:bg-sunken hover:text-fg" href={data.gdriveUrl} target="_blank" rel="noreferrer" data-tip="Google Drive에서 열기">
              Drive <ExternalLink size={16} aria-hidden />
            </a>
          )}
        </div>
        {settingsOpen && <DocSettingsDialog doc={data} onClose={() => setSettingsOpen(false)} />}
        {savedNotice && <p className="basis-full rounded-md bg-ok-soft px-3 py-1 text-xs text-ok">{savedNotice}</p>}
      </div>
      <div>
        {data.originUrl && (
          <OriginBar origin={data.originUrl} html={!!entry && /\.html?$/i.test(entry.path)} scripts={scripts} setScripts={setScripts} />
        )}
      </div>
      <div ref={stage} className="relative min-h-0 min-w-0 bg-bg">
        {presenting && entry ? (
          <>
            <PresentationContent key={fileSrc(entry)} file={entry}
              ctx={{ menu, doc, version: version.version, isCurrent: version.version === data.currentVersion, scripts }} />
            <IconButton icon={Minimize} label="프레젠테이션 끝내기 (Esc)" variant="outline"
              className="absolute top-3 right-3 z-10 bg-surface/90 shadow" onClick={() => void document.exitFullscreen()} />
          </>
        ) : !entry ? (
          <EmptyState title="대표 파일(entry)이 없습니다" body="meta.yaml의 entry를 확인하세요." />
        ) : structEditing ? (
          <Suspense fallback={<EmptyState title="편집기를 불러오는 중…" />}>
            {entry.path === "deck.json" ? <DeckEditor menu={menu} doc={doc} onExit={onStructExit} />
              : /\.pdf$/i.test(entry.path) ? <PdfEditor menu={menu} doc={doc} onExit={onStructExit} />
              : <StructEditor menu={menu} doc={doc} onExit={onStructExit} />}
          </Suspense>
        ) : textEditing ? (
          /\.(docx|pptx|xlsx)$/i.test(entry.path) ? (
            <OfficeTextEditor menu={menu} doc={doc} version={version.version}
              format={/\.pptx$/i.test(entry.path) ? "pptx" : /\.xlsx$/i.test(entry.path) ? "xlsx" : "docx"} onExit={onTextEditExit} />
          ) : (
            <HtmlTextEditor menu={menu} doc={doc} version={version.version} onExit={onTextEditExit} />
          )
        ) : (refCopy || highlight.length > 0) && referable && !cmpVersion ? (
          /\.(html?|svg)$/i.test(entry.path) ? (
            <HtmlRefView category={category} menu={menu} doc={doc} version={version.version} highlight={highlight} copy={refCopy} onExit={exitRef} />
          ) : (
            <SegmentRefList category={category} menu={menu} doc={doc} version={version.version} highlight={highlight} copy={refCopy} onExit={exitRef} />
          )
        ) : cmpVersion && cmpEntry && comparable ? (
          SEGMENT_DIFF.test(entry.path) ? (
            <SegmentDiffViewer menu={menu} doc={doc} fromVersion={cmpVersion.version} toVersion={version.version} />
          ) : (
            <DiffViewer from={cmpEntry} to={entry} fromLabel={versionLabel(cmpVersion.version)} toLabel={versionLabel(version.version)} />
          )
        ) : (
          <Viewer
            key={fileSrc(entry)}
            file={entry}
            ctx={{ menu, doc, version: version.version, isCurrent: version.version === data.currentVersion, scripts }}
          />
        )}
      </div>
    </div>
  );
}

/**
 * 문서 제목(h1). 누르면 그 자리 입력칸이 되어 보는 중에도 제목을 고친다.
 * Enter 저장(확인 창), Esc·바깥 클릭 취소. 한글 조합 중 Enter는 건너뛴다(TC-UI-31과 같은 이유)
 */
function DocTitle({ menu, doc, title }: { menu: string; doc: string; title: string }) {
  const { run, error } = useAction();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(title);
  const done = useRef(false);
  const finish = async (save: boolean) => {
    if (done.current) return;
    done.current = true;
    if (save && value.trim() && value.trim() !== title) {
      await run(() => manage.updateDoc(menu, doc, { title: value.trim() }), {
        title: "문서 제목을 바꿀까요?", confirmText: "저장", details: [`${title} → ${value.trim()}`],
      });
    }
    setEditing(false);
  };

  if (editing) {
    return (
      <input
        className="min-w-0 flex-1 rounded-md border border-accent bg-surface px-2 text-[2em] leading-tight font-bold"
        value={value}
        aria-label="문서 제목"
        autoFocus
        onFocus={(e) => e.target.select()}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing || e.keyCode === 229) return;
          // Enter 기본 동작을 막아야 확인 창의 버튼이 같은 키 입력을 받아 바로 실행되지 않는다
          if (e.key === "Enter") { e.preventDefault(); void finish(true); }
          if (e.key === "Escape") { e.preventDefault(); void finish(false); }
        }}
        onBlur={() => void finish(false)}
      />
    );
  }
  return (
    <h1 className="flex min-w-0 flex-1 items-center gap-2 text-[2em] leading-tight font-bold">
      <button type="button" className="min-w-0 truncate rounded-md text-left hover:bg-sunken" data-tip="눌러서 제목 수정"
        onClick={() => { done.current = false; setValue(title); setEditing(true); }}>
        {title}
      </button>
      {error && <span role="alert" className="shrink-0 rounded bg-high-soft px-2 py-0.5 text-xs font-normal text-high">{error}</span>}
    </h1>
  );
}
