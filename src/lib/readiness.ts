import { nativeHttpAvailable } from '@/lib/nativeHttp'
import { createSearchProvider } from '@/providers/search'
import {
  DEFAULT_SETTINGS,
  type ImageSettings,
  type SearchSettings,
  type Settings,
} from './settings'

/**
 * Проверка готовности инструментов перед отправкой сообщения.
 * Возвращает список проблем — UI показывает их пользователю заранее,
 * а не после «No response».
 */

export interface ReadinessIssue {
  scope: 'api' | 'search' | 'image'
  severity: 'error' | 'warning'
  message: string
  fix: string
}

export interface Readiness {
  issues: ReadinessIssue[]
  /** можно ли вообще отправлять запрос модели */
  canChat: boolean
}

function checkApi(settings: Settings): ReadinessIssue[] {
  const issues: ReadinessIssue[] = []
  const anthropic = settings.protocol === 'anthropic'

  // Claude говорит на своём протоколе, а наш backend — на OpenAI-совместимом:
  // в proxy-режиме запрос уйдёт не туда, поэтому предупреждаем заранее.
  if (anthropic && settings.mode === 'proxy') {
    issues.push({
      scope: 'api',
      severity: 'error',
      message:
        'Тип подключения «Anthropic (Claude)» не работает в proxy-режиме: backend отдаёт OpenAI-протокол.',
      fix: 'Настройки → Подключение → включите direct (ключ хранится в браузере) либо выберите тип «OpenAI-совместимый», если Claude идёт через прокси-шлюз.',
    })
  }

  if (settings.mode !== 'proxy') {
    if (!settings.baseUrl.trim()) {
      issues.push({
        scope: 'api',
        severity: 'error',
        message: 'Не задан адрес API (Base URL).',
        fix: anthropic
          ? 'Откройте «Настроить подключение» и укажите https://api.anthropic.com/v1.'
          : 'Откройте «Настроить подключение» и укажите Base URL провайдера, например https://api.openai.com/v1.',
      })
    } else if (!/\/v\d+\/?$/.test(settings.baseUrl.trim())) {
      issues.push({
        scope: 'api',
        severity: 'warning',
        message: 'Base URL не оканчивается на /v1 — большинство OpenAI-совместимых API ждут версию в пути.',
        fix: 'Примеры: https://api.openai.com/v1, https://openrouter.ai/api/v1.',
      })
    }
    if (!settings.apiKey.trim()) {
      issues.push({
        scope: 'api',
        severity: 'error',
        message: 'Не задан API key.',
        fix: anthropic
          ? 'Ключ Claude создаётся в console.anthropic.com → Settings → API keys и начинается на sk-ant-.'
          : 'Откройте «Настроить подключение» и вставьте ключ провайдера, либо включите proxy-режим (ключ хранится на сервере).',
      })
    } else if (anthropic && !settings.apiKey.trim().startsWith('sk-ant-')) {
      issues.push({
        scope: 'api',
        severity: 'warning',
        message: 'Ключ Anthropic обычно начинается на sk-ant- — похоже, вставлен ключ другого провайдера.',
        fix: 'Проверьте ключ в console.anthropic.com → Settings → API keys.',
      })
    }
  }
  if (!settings.model.trim()) {
    issues.push({
      scope: 'api',
      severity: 'error',
      message: 'Не выбрана модель.',
      fix: '«Настроить подключение» → выберите модель из списка (или введите её id вручную).',
    })
  }
  return issues
}

function checkSearch(settings: Settings): ReadinessIssue[] {
  if (!settings.search.enabled) return []
  const s: SearchSettings = settings.search
  if (s.provider === 'searxng') {
    if (!s.baseUrl.trim()) {
      return [
        {
          scope: 'search',
          severity: 'warning',
          message: 'SearXNG выбран провайдером поиска, но не задан адрес инстанса.',
          fix: 'Настройки → Поиск → Base URL (например, http://localhost:8080).',
        },
      ]
    }
    return []
  }
  const provider = createSearchProvider({ ...s, enabled: true })
  if (provider?.requiresKey && !s.apiKey.trim()) {
    return [
      {
        scope: 'search',
        severity: 'warning',
        message: `Провайдер поиска «${provider.label}» не настроен: нет API key.`,
        fix: 'Настройки → Поиск → API key. Либо выберите «Бесплатный поиск (без API-ключа)».',
      },
    ]
  }
  // Бесплатный поиск и чтение страниц: в браузере их выполняет backend
  // (Bing/DuckDuckGo не отдают CORS, произвольные сайты закрыты для browser-fetch),
  // а в APK запросы идут через нативный HTTP и работают без сервера.
  const standalone = nativeHttpAvailable() && settings.mode === 'direct' && !s.backendUrl.trim()
  if (standalone) {
    if (s.readPages) {
      return [
        {
          scope: 'search',
          severity: 'warning',
          message: 'Скриншоты страниц делает только backend: в приложении доступны текст, структура и метаданные страницы.',
          fix: 'Если нужны скриншоты, укажите адрес backend в Настройки → Поиск → Backend URL.',
        },
      ]
    }
    return []
  }

  if (settings.mode === 'direct' && (provider?.serverSide || s.readPages)) {
    const endpoints = [provider?.serverSide ? '/api/search' : null, s.readPages ? '/api/page' : null]
      .filter(Boolean)
      .join(' и ')
    return [
      {
        scope: 'search',
        severity: 'warning',
        message: s.backendUrl.trim()
          ? `Поиск и чтение страниц выполняет backend: ${s.backendUrl.trim()}${endpoints ? ` (${endpoints})` : ''}.`
          : `Работа с вебом выполняется локальным backend (${endpoints}): браузерные запросы к этим сервисам блокируются (CORS).`,
        fix: 'Держите запущенным npm run dev:api. Если фронтенд открыт не с backend-хоста — укажите Настройки → Поиск → Backend URL.',
      },
    ]
  }
  return []
}

function checkImage(settings: Settings): ReadinessIssue[] {
  if (!settings.image.enabled) return []
  const i: ImageSettings = settings.image
  const issues: ReadinessIssue[] = []

  // Claude не умеет рисовать: с его протоколом картинки работают только
  // через отдельное подключение («inherit» уходит в Claude и падает).
  if (settings.protocol === 'anthropic' && i.mode === 'inherit') {
    issues.push({
      scope: 'image',
      severity: 'warning',
      message: 'Генерация изображений включена, но протокол Anthropic (Claude) картинки не поддерживает.',
      fix: 'Настройки → Подключение → Генерация изображений: задайте своё подключение (OpenAI, Gemini) либо выключите генерацию картинок.',
    })
  }

  if (!i.model.trim()) {
    issues.push({
      scope: 'image',
      severity: 'warning',
      message: 'Генерация изображений включена, но модель не выбрана.',
      fix: 'Выберите модель в настройках → «Подключение» (например, gpt-image-1 или gemini-2.5-flash-image) либо отключите генерацию картинок.',
    })
  }
  return issues
}

export function getReadiness(settings: Settings): Readiness {
  const issues = [...checkApi(settings), ...checkSearch(settings), ...checkImage(settings)]
  return {
    issues,
    canChat: !issues.some((i) => i.severity === 'error'),
  }
}

/**
 * Сброс к дефолтам конкретной секции — удобно в настройках.
 */
export function defaultSearch(): SearchSettings {
  return { ...DEFAULT_SETTINGS.search }
}
export function defaultImage(): ImageSettings {
  return { ...DEFAULT_SETTINGS.image }
}
