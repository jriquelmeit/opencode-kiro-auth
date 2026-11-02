import { Integration, Model, Plugin, Provider } from '@opencode/plugin'
import { KIRO_CONSTANTS } from './constants.js'
import { AuthHandler } from './core/auth/auth-handler.js'
import { RequestHandler } from './core/request/request-handler.js'
import { AccountCache } from './infrastructure/database/account-cache.js'
import { AccountRepository } from './infrastructure/database/account-repository.js'
import { AccountManager } from './plugin/accounts.js'
import { bootstrapAuthIfNeeded } from './plugin/auth-bootstrap.js'
import { loadConfig } from './plugin/config/index.js'
import * as logger from './plugin/logger.js'
import { buildModelRegistry } from './plugin/model-registry.js'

const KIRO_PROVIDER_ID = Provider.ID.make('kiro')
const PROXY_PORT = 40129

function buildBaseUrl(region: string): string {
  return KIRO_CONSTANTS.BASE_URL.replace('/generateAssistantResponse', '').replace(
    '{{region}}',
    region || 'us-east-1'
  )
}

async function ensureProxy(
  requestHandler: RequestHandler,
  showToast: (m: string, v: string) => void
): Promise<void> {
  try {
    const probe = await fetch(`http://127.0.0.1:${PROXY_PORT}/health`, {
      signal: AbortSignal.timeout(300)
    }).catch(() => null)
    if (probe?.ok) {
      logger.log('Proxy already running')
      return
    }
  } catch {}

  try {
    const server = Bun.serve({
      port: PROXY_PORT,
      async fetch(req: Request): Promise<Response> {
        if (new URL(req.url).pathname === '/health') return new Response('ok')
        try {
          const body = req.method !== 'GET' ? await req.text() : undefined
          const headers: Record<string, string> = {}
          req.headers.forEach((v, k) => {
            headers[k] = v
          })

          // Rewrite proxy URL to the real Kiro API endpoint so the request
          // handler's URL pattern check passes and it routes correctly.
          const proxyUrl = new URL(req.url)
          const kiroBaseUrl = buildBaseUrl(loadConfig('').default_region || 'us-east-1')
          const realUrl = kiroBaseUrl + proxyUrl.pathname + proxyUrl.search

          return await requestHandler.handle(
            realUrl,
            { method: req.method, headers, body },
            showToast
          )
        } catch (e) {
          logger.warn(`Proxy error: ${e instanceof Error ? e.message : String(e)}`)
          return new Response(JSON.stringify({ error: String(e) }), {
            status: 500,
            headers: { 'content-type': 'application/json' }
          })
        }
      }
    })
    logger.log(`Kiro proxy started on port ${server.port}`)
  } catch (e) {
    // Port already in use from another plugin instance — that's fine
    logger.log(
      `Proxy bind skipped (likely already running): ${e instanceof Error ? e.message : String(e)}`
    )
  }
}

function buildModels(): Model.Info[] {
  const specs = buildModelRegistry() as Record<string, any>
  return Object.entries(specs).map(([modelID, spec]: [string, any]) => {
    const base = Model.Info.default(KIRO_PROVIDER_ID, Model.ID.make(modelID))
    const limit = spec.limit ?? { context: 200000, output: 64000 }
    return {
      ...base,
      name: spec.name ?? modelID,
      capabilities: {
        tools: true,
        input: spec.modalities?.input ?? ['text'],
        output: ['text']
      },
      limit: { context: limit.context, output: limit.output },
      enabled: true,
      status: 'active' as const
    }
  })
}

// ---------------------------------------------------------------------------
// V2 plugin
// ---------------------------------------------------------------------------
const v2Plugin = Plugin.define({
  id: 'kiro',

  async setup(ctx) {
    const config = loadConfig(ctx.location?.directory || '')
    const proxyBaseURL = `http://127.0.0.1:${PROXY_PORT}`

    const cache = new AccountCache(60000)
    const repository = new AccountRepository(cache)
    const authHandler = new AuthHandler(config, repository)
    const accountManager = await AccountManager.loadFromDisk(config.account_selection_strategy)
    authHandler.setAccountManager(accountManager)
    const requestHandler = new RequestHandler(accountManager, config, repository, undefined)
    const showToast = (msg: string, v: string) => logger.log(`[toast:${v}] ${msg}`)

    bootstrapAuthIfNeeded('kiro')
    await authHandler.initialize(showToast as any)
    await ensureProxy(requestHandler, showToast)

    // ctx.provider.transform is per-location: it only registers the provider
    // for the plugin's own directory, not for the user's project directories.
    // The provider is defined globally in opencode.jsonc pointing to the proxy.
    // Here we only need the proxy running — no transform needed.

    // --- Register integration so kiro appears in /connect ---
    const INTEGRATION_ID = 'kiro'
    const METHOD_ID = Integration.MethodID.make('idc')
    const METHOD_BUILDERID = Integration.MethodID.make('builder-id')

    await ctx.integration.transform((editor) => {
      // Ensure the integration entry exists
      if (!editor.get(INTEGRATION_ID)) {
        editor.update(INTEGRATION_ID, (i) => {
          i.id = INTEGRATION_ID
          i.name = 'Kiro (AWS CodeWhisperer)'
        })
      }

      // IAM Identity Center / AWS Builder ID — OAuth flow handled by the existing IdcAuthMethod
      editor.method.update({
        integrationID: INTEGRATION_ID,
        method: {
          id: METHOD_ID,
          type: 'oauth' as const,
          label: 'AWS Builder ID / IAM Identity Center',
          form: [
            {
              type: 'string' as const,
              key: 'start_url',
              title: 'IAM Identity Center Start URL',
              description: 'Leave blank for AWS Builder ID',
              required: false
            },
            {
              type: 'string' as const,
              key: 'idc_region',
              title: 'IAM Identity Center Region (sso_region)',
              description: 'Leave blank for us-east-1',
              required: false
            }
          ]
        },
        authorize: async (answer: Record<string, any>) => {
          const idcMethod = authHandler.getMethods().find((m: any) => m.type === 'oauth')
          if (!idcMethod) throw new Error('No OAuth method available')
          const result = await (idcMethod as any).authorize(answer)

          // Wrap the v1 callback to return a Credential.OAuth compatible object.
          // The actual token is saved to kiro.db inside the callback — OpenCode's
          // credential store is used as a signal that auth completed, not for storage.
          const wrapCallback = async (): Promise<any> => {
            const r = await result.callback()
            if (r.type === 'failed') throw new Error('Authorization failed')
            // r.key is the access token; we store a minimal OAuth credential
            // so OpenCode knows the integration is connected.
            return {
              type: 'oauth' as const,
              methodID: METHOD_ID,
              refresh: 'kiro-managed', // kiro.db manages actual refresh
              access: r.key ?? 'kiro-managed',
              expires: Date.now() + 8 * 60 * 60 * 1000 // 8h placeholder
            }
          }

          return {
            url: result.url,
            instructions: result.instructions,
            mode: 'auto' as const,
            callback: wrapCallback() // Promise<Credential.OAuth> for auto mode
          }
        }
      })

      // Kiro CLI sync — uses kiro-cli login (command-based)
      editor.method.update({
        integrationID: INTEGRATION_ID,
        method: {
          id: METHOD_BUILDERID,
          type: 'command' as const,
          label: 'Sync from Kiro CLI (run kiro-cli login first)',
          command: ['kiro-cli', 'login']
        }
      })
    })
  }
})

// ---------------------------------------------------------------------------
// V1 compat server function (OpenCode v1 calls this)
// ---------------------------------------------------------------------------
async function v1Server({ client, directory }: any): Promise<any> {
  const { tool } = await import('@opencode-ai/plugin')
  const { formatWebSearchResults, kiroWebSearch } = await import('./plugin/web-search.js')

  const config = loadConfig(directory || '')
  const baseURL = buildBaseUrl(config.default_region || 'us-east-1')
  const showToast = (msg: string, variant: string) => {
    try {
      client?.tui?.showToast({ body: { message: msg, variant } }).catch(() => {})
    } catch {}
  }

  const cache = new AccountCache(60000)
  const repository = new AccountRepository(cache)
  const authHandler = new AuthHandler(config, repository)
  const accountManager = await AccountManager.loadFromDisk(config.account_selection_strategy)
  authHandler.setAccountManager(accountManager)
  const requestHandler = new RequestHandler(accountManager, config, repository, client)

  return {
    config: async (input: any) => {
      bootstrapAuthIfNeeded('kiro')
      if (!input.provider) input.provider = {}
      if (!input.provider.kiro) input.provider.kiro = {}
      input.provider.kiro.npm = '@ai-sdk/openai-compatible'
      if (!input.provider.kiro.api) input.provider.kiro.api = baseURL
      if (!input.provider.kiro.models) input.provider.kiro.models = buildModelRegistry()
    },
    auth: {
      provider: 'kiro',
      loader: async (getAuth: any) => {
        await getAuth()
        await authHandler.initialize(showToast as any)
        return {
          apiKey: '',
          baseURL,
          fetch: (req: any, init?: any) => requestHandler.handle(req, init, showToast)
        }
      },
      methods: authHandler.getMethods()
    },
    provider: {
      id: 'kiro',
      models: async (provider: any) => {
        const models = provider?.models || {}
        const normalized: Record<string, any> = {}
        for (const [id, model] of Object.entries(models)) {
          const m = model as any
          normalized[id] = {
            ...m,
            api: { ...(m.api || {}), npm: '@ai-sdk/openai-compatible', url: m.api?.url || baseURL }
          }
        }
        return normalized
      }
    },
    tool:
      config.web_search_enabled && accountManager.getCurrentOrNext()?.profileArn
        ? {
            kiro_web_search: tool({
              description: "Search the web using Kiro's built-in search engine.",
              args: {
                query: tool.schema
                  .string()
                  .describe('The search query. Must be 200 characters or fewer.')
              },
              async execute(args: { query: string }) {
                try {
                  return formatWebSearchResults(await kiroWebSearch(accountManager, args.query))
                } catch (e) {
                  return `Web search failed: ${e instanceof Error ? e.message : String(e)}`
                }
              }
            })
          }
        : {}
  }
}

export default { ...v2Plugin, server: v1Server }
export { buildModelRegistry }
