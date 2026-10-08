import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from "fflate";
import { Parser } from "htmlparser2";
import { decodeXml, encodeXml } from "./ooxml.ts";
import { EditError, resolveChanges, textHash, type Adapter, type Change, type Segment } from "./types.ts";

/**
 * XLSX 어댑터(2.0, REQUIREMENT-2.0 2.6). 문자 셀의 글자만 고친다. 숫자·수식 셀은 건드리지 않는다.
 * - 공유 문자열(<c t="s"><v>번호</v>): 글자는 xl/sharedStrings.xml의 <si>에 있고 여러 셀이 같은 <si>를 가리킬 수 있다.
 *   그 셀만 쓰는 <si>면 그 자리에서 고치고, 여러 셀이 함께 쓰면 고친 셀용 새 <si>를 끝에 붙이고 그 셀만 새 번호를 가리키게 한다.
 * - 인라인 문자열(<c t="inlineStr"><is><t>): 시트 XML 안의 글자를 그 자리에서 고친다.
 * - 한 셀 안에서 서식이 다른 글자(리치 텍스트 run)는 조각을 나눈다.
 */

const SST = "xl/sharedStrings.xml";

/** 글자 요소(<t>) 하나의 원본 위치. 위치는 그 요소가 들어 있는 XML 문자열 기준이다 */
interface TextEl { openStart: number; openEnd: number; closeStart: number; raw: string; rPr: string }
interface SharedString { start: number; end: number; ts: TextEl[] }
interface Cell { ref: string; type: string; vStart: number; vEnd: number; v: string; ts: TextEl[] }
interface Sheet { part: string; name: string; xml: string; cells: Cell[] }

/** <si>(공유 문자열) 목록. 일본어 읽기(<rPh>) 안의 <t>는 글자가 아니므로 뺀다 */
function scanShared(xml: string): SharedString[] {
  const out: SharedString[] = [];
  let cur: SharedString | null = null, inPh = false, rPr = "", rPrStart = -1, open: { start: number; end: number } | null = null;
  const parser = new Parser({
    onopentag(name) {
      const s = parser.startIndex, e = parser.endIndex;
      // 서식(rPr)은 문자열마다 새로 읽는다(앞 문자열의 굵게가 넘어오지 않게)
      if (name === "si") { cur = { start: s, end: -1, ts: [] }; rPr = ""; }
      else if (name === "rPh") inPh = true;
      else if (name === "r") rPr = "";
      else if (name === "rPr") rPrStart = s;
      else if (name === "t" && cur && !inPh) open = { start: s, end: e };
    },
    onclosetag(name) {
      const e = parser.endIndex;
      if (name === "rPh") inPh = false;
      else if (name === "rPr" && rPrStart >= 0) { rPr = xml.slice(rPrStart, e + 1); rPrStart = -1; }
      else if (name === "t" && open && cur) {
        const closeStart = parser.startIndex;
        if (closeStart > open.end) cur.ts.push({ openStart: open.start, openEnd: open.end, closeStart, raw: xml.slice(open.end + 1, closeStart), rPr });
        open = null;
      } else if (name === "si" && cur) { cur.end = e + 1; out.push(cur); cur = null; }
    },
  }, { xmlMode: true });
  parser.write(xml);
  parser.end();
  return out;
}

/** 시트의 셀 목록: 주소, 형식(t), 값(<v>) 위치, 인라인 글자(<is><t>). 수식(<f>)이 있는 셀은 뺀다 */
function scanSheet(xml: string): Cell[] {
  const out: Cell[] = [];
  let cur: (Cell & { formula: boolean }) | null = null;
  let vStart = -1, rPr = "", rPrStart = -1, inIs = false, inPh = false, open: { start: number; end: number } | null = null;
  const parser = new Parser({
    onopentag(name, attrs) {
      const s = parser.startIndex, e = parser.endIndex;
      if (name === "c") { cur = { ref: attrs.r ?? "", type: attrs.t ?? "n", vStart: -1, vEnd: -1, v: "", ts: [], formula: false }; rPr = ""; }
      else if (!cur) return;
      else if (name === "f") cur.formula = true;
      else if (name === "v") vStart = e + 1;
      else if (name === "is") inIs = true;
      else if (name === "rPh") inPh = true;
      else if (name === "r") rPr = "";
      else if (name === "rPr") rPrStart = s;
      else if (name === "t" && inIs && !inPh) open = { start: s, end: e };
    },
    onclosetag(name) {
      const e = parser.endIndex;
      if (!cur) return;
      if (name === "v" && vStart >= 0) { cur.vStart = vStart; cur.vEnd = parser.startIndex; cur.v = xml.slice(vStart, parser.startIndex); vStart = -1; }
      else if (name === "is") inIs = false;
      else if (name === "rPh") inPh = false;
      else if (name === "rPr" && rPrStart >= 0) { rPr = xml.slice(rPrStart, e + 1); rPrStart = -1; }
      else if (name === "t" && open) {
        const closeStart = parser.startIndex;
        if (closeStart > open.end) cur.ts.push({ openStart: open.start, openEnd: open.end, closeStart, raw: xml.slice(open.end + 1, closeStart), rPr });
        open = null;
      } else if (name === "c") {
        if (!cur.formula && (cur.type === "s" || cur.type === "inlineStr")) out.push(cur);
        cur = null;
      }
    },
  }, { xmlMode: true });
  parser.write(xml);
  parser.end();
  return out;
}

/** workbook.xml의 시트 순서·이름과 관계 파일로 시트 파트 경로를 맞춘다 */
function sheets(zip: Record<string, Uint8Array>): Sheet[] {
  const wb = zip["xl/workbook.xml"], rels = zip["xl/_rels/workbook.xml.rels"];
  if (!wb || !rels) throw new EditError(400, "엑셀 파일 구조(workbook.xml)를 읽을 수 없습니다");
  const target = new Map<string, string>();
  for (const m of strFromU8(rels).matchAll(/<Relationship\b[^>]*>/g)) {
    const id = /\bId="([^"]+)"/.exec(m[0])?.[1], t = /\bTarget="([^"]+)"/.exec(m[0])?.[1];
    if (id && t) target.set(id, t.startsWith("/") ? t.slice(1) : "xl/" + t.replace(/^\.\//, ""));
  }
  return [...strFromU8(wb).matchAll(/<sheet\b[^>]*>/g)].flatMap((m) => {
    const name = decodeXml(/\bname="([^"]*)"/.exec(m[0])?.[1] ?? "");
    const part = target.get(/\br:id="([^"]+)"/.exec(m[0])?.[1] ?? "");
    if (!part || !zip[part]) return [];
    const xml = strFromU8(zip[part]);
    return [{ part, name, xml, cells: scanSheet(xml) }];
  });
}

const fmtOf = (rPr: string) =>
  [/<b(\s+val="(true|1)")?\s*\/>/.test(rPr) && "b", /<i(\s+val="(true|1)")?\s*\/>/.test(rPr) && "i", /<u(\s|\/)/.test(rPr) && !/<u\s+val="none"/.test(rPr) && "u"]
    .filter(Boolean).join(" ") || undefined;

/** 조각 하나 = 한 셀의 run 하나. el은 그 글자 요소, shared는 공유 문자열 번호(인라인이면 없음) */
interface Located extends Segment { sheet: Sheet; cell: Cell; run: number; el: TextEl; shared?: number }

function collect(zip: Record<string, Uint8Array>): { segs: Located[]; sst: SharedString[]; sstXml: string; list: Sheet[] } {
  const sstXml = zip[SST] ? strFromU8(zip[SST]) : "";
  const sst = sstXml ? scanShared(sstXml) : [];
  const list = sheets(zip);
  const segs: Located[] = [];
  for (const sheet of list) {
    for (const cell of sheet.cells) {
      const shared = cell.type === "s" ? Number(cell.v) : undefined;
      const ts = shared !== undefined ? sst[shared]?.ts ?? [] : cell.ts;
      ts.forEach((el, run) => {
        const text = decodeXml(el.raw);
        if (!text) return;
        segs.push({
          id: segs.length, text, hash: textHash(text), multiline: /\n/.test(text),
          group: `${sheet.name} · ${cell.ref}`, fmt: fmtOf(el.rPr), sheet, cell, run, el, shared,
        });
      });
    }
  }
  return { segs, sst, sstXml, list };
}

const strip = ({ sheet: _s, cell: _c, run: _r, el: _e, shared: _sh, ...seg }: Located): Segment => seg;

/** <t> 하나의 글자를 바꾼 XML 조각. 앞뒤 공백·줄바꿈이 있으면 xml:space="preserve"를 붙인다 */
function setText(xml: string, el: TextEl, text: string, offset = 0): string {
  let openTag = xml.slice(el.openStart - offset, el.openEnd - offset + 1);
  if (/^\s|\s$/.test(text) && !/xml:space=/.test(openTag)) openTag = openTag.replace(/^<t/, '<t xml:space="preserve"');
  return xml.slice(0, el.openStart - offset) + openTag + encodeXml(text) + xml.slice(el.closeStart - offset);
}

export const xlsxAdapter: Adapter = {
  extract(data) {
    return collect(unzipSync(data)).segs.map(strip);
  },

  apply(data, changes: Change[]) {
    const zip = unzipSync(data);
    const { segs, sst, sstXml, list } = collect(zip);
    const edits = resolveChanges(segs, changes);
    if (edits.size === 0) return { data, changed: 0 };

    // 공유 문자열마다 몇 셀이 가리키는지
    const uses = new Map<number, number>();
    for (const sh of list) for (const c of sh.cells) if (c.type === "s") uses.set(Number(c.v), (uses.get(Number(c.v)) ?? 0) + 1);

    // 셀 단위로 바뀐 run을 모은다
    const byCell = new Map<Cell, { seg: Located; text: string }[]>();
    for (const seg of segs) {
      const text = edits.get(seg.id);
      if (text === undefined) continue;
      byCell.set(seg.cell, [...(byCell.get(seg.cell) ?? []), { seg, text }]);
    }

    const sstEdits: { el: TextEl; text: string }[] = [];          // 그 자리에서 고칠 공유 문자열 글자
    const appended: string[] = [];                                // 끝에 붙일 새 <si>
    const sheetEdits = new Map<Sheet, { start: number; end: number; str: string }[]>();
    const addSheetEdit = (sh: Sheet, e: { start: number; end: number; str: string }) => sheetEdits.set(sh, [...(sheetEdits.get(sh) ?? []), e]);

    for (const [cell, list2] of byCell) {
      const { sheet, shared } = list2[0].seg;
      if (shared === undefined) {
        // 인라인 문자열: 시트 XML의 <t>를 그 자리에서
        for (const { seg, text } of list2) {
          const piece = setText(sheet.xml.slice(seg.el.openStart, seg.el.closeStart), seg.el, text, seg.el.openStart);
          addSheetEdit(sheet, { start: seg.el.openStart, end: seg.el.closeStart, str: piece });
        }
      } else if ((uses.get(shared) ?? 0) <= 1) {
        for (const { seg, text } of list2) sstEdits.push({ el: seg.el, text });
      } else {
        // 여러 셀이 함께 쓰는 문자열: 이 셀만 새 <si>를 가리키게 한다
        const si = sst[shared];
        let raw = sstXml.slice(si.start, si.end);
        for (const { seg, text } of [...list2].sort((a, b) => b.seg.el.openStart - a.seg.el.openStart)) raw = setText(raw, seg.el, text, si.start);
        const index = sst.length + appended.length;
        appended.push(raw);
        addSheetEdit(sheet, { start: cell.vStart, end: cell.vEnd, str: String(index) });
      }
    }

    const out: Zippable = { ...zip };
    if (sstEdits.length || appended.length) {
      let xml = sstXml;
      for (const { el, text } of sstEdits.sort((a, b) => b.el.openStart - a.el.openStart)) xml = setText(xml, el, text);
      if (appended.length) {
        xml = xml.replace(/<\/sst>\s*$/, appended.join("") + "</sst>");
        // uniqueCount(서로 다른 문자열 수)만 늘어난다. count(셀 참조 수)는 그대로다
        xml = xml.replace(/(<sst\b[^>]*\buniqueCount=")(\d+)(")/, (_, a: string, n: string, b: string) => a + (Number(n) + appended.length) + b);
      }
      out[SST] = strToU8(xml);
    }
    for (const [sheet, list2] of sheetEdits) {
      let xml = sheet.xml;
      for (const e of list2.sort((a, b) => b.start - a.start)) xml = xml.slice(0, e.start) + e.str + xml.slice(e.end);
      out[sheet.part] = strToU8(xml);
    }
    return { data: zipSync(out), changed: edits.size };
  },
};
