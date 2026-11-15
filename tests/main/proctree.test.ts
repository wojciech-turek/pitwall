import { describe, expect, test } from 'vitest'
import type { Exec } from '../../src/main/exec'
import { listeningPorts, parseLsofListen } from '../../src/main/proctree'

describe('parseLsofListen', () => {
  test('reads the three address forms, drops p and f lines, unique and sorted', () => {
    const out = 'p123\nf20\nn*:5173\nf21\nn127.0.0.1:3000\nf22\nn[::1]:5173\nn*:80\n'
    expect(parseLsofListen(out)).toEqual([80, 3000, 5173])
  })
  test('ignores junk', () => {
    expect(parseLsofListen('')).toEqual([])
    expect(parseLsofListen('nfoo\nn*:abc\n')).toEqual([])
  })
})

describe('listeningPorts', () => {
  test('no pids: no call', async () => {
    const exec: Exec = async () => { throw new Error('called') }
    expect(await listeningPorts([], exec)).toEqual([])
  })
  test('asks lsof about the pids', async () => {
    let args: string[] = []
    const exec: Exec = async (_f, a) => { args = a; return { code: 0, stdout: 'p1\nn*:4000\n', stderr: '' } }
    expect(await listeningPorts([1, 2], exec)).toEqual([4000])
    expect(args).toEqual(['-nP', '-a', '-iTCP', '-sTCP:LISTEN', '-p', '1,2', '-Fn'])
  })
  test('lsof failing (it exits 1 when nothing matches) or throwing gives []', async () => {
    expect(await listeningPorts([1], async () => ({ code: 1, stdout: '', stderr: '' }))).toEqual([])
    expect(await listeningPorts([1], async () => { throw new Error('nope') })).toEqual([])
  })
})
