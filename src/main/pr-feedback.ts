import type { Exec } from './exec'
import { plainText } from '../shared/plain-text'
import type { PrInfo, ReviewThread } from '../shared/types'

const MAX_BODY = 2000

/** Both messages are pasted into Claude's prompt: what GitHub said in them loses its control characters. */
export function checksMessage(pr: PrInfo): string {
  const list = (pr.failing ?? []).map((f) => (f.url ? `- ${f.name}: ${f.url}` : `- ${f.name}`)).join('\n')
  return plainText(`CI checks are failing on PR #${pr.number} (${pr.url}):\n${list}\n\n` +
    `Look at the failures (for example \`gh pr checks ${pr.number}\`, or \`gh run view <run id> --log-failed\`), fix them, and push.`)
}

const indent = (s: string): string => s.replace(/\n/g, '\n  ')

export function reviewsMessage(pr: PrInfo, threads: ReviewThread[]): string {
  const items = threads.map((t) => {
    const [first, ...rest] = t.comments
    const where = t.line === null ? t.path : `${t.path}:${t.line}`
    const lines = [`- ${where} (${first?.author ?? 'ghost'}): ${indent(first?.body ?? '')}`]
    for (const c of rest) lines.push(`  ${c.author}: ${indent(c.body)}`)
    return lines.join('\n')
  })
  return plainText(`Unresolved review comments on PR #${pr.number} (${pr.url}):\n\n${items.join('\n')}\n\n` +
    'Address these review comments, then push. Reply on GitHub only if a comment asks a question.')
}

const QUERY =
  'query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100){nodes{isResolved isOutdated path line comments(first:20){nodes{author{login} body}}}}}}}'

/** The unresolved, current review threads with their comments; null when GitHub couldn't say. */
export async function fetchReviewThreads(o: {
  ghBin: string; cwd: string; token: string; owner: string; repo: string; number: number; exec: Exec; env: Record<string, string>
}): Promise<ReviewThread[] | null> {
  const r = await o.exec(
    o.ghBin,
    ['api', 'graphql', '-f', `query=${QUERY}`, '-f', `owner=${o.owner}`, '-f', `name=${o.repo}`, '-F', `number=${o.number}`],
    { cwd: o.cwd, env: { ...o.env, GH_TOKEN: o.token } }
  )
  if (r.code !== 0) return null
  try {
    const j = JSON.parse(r.stdout) as { data?: { repository?: { pullRequest?: { reviewThreads?: { nodes?: unknown } } } } }
    const nodes = j?.data?.repository?.pullRequest?.reviewThreads?.nodes
    if (!Array.isArray(nodes)) return null
    const out: ReviewThread[] = []
    for (const n of nodes) {
      const t = (n ?? {}) as Record<string, unknown>
      if (t.isResolved !== false || t.isOutdated !== false) continue
      const cs = (t.comments as { nodes?: unknown } | undefined)?.nodes
      const comments = (Array.isArray(cs) ? cs : []).map((c) => {
        const o2 = (c ?? {}) as { author?: { login?: unknown } | null; body?: unknown }
        const login = o2.author?.login
        return { author: typeof login === 'string' && login ? login : 'ghost', body: String(o2.body ?? '').slice(0, MAX_BODY) }
      })
      if (!comments.length) continue
      out.push({ path: typeof t.path === 'string' ? t.path : '', line: typeof t.line === 'number' ? t.line : null, comments })
    }
    return out
  } catch { return null }
}
