/** 스크립트를 켜고 끈 sandbox 값. 어느 쪽이든 allow-same-origin은 주지 않는다 */
export const htmlSandbox = (scripts = true) =>
  `${scripts ? "allow-scripts " : ""}allow-popups allow-popups-to-escape-sandbox allow-downloads`;

/**
 * docs/의 HTML 문서를 그대로 연다. 문서 안의 복사 버튼 같은 스크립트는 동작하게 두고,
 * allow-same-origin은 주지 않아 사이트(부모 창)에는 접근하지 못하게 한다.
 * 외부에서 가져온 문서는 scripts=false로 스크립트를 끈 채 연다(3.3).
 */
export function HtmlViewer({ url, scripts = true }: { url: string; scripts?: boolean }) {
  return (
    <iframe
      src={url}
      title="문서"
      className="block h-full w-full border-0 bg-surface"
      sandbox={htmlSandbox(scripts)}
    />
  );
}
