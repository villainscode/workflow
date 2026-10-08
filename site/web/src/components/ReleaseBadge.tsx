import { useSearchParams } from "react-router";
import { versionLabel, type DocDetail } from "../lib/api.ts";
import { manage } from "../lib/manage.ts";
import { StatusBadge } from "./StatusBadge.tsx";
import { useAction } from "./manage/useAction.ts";

/** 다음 정식 버전 번호(서버 nextMajor와 같은 규칙): v0.x → v1.0, v1.2 → v2.0 */
function nextMajor(versions: string[]): string {
  const majors = versions.map((v) => /^v(\d+)\.\d+$/.exec(v)).filter((m) => m !== null).map((m) => Number(m[1]));
  return `v${(majors.length ? Math.max(...majors) : 0) + 1}.0`;
}

/**
 * 문서 상태 배지. draft·review면 버튼이 되어, 누르면 확인 후 정식 버전(v1.0 등)으로 확정한다.
 * 정식(approved) 문서는 누를 수 없는 배지로 둔다.
 */
export function ReleaseBadge({ doc }: { doc: DocDetail }) {
  const [, setParams] = useSearchParams();
  const { run, busy } = useAction();
  if (doc.status === "approved") return <StatusBadge status={doc.status} />;

  const next = nextMajor(doc.versions.map((v) => v.version));
  return (
    <button
      type="button"
      className="rounded-full ring-accent transition hover:ring-2 disabled:opacity-50"
      data-tip={`${doc.status} · 누르면 정식 버전(${next})으로 변경`}
      aria-label={`${doc.status} 상태. 정식 버전 ${next}으로 변경`}
      disabled={busy}
      onClick={async () => {
        const ok = await run(() => manage.release(doc.menuSlug, doc.slug), {
          title: `${next}으로 변경하시겠습니까?`,
          message: "draft 문서를 정식 버전으로 확정합니다. 현재 버전 파일을 복사해 새 버전을 만들고, 기존 버전은 그대로 남습니다.",
          details: [`문서: ${doc.title}`, `${versionLabel(doc.currentVersion)} (${doc.status}) → ${next} (approved)`],
          confirmText: `${next}으로 변경`,
        });
        if (ok) setParams({}); // 최신(새 정식) 버전을 보도록 버전 선택을 비운다
      }}
    >
      <StatusBadge status={doc.status} noTip />
    </button>
  );
}
