import { describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { withRefreshLock } from '../plugin/storage/refresh-lock.js'
import { DB_PATH } from '../plugin/storage/sqlite.js'

describe('withRefreshLock', () => {
  test('serializes concurrent calls for the same account', async () => {
    const events: string[] = []
    const p1 = withRefreshLock('acc-test-1', async () => {
      events.push('p1-start')
      await new Promise((r) => setTimeout(r, 60))
      events.push('p1-end')
      return 1
    })
    const p2 = withRefreshLock('acc-test-1', async () => {
      events.push('p2-start')
      events.push('p2-end')
      return 2
    })

    const [r1, r2] = await Promise.all([p1, p2])
    expect(r1).toBe(1)
    expect(r2).toBe(2)
    // p1 must fully finish before p2 starts
    expect(events).toEqual(['p1-start', 'p1-end', 'p2-start', 'p2-end'])
  })

  test('creates the refresh lock target file', () => {
    expect(existsSync(`${DB_PATH}.refresh`)).toBe(true)
  })
})
