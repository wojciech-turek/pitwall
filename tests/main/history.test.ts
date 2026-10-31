import { appendFile, mkdir, mkdtemp, realpath, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import {
  CappedText, historySources, lineText, queryTerms, SessionHistory, TEXT_CAP, type HistorySource
} from '../../src/main/history'
import type { AppSnapshot, Project, Session, SessionView, SubProject } from '../../src/shared/types'
import { WINDOWS } from '../helpers/processes'

let tmp: string

beforeEach(async () => {
  tmp = await realpath(await mkdtemp(join(tmpdir(), 'pitwall-history-')))
})
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true })
})

const user = (text: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: 'user', message: { role: 'user', content: text }, ...extra })
const assistant = (...blocks: unknown[]) =>
  JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: blocks } })
const text = (t: string) => ({ type: 'text', text: t })

async function transcript(configDir: string, folder: string, id: string, lines: string[]): Promise<string> {
  const dir = join(configDir, 'projects', folder)
  await mkdir(dir, { recursive: true })
  const file = join(dir, `${id}.jsonl`)
  await writeFile(file, lines.map((l) => l + '\n').join(''))
  return file
}

function session(id: string, o: Partial<Session> = {}): Session {
  return {
    id, subProjectId: 'sp_1', title: `Title ${id}`, slug: id, claudeSessionId: `c-${id}`, cwd: `/w/${id}`,
    branchCreatedByPitwall: false, createdAt: 1, lastViewedAt: 1, ...o
  }
}
function source(s: Session, configDir: string, o: Partial<HistorySource> = {}): HistorySource {
  return { session: s, archived: true, projectName: 'Acme', subProjectName: 'repo', configDir, updatedAt: 100, ...o }
}

describe('lineText', () => {
  test('user prompts and assistant text only', () => {
    expect(lineText(user('fix the tax rounding'))).toBe('fix the tax rounding')
    expect(lineText(JSON.stringify({ type: 'user', message: { role: 'user', content: [text('with an image'), { type: 'image' }] } })))
      .toBe('with an image')
    expect(lineText(assistant(text('Done, '), text('rounded.')))).toBe('Done, \nrounded.')
    expect(lineText(assistant({ type: 'thinking', thinking: 'secret thoughts' }))).toBeNull()
    expect(lineText(assistant({ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'rm -rf build' } }))).toBeNull()
    expect(lineText(JSON.stringify({
      type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [text('build output')] }] }
    }))).toBeNull()
    expect(lineText(JSON.stringify({ type: 'system', content: 'hook ran', subtype: 'x' }))).toBeNull()
    expect(lineText(JSON.stringify({ type: 'ai-title', aiTitle: 'user assistant' }))).toBeNull()
  })

  test('skips meta, side chains, compact summaries and command wrappers', () => {
    expect(lineText(user('Caveat: the messages below', { isMeta: true }))).toBeNull()
    expect(lineText(user('subagent prompt', { isSidechain: true }))).toBeNull()
    expect(lineText(user('This session is being continued', { isCompactSummary: true }))).toBeNull()
    expect(lineText(user('<command-name>/clear</command-name>'))).toBeNull()
    expect(lineText(user('<local-command-stdout>ok</local-command-stdout>'))).toBeNull()
    expect(lineText(user('<task-notification>done</task-notification>'))).toBeNull()
    expect(lineText(user('<b>bold</b> is fine'))).toBe('<b>bold</b> is fine')
  })

  test('tolerates corrupt and odd lines', () => {
    for (const l of ['', '{', '{"type":"user","message":', 'null', '"user"', '[1,2]', '{"type":"user"}',
      '{"type":"user","message":{"content":42}}', '{"type":"assistant","message":{"content":[null,{"type":"text"}]}}']) {
      expect(lineText(l)).toBeNull()
    }
  })
})

describe('CappedText', () => {
  test('keeps everything under the cap', () => {
    const c = new CappedText(100)
    c.add('alpha')
    c.add('beta')
    expect(c.toString()).toBe('alpha\nbeta')
  })

  test('a piece longer than half the cap is cut to half', () => {
    const c = new CappedText(1000)
    c.add('s' + 'x'.repeat(5000) + 'e')
    expect(c.toString()).toBe('s' + 'x'.repeat(499))
    expect(c.size).toBe(500)
  })

  test('adding in many small steps keeps the same result as one pass', () => {
    const c = new CappedText(1000)
    const all: string[] = []
    for (let i = 0; i < 3000; i++) {
      c.add(`m${i}`)
      all.push(`m${i}`)
      if (i % 7 === 0) c.toString() // a search between reads
    }
    const s = c.toString()
    expect(s.startsWith(all.join('\n').slice(0, 500))).toBe(true)
    expect(s.endsWith(all.join('\n').slice(-500))).toBe(true)
    expect(s.length).toBeLessThanOrEqual(1003)
  })

  test('over the cap keeps the start and the most recent text', () => {
    const c = new CappedText(1000)
    c.add('FIRSTWORD')
    for (let i = 0; i < 500; i++) c.add(`middle ${i}`)
    c.add('LASTWORD')
    const s = c.toString()
    expect(s.length).toBeLessThanOrEqual(1010)
    expect(s.startsWith('FIRSTWORD')).toBe(true)
    expect(s.endsWith('LASTWORD')).toBe(true)
    expect(s).not.toContain('middle 250\n')
  })
})

describe('queryTerms', () => {
  test('lowercase, whitespace-separated, no duplicates', () => {
    expect(queryTerms('  Tax  ROUNDING\ttax ')).toEqual(['tax', 'rounding'])
    expect(queryTerms('   ')).toEqual([])
  })

  test('at most 256 characters and 16 terms', () => {
    expect(queryTerms(Array.from({ length: 40 }, (_, i) => `t${i}`).join(' '))).toHaveLength(16)
    expect(queryTerms('x'.repeat(1000))).toEqual(['x'.repeat(256)])
  })
})

describe('historySources', () => {
  const project = (id: string, extraEnv: Project['extraEnv'] = []): Project => ({
    id, name: `Project ${id}`, createdAt: 0, extraEnv, identity: { sshKeyPath: '', ghAccount: '', gitName: '', gitEmail: '' }
  })
  const sub = (id: string, projectId: string): SubProject => ({ id, projectId, name: `Sub ${id}`, kind: 'folder', path: '/x', createdAt: 0 })

  // (POSIX paths: the same lookup on Windows builds C:\ paths with backslashes.)
  test.skipIf(WINDOWS)("config dir: the project's CLAUDE_CONFIG_DIR, else the app's, else ~/.claude; updatedAt: latest event or archivedAt", () => {
    const running: SessionView = { ...session('a', { subProjectId: 'sp_a', createdAt: 5 }), status: 'read', lastActivityAt: 900 }
    const fresh: SessionView = { ...session('b', { subProjectId: 'sp_b', createdAt: 7 }), status: 'starting' }
    const archived = session('c', { subProjectId: 'sp_a', archivedAt: 1234 })
    const orphan = session('d', { subProjectId: 'sp_gone', archivedAt: 50 })
    const snap: Pick<AppSnapshot, 'projects' | 'subProjects' | 'sessions' | 'archived'> = {
      projects: [project('p1', [{ key: 'CLAUDE_CONFIG_DIR', value: '~/work-claude' }]), project('p2')],
      subProjects: [sub('sp_a', 'p1'), sub('sp_b', 'p2')],
      sessions: [running, fresh],
      archived: [archived, orphan]
    }
    const home = '/home/me'
    const byId = (env: Record<string, string>) =>
      Object.fromEntries(historySources(snap, home, env).map((s) => [s.session.id, s]))
    const a = byId({})
    expect(a.a).toMatchObject({ archived: false, configDir: '/home/me/work-claude', projectName: 'Project p1', subProjectName: 'Sub sp_a', updatedAt: 900 })
    expect(a.b).toMatchObject({ archived: false, configDir: '/home/me/.claude', updatedAt: 7 })
    expect(a.c).toMatchObject({ archived: true, configDir: '/home/me/work-claude', updatedAt: 1234 })
    expect(a.d).toMatchObject({ archived: true, configDir: '/home/me/.claude', projectName: '', subProjectName: '', updatedAt: 50 })
    expect(byId({ CLAUDE_CONFIG_DIR: '/app/claude' }).b.configDir).toBe('/app/claude')
    expect(byId({ CLAUDE_CONFIG_DIR: '/app/claude' }).a.configDir).toBe('/home/me/work-claude')
  })
})

describe('SessionHistory', () => {
  test('finds a session by a word only in its conversation, in any project folder of its config dir', async () => {
    const cfg = join(tmp, '.claude')
    await transcript(cfg, '-w-a', 'c-a', [user('please refactor the quokka parser'), assistant(text('Refactored the parser.'))])
    // Claude may keep it under another project folder (e.g. resumed from a different path).
    await transcript(cfg, '-elsewhere', 'c-b', [user('nothing to see')])
    await transcript(cfg, '-other', 'c-zzz', [user('quokka in a session Pitwall does not know')])
    const h = new SessionHistory(() => [source(session('a'), cfg), source(session('b'), cfg)])
    const hits = await h.search('QUOKKA')
    expect(hits).toEqual([{
      sessionId: 'a', title: 'Title a', archived: true, projectName: 'Acme', subProjectName: 'repo',
      matchedIn: 'conversation', snippet: 'please refactor the quokka parser Refactored the parser.', updatedAt: 100
    }])
    expect(await h.search('refactored parser')).toHaveLength(1)
    expect(await h.search('quokka nothing')).toEqual([])
  })

  test("reads a project's own config dir, not the default one", async () => {
    const own = join(tmp, 'work-claude')
    const def = join(tmp, '.claude')
    await transcript(own, '-w-a', 'c-a', [user('ownword')])
    await transcript(def, '-w-a', 'c-a', [user('defaultword')])
    const h = new SessionHistory(() => [source(session('a'), own)])
    expect(await h.search('ownword')).toHaveLength(1)
    expect(await h.search('defaultword')).toEqual([])
  })

  test('searches every conversation the session had (after /clear)', async () => {
    const cfg = join(tmp, '.claude')
    await transcript(cfg, '-w-a', 'old-1', [user('first conversation about walruses')])
    await transcript(cfg, '-w-a', 'old-2', [user('second about narwhals')])
    await transcript(cfg, '-w-a', 'c-a', [user('current about otters')])
    const h = new SessionHistory(() => [source(session('a', { pastClaudeIds: ['old-1', 'old-2'] }), cfg)])
    for (const w of ['walruses', 'narwhals', 'otters']) expect((await h.search(w)).map((x) => x.sessionId)).toEqual(['a'])
    expect(await h.search('walruses otters')).toHaveLength(1)
  })

  test('corrupt lines, a missing config dir and a trailing partial line never break a search', async () => {
    const cfg = join(tmp, '.claude')
    const file = await transcript(cfg, '-w-a', 'c-a', [
      '{"type":"user","message":{"content":"broken', 'garbage \u0000\u0001', user('valid penguin line'), '{{{{',
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'ünïcödé émoji 🧾 kiwi' } })
    ])
    await appendFile(file, '{"type":"user","message":{"role":"user","content":"half writ')
    const h = new SessionHistory(() => [source(session('a'), cfg), source(session('b'), join(tmp, 'no-such-dir'))])
    expect((await h.search('penguin')).map((x) => x.sessionId)).toEqual(['a'])
    expect((await h.search('kiwi'))[0].snippet).toBe('valid penguin line ünïcödé émoji 🧾 kiwi')
    expect(await h.search('half')).toEqual([])
    // The line completes: it is picked up next time.
    await appendFile(file, 'ten"}}\n')
    expect((await h.search('written'))).toHaveLength(1)
  })

  test('a final line without a newline is read', async () => {
    const cfg = join(tmp, '.claude')
    const dir = join(cfg, 'projects', '-w-a')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'c-a.jsonl'), user('no newline at the end, flamingo'))
    const h = new SessionHistory(() => [source(session('a'), cfg)])
    expect(await h.search('flamingo')).toHaveLength(1)
  })

  test('appended lines are read incrementally; an unchanged file is not read again', async () => {
    const cfg = join(tmp, '.claude')
    const file = await transcript(cfg, '-w-a', 'c-a', [user('first message about herons')])
    const h = new SessionHistory(() => [source(session('a'), cfg)])
    expect(await h.search('herons')).toHaveLength(1)
    const afterFirst = h.bytesRead
    expect(await h.search('herons')).toHaveLength(1)
    expect(h.bytesRead).toBe(afterFirst)
    const more = user('then about pelicans') + '\n'
    await appendFile(file, more)
    expect(await h.search('pelicans')).toHaveLength(1)
    expect(await h.search('herons')).toHaveLength(1)
    // Only the new line plus a short check of the bytes before it.
    expect(h.bytesRead - afterFirst).toBeLessThan(Buffer.byteLength(more) + 100)
  })

  test('a rewritten file is read again from the start', async () => {
    const cfg = join(tmp, '.claude')
    const file = await transcript(cfg, '-w-a', 'c-a', [user('original about badgers and more padding here')])
    const h = new SessionHistory(() => [source(session('a'), cfg)])
    expect(await h.search('badgers')).toHaveLength(1)
    await writeFile(file, user('replaced with moles, and much longer than the original content was before') + '\n')
    expect(await h.search('badgers')).toEqual([])
    expect(await h.search('moles')).toHaveLength(1)
  })

  test('title hits first, then most recent; every term must match the title or the conversation', async () => {
    const cfg = join(tmp, '.claude')
    await transcript(cfg, '-x', 'c-old-conv', [user('we discussed the tax rounding bug')])
    await transcript(cfg, '-x', 'c-new-conv', [user('tax rounding again')])
    await transcript(cfg, '-x', 'c-mixed', [user('only rounding here')])
    const h = new SessionHistory(() => [
      source(session('old-conv', { title: 'Something' }), cfg, { updatedAt: 10 }),
      source(session('new-conv', { title: 'Other' }), cfg, { updatedAt: 30, archived: false }),
      source(session('old-title', { title: 'Fix tax rounding' }), cfg, { updatedAt: 5 }),
      source(session('new-title', { title: 'Tax rounding v2' }), cfg, { updatedAt: 20 }),
      source(session('mixed', { title: 'Tax' }), cfg, { updatedAt: 40 }),
      source(session('none', { title: 'Unrelated' }), cfg, { updatedAt: 50 })
    ])
    const hits = await h.search('tax rounding')
    expect(hits.map((x) => [x.sessionId, x.matchedIn])).toEqual([
      ['new-title', 'title'], ['old-title', 'title'],
      ['mixed', 'conversation'], ['new-conv', 'conversation'], ['old-conv', 'conversation']
    ])
    expect(hits.find((x) => x.sessionId === 'new-conv')?.archived).toBe(false)
    expect(hits.find((x) => x.sessionId === 'mixed')?.snippet).toBe('only rounding here')
    expect(hits.find((x) => x.sessionId === 'old-title')?.snippet).toBe('')
  })

  test('at most 50 hits; an empty query finds nothing', async () => {
    const cfg = join(tmp, '.claude')
    const sources = Array.from({ length: 80 }, (_, i) => source(session(`s${i}`, { title: `Common ${i}` }), cfg, { updatedAt: i }))
    const h = new SessionHistory(() => sources)
    const hits = await h.search('common')
    expect(hits).toHaveLength(50)
    expect(hits[0].sessionId).toBe('s79')
    expect(await h.search('   ')).toEqual([])
  })

  test('snippet: about 60 characters either side of the first conversation match, on one line', async () => {
    const cfg = join(tmp, '.claude')
    const before = 'a'.repeat(100)
    const after = 'b'.repeat(100)
    await transcript(cfg, '-x', 'c-a', [user(`${before}\n\n  MATCHWORD   ${after}`), user('second matchword')])
    const h = new SessionHistory(() => [source(session('a'), cfg)])
    const [hit] = await h.search('matchword')
    expect(hit.snippet).toBe(`…${'a'.repeat(56)} MATCHWORD ${'b'.repeat(57)}…`)
  })

  test('text past the cap: the start and the end stay searchable', async () => {
    const cfg = join(tmp, '.claude')
    const filler = Array.from({ length: 2000 }, (_, i) => user(`filler ${i} ${'x'.repeat(400)}`))
    await transcript(cfg, '-x', 'c-a', [user('opening aardvark'), ...filler, user('closing zebra')])
    const h = new SessionHistory(() => [source(session('a'), cfg)])
    expect(await h.search('aardvark')).toHaveLength(1)
    expect(await h.search('zebra')).toHaveLength(1)
    expect(await h.search('filler 1000 ')).toEqual([])
    expect(TEXT_CAP).toBeGreaterThanOrEqual(250_000)
  })

  test('memory stays within the cap: several big conversations and one huge message', async () => {
    const cfg = join(tmp, '.claude')
    const big = (tag: string) => Array.from({ length: 400 }, (_, i) => user(`${tag} ${i} ${'w'.repeat(2000)}`))
    await transcript(cfg, '-x', 'old-1', [user('earliest ibis'), ...big('first')])
    await transcript(cfg, '-x', 'old-2', big('second'))
    await transcript(cfg, '-x', 'c-a', [...big('third'), user('huge ' + 'h'.repeat(5_000_000)), user('latest stork')])
    let sources = [source(session('a', { pastClaudeIds: ['old-1', 'old-2'] }), cfg)]
    const h = new SessionHistory(() => sources)
    expect(await h.search('ibis')).toHaveLength(1) // the start of the first conversation
    expect(await h.search('stork')).toHaveLength(1) // the end of the current one
    // One copy of the text and one lowercase copy, each within the cap.
    expect(h.keptChars()).toBeLessThanOrEqual(2 * (TEXT_CAP + 10))
    expect(h.keptChars()).toBeGreaterThan(TEXT_CAP)
    // More conversation arrives: still within the cap.
    await appendFile(join(cfg, 'projects', '-x', 'c-a.jsonl'), big('fourth').join('\n') + '\n' + user('newest heron') + '\n')
    expect(await h.search('heron')).toHaveLength(1)
    expect(await h.search('ibis')).toHaveLength(1)
    expect(h.keptChars()).toBeLessThanOrEqual(2 * (TEXT_CAP + 10))
    // A session that's gone is forgotten.
    sources = []
    expect(await h.search('heron')).toEqual([])
    expect(h.keptChars()).toBe(0)
  })

  test('a new conversation after /clear is read without reading the earlier one again', async () => {
    const cfg = join(tmp, '.claude')
    await transcript(cfg, '-x', 'c-a', [user('before clear, puffin')])
    let s = session('a')
    const h = new SessionHistory(() => [source(s, cfg)])
    expect(await h.search('puffin')).toHaveLength(1)
    const before = h.bytesRead
    const next = user('after clear, gannet') + '\n'
    await transcript(cfg, '-x', 'c-b', [user('after clear, gannet')])
    s = session('a', { claudeSessionId: 'c-b', pastClaudeIds: ['c-a'] })
    expect(await h.search('puffin gannet')).toHaveLength(1)
    expect(h.bytesRead - before).toBeLessThan(Buffer.byteLength(next) + 100)
  })

  test("a conversation added to a folder in the same clock step as the last search is still found (Windows' ~16 ms steps)", async () => {
    const cfg = join(tmp, '.claude')
    await transcript(cfg, '-x', 'c-a', [user('first, puffin')])
    const dir = join(cfg, 'projects', '-x')
    const step = new Date()
    await utimes(dir, step, step)
    let s = session('a')
    const h = new SessionHistory(() => [source(s, cfg)])
    expect(await h.search('puffin')).toHaveLength(1)
    await transcript(cfg, '-x', 'c-b', [user('then, gannet')])
    await utimes(dir, step, step) // the folder's mtime didn't move: same step
    s = session('a', { claudeSessionId: 'c-b', pastClaudeIds: ['c-a'] })
    expect(await h.search('puffin gannet')).toHaveLength(1)
  })

  test('a 20 MB transcript: indexed in the background, then searched in well under a second', async () => {
    const cfg = join(tmp, '.claude')
    const big = 'y'.repeat(200_000)
    const lines: string[] = []
    let size = 0
    let i = 0
    while (size < 20 * 1024 * 1024) {
      const l = i % 10 === 0
        ? JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: big }] } })
        : i % 3 === 0
          ? assistant({ type: 'tool_use', id: `t${i}`, name: 'Write', input: { content: big.slice(0, 50_000) } })
          : i % 2 === 0 ? user(`prompt number ${i} about the codebase`) : assistant(text(`reply number ${i} with some text`))
      lines.push(l)
      size += l.length + 1
      i++
    }
    lines.push(user('needle at the very end'))
    await transcript(cfg, '-x', 'c-a', lines)
    const h = new SessionHistory(() => [source(session('a'), cfg)])
    const t0 = performance.now()
    expect(await h.search('needle')).toHaveLength(1)
    const indexMs = performance.now() - t0
    expect(indexMs).toBeLessThan(10_000)
    const t1 = performance.now()
    expect(await h.search('needle')).toHaveLength(1)
    expect(await h.search('nothing matches this')).toEqual([])
    expect(performance.now() - t1).toBeLessThan(1000)
  })

  test('a giant line (no newline for tens of MB) is skipped, not held in memory', async () => {
    const cfg = join(tmp, '.claude')
    const dir = join(cfg, 'projects', '-x')
    await mkdir(dir, { recursive: true })
    const file = join(dir, 'c-a.jsonl')
    await writeFile(file, user('before the blob, heron') + '\n')
    await appendFile(file, '{"type":"user","message":{"content":"' + 'z'.repeat(20 * 1024 * 1024) + '"}}\n')
    await appendFile(file, user('after the blob, egret') + '\n')
    const h = new SessionHistory(() => [source(session('a'), cfg)])
    expect(await h.search('heron egret')).toHaveLength(1)
  })

  test('concurrent searches share one indexing pass', async () => {
    const cfg = join(tmp, '.claude')
    await transcript(cfg, '-x', 'c-a', [user('shared kestrel')])
    const h = new SessionHistory(() => [source(session('a'), cfg)])
    const [a, b] = await Promise.all([h.search('kestrel'), h.search('kestrel')])
    expect(a).toHaveLength(1)
    expect(b).toHaveLength(1)
    expect(h.bytesRead).toBe(Buffer.byteLength(user('shared kestrel') + '\n'))
  })
})
