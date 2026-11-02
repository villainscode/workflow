import type { TextCommands, TextState } from "../../editor/TextToolbar.tsx";

/**
 * HTML 편집 사본(iframe)의 contenteditable 요소에 글자 도구 막대 명령을 댄다(6.0 V2).
 * 굵게·기울임·밑줄·링크는 브라우저 편집 명령(<b>·<i>·<u>·<a>), 색·글꼴·크기는 고른 글자를 <span style>로 감싼다.
 * 서버가 저장할 때 span style은 color·font-family·font-size·font-weight만 남긴다(core sanitizeInline).
 * 막대의 목록·입력칸으로 포커스가 옮겨 가도 선택을 잃지 않게 마지막 선택 범위를 기억해 두었다가 되살린다.
 */

type Prop = "color" | "font-family" | "font-size";

export function inlineText(doc: Document, root: HTMLElement) {
  let saved: Range | null = null;
  const inside = (n: Node | null) => !!n && root.contains(n);
  const remember = () => {
    const sel = doc.getSelection();
    if (sel && sel.rangeCount && inside(sel.anchorNode)) saved = sel.getRangeAt(0).cloneRange();
  };
  doc.addEventListener("selectionchange", remember);
  const restore = () => {
    root.focus();
    const sel = doc.getSelection();
    if (saved && sel) { sel.removeAllRanges(); sel.addRange(saved); }
    return sel;
  };
  const exec = (name: string, value?: string) => { restore(); doc.execCommand(name, false, value); remember(); };

  /** 선택 위치에서 root까지 올라가며 그 속성을 가진 가장 가까운 span */
  const spanWith = (prop: Prop): HTMLElement | null => {
    for (let n: Node | null = saved?.startContainer ?? null; n && n !== root; n = n.parentNode) {
      if (n instanceof doc.defaultView!.HTMLElement && n.tagName === "SPAN" && n.style.getPropertyValue(prop)) return n;
    }
    return null;
  };
  const unwrapEmpty = (s: HTMLElement) => {
    if (s.getAttribute("style")?.trim()) return;
    s.replaceWith(...s.childNodes);
  };
  const style = (prop: Prop, value: string | null) => {
    const sel = restore();
    if (!saved || !sel) return;
    if (value === null) {
      // 지우기: 고른 범위 안의 span과, 범위를 감싼 span에서 그 속성을 뺀다
      const around = spanWith(prop);
      around?.style.removeProperty(prop);
      root.querySelectorAll("span").forEach((s) => { if (saved!.intersectsNode(s)) { s.style.removeProperty(prop); unwrapEmpty(s); } });
      if (around?.isConnected) unwrapEmpty(around);
      remember();
      return;
    }
    if (saved.collapsed) return;
    const span = doc.createElement("span");
    span.style.setProperty(prop, value);
    span.appendChild(saved.extractContents());
    span.querySelectorAll("span").forEach((s) => { s.style.removeProperty(prop); unwrapEmpty(s); });
    saved.insertNode(span);
    const r = doc.createRange();
    r.selectNodeContents(span);
    sel.removeAllRanges();
    sel.addRange(r);
    saved = r.cloneRange();
  };

  const cmd: TextCommands = {
    toggleBold: () => exec("bold"),
    toggleItalic: () => exec("italic"),
    toggleUnderline: () => exec("underline"),
    setFontFamily: (v) => style("font-family", v),
    setFontSize: (v) => style("font-size", v),
    setColor: (v) => style("color", v),
    linkHref: () => {
      for (let n: Node | null = saved?.startContainer ?? null; n && n !== root; n = n.parentNode) if ((n as Element).tagName === "A") return (n as HTMLAnchorElement).getAttribute("href") ?? "";
      return "";
    },
    setLink: (href) => exec("createLink", href),
    unsetLink: () => exec("unlink"),
    focus: () => { restore(); },
  };

  const read = (): TextState => {
    const q = (c: string) => { try { return doc.queryCommandState(c); } catch { return false; } };
    return {
      bold: q("bold"), italic: q("italic"), underline: q("underline"), link: !!cmd.linkHref(),
      color: spanWith("color")?.style.getPropertyValue("color") ?? "",
      fontFamily: spanWith("font-family")?.style.getPropertyValue("font-family") ?? "",
      fontSize: spanWith("font-size")?.style.getPropertyValue("font-size") ?? "",
    };
  };

  return { cmd, read, dispose: () => doc.removeEventListener("selectionchange", remember) };
}
