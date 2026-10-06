import { TransformComponent, TransformWrapper } from "react-zoom-pan-pinch";

const btn = "rounded-md border border-line bg-surface px-2.5 py-1 text-xs hover:bg-sunken";

/** SVG도 <img>로 표시하므로 SVG 안의 스크립트는 실행되지 않는다. */
export function ImageViewer({ url }: { url: string }) {
  return (
    <TransformWrapper minScale={0.1} maxScale={16} centerOnInit limitToBounds={false}>
      {({ zoomIn, zoomOut, resetTransform, centerView }) => (
        <div className="relative h-full">
          <div className="absolute top-3 right-3 z-10 flex gap-1">
            <button className={btn} onClick={() => zoomOut()} aria-label="축소">−</button>
            <button className={btn} onClick={() => zoomIn()} aria-label="확대">+</button>
            <button className={btn} onClick={() => centerView(1)}>1:1</button>
            <button className={btn} onClick={() => resetTransform()}>맞춤</button>
          </div>
          <TransformComponent
            wrapperStyle={{ width: "100%", height: "100%" }}
            // 라이브러리가 콘텐츠를 display:flex로 두므로 flex 기준으로 가운데 정렬한다
            contentStyle={{ width: "100%", height: "100%", justifyContent: "center", alignItems: "center", padding: 24 }}
          >
            <img src={url} alt="" className="max-h-full max-w-full object-contain" draggable={false} />
          </TransformComponent>
        </div>
      )}
    </TransformWrapper>
  );
}
