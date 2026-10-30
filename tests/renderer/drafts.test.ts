import { beforeEach, describe, expect, test } from 'vitest'
import { clearDraft, draftKey, getDraft, setDraft } from '../../src/renderer/src/editor/drafts'
import { useUi } from '../../src/renderer/src/state/ui'

describe('drafts', () => {
  beforeEach(() => {
    clearDraft(draftKey('s1', 'a.ts'))
    useUi.setState({ selectedSessionId: null, tabs: {}, activeTab: {}, dialog: null, dirty: {} })
  })

  test('set/get/clear', () => {
    const k = draftKey('s1', 'a.ts')
    expect(getDraft(k)).toBeUndefined()
    setDraft(k, { content: 'x', baseMtimeMs: 42 })
    expect(getDraft(k)).toEqual({ content: 'x', baseMtimeMs: 42 })
    clearDraft(k)
    expect(getDraft(k)).toBeUndefined()
  })

  test('latest draft keeps the base mtime it was given; keys are per session and path', () => {
    setDraft(draftKey('s1', 'a.ts'), { content: 'one', baseMtimeMs: 7 })
    setDraft(draftKey('s1', 'a.ts'), { content: 'two', baseMtimeMs: 7 })
    expect(getDraft(draftKey('s1', 'a.ts'))).toEqual({ content: 'two', baseMtimeMs: 7 })
    expect(getDraft(draftKey('s2', 'a.ts'))).toBeUndefined()
  })

  test('closing a tab clears its draft and dirty flag', () => {
    const ui = useUi.getState()
    ui.select('s1')
    ui.openTab('s1', { id: 'file:a.ts', kind: 'file', path: 'a.ts' })
    setDraft(draftKey('s1', 'a.ts'), { content: 'x', baseMtimeMs: 1 })
    ui.setDirty('s1:file:a.ts', true)
    ui.closeTab('s1', 'file:a.ts')
    expect(getDraft(draftKey('s1', 'a.ts'))).toBeUndefined()
    expect(useUi.getState().dirty['s1:file:a.ts']).toBeUndefined()
  })
})
