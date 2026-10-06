import { useQuery } from "@tanstack/react-query";
import { EmptyState } from "../components/EmptyState.tsx";

const LANG: Record<string, string> = {
  md: "markdown", yml: "yaml", mmd: "markdown", drawio: "xml", txt: "text", csv: "csv", sh: "bash",
};

export function CodeViewer({ url, lang }: { url: string; lang: string }) {
  const { data, error } = useQuery({
    queryKey: ["code", url],
    queryFn: async () => {
      const text = await (await fetch(url)).text();
      // Shiki는 크므로 코드 뷰어를 처음 열 때만 불러온다
      const { codeToHtml } = await import("shiki");
      return codeToHtml(text, {
        lang: LANG[lang] ?? lang,
        themes: { light: "github-light", dark: "github-dark" },
        defaultColor: "light",
      });
    },
  });

  if (error) return <EmptyState title="파일을 읽을 수 없습니다" body={String(error)} />;
  if (!data) return <EmptyState title="불러오는 중…" />;
  return (
    <div className="h-full overflow-y-auto p-4">
      <div className="rounded-lg border border-line bg-surface p-4" dangerouslySetInnerHTML={{ __html: data }} />
    </div>
  );
}
