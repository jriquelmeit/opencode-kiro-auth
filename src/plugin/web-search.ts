import { KIRO_CONSTANTS } from '../constants.js'
import { accessTokenExpired } from '../kiro/auth.js'
import type { AccountManager } from './accounts.js'
import * as logger from './logger.js'
import { refreshAccessToken } from './token.js'
import type { KiroAuthDetails } from './types'

// Kiro exposes a server-side web search via the CodeWhisperer InvokeMCP target.
// It speaks JSON-RPC (tools/call) and requires a profileArn, so it is only
// available to Pro accounts. The query is capped at 200 characters by the API.
const MCP_TARGET = 'AmazonCodeWhispererStreamingService.InvokeMCP'
const MAX_QUERY_LENGTH = 200
const REQUEST_TIMEOUT_MS = 30_000

export interface WebSearchResult {
  title: string
  url: string
  snippet: string
  domain?: string
  publishedDate?: number
}

interface McpResponse {
  result?: { content?: Array<{ type: string; text: string }> }
  error?: { code: number; message: string }
}

/**
 * Call Kiro's server-side `web_search` MCP tool with a fresh access token.
 * Returns parsed results, or throws with a readable message on failure.
 */
export async function kiroWebSearch(
  accountManager: AccountManager,
  query: string
): Promise<WebSearchResult[]> {
  const account = accountManager.getCurrentOrNext()
  if (!account) throw new Error('No healthy Kiro account available')
  if (!account.profileArn) {
    throw new Error('Web search requires a Kiro Pro account (no profileArn on this account)')
  }

  let auth: KiroAuthDetails = accountManager.toAuthDetails(account)
  if (accessTokenExpired(auth)) {
    auth = await refreshAccessToken(auth)
    accountManager.updateFromAuth(account, auth)
  }

  const trimmed = query.length > MAX_QUERY_LENGTH ? query.slice(0, MAX_QUERY_LENGTH) : query
  const url = KIRO_CONSTANTS.BASE_URL.replace('/generateAssistantResponse', '/').replace(
    '{{region}}',
    auth.region
  )

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${auth.access}`,
      'Content-Type': 'application/x-amz-json-1.0',
      'X-Amz-Target': MCP_TARGET,
      'x-amzn-kiro-agent-mode': 'vibe'
    },
    body: JSON.stringify({
      profileArn: auth.profileArn,
      jsonrpc: '2.0',
      id: '1',
      method: 'tools/call',
      params: { name: 'web_search', arguments: { query: trimmed } }
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Kiro web search failed: HTTP ${res.status} ${body.slice(0, 200)}`)
  }

  const data = (await res.json()) as McpResponse
  if (data.error) {
    throw new Error(`Kiro web search error: ${data.error.message}`)
  }

  const text = data.result?.content?.find((c) => c.type === 'text')?.text
  if (!text) return []

  try {
    const parsed = JSON.parse(text) as { results?: WebSearchResult[] }
    return parsed.results ?? []
  } catch (e) {
    logger.warn('Kiro web search: failed to parse results payload', e)
    return []
  }
}

/** Render results as compact markdown for the model to consume. */
export function formatWebSearchResults(results: WebSearchResult[]): string {
  if (results.length === 0) return 'No results found.'
  return results
    .map((r, i) => {
      const lines = [`${i + 1}. [${r.title}](${r.url})`]
      const meta: string[] = []
      if (r.domain) meta.push(r.domain)
      if (typeof r.publishedDate === 'number') {
        meta.push(new Date(r.publishedDate).toISOString().slice(0, 10))
      }
      if (meta.length) lines.push(`   ${meta.join(' · ')}`)
      if (r.snippet) lines.push(`   ${r.snippet}`)
      return lines.join('\n')
    })
    .join('\n\n')
}

// Adapted from Kiro's own web_search tool spec so the model gets the same guidance on
// when to search and how to attribute results.
export const WEB_SEARCH_DESCRIPTION = `Search the web using Kiro's built-in search engine. Returns titles, URLs, snippets, domains, and publish dates for a query. Billed as Kiro credits.

## When to Use
- The user asks for current or up-to-date information (pricing, versions, release notes, recent events, library APIs).
- Verifying facts that may have changed recently, or details likely newer than the model's training data.
- Looking up specifics of a library, framework, or tool that can't be reliably inferred from the codebase or context.

## When NOT to Use
- Basic concepts, historical facts, or well-established programming syntax the model already knows.
- Anything answerable from the current repository, files, or conversation. Search the codebase first.

## Query Tips
- Keep queries focused; the query MUST be 200 characters or fewer (longer queries are rejected).
- Rephrase the user's request into effective keywords. Run multiple focused searches for complex questions rather than one broad query.
- The snippets often contain enough to answer directly; only fetch a full page (via a separate fetch tool) when you need more detail.

## Using Results & Attribution
- Prioritize the most recently published, authoritative sources (prefer official docs over blogs; use the domain to judge authority).
- ALWAYS cite sources with inline links in the format [description](url).
- Paraphrase and summarize; do not reproduce more than ~30 consecutive words verbatim from any single source. Preserve factual accuracy while condensing.`
