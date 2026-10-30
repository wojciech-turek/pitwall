export async function waitFor<T>(
  fn: () => Promise<T | false | null | undefined>,
  timeoutMs = 8000,
  label = 'condition'
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  for (;;) {
    try {
      const v = await fn()
      if (v) return v
    } catch (e) {
      lastError = e
    }
    if (Date.now() > deadline) {
      const extra = lastError instanceof Error ? ` (last error: ${lastError.message})` : ''
      throw new Error(`Timed out after ${timeoutMs}ms waiting for ${label}${extra}`)
    }
    await new Promise((r) => setTimeout(r, 100))
  }
}
