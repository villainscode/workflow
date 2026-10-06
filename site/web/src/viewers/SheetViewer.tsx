import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { EmptyState } from "../components/EmptyState.tsx";

const MAX_ROWS = 2000;

/** XLSX·CSV를 시트 탭 + 표로 보여준다(읽기 전용). */
export function SheetViewer({ url, csv }: { url: string; csv?: boolean }) {
  const [active, setActive] = useState(0);
  const { data, error } = useQuery({
    queryKey: ["sheet", url],
    queryFn: async () => {
      const [XLSX, res] = await Promise.all([import("xlsx"), fetch(url)]);
      // CSV는 바이트로 넘기면 인코딩을 잘못 추측하므로 UTF-8 텍스트로 읽어 넘긴다
      const wb = csv
        ? XLSX.read((await res.text()).replace(/^\uFEFF/, ""), { type: "string", dense: true })
        : XLSX.read(await res.arrayBuffer(), { dense: true });
      return wb.SheetNames.map((name) => ({
        name,
        rows: XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[name], { header: 1, raw: false, defval: "" }),
      }));
    },
  });

  if (error) return <EmptyState title="표를 읽을 수 없습니다" body={String(error)} />;
  if (!data) return <EmptyState title="불러오는 중…" />;
  const sheet = data[active];
  const rows = sheet?.rows.slice(0, MAX_ROWS) ?? [];
  const cols = Math.max(0, ...rows.map((r) => r.length));

  return (
    <div className="grid h-full grid-rows-[auto_minmax(0,1fr)]">
      <div className="flex flex-wrap gap-1 border-b border-line bg-surface px-4 py-1.5">
        {data.map((s, i) => (
          <button key={s.name} onClick={() => setActive(i)}
            className={`rounded-md px-2.5 py-1 text-xs ${i === active ? "bg-accent-soft text-accent" : "text-muted hover:bg-sunken"}`}>
            {s.name}
          </button>
        ))}
        <span className="ml-auto self-center font-mono text-[11px] text-muted">
          {sheet?.rows.length ?? 0}행 × {cols}열{(sheet?.rows.length ?? 0) > MAX_ROWS ? ` (앞 ${MAX_ROWS}행만 표시)` : ""}
        </span>
      </div>
      <div className="overflow-y-auto p-4">
        {/* 열이 많아도 가로 스크롤 대신 칸 안에서 줄을 바꾼다 */}
        <table className="w-full table-fixed border-collapse bg-surface text-xs">
          <tbody>
            {rows.map((r, ri) => (
              <tr key={ri} className={ri === 0 ? "bg-sunken font-medium" : ""}>
                <th className="w-10 border border-line px-1 py-1 text-right font-mono font-normal text-muted">{ri + 1}</th>
                {Array.from({ length: cols }, (_, ci) => (
                  <td key={ci} className="border border-line px-2 py-1 align-top break-words">{String(r[ci] ?? "")}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
