import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { Integration, Model, Plugin, Provider } from '@opencode/plugin'
import { buildModelRegistry } from './plugin/model-registry.js'
import { getRuntime, type KiroRuntime } from './plugin/runtime.js'
import {
  formatWebSearchResults,
  kiroWebSearch,
  WEB_SEARCH_DESCRIPTION
} from './plugin/web-search.js'
import { KiroRpc } from './rpc.js'

const KIRO_PROVIDER_ID = Provider.ID.make('kiro')
const INTEGRATION_ID = Integration.ID.make('kiro')
const METHOD_IDC = Integration.MethodID.make('idc')
const METHOD_PROFILE = Integration.MethodID.make('profile')
const METHOD_COMMAND = Integration.MethodID.make('kiro-cli')

function buildModels(): Model.Info[] {
  const specs = buildModelRegistry() as Record<string, any>
  return Object.entries(specs).map(([modelID, spec]: [string, any]) => {
    const base = Model.Info.default(KIRO_PROVIDER_ID, Model.ID.make(modelID))
    const limit = spec.limit ?? { context: 200000, output: 64000 }
    const input: string[] = spec.modalities?.input ?? ['text']

    const variants: any[] = []
    if (spec.variants && typeof spec.variants === 'object') {
      for (const [variantKey, variantVal] of Object.entries(spec.variants)) {
        variants.push({
          id: Model.VariantID.make(variantKey),
          settings: variantVal as any,
          body: variantVal as any
        })
      }
    }

    const info: any = {
      ...base,
      name: spec.name ?? modelID,
      capabilities: {
        tools: true,
        input,
        output: ['text']
      },
      limit: { context: limit.context, output: limit.output },
      variants,
      enabled: true,
      status: 'active' as const
    }

    if (spec.reasoning) {
      info.compatibility = {
        reasoningField: spec.interleaved?.field ?? 'reasoning_content'
      }
    }

    return info as Model.Info
  })
}

const plugin = Plugin.define({
  id: 'kiro',

  async setup(ctx) {
    const runtime: KiroRuntime = await getRuntime(ctx.location?.directory || '')
    const abortController = new AbortController()

    // 1. Dynamic Provider + Models
    const models = buildModels()
    await ctx.provider.transform((editor) => {
      const existing = editor.get(KIRO_PROVIDER_ID)
      if (!existing) {
        editor.add({
          info: {
            ...Provider.Info.empty(KIRO_PROVIDER_ID),
            name: 'Kiro',
            activation: 'enabled' as const,
            package: 'aisdk:@ai-sdk/openai-compatible',
            settings: {
              baseURL: runtime.baseURL,
              apiKey: 'kiro-managed'
            },
            integrationID: INTEGRATION_ID
          } as any,
          models
        })
      } else {
        editor.models.set(KIRO_PROVIDER_ID, models)
      }
    })

    // 2. Custom SDK & Language hook (replaces the local 127.0.0.1:40129 proxy)
    const sdkInstance = createOpenAICompatible({
      name: 'kiro',
      baseURL: runtime.baseURL,
      includeUsage: true,
      fetch: ((input: any, init?: any) => {
        return runtime.requestHandler.handle(input, init, (msg, variant) => {
          runtime.notify(msg, variant)
        })
      }) as any
    })

    await ctx.aisdk.hook(
      'sdk',
      (e) => {
        const pkg = e.package.replace(/^aisdk:/, '')
        if (pkg === '@ai-sdk/openai-compatible' || pkg === 'openai-compatible') {
          e.sdk = sdkInstance
        }
      },
      { providerID: KIRO_PROVIDER_ID }
    )

    await ctx.aisdk.hook(
      'language',
      (e) => {
        if (e.sdk && typeof e.sdk.chatModel === 'function') {
          e.language = e.sdk.chatModel(e.model.modelID ?? e.model.id)
        }
      },
      { providerID: KIRO_PROVIDER_ID }
    )

    // 3. Integration (/connect) methods
    const idcMethod = runtime.authHandler.createIdcMethod()

    const makeOauthCredential = (methodID: any, key: string, accountId: string, email: string) => ({
      type: 'oauth' as const,
      methodID,
      refresh: 'kiro-managed',
      access: key || 'kiro-managed',
      expires: Date.now() + 365 * 24 * 60 * 60 * 1000,
      metadata: { accountId, email }
    })

    await ctx.integration.transform((editor) => {
      if (!editor.get(INTEGRATION_ID)) {
        editor.update(INTEGRATION_ID, (i) => {
          i.id = INTEGRATION_ID
          i.name = 'Kiro (AWS CodeWhisperer)'
        })
      }

      // Method A: AWS Builder ID / IAM Identity Center
      editor.method.update({
        integrationID: INTEGRATION_ID,
        method: {
          id: METHOD_IDC,
          type: 'oauth',
          label: 'AWS Builder ID / IAM Identity Center',
          form: [
            {
              type: 'string',
              key: 'start_url',
              title: 'IAM Identity Center Start URL',
              description: 'Leave blank for AWS Builder ID',
              required: false
            },
            {
              type: 'string',
              key: 'idc_region',
              title: 'IAM Identity Center Region (sso_region)',
              description: 'Leave blank for us-east-1',
              required: false
            }
          ] as any
        },
        authorize: async (answer) => {
          const result = await idcMethod.authorize(answer as any)
          const run = async () => {
            const r = await result.callback()
            runtime.notify(`Kiro connected: ${r.email}`, 'success')
            return makeOauthCredential(METHOD_IDC, r.key, r.accountId, r.email)
          }
          return {
            url: result.url,
            instructions: result.instructions,
            mode: 'auto',
            callback: run()
          }
        },
        refresh: async (cred) => cred,
        label: (cred) => {
          const email = (cred.metadata as any)?.email
          return email ? `Kiro (${email})` : 'Kiro (IAM Identity Center)'
        }
      })

      // Method B: IAM Identity Center with Application Profile ARN
      editor.method.update({
        integrationID: INTEGRATION_ID,
        method: {
          id: METHOD_PROFILE,
          type: 'oauth',
          label: 'IAM Identity Center with Profile ARN',
          form: [
            {
              type: 'string',
              key: 'start_url',
              title: 'Start URL',
              required: true
            },
            {
              type: 'string',
              key: 'profile_arn',
              title: 'Application Profile ARN',
              description: 'arn:aws:codewhisperer:... or arn:aws:qdeveloper:...',
              required: true
            },
            {
              type: 'string',
              key: 'idc_region',
              title: 'SSO Region',
              description: 'Defaults to us-east-1',
              required: false
            }
          ] as any
        },
        authorize: async (answer) => {
          const result = await idcMethod.authorize(answer as any)
          const run = async () => {
            const r = await result.callback()
            runtime.notify(`Kiro profile connected: ${r.email}`, 'success')
            return makeOauthCredential(METHOD_PROFILE, r.key, r.accountId, r.email)
          }
          return {
            url: result.url,
            instructions: result.instructions,
            mode: 'auto',
            callback: run()
          }
        },
        refresh: async (cred) => cred,
        label: (cred) => {
          const email = (cred.metadata as any)?.email
          return email ? `Kiro Profile (${email})` : 'Kiro Profile ARN'
        }
      })

      // Method C: kiro-cli sync via command
      editor.method.update({
        integrationID: INTEGRATION_ID,
        method: {
          id: METHOD_COMMAND,
          type: 'command',
          label: 'Sync from Kiro CLI (runs kiro-cli login)',
          command: ['kiro-cli', 'login']
        }
      })
    })

    // 4. Built-in tool: kiro_web_search (when enabled and an account with profileArn exists)
    if (runtime.config.web_search_enabled && runtime.hasWebSearchAccount()) {
      await ctx.tool.transform((editor) => {
        if (!editor.get('kiro_web_search')) {
          editor.add({
            name: 'kiro_web_search',
            description: WEB_SEARCH_DESCRIPTION,
            input: {
              type: 'object',
              properties: {
                query: {
                  type: 'string',
                  description: 'The search query. Must be 200 characters or fewer.'
                }
              },
              required: ['query'],
              additionalProperties: false
            } as any,
            execute: async (args: { query: string }) => {
              try {
                const results = await kiroWebSearch(runtime.accountManager, args.query)
                return { content: formatWebSearchResults(results) }
              } catch (e) {
                return {
                  content: `Web search failed: ${e instanceof Error ? e.message : String(e)}`
                }
              }
            }
          })
        }
      })
    }

    // 5. Server-to-TUI RPC Registration
    const rpcRegistration = await ctx.rpc.register(KiroRpc, {
      usage: async () => {
        await runtime.authHandler.waitForUsage()
        return { items: runtime.authHandler.getUsageMessages() }
      }
    })

    const unsubscribeNotifier = runtime.addNotifier((notice) => {
      rpcRegistration.events.emit('notice', notice).catch(() => {})
    })

    // 6. Listen to OpenCode credential and integration events to resync
    void (async () => {
      try {
        const events = ctx.event.subscribe()
        for await (const evt of events) {
          if (abortController.signal.aborted) break
          if (
            evt.type === 'credential.switched' ||
            evt.type === 'credential.updated' ||
            evt.type === 'integration.updated'
          ) {
            await runtime.resync().catch(() => {})
            await ctx.tool.reload().catch(() => {})
            await ctx.provider.reload().catch(() => {})
          }
        }
      } catch {}
    })()

    // 7. Cleanup on unload
    return async () => {
      abortController.abort()
      unsubscribeNotifier()
      await rpcRegistration.dispose().catch(() => {})
    }
  }
})

export default plugin
export { buildModelRegistry }
