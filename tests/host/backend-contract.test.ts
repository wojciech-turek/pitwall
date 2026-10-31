import { rm } from 'node:fs/promises'
import { describeBackendContract } from '../helpers/backend-contract'
import { makeHostBackend, makeHostDirs, stopHost } from '../helpers/host'

describeBackendContract('host', async () => {
  const { tmp, dataDir } = await makeHostDirs()
  const backend = makeHostBackend(dataDir)
  return {
    backend,
    tmp,
    async cleanup() {
      backend.disconnect()
      await stopHost(dataDir)
      await rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  }
})
