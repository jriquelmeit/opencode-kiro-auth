import { KIRO_CONSTANTS } from '../constants.js'
import { AuthHandler } from '../core/auth/auth-handler.js'
import { RequestHandler } from '../core/request/request-handler.js'
import { AccountCache } from '../infrastructure/database/account-cache.js'
import { AccountRepository } from '../infrastructure/database/account-repository.js'
import { AccountManager } from './accounts.js'
import { loadConfig, type KiroConfig } from './config/index.js'
import * as logger from './logger.js'
import { syncFromKiroCli } from './sync/kiro-cli.js'

export type NoticeVariant = 'info' | 'success' | 'warning' | 'error'
export type Notifier = (notice: { id: number; message: string; variant: NoticeVariant }) => void

export interface KiroRuntime {
  config: KiroConfig
  repository: AccountRepository
  accountManager: AccountManager
  authHandler: AuthHandler
  requestHandler: RequestHandler
  notify: (message: string, variant: NoticeVariant) => void
  addNotifier: (notifier: Notifier) => () => void
  resync: () => Promise<void>
  hasWebSearchAccount: () => boolean
  baseURL: string
}

const RUNTIME_KEY = Symbol.for('opencode-kiro-auth.runtime')

export function buildBaseUrl(region: string): string {
  return KIRO_CONSTANTS.BASE_URL.replace('/generateAssistantResponse', '').replace(
    '{{region}}',
    region || 'us-east-1'
  )
}

async function createRuntime(directory: string): Promise<KiroRuntime> {
  const config = loadConfig(directory)
  const repository = new AccountRepository(new AccountCache(60000))
  const accountManager = await AccountManager.loadFromDisk(config.account_selection_strategy)
  const authHandler = new AuthHandler(config, repository)
  authHandler.setAccountManager(accountManager)

  const notifiers = new Set<Notifier>()
  let noticeId = 0
  const notify = (message: string, variant: NoticeVariant) => {
    logger.log(`[notice:${variant}] ${message}`)
    const notice = { id: ++noticeId, message, variant }
    for (const notifier of notifiers) {
      try {
        notifier(notice)
      } catch {}
    }
  }

  const requestHandler = new RequestHandler(accountManager, config, repository)

  await authHandler.initialize(notify)

  return {
    config,
    repository,
    accountManager,
    authHandler,
    requestHandler,
    notify,
    addNotifier(notifier) {
      notifiers.add(notifier)
      return () => notifiers.delete(notifier)
    },
    async resync() {
      await syncFromKiroCli()
      repository.invalidateCache()
      for (const acc of await repository.findAll()) accountManager.addAccount(acc)
    },
    hasWebSearchAccount() {
      return accountManager.getAccounts().some((a) => a.isHealthy && !!a.profileArn)
    },
    baseURL: buildBaseUrl(config.default_region || 'us-east-1')
  }
}

/**
 * OpenCode v2 calls setup() once per location. All of them must share a single
 * account pool and request queue, otherwise several instances in one process
 * refresh the same rotating refresh token at once.
 */
export function getRuntime(directory: string): Promise<KiroRuntime> {
  const store = globalThis as any
  if (!store[RUNTIME_KEY]) {
    const created = createRuntime(directory)
    store[RUNTIME_KEY] = created
    created.catch(() => {
      if (store[RUNTIME_KEY] === created) delete store[RUNTIME_KEY]
    })
  }
  return store[RUNTIME_KEY]
}
