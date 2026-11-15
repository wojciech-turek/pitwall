import { describe, expect, test } from 'vitest'
import { checksMessage, fetchReviewThreads, reviewsMessage } from '../../src/main/pr-feedback'
import type { PrInfo } from '../../src/shared/types'

const pr: PrInfo = {
  number: 12, url: 'https://github.com/o/r/pull/12', title: 't', state: 'OPEN', checks: 'failing', updatedAt: 0,
  failing: [{ name: 'build', url: 'https://x/1' }, { name: 'lint' }]
}

describe('checksMessage', () => {
  test('exact text', () => {
    expect(checksMessage(pr)).toBe(
      'CI checks are failing on PR #12 (https://github.com/o/r/pull/12):\n' +
      '- build: https://x/1\n' +
      '- lint\n' +
      '\n' +
      'Look at the failures (for example `gh pr checks 12`, or `gh run view <run id> --log-failed`), fix them, and push.'
    )
  })
})

describe('reviewsMessage', () => {
  test('lists threads, indents newlines and further comments, ends with the closing line', () => {
    const text = reviewsMessage(pr, [
      { path: 'src/a.ts', line: 7, comments: [{ author: 'ann', body: 'rename this\nplease' }, { author: 'bob', body: 'agreed' }] },
      { path: 'src/b.ts', line: null, comments: [{ author: 'ghost', body: 'why?' }] }
    ])
    expect(text).toBe(
      'Unresolved review comments on PR #12 (https://github.com/o/r/pull/12):\n' +
      '\n' +
      '- src/a.ts:7 (ann): rename this\n  please\n' +
      '  bob: agreed\n' +
      '- src/b.ts (ghost): why?\n' +
      '\n' +
      'Address these review comments, then push. Reply on GitHub only if a comment asks a question.'
    )
  })
})

describe('fetchReviewThreads', () => {
  const o = { ghBin: 'gh', cwd: '/w', token: 'tok', owner: 'o', repo: 'r', number: 12, env: { PATH: '/x' } }
  const t = (isResolved: boolean, isOutdated: boolean, path: string, line: number | null, comments: unknown[]) =>
    ({ isResolved, isOutdated, path, line, comments: { nodes: comments } })
  const reply = (nodes: unknown[]) => async () =>
    ({ code: 0, stdout: JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes } } } } }), stderr: '' })

  test('keeps unresolved current threads, ghost author, cuts bodies', async () => {
    const seen: { args: string[]; env?: Record<string, string> }[] = []
    const ex = async (f: string, args: string[], opts?: { env?: Record<string, string> }) => {
      seen.push({ args, env: opts?.env })
      return reply([
        t(false, false, 'a.ts', 3, [{ author: { login: 'ann' }, body: 'x'.repeat(2500) }, { author: null, body: 'hm' }]),
        t(true, false, 'b.ts', 1, [{ author: { login: 'z' }, body: 'resolved' }]),
        t(false, true, 'c.ts', 1, [{ author: { login: 'z' }, body: 'outdated' }]),
        t(false, false, 'd.ts', null, [{ author: { login: 'bob' }, body: 'file level' }])
      ])()
    }
    const r = await fetchReviewThreads({ ...o, exec: ex })
    expect(r).toEqual([
      { path: 'a.ts', line: 3, comments: [{ author: 'ann', body: 'x'.repeat(2000) }, { author: 'ghost', body: 'hm' }] },
      { path: 'd.ts', line: null, comments: [{ author: 'bob', body: 'file level' }] }
    ])
    expect(seen[0].args.slice(0, 2)).toEqual(['api', 'graphql'])
    expect(seen[0].args).toContain('number=12')
    expect(seen[0].env?.GH_TOKEN).toBe('tok')
  })
  test('failures give null', async () => {
    expect(await fetchReviewThreads({ ...o, exec: async () => ({ code: 1, stdout: '', stderr: 'x' }) })).toBeNull()
    expect(await fetchReviewThreads({ ...o, exec: async () => ({ code: 0, stdout: 'nope', stderr: '' }) })).toBeNull()
    expect(await fetchReviewThreads({ ...o, exec: async () => ({ code: 0, stdout: '{"data":{}}', stderr: '' }) })).toBeNull()
  })
})
