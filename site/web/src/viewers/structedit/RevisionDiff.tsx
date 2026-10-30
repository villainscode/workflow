import { useQuery } from "@tanstack/react-query";
import { getRevisionFiles, getWork, type WorkFile } from "../../lib/structedit.ts";
import { EmptyState } from "../../components/EmptyState.tsx";
import { Modal } from "../../components/Modal.tsx";
import { TextDiff } from "../DiffViewer.tsx";

/**
 * 수정본 비교(5.0 M7): 고른 수정본과 지금 작업본. 글자 형식은 대표 파일을 줄 단위로, 덱은 슬라이드를 차례로 이어 붙여 비교한다.
 * 그 밖의 형식(DOCX·PPTX·XLSX·PDF·그림)은 바뀐 파일 목록만 보여 준다.
 */

const TEXT = /\.(md|markdown|html?|svg|ya?ml|json|txt|mmd|csv|xml)$/i;
const text = async (f: WorkFile | undefined) => (f ? (await fetch(`${f.url}?h=${f.sha256.slice(0, 12)}`)).text() : "");

async function snapshot(files: WorkFile[], entry: string) {
  const by = new Map(files.map((f) => [f.path, f]));
  if (entry === "deck.json") {
    const order = (JSON.parse(await text(by.get(entry))) as { order: string[] }).order;
    return (await Promise.all(order.map(async (id) => `── 슬라이드 ${id}\n${await text(by.get(`slides/${id}.html`))}`))).join("\n");
  }
  return TEXT.test(entry) ? text(by.get(entry)) : null;
}

export function RevisionDiff({ menu, doc, rev, current, onClose }: { menu: string; doc: string; rev: number; current: number; onClose: () => void }) {
  const q = useQuery({
    queryKey: ["rev-diff", menu, doc, rev, current],
    queryFn: async () => {
      const [a, b] = await Promise.all([getRevisionFiles(menu, doc, rev), getWork(menu, doc)]);
      const [ta, tb] = await Promise.all([snapshot(a.files, a.entry), snapshot(b.files, b.entry)]);
      const pa = new Map(a.files.map((f) => [f.path, f.sha256])), pb = new Map(b.files.map((f) => [f.path, f.sha256]));
      const files = [...new Set([...pa.keys(), ...pb.keys()])].sort()
        .map((p) => ({ path: p, state: !pa.has(p) ? "추가" : !pb.has(p) ? "삭제" : pa.get(p) !== pb.get(p) ? "바뀜" : "" }))
        .filter((x) => x.state);
      return { ta, tb, files };
    },
  });
  const label = `수정본 ${rev}`, now = current > 0 ? `지금(수정본 ${current})` : "지금";
  return (
    <Modal title={`${label} → ${now} 비교`} onClose={onClose} wide>
      <div className="max-h-[70dvh] min-h-40 overflow-y-auto">
        {q.error ? <EmptyState title="비교할 수 없습니다" body={String((q.error as Error).message)} />
          : !q.data ? <EmptyState title="불러오는 중…" />
          : q.data.ta !== null && q.data.tb !== null ? <TextDiff a={q.data.ta} b={q.data.tb} fromLabel={label} toLabel={now} />
          : (
            <div className="space-y-2 p-1 text-sm">
              <p className="text-xs text-muted">이 형식은 내용 비교를 지원하지 않아 바뀐 파일만 보여 줍니다.</p>
              {q.data.files.length === 0 ? <p>바뀐 파일이 없습니다.</p> : (
                <ul className="space-y-1 font-mono text-xs">
                  {q.data.files.map((f) => <li key={f.path}><span className="mr-2 rounded bg-sunken px-1">{f.state}</span>{f.path}</li>)}
                </ul>
              )}
            </div>
          )}
      </div>
    </Modal>
  );
}
