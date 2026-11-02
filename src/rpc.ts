import { Rpc } from '@opencode/plugin'

/**
 * Bridge between the Kiro server plugin and its TUI part. The server cannot
 * show toasts itself, so the TUI pulls the usage summary on connect.
 */
export const KiroRpc = Rpc.define({
  id: 'kiro',
  methods: {
    usage: {
      input: { type: 'object', additionalProperties: false },
      output: {
        type: 'object',
        properties: {
          items: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                message: { type: 'string' },
                variant: { type: 'string' }
              },
              required: ['message', 'variant'],
              additionalProperties: false
            }
          }
        },
        required: ['items'],
        additionalProperties: false
      }
    }
  },
  events: {
    notice: {
      schema: {
        type: 'object',
        properties: {
          id: { type: 'number' },
          message: { type: 'string' },
          variant: { type: 'string' }
        },
        required: ['id', 'message', 'variant'],
        additionalProperties: false
      }
    }
  }
})
