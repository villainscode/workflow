import { useState } from "react";
import { useParams, useSearchParams } from "react-router";
import { DocSettingsDialog } from "./manage/DocSettingsDialog.tsx";
import { fileSrc, useDoc } from "../lib/api.ts";
import { useOpenUpload } from "./upload/UploadContext.tsx";
import { EmptyState } from "./EmptyState.tsx";
import { StatusBadge } from "./StatusBadge.tsx";
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
              {v.version}{v.version === data.currentVersion ? " (최신)" : ""}
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
              <option key={v.version} value={v.version}>{v.version}과 비교</option>
            ))}
          </select>
        )}
        <StatusBadge status={data.status} />
        {entry && (
          <a className="text-xs text-accent hover:underline" href={entry.url} download>다운로드</a>
        )}
        <button
          className="rounded-md border border-line px-2 py-0.5 text-xs hover:bg-sunken"
          onClick={() => openUpload({ menu, doc })}
        >
          새 버전
        </button>
        <button
          className="rounded-md border border-line px-2 py-0.5 text-xs hover:bg-sunken"
          onClick={() => setSettingsOpen(true)}
        >
          관리
        </button>
        {settingsOpen && <DocSettingsDialog doc={data} onClose={() => setSettingsOpen(false)} />}
        {data.notionUrl && <a className="text-xs text-accent hover:underline" href={data.notionUrl} target="_blank" rel="noreferrer">Notion</a>}
        {data.gdriveUrl && <a className="text-xs text-accent hover:underline" href={data.gdriveUrl} target="_blank" rel="noreferrer">Drive</a>}
        {version.note && (
          <details className="basis-full text-xs text-muted">
            <summary className="cursor-pointer">{version.version} 변경 메모{version.createdAt ? ` · ${version.createdAt}` : ""}</summary>
            <p className="mt-1 max-w-3xl leading-relaxed">{version.note}</p>
          </details>
        )}
      </div>
      <div className="min-h-0 min-w-0 bg-bg">
        {!entry ? (
          <EmptyState title="대표 파일(entry)이 없습니다" body="meta.yaml의 entry를 확인하세요." />
        ) : cmpVersion && cmpEntry && comparable ? (
          <DiffViewer from={cmpEntry} to={entry} fromLabel={cmpVersion.version} toLabel={version.version} />
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
