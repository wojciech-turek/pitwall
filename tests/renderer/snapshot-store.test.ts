import { describe, expect, test } from 'vitest'
import { __pushSnapshot, __snapStore, refreshSnapshot } from '../../src/renderer/src/state/snapshot'
import type { AppSnapshot } from '../../src/shared/types'

const mk = (n: number) => ({ projects: [], subProjects: [], sessions: Array(n).fill({}), archived: [] }) as unknown as AppSnapshot

describe('refreshSnapshot', () => {
  test('stores the fetched snapshot', async () => {
    await refreshSnapshot(async () => mk(1))
    expect(__snapStore.getState().snap?.sessions).toHaveLength(1)
  })
  test('a push arriving during the fetch wins', async () => {
    await refreshSnapshot(async () => { __pushSnapshot(mk(3)); return mk(2) })
    expect(__snapStore.getState().snap?.sessions).toHaveLength(3)
  })
})
