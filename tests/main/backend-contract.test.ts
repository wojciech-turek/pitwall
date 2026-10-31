import { describeBackendContract } from '../helpers/backend-contract'
import { makeTestEnv } from '../helpers/env'

describeBackendContract('tmux', async () => {
  const t = await makeTestEnv()
  return { backend: t.backend, tmp: t.tmp, cleanup: t.cleanup }
})
