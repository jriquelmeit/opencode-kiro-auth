import { Plugin } from '@opencode/plugin/tui'
import { KiroRpc } from './rpc.js'

type ToastVariant = 'info' | 'warning' | 'success' | 'error'

/**
 * TUI companion for the Kiro plugin.
 * The OpenCode server has no direct toast API; this client connects to the server
 * via the typed KiroRpc, pulls startup usage, and listens for live notice events.
 */
const tuiPlugin = Plugin.define({
  id: 'kiro.tui',

  setup(context) {
    const seenNoticeIds = new Set<number>()
    let isDisposed = false

    const show = (message: string, variant: ToastVariant = 'info') => {
      try {
        context.ui.toast.show({ message, variant })
      } catch {}
    }

    const rpc = context.client.rpc(KiroRpc)

    // 1. Pull startup usage summary with retries (the server might still be loading)
    void (async () => {
      for (let attempt = 0; attempt < 10; attempt++) {
        if (isDisposed) return
        try {
          const res = (await rpc.usage({})) as any
          if (res?.items && Array.isArray(res.items)) {
            for (const item of res.items) {
              show(item.message, (item.variant as ToastVariant) || 'info')
            }
            return
          }
        } catch {
          await new Promise((r) => setTimeout(r, 1000))
        }
      }
    })()

    // 2. Subscribe to server notices (auth changes, syncs, quota warnings)
    const unsubscribe = rpc.events.on('notice', (event: any) => {
      if (isDisposed) return
      const data = event.data as { id: number; message: string; variant: string }
      if (!data || typeof data.id !== 'number') return
      if (seenNoticeIds.has(data.id)) return
      seenNoticeIds.add(data.id)
      show(data.message, (data.variant as ToastVariant) || 'info')
    })

    return () => {
      isDisposed = true
      unsubscribe()
    }
  }
})

export default tuiPlugin
