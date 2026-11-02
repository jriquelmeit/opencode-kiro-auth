import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import lockfile from 'proper-lockfile'
import { DB_PATH } from './sqlite'

const REFRESH_LOCK_OPTIONS = {
  stale: 30000,
  update: 10000,
  retries: {
    retries: 40,
    minTimeout: 250,
    maxTimeout: 1000,
    factor: 1.3
  },
  realpath: false
}

const inFlight = new Map<string, Promise<unknown>>()

function lockTarget(): string {
  const target = `${DB_PATH}.refresh`
  if (!existsSync(target)) {
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, '')
  }
  return target
}

/**
 * Serializes token refreshes for one account across every opencode instance
 * and every plugin location in this process. The refresh token rotates on use,
 * so two concurrent refreshes with the same token make the second one fail with
 * invalid_grant and mark a healthy account as permanently unhealthy.
 */
export async function withRefreshLock<T>(accountId: string, fn: () => Promise<T>): Promise<T> {
  const pending = inFlight.get(accountId)
  if (pending) {
    await pending.catch(() => {})
  }

  const run = (async () => {
    const release = await lockfile.lock(lockTarget(), REFRESH_LOCK_OPTIONS)
    try {
      return await fn()
    } finally {
      await release().catch(() => {})
    }
  })()

  inFlight.set(accountId, run)
  try {
    return await run
  } finally {
    if (inFlight.get(accountId) === run) inFlight.delete(accountId)
  }
}
