import { mkdir, mkdtemp, readdir, realpath, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { claudeProjectDirName, listOutsideConversations } from '../../src/main/conversations'

// Counts the bytes read from files, to check that listing reads only the ends of a transcript.
const io = vi.hoisted(() => ({ bytesRead: 0 }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>()
  const open: typeof fs.open = async (...args) => {
    const fh = await fs.open(...args)
    const read = fh.read.bind(fh) as (...a: unknown[]) => Promise<{ bytesRead: number }>
    ;(fh as unknown as { read: typeof read }).read = async (...a) => {
      const r = await read(...a)
      io.bytesRead += r.bytesRead
      return r
    }
    return fh
  }
  const readFile = (async (...args: Parameters<typeof fs.readFile>) => {
    const r = await fs.readFile(...args)
    io.bytesRead += r.length
    return r
  }) as typeof fs.readFile
  return { ...fs, open, readFile, default: { ...fs, open, readFile } }
})

const REPO = '/x/repo'
const WORKTREES = '/home/me/pitwall/worktrees'
let tmp: string
let cfg: string
/** File mtimes, a whole second apart: each file written is newer than the last. */
let clock: number

beforeEach(async () => {
  tmp = await realpath(await mkdtemp(join(tmpdir(), 'pitwall-conversations-')))
  cfg = join(tmp, '.claude')
  clock = Date.UTC(2026, 9, 1)
})
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true })
})

const id = (n: number) => `${String(n).padStart(8, '0')}-0000-4000-8000-00000000000a`
const at = (cwd: string, gitBranch = 'main') =>
  ({ cwd, gitBranch, isSidechain: false, sessionId: 's', timestamp: '2026-10-01T10:00:00.000Z', userType: 'external' })
const user = (text: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: 'user', message: { role: 'user', content: text }, ...extra })
const assistant = (t: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: t }] }, ...extra })
const mode = JSON.stringify({ type: 'mode', mode: 'normal', sessionId: 's' })
const customTitle = (t: string) => JSON.stringify({ type: 'custom-title', customTitle: t, sessionId: 's' })
const aiTitle = (t: string) => JSON.stringify({ type: 'ai-title', aiTitle: t, sessionId: 's' })
const summary = (t: string) => JSON.stringify({ type: 'summary', summary: t, leafUuid: 'u' })
/** A conversation as Claude writes it: metadata without a cwd first, then the turns. */
const chat = (cwd: string, text: string, branch = 'main') => [mode, user(text, at(cwd, branch)), assistant('On it.', at(cwd, branch))]

/** Writes `<config dir>/projects/<dir>/<name>`, newer than every file before it. */
async function write(dir: string, name: string, lines: string[]): Promise<string> {
  const d = join(cfg, 'projects', dir)
  await mkdir(d, { recursive: true })
  const file = join(d, name)
  await writeFile(file, lines.map((l) => l + '\n').join(''))
  const t = new Date((clock += 1000))
  await utimes(file, t, t)
  return file
}
/** A conversation run in `cwd`, kept where Claude keeps it. */
const convo = (cwd: string, n: number, lines: string[]) => write(claudeProjectDirName(cwd), `${id(n)}.jsonl`, lines)

const list = (o: Partial<Parameters<typeof listOutsideConversations>[0]> = {}) =>
  listOutsideConversations({ configDir: cfg, folder: REPO, exclude: new Set(), worktreesRoot: WORKTREES, platform: 'darwin', ...o })

describe('claudeProjectDirName', () => {
  test("every character but a letter or digit becomes '-', as Claude names its project folders", () => {
    expect(claudeProjectDirName('/x/repo')).toBe('-x-repo')
    expect(claudeProjectDirName('/Users/me/my.app_v2')).toBe('-Users-me-my-app-v2')
  })
})

describe('listOutsideConversations', () => {
  test("lists a folder's conversations and those of its subfolders, newest first", async () => {
    // Where it was started counts, not where it moved to later.
    const a = await convo(REPO, 1, [...chat(REPO, 'Fix the tax rounding'), assistant('Moved.', at('/tmp/elsewhere'))])
    const b = await convo('/x/repo/packages/web', 2, chat('/x/repo/packages/web', 'Tidy the web package', 'web-tidy'))
    const c = await convo(REPO, 3, chat(REPO, 'Add a changelog'))
    await convo('/y/other', 4, chat('/y/other', 'Somewhere else'))
    const item = async (n: number, path: string, title: string, cwd: string, branch: string) =>
      ({ claudeId: id(n), title, cwd, branch, updatedAt: (await stat(path)).mtimeMs, transcriptPath: path })
    expect(await list()).toEqual({
      truncated: false,
      items: [
        await item(3, c, 'Add a changelog', REPO, 'main'),
        await item(2, b, 'Tidy the web package', '/x/repo/packages/web', 'web-tidy'),
        await item(1, a, 'Fix the tax rounding', REPO, 'main')
      ]
    })
  })

  test('never lists a sibling folder that shares the prefix (/x/repo vs /x/repo-old)', async () => {
    await convo(REPO, 1, chat(REPO, 'mine'))
    await convo('/x/repo-old', 2, chat('/x/repo-old', 'the old copy'))
    await convo('/x/repo.old', 3, chat('/x/repo.old', 'also encoded -x-repo-old'))
    await convo('/x/repo-old/sub', 4, chat('/x/repo-old/sub', 'inside the old copy'))
    await convo('/x/repository', 5, chat('/x/repository', 'a longer name'))
    await convo('/x/repo-old', 7, [...chat('/x/repo-old', 'moved into the folder later'), assistant('Moved.', at(REPO))])
    // Kept in this folder's own project folder, but started elsewhere.
    await write(claudeProjectDirName(REPO), `${id(6)}.jsonl`, chat('/x/repo-old', 'recorded elsewhere'))
    expect((await list()).items.map((x) => x.title)).toEqual(['mine'])
  })

  test('skips excluded ids, Pitwall worktrees, non-UUID and sidechain files, and conversations with no user text', async () => {
    const home = '/home/me'
    await convo(`${home}/sub`, 1, chat(home, 'an older copy of the same conversation'))
    await convo(home, 1, chat(home, 'a plain one'))
    await convo(home, 2, chat(home, 'already a Pitwall session'))
    await convo(`${WORKTREES}/repo/fix-tax`, 3, chat(`${WORKTREES}/repo/fix-tax`, 'in a Pitwall worktree'))
    await write(claudeProjectDirName(home), 'agent-1234abcd.jsonl', chat(home, 'an old subagent file'))
    await write(claudeProjectDirName(home), 'notes.jsonl', chat(home, 'not a conversation id'))
    await write(join(claudeProjectDirName(home), id(4), 'subagents'), `${id(5)}.jsonl`, chat(home, 'a subagent'))
    await convo(home, 6, [mode, user('subagent prompt', { ...at(home), isSidechain: true }), assistant('ok', { ...at(home), isSidechain: true }), user('a later message', at(home))])
    await convo(home, 7, [mode, user('<command-name>/clear</command-name>', at(home)), user('Caveat: below', { ...at(home), isMeta: true }), assistant('Cleared.', at(home))])
    await convo(home, 8, [mode, assistant('Hello.', at(home)), customTitle('Named, never used')])
    await convo(home, 9, [mode, user('no cwd recorded'), assistant('ok')])
    const { items } = await list({ folder: home, exclude: new Set([id(2)]) })
    expect(items.map((x) => x.title)).toEqual(['a plain one'])
  })

  test("title: custom title, then Claude's title, then the first real user message (skipping /commands and meta)", async () => {
    await convo(REPO, 1, [mode, customTitle('Old name'), ...chat(REPO, 'first message'), aiTitle('Claude title'), customTitle('Tax  rounding\nfix')])
    await convo(REPO, 2, [...chat(REPO, 'first message'), aiTitle('Early title'), assistant('more', at(REPO)), aiTitle('Fix the invoice totals')])
    await convo(REPO, 3, [summary('An older summary line'), ...chat(REPO, 'first message')])
    await convo(REPO, 4, [
      mode,
      user('<command-name>/model</command-name>', at(REPO)),
      user('<local-command-stdout>Set model</local-command-stdout>', at(REPO)),
      user('Caveat: the messages below', { ...at(REPO), isMeta: true }),
      user('  Please look at\n\nthe   parser  ', at(REPO)),
      user('a later message', at(REPO))
    ])
    await convo(REPO, 5, chat(REPO, 'word '.repeat(60)))
    const titles = (await list()).items.map((x) => x.title).reverse()
    expect(titles.slice(0, 4)).toEqual(['Tax rounding fix', 'Fix the invoice totals', 'An older summary line', 'Please look at the parser'])
    expect(titles[4]).toBe('word '.repeat(60).slice(0, 119) + '…')
    expect(titles[4]).toHaveLength(120)
  })

  test('titles lose control characters (ESC, NUL, DEL…), so none reaches a session title, --name or env.sh', async () => {
    await convo(REPO, 1, chat(REPO, '\u001b[31mBuild\u001b[0m\u0000failed\u007f again\u0007'))
    await convo(REPO, 2, [mode, ...chat(REPO, 'first message'), customTitle('Pasted\u001b[2K\u0000name')])
    // Nothing left of a title but control characters: the next one is used.
    await convo(REPO, 3, [mode, ...chat(REPO, 'the first message'), customTitle('\u001b\u0000\u007f')])
    const titles = (await list()).items.map((x) => x.title).reverse()
    expect(titles).toEqual(['[31mBuild [0m failed again', 'Pasted [2K name', 'the first message'])
    for (const t of titles) expect(t).not.toMatch(/[\u0000-\u001f\u007f]/)
  })

  test("branch is the latest recorded gitBranch; 'HEAD' counts as none", async () => {
    await convo(REPO, 1, [...chat(REPO, 'switched', 'main'), assistant('now on a feature', at(REPO, 'feature/x')), mode])
    await convo(REPO, 2, [...chat(REPO, 'detached', 'main'), assistant('detached now', at(REPO, 'HEAD'))])
    await convo(REPO, 3, [mode, user('never recorded', { cwd: REPO }), assistant('ok', { cwd: REPO })])
    const items = (await list()).items.reverse()
    expect(items[0].branch).toBe('feature/x')
    expect(items[1]).not.toHaveProperty('branch')
    expect(items[2]).not.toHaveProperty('branch')
  })

  test('stops at the limit and says truncated', async () => {
    for (let n = 1; n <= 5; n++) await convo(REPO, n, chat(REPO, `conversation ${n}`))
    expect(await list({ limit: 3 })).toMatchObject({ truncated: true, items: [{ claudeId: id(5) }, { claudeId: id(4) }, { claudeId: id(3) }] })
    expect(await list({ limit: 5 })).toMatchObject({ truncated: false })
    expect((await list()).items).toHaveLength(5)
  })

  test('at most 200 by default', async () => {
    const dir = claudeProjectDirName(REPO)
    await mkdir(join(cfg, 'projects', dir), { recursive: true })
    const lines = chat(REPO, 'one of many').map((l) => l + '\n').join('')
    await Promise.all(Array.from({ length: 201 }, (_, n) => writeFile(join(cfg, 'projects', dir, `${id(n)}.jsonl`), lines)))
    const r = await list()
    expect(r.items).toHaveLength(200)
    expect(r.truncated).toBe(true)
  })

  test('reads only the head and tail of a 50 MB transcript', async () => {
    const filler = assistant('y'.repeat(100_000), at(REPO))
    await convo(REPO, 1, [
      mode, user('Start the big refactor', at(REPO)), ...Array<string>(520).fill(filler),
      customTitle('Big refactor'), assistant('Done.', at(REPO, 'late-branch'))
    ])
    io.bytesRead = 0
    const { items } = await list()
    expect(items).toMatchObject([{ claudeId: id(1), title: 'Big refactor', cwd: REPO, branch: 'late-branch' }])
    expect(io.bytesRead).toBeGreaterThan(0)
    expect(io.bytesRead).toBeLessThan(400 * 1024)
  })

  test("a conversation whose messages all lie between the head and the tail is listed by Claude's title", async () => {
    // Claude writes big attachment lines before the first message; it titles a conversation only from what was typed.
    const attachment = JSON.stringify({ type: 'attachment', attachment: { type: 'file', content: 'a'.repeat(50_000) }, ...at(REPO) })
    await convo(REPO, 1, [
      mode, ...Array<string>(6).fill(attachment), user('typed after the attachments', at(REPO)),
      ...Array<string>(3).fill(assistant('z'.repeat(50_000), at(REPO))), aiTitle('Titled by Claude')
    ])
    io.bytesRead = 0
    expect((await list()).items).toMatchObject([{ claudeId: id(1), title: 'Titled by Claude', cwd: REPO, branch: 'main' }])
    expect(io.bytesRead).toBeLessThanOrEqual(320 * 1024)
  })

  test('corrupt lines are ignored', async () => {
    await convo(REPO, 1, [
      '{', 'garbage \u0000', 'null', '[1,2]', '"user"', '{"type":"custom-title","customTitle":', JSON.stringify({ type: 'custom-title', customTitle: 42 }),
      JSON.stringify({ type: 'user', cwd: 42 }), user('The real first message', at(REPO)), '{{{{', assistant('ok', at(REPO))
    ])
    await convo(REPO, 2, ['{"broken', '\u0001\u0002', '[]'])
    // A last line still being written.
    const writing = await convo(REPO, 3, chat(REPO, 'still being written'))
    await writeFile(writing, '{"type":"user","message":{"content":"half', { flag: 'a' })
    await utimes(writing, new Date((clock += 1000)), new Date(clock))
    expect((await list()).items.map((x) => [x.title, x.cwd])).toEqual([['still being written', REPO], ['The real first message', REPO]])
  })

  test('never writes under the config dir', async () => {
    await convo(REPO, 1, chat(REPO, 'one'))
    await convo('/x/repo/sub', 2, [...chat('/x/repo/sub', 'two'), customTitle('Two')])
    await convo('/x/repo-old', 3, chat('/x/repo-old', 'three'))
    const snapshot = async (): Promise<string[]> => {
      const out: string[] = []
      const walk = async (dir: string): Promise<void> => {
        for (const e of await readdir(dir, { withFileTypes: true })) {
          const p = join(dir, e.name)
          const st = await stat(p)
          out.push(`${p} ${st.size} ${st.mtimeMs}`)
          if (e.isDirectory()) await walk(p)
        }
      }
      await walk(cfg)
      return out.sort()
    }
    const before = await snapshot()
    expect((await list()).items).toHaveLength(2)
    expect(await snapshot()).toEqual(before)
  })

  test('Windows paths: C:\\Users\\me\\repo → C--Users-me-repo, matched case-insensitively', async () => {
    const folder = 'C:\\Users\\me\\repo'
    expect(claudeProjectDirName(folder)).toBe('C--Users-me-repo')
    await write('c--users-me-repo', `${id(1)}.jsonl`, chat('c:\\users\\me\\repo', 'lowercase drive and names'))
    await write('C--Users-me-repo-src', `${id(2)}.jsonl`, chat('C:\\Users\\me\\repo\\src\\', 'in a subfolder'))
    await write('C--Users-me-repo-old', `${id(3)}.jsonl`, chat('C:\\Users\\me\\repo-old', 'a sibling'))
    await write('C--Users-me-repo-wt', `${id(4)}.jsonl`, chat('C:\\Users\\me\\repo\\wt\\fix', 'in a worktree'))
    const { items } = await list({ folder, platform: 'win32', worktreesRoot: 'c:\\users\\ME\\repo\\wt' })
    expect(items.map((x) => x.title)).toEqual(['in a subfolder', 'lowercase drive and names'])
  })
})
