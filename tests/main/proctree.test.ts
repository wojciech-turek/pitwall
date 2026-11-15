import { describe, expect, test } from 'vitest'
import type { Exec } from '../../src/main/exec'
import { listeningPorts, parseLsofListen } from '../../src/main/proctree'

const obj = (m: Map<number, number[]>) => Object.fromEntries(m)

describe('parseLsofListen', () => {
  test('reads the three address forms by process (the p lines), drops f lines, unique and sorted', () => {
    const out = 'p123\nf20\nn*:5173\nf21\nn127.0.0.1:3000\nf22\nn[::1]:5173\nn*:80\np456\nf3\nn*:8080\n'
    expect(obj(parseLsofListen(out))).toEqual({ 123: [80, 3000, 5173], 456: [8080] })
  })
  test('ignores junk, and ports before any p line', () => {
    expect(obj(parseLsofListen(''))).toEqual({})
    expect(obj(parseLsofListen('nfoo\nn*:abc\n'))).toEqual({})
    expect(obj(parseLsofListen('n*:80\npx\nn*:81\n'))).toEqual({})
  })
})

describe('listeningPorts', () => {
  test('no pids: no call', async () => {
    const exec: Exec = async () => { throw new Error('called') }
    expect(obj(await listeningPorts([], exec))).toEqual({})
  })
  test('asks lsof about all the pids at once', async () => {
    let args: string[] = []
    const exec: Exec = async (_f, a) => { args = a; return { code: 0, stdout: 'p1\nf3\nn*:4000\np2\nf4\nn*:4001\n', stderr: '' } }
    expect(obj(await listeningPorts([1, 2], exec))).toEqual({ 1: [4000], 2: [4001] })
    expect(args).toEqual(['-nP', '-a', '-iTCP', '-sTCP:LISTEN', '-p', '1,2', '-Fn'])
  })
  test('lsof failing (it exits 1 when nothing matches) or throwing gives none', async () => {
    expect(obj(await listeningPorts([1], async () => ({ code: 1, stdout: '', stderr: '' })))).toEqual({})
    expect(obj(await listeningPorts([1], async () => { throw new Error('nope') }))).toEqual({})
  })
})
