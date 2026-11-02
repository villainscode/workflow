// svgcanvas의 PDF 내보내기(jspdf)는 쓰지 않는다. 번들에서 빼려고 빈 모듈로 바꾼다(vite.config.ts 별칭, V0 스파이크 2)
export class jsPDF {
  constructor() { throw new Error("PDF 내보내기는 쓰지 않습니다"); }
}
