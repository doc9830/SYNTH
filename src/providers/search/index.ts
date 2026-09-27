import type { SearchSettings } from '@/lib/settings'
import { createBraveProvider } from './brave'
import { createKeylessProvider } from './keyless'
import { createSearxngProvider } from './searxng'
import { createTavilyProvider } from './tavily'
import type { WebSearchProvider } from './types'

export * from './types'
export { createTavilyProvider } from './tavily'
export { createBraveProvider } from './brave'
export { createSearxngProvider } from './searxng'
export { createKeylessProvider, KEYLESS_ENGINE_LABELS, KEYLESS_AUTO_ORDER } from './keyless'

export const SEARCH_PROVIDER_LABELS: Record<SearchSettings['provider'], string> = {
  keyless: 'Без API-ключа (Bing · DuckDuckGo · Wikipedia)',
  tavily: 'Tavily',
  brave: 'Brave Search',
  searxng: 'SearXNG (self-hosted)',
}

/** Создаёт провайдер поиска по настройкам. Возвращает null, если поиск выключен. */
export function createSearchProvider(settings: SearchSettings): WebSearchProvider | null {
  if (!settings.enabled) return null
  switch (settings.provider) {
    case 'keyless':
      return createKeylessProvider({ engine: settings.engine })
    case 'tavily':
      return createTavilyProvider({ apiKey: settings.apiKey })
    case 'brave':
      return createBraveProvider({ apiKey: settings.apiKey })
    case 'searxng':
      return createSearxngProvider({ baseUrl: settings.baseUrl })
    default:
      return null
  }
}

