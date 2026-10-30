import { createElement, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { Slide, SlideNode } from "@workflow/core/slide";
import { useAssetUrl } from "../../lib/deck.ts";
import "./slide-base.css";

/**
 * 슬라이드 렌더러(명세 05절). 노드 트리를 React 요소로 그린다(innerHTML 금지). 허용 목록 밖은 그릴 방법이 없다.
 * 글자 조각만 core가 검증한 인라인 HTML(b i u a span br)이라 dangerouslySetInnerHTML로 넣는다.
 * 보기·썸네일·발표·편집이 모두 이 컴포넌트를 쓴다. 편집에서는 요소마다 data-eid를 붙인다.
 */

const camel = (k: string) => k.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
const toStyle = (s: Record<string, string>): CSSProperties => Object.fromEntries(Object.entries(s).map(([k, v]) => [camel(k), v]));
// 링크는 새 탭으로, 원래 창을 건드리지 못하게
const linkSafe = (html: string) => html.replace(/<a href=/g, '<a target="_blank" rel="noopener noreferrer" href=');

function Img({ node, eid }: { node: Extract<SlideNode, { kind: "el" }>; eid?: string }) {
  const url = useAssetUrl(node.attrs.src);
  const style = toStyle(node.style);
  if (!url) return <div data-eid={eid} className="slide-img-missing" style={style} role="img" aria-label={node.attrs.alt}>{node.attrs.alt || "그림"}</div>;
  return <img data-eid={eid} src={url} alt={node.attrs.alt ?? ""} style={style} draggable={false} />;
}

/** 편집 중인 요소: 그 요소의 내용 자리에 글자 편집기를 넣는다 */
export interface Editing { eid: string; content: ReactNode }

function render(node: SlideNode, key: number, edit: boolean, root = false, editing?: Editing): ReactNode {
  if (node.kind === "text") return <span key={key} dangerouslySetInnerHTML={{ __html: linkSafe(node.html) }} />;
  const eid = edit ? node.eid : undefined;
  if (node.tag === "img") return <Img key={key} node={node} eid={eid} />;
  const style = toStyle(node.style);
  if (node.tag === "hr") return <hr key={key} data-eid={eid} style={style} />;
  const onlyText = node.children.length > 0 && node.children.every((c) => c.kind === "text");
  const props: Record<string, unknown> = { key, "data-eid": eid, style, className: root ? "slide-root" : undefined };
  if (editing && editing.eid === node.eid) return createElement(node.tag, props, editing.content);
  if (onlyText) {
    props.dangerouslySetInnerHTML = { __html: linkSafe(node.children.map((c) => (c as { html: string }).html).join("")) };
    return createElement(root ? "div" : node.tag, props);
  }
  let kids: ReactNode[] = node.children.map((c, i) => render(c, i, edit, false, editing));
  // 형식은 table > tr이지만 DOM에는 tbody가 있어야 한다
  if (node.tag === "table") kids = [<tbody key="b">{kids}</tbody>];
  return createElement(root ? "div" : node.tag, props, ...kids);
}

/** 1920×1080 슬라이드 하나(배율 없이). 바깥에서 SlideCanvas로 줄인다 */
export function SlideRenderer({ slide, edit = false, family, editing }: { slide: Slide; edit?: boolean; family?: string; editing?: Editing }) {
  const el = render(slide.root, 0, edit, true, editing);
  return <div style={family ? { fontFamily: family } : undefined} className="contents">{el}</div>;
}

/**
 * 1920×1080을 주어진 너비(없으면 부모 너비)에 맞춰 transform: scale로 줄인다. 좌표계는 늘 1920×1080이다.
 * children은 캔버스 좌표로 그린다(편집 레이어도 같은 변환 안에 둔다)
 */
export function SlideCanvas({ width, children, onScale }: { width?: number; children: ReactNode; onScale?: (s: number) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(width ?? 0);
  useEffect(() => {
    if (width !== undefined) { setW(width); return; }
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    setW(el.clientWidth);
    return () => ro.disconnect();
  }, [width]);
  const scale = w / 1920;
  useEffect(() => { if (scale > 0) onScale?.(scale); }, [scale, onScale]);
  return (
    <div ref={box} style={{ width: width ?? "100%", height: w * (1080 / 1920), position: "relative", overflow: "hidden" }}>
      {w > 0 && (
        <div style={{ width: 1920, height: 1080, transform: `scale(${scale})`, transformOrigin: "0 0", position: "absolute", left: 0, top: 0 }}>
          {children}
        </div>
      )}
    </div>
  );
}
