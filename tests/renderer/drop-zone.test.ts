import { describe, expect, test } from 'vitest'
import { EMPTY_LAYOUT, dropSession, panes, showSession, type Layout } from '../../src/renderer/src/state/layout'
import { SESSION_MIME, dropPreview, isSessionDrag, paneDropZone } from '../../src/renderer/src/state/dropZone'

function build(sessions: string[]): Layout {
  let n = 0
  const newId = (): string => `p${++n}`
  let l = showSession(EMPTY_LAYOUT, sessions[0], newId)
  for (const s of sessions.slice(1)) l = dropSession(l, s, panes(l).at(-1)!.id, 'right', newId)
  return l
}

describe('dropPreview', () => {
  test('edges cover their half and say which way it splits', () => {
    expect(dropPreview('left', 'pane', false)).toEqual({ label: 'Split left', inset: { top: '0', right: '50%', bottom: '0', left: '0' } })
    expect(dropPreview('right', 'pane', false)).toEqual({ label: 'Split right', inset: { top: '0', right: '0', bottom: '0', left: '50%' } })
    expect(dropPreview('top', 'pane', false)).toEqual({ label: 'Split up', inset: { top: '0', right: '0', bottom: '50%', left: '0' } })
    expect(dropPreview('bottom', 'pane', false)).toEqual({ label: 'Split down', inset: { top: '50%', right: '0', bottom: '0', left: '0' } })
  })

  test('center covers the whole pane', () => {
    const full = { top: '0', right: '0', bottom: '0', left: '0' }
    expect(dropPreview('center', 'pane', false)).toEqual({ label: 'Replace', inset: full })
    expect(dropPreview('center', 'pane', true)).toEqual({ label: 'Already here', inset: full })
    expect(dropPreview('center', 'empty', false)).toEqual({ label: 'Open here', inset: full })
  })
})

describe('paneDropZone', () => {
  const l = build(['A', 'B'])
  const [left, right] = panes(l)

  test('the nearest edge of the pane, else center', () => {
    expect(paneDropZone(l, 'C', right.id, 380, 150, 400, 300)).toBe('right')
    expect(paneDropZone(l, 'C', right.id, 200, 290, 400, 300)).toBe('bottom')
    expect(paneDropZone(l, 'C', right.id, 200, 150, 400, 300)).toBe('center')
  })

  test('over the pane that already shows the session: center', () => {
    expect(paneDropZone(l, 'A', left.id, 380, 150, 400, 300)).toBe('center')
  })

  test('with 4 panes, an edge replaces unless the session is already shown', () => {
    const four = build(['A', 'B', 'C', 'D'])
    const target = panes(four)[0].id
    expect(paneDropZone(four, 'E', target, 5, 150, 400, 300)).toBe('center')
    expect(paneDropZone(four, 'D', target, 5, 150, 400, 300)).toBe('left')
  })

  test('a pane that is not laid out yet: center', () => {
    expect(paneDropZone(l, 'C', right.id, 0, 0, 0, 0)).toBe('center')
  })
})

describe('isSessionDrag', () => {
  test('only drags that carry a session', () => {
    expect(isSessionDrag({ types: [SESSION_MIME] })).toBe(true)
    expect(isSessionDrag({ types: ['Files'] })).toBe(false)
    expect(isSessionDrag({ types: ['text/uri-list', 'text/plain'] })).toBe(false)
    expect(isSessionDrag(null)).toBe(false)
  })
  test('the MIME type', () => {
    expect(SESSION_MIME).toBe('application/x-pitwall-session')
  })
})
