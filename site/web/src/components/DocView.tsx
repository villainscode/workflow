import { useEffect, useRef, useState } from "react";
import { Download, ExternalLink, FilePlus2, Minimize, Presentation, Settings2 } from "lucide-react";
import { PresentationContent } from "../viewers/Presentation.tsx";
import { IconButton } from "./IconButton.tsx";
import { useParams, useSearchParams } from "react-router";
import { DocSettingsDialog } from "./manage/DocSettingsDialog.tsx";
import { fileSrc, useDoc, versionLabel } from "../lib/api.ts";
import { useOpenUpload } from "./upload/UploadContext.tsx";
import { useConfirm } from "./confirm/ConfirmProvider.tsx";
import { EmptyState } from "./EmptyState.tsx";
import { ReleaseBadge } from "./ReleaseBadge.tsx";
import { Viewer } from "../viewers/Viewer.tsx";
import { DiffViewer } from "../viewers/DiffViewer.tsx";

// 줄 단위 비교가 의미 있는 텍스트 형식
const TEXT = /\.(md|markdown|html?|ya?ml|json|txt|mmd|csv|xml|ts|tsx|js|sh|py|sql)$/i;

export function DocView() {
  const { menu = "", doc = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const { data, error, isLoading } = useDoc(menu, doc);
  const openUpload = useOpenUpload();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const confirm = useConfirm();
  // 프레젠테이션 모드: 문서 영역(stage)만 브라우저 전체 화면으로 띄운다. Esc로 나가도 이벤트로 상태를 맞춘다
  const stage = useRef<HTMLDivElement>(null);
  const [presenting, setPresenting] = useState(false);
  useEffect(() => {
    const sync = () => setPresenting(document.fullscreenElement !== null && document.fullscreenElement === stage.current);
    document.addEventListener("fullscreenchange", sync);
    return () => document.removeEventListener("fullscreenchange", sync);
  }, []);

  if (isLoading) return <EmptyState title="불러오는 중…" />;
  if (error || !data) return <EmptyState title="문서를 열 수 없습니다" body={String(error ?? "")} />;

  const versionKey = params.get("v") ?? data.currentVersion;
  const version = data.versions.find((v) => v.version === versionKey);
  if (!version) return <EmptyState title={`${versionKey} 버전이 없습니다`} />;
  const entry = version.files.find((f) => f.isEntry);
  const cmpKey = params.get("cmp");
  const cmpVersion = data.versions.find((v) => v.version === cmpKey && v.version !== version.version);
  const cmpEntry = cmpVersion?.files.find((f) => f.isEntry);
  const comparable = !!entry && TEXT.test(entry.path) && data.versions.length > 1;
  const setParam = (k: string, v: string | null) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v); else next.delete(k);
    setParams(next);
  };

  return (
    <div className="grid h-full grid-rows-[auto_minmax(0,1fr)]">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line bg-surface px-4 py-2">
        <h1 className="min-w-0 flex-1 truncate text-base font-bold" title={data.title}>{data.title}</h1>
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
        <ReleaseBadge doc={data} />
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
          <IconButton icon={FilePlus2} label="새 버전 올리기" onClick={() => openUpload({ menu, doc })} />
          <IconButton icon={Presentation} label="프레젠테이션 (전체 화면)" disabled={!entry}
            onClick={() => void stage.current?.requestFullscreen()} />
          <IconButton icon={Settings2} label="문서 관리" onClick={() => setSettingsOpen(true)} />
          {data.notionUrl && (
            <a className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-xs text-muted hover:bg-sunken hover:text-fg" href={data.notionUrl} target="_blank" rel="noreferrer" title="Notion에서 열기">
              Notion <ExternalLink size={16} aria-hidden />
            </a>
          )}
          {data.gdriveUrl && (
            <a className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-xs text-muted hover:bg-sunken hover:text-fg" href={data.gdriveUrl} target="_blank" rel="noreferrer" title="Google Drive에서 열기">
              Drive <ExternalLink size={16} aria-hidden />
            </a>
          )}
        </div>
        {settingsOpen && <DocSettingsDialog doc={data} onClose={() => setSettingsOpen(false)} />}
        {version.note && (
          <details className="basis-full text-xs text-muted">
            <summary className="cursor-pointer">{versionLabel(version.version)} 변경 메모{version.createdAt ? ` · ${version.createdAt}` : ""}</summary>
            <p className="mt-1 max-w-3xl leading-relaxed">{version.note}</p>
          </details>
        )}
      </div>
      <div ref={stage} className="relative min-h-0 min-w-0 bg-bg">
        {presenting && entry ? (
          <>
            <PresentationContent key={fileSrc(entry)} file={entry}
              ctx={{ menu, doc, version: version.version, isCurrent: version.version === data.currentVersion }} />
            <IconButton icon={Minimize} label="프레젠테이션 끝내기 (Esc)" variant="outline"
              className="absolute top-3 right-3 z-10 bg-surface/90 shadow" onClick={() => void document.exitFullscreen()} />
          </>
        ) : !entry ? (
          <EmptyState title="대표 파일(entry)이 없습니다" body="meta.yaml의 entry를 확인하세요." />
        ) : cmpVersion && cmpEntry && comparable ? (
          <DiffViewer from={cmpEntry} to={entry} fromLabel={versionLabel(cmpVersion.version)} toLabel={versionLabel(version.version)} />
        ) : (
          <Viewer
            key={fileSrc(entry)}
            file={entry}
            ctx={{ menu, doc, version: version.version, isCurrent: version.version === data.currentVersion }}
          />
        )}
      </div>
    </div>
  );
}
