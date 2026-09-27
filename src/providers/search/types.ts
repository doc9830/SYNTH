import type { SearchResult } from '@/types'

/**
 * Provider abstraction для веб-поиска.
 * Приложение не привязано к одному поисковику: провайдер выбирается в настройках,
 * а агент видит только общий интерфейс.
 */
export interface WebSearchProvider {
  readonly id: string
  readonly label: string
  /** true, если провайдер требует API key */
  readonly requiresKey: boolean
  /**
   * true — провайдер обязан работать на backend (внешний сервис не отдаёт CORS,
   * как Bing RSS и DuckDuckGo). Браузер в таком случае обращается к /api/search.
   */
  readonly serverSide?: boolean
  search(
    query: string,
    options: { maxResults: number; signal?: AbortSignal },
  ): Promise<SearchResult[]>
}

export interface SearchQueryOptions {
  maxResults: number
  signal?: AbortSignal
}

export function assertSearchKey(providerLabel: string, apiKey: string): void {
  if (!apiKey.trim()) {
    throw new Error(
      `Провайдер поиска «${providerLabel}» требует API key. Укажите его в Settings → Web Search.`,
    )
  }
}
