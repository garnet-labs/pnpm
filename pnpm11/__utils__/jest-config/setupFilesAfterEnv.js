import path from 'path'
import { finishWorkers } from '@pnpm/worker'

const pnpmBinDir = path.join(import.meta.dirname, 'node_modules/.bin')
process.env.PATH = `${pnpmBinDir}${path.delimiter}${process.env.PATH}`

// Tests that hit the real registry fall back to this mirror when
// registry.npmjs.org rate-limits CI. Warn once per test file when the
// fallback is down so a later 429 is not misread as a test failure.
const FALLBACK_MIRROR_PING = 'https://registry.npmmirror.com/-/ping'

beforeAll(async () => {
  try {
    const res = await fetch(FALLBACK_MIRROR_PING, { signal: AbortSignal.timeout(5_000) })
    if (!res.ok) console.warn(`Fallback registry mirror answered ${res.status}`)
  } catch (err) {
    console.warn('Fallback registry mirror is unreachable:', err?.cause?.code ?? err?.message)
  }
})

afterAll(async () => {
  await finishWorkers()
})
