/**
 * 브라우저 내장 PDF 뷰어로 연다. 페이지 이동, 확대, 썸네일, 검색, 인쇄를 브라우저가 제공한다.
 * Chrome은 sandbox iframe 안에서 PDF를 열지 않으므로 sandbox를 걸지 않는다(PDF는 사이트에 접근하지 못한다).
 */
export function PdfViewer({ url, note }: { url: string; note?: string }) {
  return (
    <div className="grid h-full grid-rows-[auto_minmax(0,1fr)]">
      {note ? <p className="border-b border-line bg-surface px-4 py-1.5 text-xs text-muted">{note}</p> : <span />}
      <iframe src={url} title="PDF" className="block h-full w-full border-0 bg-surface" />
    </div>
  );
}
