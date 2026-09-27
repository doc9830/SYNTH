import type { SearchResult } from '@/types'
import { assertSearchKey, type SearchQueryOptions, type WebSearchProvider } from './types'

/**
 * Brave Search API.
 * GET https://api.search.brave.com/res/v1/web/search, заголовок X-Subscription-Token.
 */
export function createBraveProvider(config: { apiKey: string }): WebSearchProvider {
  return {
    id: 'brave',
    label: 'Brave Search',
    requiresKey: true,

    async search(query: string, options: SearchQueryOptions): Promise<SearchResult[]> {
      assertSearchKey('Brave Search', config.apiKey)

      const url = new URL('https://api.search.brave.com/res/v1/web/search')
      url.searchParams.set('q', query)
      url.searchParams.set('count', String(Math.min(options.maxResults, 20)))

      const res = await fetch(url.toString(), {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          'X-Subscription-Token': config.apiKey.trim(),
        },
        signal: options.signal,
      })

      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(`Brave Search вернул HTTP ${res.status}. ${text.slice(0, 300)}`)
      }

      const json = (await res.json()) as {
        web?: {
          results?: Array<{
            title?: string
            url?: string
            description?: string
            age?: string
            page_age?: string
            meta_url?: { hostname?: string }
          }>
        }
      }

      return (json.web?.results ?? [])
        .filter((r) => Boolean(r.url))
        .map((r) => ({
          title: r.title?.trim() || r.url || '',
          url: r.url as string,
          snippet: (r.description ?? '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim(),
          publishedAt: r.page_age ?? r.age,
          source: r.meta_url?.hostname ?? 'brave',
        }))
    },
  }
}
