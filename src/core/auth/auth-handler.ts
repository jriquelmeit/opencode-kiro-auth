import type { AccountRepository } from '../../infrastructure/database/account-repository.js'
import * as logger from '../../plugin/logger.js'
import { kiroDb } from '../../plugin/storage/sqlite.js'
import { summarizeUsage } from '../../plugin/usage.js'
import { UsageTracker } from '../account/usage-tracker.js'
import { IdcAuthMethod } from './idc-auth-method.js'
import { TokenRefresher } from './token-refresher.js'

type ToastFunction = (message: string, variant: 'info' | 'warning' | 'success' | 'error') => void

export class AuthHandler {
  private accountManager?: any
  private startupUsageFetched = false
  private startupUsage: Promise<void> = Promise.resolve()

  constructor(
    private config: any,
    private repository: AccountRepository
  ) {}

  async initialize(showToast?: ToastFunction): Promise<void> {
    const { syncFromKiroCli } = await import('../../plugin/sync/kiro-cli.js')

    // Clean up stale replaced-account rows before loading so multiple opencode
    // instances don't accumulate hundreds of zombie rows in the DB.
    try {
      const removed = await kiroDb.cleanupTestAndStaleAccounts()
      if (removed > 0) logger.log(`Auth init: swept ${removed} stale row(s) from DB`)
    } catch (e) {
      logger.debug(
        `Auth init: cleanup failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`
      )
    }

    logger.log('Auth init', { autoSyncKiroCli: !!this.config.auto_sync_kiro_cli })
    if (this.config.auto_sync_kiro_cli) {
      logger.log('Kiro CLI sync: start')
      await syncFromKiroCli()
      this.repository.invalidateCache()
      const accounts = await this.repository.findAll()
      if (this.accountManager) {
        for (const a of accounts) this.accountManager.addAccount(a)
      }
      logger.log('Kiro CLI sync: done', { importedAccounts: accounts.length })
    }

    // Refresh usage before the summary toast: the persisted value is stale after
    // the monthly reset until the first request syncs. Backgrounded so it never
    // delays the auth loader, and falls back to the stored value on error.
    this.startupUsage = (async () => {
      try {
        await this.refreshUsageFromApi(showToast)
      } catch (e) {
        logger.warn('Startup usage refresh failed', {
          error: e instanceof Error ? e.message : String(e)
        })
      }
      this.logUsageSummary()
    })()
  }

  /** Resolves once the startup usage refresh settled, or after `timeoutMs`. */
  async waitForUsage(timeoutMs = 8000): Promise<void> {
    await Promise.race([
      this.startupUsage,
      new Promise<void>((resolve) => setTimeout(resolve, timeoutMs))
    ])
  }

  /** One line per healthy account, e.g. "Kiro usage (a@b.c): 172.42/2000 (9%)". */
  getUsageMessages(): Array<{ message: string; variant: 'info' | 'warning' }> {
    if (!this.accountManager) return []
    const out: Array<{ message: string; variant: 'info' | 'warning' }> = []
    for (const acc of this.accountManager.getAccounts().filter((a: any) => a.isHealthy)) {
      const { used, limit, pct } = summarizeUsage(acc.usedCount ?? 0, acc.limitCount ?? 0)
      if (limit > 0) {
        out.push({
          message: `Kiro usage (${acc.email}): ${used}/${limit} (${pct}%)`,
          variant: pct >= 90 ? 'warning' : 'info'
        })
      } else if (used > 0) {
        out.push({ message: `Kiro usage (${acc.email}): ${used} requests used`, variant: 'info' })
      }
    }
    return out
  }

  async refreshUsageFromApi(showToast?: ToastFunction): Promise<void> {
    if (!this.accountManager || this.config.usage_tracking_enabled === false) return
    if (this.startupUsageFetched) return
    this.startupUsageFetched = true

    const { syncFromKiroCli } = await import('../../plugin/sync/kiro-cli.js')
    const tokenRefresher = new TokenRefresher(
      this.config,
      this.accountManager,
      syncFromKiroCli,
      this.repository
    )
    const usageTracker = new UsageTracker(this.config, this.accountManager, this.repository)
    const toast: ToastFunction = showToast ?? (() => {})

    for (const acc of this.accountManager.getAccounts()) {
      if (!acc.isHealthy) continue
      try {
        const { account: usable } = await tokenRefresher.refreshIfNeeded(
          acc,
          this.accountManager.toAuthDetails(acc),
          toast
        )
        if (!usable.isHealthy) continue
        await usageTracker.syncNow(usable, this.accountManager.toAuthDetails(usable))
      } catch (e) {
        logger.warn('Startup usage fetch failed; keeping stored value', {
          email: acc.email,
          error: e instanceof Error ? e.message : String(e)
        })
      }
    }
  }

  private logUsageSummary(): void {
    for (const { message } of this.getUsageMessages()) logger.log(message)
  }

  setAccountManager(am: any): void {
    this.accountManager = am
  }

  createIdcMethod(): IdcAuthMethod {
    return new IdcAuthMethod(this.config, this.repository, this.accountManager)
  }
}
