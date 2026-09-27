import type { SearchResult } from '@/types'
import type { SearchQueryOptions, WebSearchProvider } from './types'

/**
 * SearXNG — self-hosted мета-поисковик без API key.
 * Требует, чтобы в инстансе был включён JSON-формат (search.formats: [json]).
 * GET {baseUrl}/search?q=...&format=json
 */
export function createSearxngProvider(config: { baseUrl: string }): WebSearchProvider {
  return {
    id: 'searxng',
    label: 'SearXNG (self-hosted)',
    requiresKey: false,

    async search(query: string, options: SearchQueryOptions): Promise<SearchResult[]> {
      const base = config.baseUrl.trim().replace(/\/+$/, '')
      if (!base) {
        throw new Error(
          'Для SearXNG укажите адрес инстанса (Settings → Web Search → Base URL), например http://localhost:8080',
        )
      }

      const url = new URL(`${base}/search`)
      url.searchParams.set('q', query)
      url.searchParams.set('format', 'json')
      url.searchParams.set('language', 'ru-RU')
      url.searchParams.set('safesearch', '1')

      const res = await fetch(url.toString(), {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: options.signal,
      })

      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(
          `SearXNG вернул HTTP ${res.status}. Проверьте, что в инстансе включён JSON-формат и разрешён CORS. ${text.slice(0, 200)}`,
        )
      }

      const json = (await res.json()) as {
        results?: Array<{
          title?: string
          url?: string
          content?: string
          publishedDate?: string | null
          engine?: string
        }>
      }

      return (json.results ?? [])
        .slice(0, options.maxResults)
        .filter((r) => Boolean(r.url))
        .map((r) => ({
          title: r.title?.trim() || r.url || '',
          url: r.url as string,
          snippet: (r.content ?? '').replace(/\s+/g, ' ').trim(),
          publishedAt: r.publishedDate ?? undefined,
          source: r.engine ?? 'searxng',
        }))
    },
  }
}
