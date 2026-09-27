/**
 * Пресеты провайдеров: подставляют Base URL и подсказывают, где взять ключ.
 *
 * Приложение — универсальный клиент: работает с любым OpenAI-совместимым API
 * (/v1/models, /v1/chat/completions). Список ниже лишь экономит ввод,
 * пользователь всегда может выбрать «Другой / свой» и указать адрес вручную.
 */

export interface ProviderPreset {
  id: string
  label: string
  baseUrl: string
  /** Короткая подсказка про модель для плейсхолдера */
  modelHint?: string
  /** Где взять API-ключ */
  keyUrl?: string
  /** Локальный сервер (ключ обычно не нужен) */
  local?: boolean
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    modelHint: 'gpt-4o-mini',
    keyUrl: 'https://platform.openai.com/api-keys',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    modelHint: 'openai/gpt-4o-mini',
    keyUrl: 'https://openrouter.ai/keys',
  },
  {
    id: 'ruapi',
    label: 'RuAPI',
    baseUrl: 'https://www.ruapi.ai/v1',
    modelHint: 'deepseek-v4.1-flash',
    keyUrl: 'https://www.ruapi.ai',
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    modelHint: 'deepseek-chat',
    keyUrl: 'https://platform.deepseek.com/api_keys',
  },
  {
    id: 'groq',
    label: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    modelHint: 'llama-3.3-70b-versatile',
    keyUrl: 'https://console.groq.com/keys',
  },
  {
    id: 'mistral',
    label: 'Mistral',
    baseUrl: 'https://api.mistral.ai/v1',
    modelHint: 'mistral-large-latest',
    keyUrl: 'https://console.mistral.ai/api-keys',
  },
  {
    id: 'together',
    label: 'Together AI',
    baseUrl: 'https://api.together.xyz/v1',
    modelHint: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
    keyUrl: 'https://api.together.xyz/settings/api-keys',
  },
  {
    id: 'ollama',
    label: 'Ollama (локально)',
    baseUrl: 'http://localhost:11434/v1',
    modelHint: 'llama3.2',
    local: true,
  },
  {
    id: 'lmstudio',
    label: 'LM Studio (локально)',
    baseUrl: 'http://localhost:1234/v1',
    modelHint: 'local-model',
    local: true,
  },
  { id: 'custom', label: 'Другой / свой адрес', baseUrl: '' },
]

export function presetById(id: string): ProviderPreset | undefined {
  return PROVIDER_PRESETS.find((p) => p.id === id)
}

/** Пресет по введённому Base URL (для подписи «провайдер: …»). */
export function presetByBaseUrl(baseUrl: string): ProviderPreset | undefined {
  const normalized = baseUrl.trim().replace(/\/+$/, '').toLowerCase()
  if (!normalized) return undefined
  return PROVIDER_PRESETS.find(
    (p) => p.baseUrl && p.baseUrl.replace(/\/+$/, '').toLowerCase() === normalized,
  )
}

/** Человекочитаемое имя подключения: «OpenAI», «RuAPI», иначе сам адрес. */
export function providerLabel(providerId: string, baseUrl: string): string {
  return presetById(providerId)?.label ?? presetByBaseUrl(baseUrl)?.label ?? baseUrl.trim()
}
