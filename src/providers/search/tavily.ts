import type { SearchResult } from '@/types'
import { assertSearchKey, type SearchQueryOptions, type WebSearchProvider } from './types'

/**
 * Tavily — поисковый API, заточенный под LLM-агентов.
 * POST https://api.tavily.com/search, авторизация: Authorization: Bearer tvly-...
 * Отдаёт готовые сниппеты и дату публикации — хороший вариант по умолчанию.
 */
export function createTavilyProvider(config: { apiKey: string }): WebSearchProvider {
  return {
    id: 'tavily',
    label: 'Tavily',
    requiresKey: true,

    async search(query: string, options: SearchQueryOptions): Promise<SearchResult[]> {
      assertSearchKey('Tavily', config.apiKey)

      const res = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.apiKey.trim()}`,
        },
        body: JSON.stringify({
          query,
          max_results: options.maxResults,
          search_depth: 'basic',
          include_answer: false,
          include_raw_content: false,
        }),
        signal: options.signal,
      })

      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(`Tavily вернул HTTP ${res.status}. ${text.slice(0, 300)}`)
      }

      const json = (await res.json()) as {
        results?: Array<{
          title?: string
          url?: string
          content?: string
          published_date?: string
        }>
      }

      return (json.results ?? [])
        .filter((r) => Boolean(r.url))
        .map((r) => ({
          title: r.title?.trim() || r.url || '',
          url: r.url as string,
          snippet: (r.content ?? '').replace(/\s+/g, ' ').trim(),
          publishedAt: r.published_date,
          source: 'tavily',
        }))
    },
  }
}
