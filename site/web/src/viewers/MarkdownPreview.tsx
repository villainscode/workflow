import { useEffect, useId, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import Markdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import { useDark } from "../lib/useDark.ts";

function CodeBlock({ code, lang }: { code: string; lang: string }) {
  const { data } = useQuery({
    queryKey: ["shiki", lang, code],
    queryFn: async () => {
      const { codeToHtml, bundledLanguages } = await import("shiki");
      return codeToHtml(code, {
        lang: lang in bundledLanguages ? lang : "text",
        themes: { light: "github-light", dark: "github-dark" },
        defaultColor: "light",
      });
    },
    staleTime: Infinity,
  });
  return data
    ? <div className="my-3 rounded-md border border-line bg-surface p-3" dangerouslySetInnerHTML={{ __html: data }} />
    : <pre className="my-3 rounded-md border border-line bg-surface p-3 text-[13px] whitespace-pre-wrap">{code}</pre>;
}

function Mermaid({ code }: { code: string }) {
  const id = "m" + useId().replace(/[^a-zA-Z0-9]/g, "");
  const dark = useDark();
  const ref = useRef<HTMLDivElement>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { default: mermaid } = await import("mermaid");
        mermaid.initialize({ startOnLoad: false, theme: dark ? "dark" : "default", securityLevel: "strict" });
        const { svg } = await mermaid.render(id, code);
        if (!cancelled && ref.current) { ref.current.innerHTML = svg; setError(""); }
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    })();
    return () => { cancelled = true; };
  }, [code, dark, id]);
  return (
    <div className="my-3">
      <div ref={ref} className="flex justify-center [&_svg]:h-auto [&_svg]:max-w-full" />
      {error && <pre className="rounded-md bg-high-soft p-2 text-xs whitespace-pre-wrap text-high">Mermaid 오류: {error}</pre>}
    </div>
  );
}

/** Markdown 미리보기. 상대 경로 이미지·링크는 문서 버전 폴더(baseUrl) 기준으로 푼다. */
export function MarkdownPreview({ source, baseUrl }: { source: string; baseUrl: string }) {
  const resolveUrl = (url: string) => {
    const safe = defaultUrlTransform(url);
    if (!safe || /^([a-z]+:|\/|#)/i.test(safe)) return safe;
    return new URL(safe, location.origin + baseUrl).pathname;
  };
  return (
    <article className="md-body">
      <Markdown
        remarkPlugins={[remarkGfm]}
        urlTransform={resolveUrl}
        components={{
          a: ({ node: _n, ...props }) => <a {...props} target={props.href?.startsWith("#") ? undefined : "_blank"} rel="noreferrer" />,
          pre: ({ children }) => <>{children}</>,
          code: ({ node: _n, className, children, ...props }) => {
            const lang = /language-([\w-]+)/.exec(className ?? "")?.[1];
            const text = String(children).replace(/\n$/, "");
            if (lang === "mermaid") return <Mermaid code={text} />;
            if (lang || text.includes("\n")) return <CodeBlock code={text} lang={lang ?? "text"} />;
            return <code className={className} {...props}>{children}</code>;
          },
        }}
      >
        {source}
      </Markdown>
    </article>
  );
}
