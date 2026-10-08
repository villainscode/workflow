import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from "fflate";
import { Parser } from "htmlparser2";
import { EditError, resolveChanges, textHash, type Adapter, type Change, type Segment } from "./types.ts";

/**
 * DOCX·PPTX 어댑터. zip 안 XML에서 글자 요소(<w:t>, <a:t>)의 원본 위치를 찾아 그 안의 글자만 바꾼다.
 * 같은 서식(rPr)의 run이 사이에 다른 내용 없이 이어지면 화면에서는 한 조각으로 합쳐 보여 주고,
 * 저장할 때는 첫 run에 글자를 모두 넣고 나머지 run은 비운다. 서식이 같으니 보이는 결과는 같다.
 */

type Kind = "docx" | "pptx";

interface TextEl { part: string; openStart: number; openEnd: number; closeStart: number; raw: string; rPr: string; para: number; where: string }
interface Located extends Segment { els: TextEl[] }

const PARTS: Record<Kind, RegExp> = {
  docx: /^word\/(document|header\d*|footer\d*)\.xml$/,
  pptx: /^ppt\/slides\/slide\d+\.xml$/,
};

const num = (s: string) => Number(s.match(/(\d+)\.xml$/)?.[1] ?? 0);
const partOrder = (a: string, b: string) => {
  const rank = (p: string) => (p.includes("document") ? 0 : p.includes("header") ? 1 : p.includes("footer") ? 2 : 3);
  return rank(a) - rank(b) || num(a) - num(b);
};

/**
 * PPTX 슬라이드의 실제 발표 순서(1부터). 파일 이름(slide3.xml)과 발표 순서는 다를 수 있으므로
 * presentation.xml의 슬라이드 목록 순서와 관계 파일(rels)의 대상 경로로 맞춘다.
 */
function slideOrder(zip: Record<string, Uint8Array>): Map<string, number> {
  const order = new Map<string, number>();
  const pres = zip["ppt/presentation.xml"], rels = zip["ppt/_rels/presentation.xml.rels"];
  if (!pres || !rels) return order;
  const target = new Map<string, string>();
  for (const m of strFromU8(rels).matchAll(/<Relationship\b[^>]*>/g)) {
    const id = /\bId="([^"]+)"/.exec(m[0])?.[1], t = /\bTarget="([^"]+)"/.exec(m[0])?.[1];
    if (id && t) target.set(id, "ppt/" + t.replace(/^\/?ppt\//, "").replace(/^\.\//, ""));
  }
  [...strFromU8(pres).matchAll(/<p:sldId\b[^>]*\br:id="([^"]+)"/g)].forEach((m, i) => {
    const t = target.get(m[1]);
    if (t) order.set(t, i + 1);
  });
  return order;
}

const decodeXml = (s: string) =>
  s.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-f]+);/gi, (_, e: string) =>
    e[0] === "#" ? String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : Number(e.slice(1)))
      : ({ lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" } as Record<string, string>)[e.toLowerCase()]);
const encodeXml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** XML 한 파트에서 글자 요소를 찾는다. 위치는 원본 문자열 기준이다 */
function scanPart(kind: Kind, part: string, xml: string, slideNo = 0): TextEl[] {
  const ns = kind === "docx" ? "w" : "a";
  const out: TextEl[] = [];
  let para = -1, slideShape = -1, tbl = 0, row = -1, cell = -1;
  let rPr = "", rPrStart = -1, inRun = false;
  let open: { start: number; end: number } | null = null;
  const parser = new Parser({
    onopentag(name) {
      const s = parser.startIndex, e = parser.endIndex;
      if (name === `${ns}:p`) para++;
      else if (name === "p:sp") slideShape++;
      else if (name === `${ns}:tbl`) tbl++;
      else if (name === `${ns}:tr`) { row++; cell = -1; }
      else if (name === `${ns}:tc`) cell++;
      else if (name === `${ns}:r`) { inRun = true; rPr = ""; }
      else if (name === `${ns}:rPr` && inRun) rPrStart = s;
      else if (name === `${ns}:t` && inRun) open = { start: s, end: e };
    },
    onclosetag(name) {
      const e = parser.endIndex;
      if (name === `${ns}:rPr` && rPrStart >= 0) { rPr = xml.slice(rPrStart, e + 1); rPrStart = -1; }
      else if (name === `${ns}:r`) inRun = false;
      else if (name === `${ns}:tbl`) { row = -1; cell = -1; }
      else if (name === `${ns}:t` && open) {
        const closeStart = parser.startIndex;
        // 자기 닫힘(<w:t/>)은 글자가 없으므로 편집 대상이 아니다
        if (closeStart > open.end) {
          const where = kind === "pptx"
            ? `슬라이드 ${slideNo} · ${row >= 0 ? `표 ${tbl} ${row + 1}행 ${cell + 1}열` : `도형 ${slideShape + 1}`}`
            : `${part.replace(/^word\/|\.xml$/g, "")}${row >= 0 ? ` · 표 ${tbl} ${row + 1}행 ${cell + 1}열` : ""}`;
          out.push({ part, openStart: open.start, openEnd: open.end, closeStart, raw: xml.slice(open.end + 1, closeStart), rPr, para, where });
        }
        open = null;
      }
    },
  }, { xmlMode: true });
  parser.write(xml);
  parser.end();
  return out;
}

/** 두 글자 요소 사이에 run 경계와 같은 서식 말고 아무것도 없으면 합칠 수 있다 */
function mergeable(kind: Kind, xml: string, a: TextEl, b: TextEl): boolean {
  if (a.part !== b.part || a.para !== b.para || a.rPr !== b.rPr) return false;
  const ns = kind === "docx" ? "w" : "a";
  const between = xml.slice(a.closeStart, b.openEnd + 1);
  const rPr = b.rPr.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^</${ns}:t>\\s*</${ns}:r>\\s*<${ns}:r(\\s[^>]*)?>\\s*${rPr}\\s*<${ns}:t(\\s[^>]*)?>$`).test(between);
}

function collect(kind: Kind, zip: Record<string, Uint8Array>): Located[] {
  const segs: Located[] = [];
  // PPTX는 발표 순서대로, 순서 목록에 없는 슬라이드 파일은 맨 뒤에 둔다
  const order = kind === "pptx" ? slideOrder(zip) : new Map<string, number>();
  const rank = (p: string) => order.get(p) ?? 10_000 + num(p);
  const parts = Object.keys(zip).filter((p) => PARTS[kind].test(p))
    .sort(kind === "pptx" ? (a, b) => rank(a) - rank(b) : partOrder);
  for (const part of parts) {
    const xml = strFromU8(zip[part]);
    const els = scanPart(kind, part, xml, order.get(part) ?? num(part));
    let group: TextEl[] = [];
    const flush = () => {
      if (group.length === 0) return;
      const text = group.map((e) => decodeXml(e.raw)).join("");
      if (text.length > 0) {
        segs.push({
          id: segs.length, text, hash: textHash(text), multiline: false,
          group: `${group[0].where} · 문단 ${group[0].para + 1}`, fmt: fmtOf(kind, group[0].rPr), els: group,
        });
      }
      group = [];
    };
    for (const el of els) {
      if (group.length && !mergeable(kind, xml, group[group.length - 1], el)) flush();
      group.push(el);
    }
    flush();
  }
  return segs;
}

/** run 서식(rPr)에서 굵게·기울임·밑줄만 읽어 목록 편집기에 보여 준다 */
function fmtOf(kind: Kind, rPr: string): string | undefined {
  const on = (tag: string) => new RegExp(`<w:${tag}(\\s+w:val="(true|1|on)")?\\s*/>`).test(rPr);
  const f = kind === "docx"
    ? [on("b") && "b", on("i") && "i", /<w:u\s+w:val="(?!none")/.test(rPr) && "u"]
    : [/\sb="1"/.test(rPr) && "b", /\si="1"/.test(rPr) && "i", /\su="(?!none")/.test(rPr) && "u"];
  return f.filter(Boolean).join(" ") || undefined;
}

const strip = ({ els: _e, ...seg }: Located): Segment => seg;

function makeAdapter(kind: Kind): Adapter {
  return {
    extract(data) {
      return collect(kind, unzipSync(data)).map(strip);
    },

    apply(data, changes: Change[]) {
      const zip = unzipSync(data);
      const segs = collect(kind, zip);
      const edits = resolveChanges(segs, changes);
      if (edits.size === 0) return { data, changed: 0 };

      // 파트별로 바꿀 글자 요소를 모아, 뒤쪽부터 바꾼다
      const byPart = new Map<string, { el: TextEl; text: string }[]>();
      for (const s of segs) {
        const text = edits.get(s.id);
        if (text === undefined) continue;
        s.els.forEach((el, i) => {
          const list = byPart.get(el.part) ?? [];
          list.push({ el, text: i === 0 ? text : "" });
          byPart.set(el.part, list);
        });
      }
      const out: Zippable = { ...zip };
      for (const [part, list] of byPart) {
        let xml = strFromU8(zip[part]);
        for (const { el, text } of list.sort((a, b) => b.el.openStart - a.el.openStart)) {
          let openTag = xml.slice(el.openStart, el.openEnd + 1);
          // Word는 앞뒤 공백이 있는 글자에 xml:space="preserve"가 없으면 공백을 지운다
          if (kind === "docx" && /^\s|\s$/.test(text) && !/xml:space=/.test(openTag)) {
            openTag = openTag.replace(/^<w:t/, '<w:t xml:space="preserve"');
          }
          xml = xml.slice(0, el.openStart) + openTag + encodeXml(text) + xml.slice(el.closeStart);
        }
        out[part] = strToU8(xml);
      }
      try {
        return { data: zipSync(out), changed: edits.size };
      } catch (e) {
        throw new EditError(500, `파일을 다시 묶지 못했습니다: ${(e as Error).message}`);
      }
    },
  };
}

export const docxAdapter = makeAdapter("docx");
export const pptxAdapter = makeAdapter("pptx");
