// MarkFlow 에디터의 이미지 업로드 설정(SettingsModal)과 안내(ImageUploadGuide)를 사이트 공통 대화상자 하나로 합쳤다.
// 업로드 서버(Cloudflare Worker) 주소는 브라우저마다 localStorage에 둔다. Worker 소스와 배포 방법은 site/cloudflare/r2-uploader/.

import { useState } from "react";
import { CircleAlert, CircleCheck, FlaskConical, Loader2 } from "lucide-react";
import { Modal, ui } from "../../components/Modal.tsx";
import { createCloudflareUploader, createTestImage } from "./cloudflareUploader.ts";

const STORAGE_KEY = "mf-cf-worker-url";

export function getSavedWorkerUrl(): string {
  try { return localStorage.getItem(STORAGE_KEY) ?? ""; } catch { return ""; }
}

type Test = { status: "idle" | "testing" | "success" | "error"; message?: string };

export function UploadSettingsDialog({ onClose, onSave }: { onClose: () => void; onSave: (url: string) => void }) {
  const [url, setUrl] = useState(getSavedWorkerUrl);
  const [test, setTest] = useState<Test>({ status: "idle" });
  const trimmed = url.trim();
  const configured = !!getSavedWorkerUrl();

  async function runTest() {
    setTest({ status: "testing" });
    try {
      const uploaded = await createCloudflareUploader(trimmed)(createTestImage());
      setTest({ status: "success", message: uploaded });
    } catch (e) {
      setTest({ status: "error", message: (e as Error).message });
    }
  }

  function save() {
    try {
      if (trimmed) localStorage.setItem(STORAGE_KEY, trimmed);
      else localStorage.removeItem(STORAGE_KEY);
    } catch { /* 저장소를 못 쓰는 브라우저 */ }
    onSave(trimmed);
    onClose();
  }

  // 주소를 지우거나 그대로 두는 저장은 바로, 새 주소는 테스트 업로드가 성공해야 저장할 수 있다
  const canSave = trimmed ? trimmed === getSavedWorkerUrl() || test.status === "success" : configured;

  return (
    <Modal title="이미지 업로드 설정" onClose={onClose}>
      <form className="grid gap-4" onSubmit={(e) => { e.preventDefault(); if (canSave) save(); }}>
        <p className="text-sm text-muted">
          툴바의 이미지 올리기, 편집 창에 끌어 놓기·붙여넣기로 넣은 이미지는 Cloudflare R2에 올리고 그 공개 주소를 문서에 넣습니다.
          {!configured && " 처음 한 번 업로드 서버를 연결해야 합니다."}
        </p>
        {!configured && (
          <ol className="grid list-decimal gap-1 rounded-md bg-sunken py-2.5 pr-3 pl-8 text-xs text-muted">
            <li>Cloudflare 계정에서 R2 버킷을 만들고 공개 접근을 켭니다.</li>
            <li>리포의 <code className="font-mono">site/cloudflare/r2-uploader</code> Worker를 배포합니다(README 참고). <code className="font-mono">ALLOWED_ORIGINS</code>에 이 사이트 주소({location.origin})를 넣습니다.</li>
            <li>배포한 Worker 주소를 아래에 넣고 테스트 업로드가 성공하면 저장합니다.</li>
          </ol>
        )}
        <label className={ui.label}>
          업로드 서버(Worker) 주소
          <input type="url" className={ui.field} value={url} autoFocus
            placeholder="https://workflow-r2-uploader.<계정>.workers.dev"
            onChange={(e) => { setUrl(e.target.value); setTest({ status: "idle" }); }} />
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className={`${ui.secondary} inline-flex items-center gap-1.5`} disabled={!trimmed || test.status === "testing"} onClick={() => void runTest()}>
            {test.status === "testing" ? <Loader2 size={16} className="animate-spin" aria-hidden /> : <FlaskConical size={16} aria-hidden />}
            {test.status === "testing" ? "테스트 중…" : "테스트 업로드"}
          </button>
          {test.status === "success" && (
            <span role="status" className="flex min-w-0 items-center gap-1 text-xs text-ok"><CircleCheck size={16} aria-hidden className="shrink-0" />연결됨 <span className="truncate text-muted">{test.message}</span></span>
          )}
          {test.status === "error" && (
            <span role="alert" className="flex min-w-0 items-center gap-1 text-xs text-high"><CircleAlert size={16} aria-hidden className="shrink-0" />{test.message}</span>
          )}
        </div>
        <div className="flex justify-end gap-2">
          <button type="button" className={ui.secondary} onClick={onClose}>취소</button>
          <button type="submit" className={ui.primary} disabled={!canSave}>{trimmed ? "저장" : configured ? "연결 해제" : "저장"}</button>
        </div>
      </form>
    </Modal>
  );
}
