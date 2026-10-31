#!/usr/bin/env node
// Stub gh CLI for tests, in Node: the same behaviour as tests/fixtures/bin/gh (sh), for Windows (gh.cmd runs it).
import { appendFileSync, readFileSync } from 'node:fs'

const env = process.env
const args = process.argv.slice(2)
if (env.STUB_GH_LOG) {
  appendFileSync(env.STUB_GH_LOG, `${args.join(' ')}\nGH_TOKEN=${env.GH_TOKEN ? 'set' : 'unset'}\nGITHUB_TOKEN=${env.GITHUB_TOKEN ? 'set' : 'unset'}\n`)
}
const out = (s) => process.stdout.write(s)
switch (`${args[0]} ${args[1]}`) {
  case 'auth switch':
    process.exit(99)
  case 'auth status':
    out(env.STUB_GH_STATUS_JSON ? readFileSync(env.STUB_GH_STATUS_JSON, 'utf8')
      : '{"hosts":{"github.com":[{"login":"dev-personal","active":true,"state":"success"},{"login":"dev-work","active":false,"state":"success"}]}}\n')
    process.exit(0)
  case 'auth token': {
    const user = args[args.indexOf('--user') + 1]
    if (args.includes('--user') && (user === 'dev-personal' || user === 'dev-work')) {
      out(`token-for-${user}\n`)
      process.exit(0)
    }
    process.stderr.write('no token\n')
    process.exit(1)
  }
  case 'pr list':
    out(env.STUB_GH_PR_JSON ? readFileSync(env.STUB_GH_PR_JSON, 'utf8') : '[]\n')
    process.exit(0)
}
process.exit(0)
