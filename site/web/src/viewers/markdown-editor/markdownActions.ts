// MarkFlow 에디터에서 가져온 툴바 서식 동작. 각 동작은 EditorView의 문서·선택 영역을 바꾼다.
// 넣는 자리표시 글자는 한국어로 바꿨다.

import type { EditorView } from '@codemirror/view'
import { EditorSelection } from '@codemirror/state'
import type { ToolbarAction } from './types.ts'

/** Wrap selected text (or insert placeholder) with prefix/suffix */
function wrapSelection(
  view: EditorView,
  prefix: string,
  suffix: string,
  placeholder: string
): void {
  const { state, dispatch } = view
  const changes = state.changeByRange((range) => {
    const selected = state.sliceDoc(range.from, range.to)
    const text = selected.length ? selected : placeholder
    const inserted = prefix + text + suffix
    return {
      changes: { from: range.from, to: range.to, insert: inserted },
      range: EditorSelection.range(
        range.from + prefix.length,
        range.from + prefix.length + text.length
      ),
    }
  })
  dispatch(state.update(changes, { scrollIntoView: true, userEvent: 'input' }))
  view.focus()
}

/** Insert text at the beginning of each selected line */
function prefixLines(view: EditorView, getPrefix: (lineNum: number) => string): void {
  const { state, dispatch } = view
  const changes = state.changeByRange((range) => {
    const fromLine = state.doc.lineAt(range.from)
    const toLine = state.doc.lineAt(range.to)
    const inserts: { from: number; insert: string }[] = []
    let offset = 0

    for (let ln = fromLine.number; ln <= toLine.number; ln++) {
      const line = state.doc.line(ln)
      const prefix = getPrefix(ln - fromLine.number + 1)
      // 한 번에 적용하는 변경의 위치는 원래 문서 기준이다(MarkFlow 원본은 앞서 넣은 길이를 더해 여러 줄에서 어긋났다)
      inserts.push({ from: line.from, insert: prefix })
      offset += prefix.length
    }

    return {
      changes: inserts,
      range: EditorSelection.range(
        range.from + getPrefix(1).length,
        range.to + offset
      ),
    }
  })
  dispatch(state.update(changes, { scrollIntoView: true, userEvent: 'input' }))
  view.focus()
}

/** Insert a block (code block, etc.) around selection or at cursor */
function insertBlock(view: EditorView, open: string, close: string, placeholder: string): void {
  const { state, dispatch } = view
  const main = state.selection.main
  const selected = state.sliceDoc(main.from, main.to)
  const content = selected || placeholder
  const text = `\n${open}\n${content}\n${close}\n`
  const insertFrom = main.from

  dispatch(
    state.update({
      changes: { from: main.from, to: main.to, insert: text },
      selection: EditorSelection.cursor(
        insertFrom + open.length + 2 + content.length
      ),
      scrollIntoView: true,
      userEvent: 'input',
    })
  )
  view.focus()
}

/** Insert text at cursor (or replace selection) */
function insertText(view: EditorView, text: string): void {
  const { state, dispatch } = view
  const main = state.selection.main
  dispatch(
    state.update({
      changes: { from: main.from, to: main.to, insert: text },
      selection: EditorSelection.cursor(main.from + text.length),
      scrollIntoView: true,
      userEvent: 'input',
    })
  )
  view.focus()
}

// ─── Public action dispatcher ─────────────────────────────────────────────────

export function applyToolbarAction(view: EditorView, action: ToolbarAction): void {
  switch (action.type) {
    case 'heading':
      prefixLines(view, () => '#'.repeat(action.level) + ' ')
      break

    case 'bold':
      wrapSelection(view, '**', '**', '굵은 글자')
      break

    case 'italic':
      wrapSelection(view, '*', '*', '기울임 글자')
      break

    case 'strikethrough':
      wrapSelection(view, '~~', '~~', '취소선 글자')
      break

    case 'code':
      wrapSelection(view, '`', '`', '코드')
      break

    case 'codeblock': {
      const lang = action.lang ?? ''
      insertBlock(view, '```' + lang, '```', '코드를 입력하세요')
      break
    }

    case 'blockquote':
      prefixLines(view, () => '> ')
      break

    case 'ul':
      prefixLines(view, () => '- ')
      break

    case 'ol':
      prefixLines(view, (n) => `${n}. `)
      break

    case 'task':
      prefixLines(view, () => '- [ ] ')
      break

    case 'link': {
      const { state } = view
      const selected = state.sliceDoc(state.selection.main.from, state.selection.main.to)
      const linkText = selected || '링크 글자'
      wrapSelection(view, '[', '](https://)', linkText)
      break
    }

    case 'image':
      insertText(view, '![대체 글자](https://)')
      break

    case 'table':
      insertText(
        view,
        '\n| 항목 1 | 항목 2 | 항목 3 |\n| --- | --- | --- |\n| 내용 | 내용 | 내용 |\n'
      )
      break

    case 'hr':
      insertText(view, '\n---\n')
      break

    case 'math-inline':
      wrapSelection(view, '$', '$', '수식')
      break

    case 'math-block':
      insertBlock(view, '$$', '$$', '수식')
      break
  }
}
