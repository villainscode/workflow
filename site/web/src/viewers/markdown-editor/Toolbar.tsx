// MarkFlow 에디터의 서식 툴바. 사이트 규칙에 맞춰 IconButton(공통 툴팁 data-tip)으로 바꾸고,
// 자체 밝게·어둡게 버튼은 뺐다(사이트 다크 모드를 따른다). 오른쪽 끝(end)에 저장 영역을 받는다.

import { memo, type ReactNode } from "react";
import {
  Heading1, Heading2, Heading3, Heading4, Heading5, Heading6,
  Bold, Italic, Strikethrough, Code,
  List, ListOrdered, ListChecks,
  Quote, SquareCode, Minus,
  Link, Image, ImageUp, Table,
  Sigma, SquareSigma,
  PenLine, Columns2, Eye,
  Settings,
} from "lucide-react";
import { IconButton } from "../../components/IconButton.tsx";
import type { EditorLayout, ToolbarAction } from "./types.ts";

const SIZE = 17;
const HEADINGS = [Heading1, Heading2, Heading3, Heading4, Heading5, Heading6] as const;

const Sep = () => <span className="mx-1 h-5 w-px shrink-0 self-center bg-line" aria-hidden />;

export const Toolbar = memo(function Toolbar({ onAction, layout, onLayoutChange, onSettingsClick, onImageUploadClick, readOnly, end }: {
  onAction: (action: ToolbarAction) => void;
  layout: EditorLayout;
  onLayoutChange: (layout: EditorLayout) => void;
  onSettingsClick: () => void;
  onImageUploadClick: () => void;
  /** 이전 버전: 서식 버튼 없이 보기 방식만 */
  readOnly?: boolean;
  end?: ReactNode;
}) {
  const btn = (label: string, icon: typeof Bold, action: ToolbarAction) =>
    <IconButton key={label} icon={icon} label={label} size={SIZE} onClick={() => onAction(action)} />;

  return (
    <div role="toolbar" aria-label="Markdown 서식" className="flex flex-wrap items-center gap-0.5 border-b border-line bg-surface px-3 py-1">
      {!readOnly && (
        <>
          {HEADINGS.map((icon, i) => btn(`제목 ${i + 1}`, icon, { type: "heading", level: (i + 1) as 1 | 2 | 3 | 4 | 5 | 6 }))}
          <Sep />
          {btn("굵게", Bold, { type: "bold" })}
          {btn("기울임", Italic, { type: "italic" })}
          {btn("취소선", Strikethrough, { type: "strikethrough" })}
          {btn("인라인 코드", Code, { type: "code" })}
          <Sep />
          {btn("글머리 목록", List, { type: "ul" })}
          {btn("번호 목록", ListOrdered, { type: "ol" })}
          {btn("할 일 목록", ListChecks, { type: "task" })}
          <Sep />
          {btn("인용", Quote, { type: "blockquote" })}
          {btn("코드 블록", SquareCode, { type: "codeblock" })}
          {btn("구분선", Minus, { type: "hr" })}
          <Sep />
          {btn("링크", Link, { type: "link" })}
          {btn("이미지 주소", Image, { type: "image" })}
          <IconButton icon={ImageUp} label="이미지 올리기 (Cloudflare R2)" size={SIZE} onClick={onImageUploadClick} />
          {btn("표", Table, { type: "table" })}
          <Sep />
          {btn("인라인 수식 ($…$)", Sigma, { type: "math-inline" })}
          {btn("수식 블록 ($$…$$)", SquareSigma, { type: "math-block" })}
          <Sep />
          <IconButton icon={Settings} label="이미지 업로드 설정" size={SIZE} onClick={onSettingsClick} />
          <Sep />
        </>
      )}
      <IconButton icon={PenLine} label="편집만" size={SIZE} active={layout === "editor"} onClick={() => onLayoutChange("editor")} />
      <IconButton icon={Columns2} label="나란히 보기" size={SIZE} active={layout === "split"} className="hidden lg:inline-flex" onClick={() => onLayoutChange("split")} />
      <IconButton icon={Eye} label="미리보기만" size={SIZE} active={layout === "preview"} onClick={() => onLayoutChange("preview")} />
      {end}
    </div>
  );
});
