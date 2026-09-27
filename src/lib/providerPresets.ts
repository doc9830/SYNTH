/**
 * Пресеты провайдеров: подставляют Base URL, тип подключения и подсказывают,
 * где взять ключ.
 *
 * Приложение — универсальный клиент: работает и с любым OpenAI-совместимым API
 * (/v1/models, /v1/chat/completions), и с Claude Messages API (/v1/messages).
 * Список ниже лишь экономит ввод, пользователь всегда может выбрать
 * «Другой / свой» и указать адрес вручную.
 */

import type { ConnectionProtocol } from './settings'

export interface ProviderPreset {
  id: string
  label: string
  baseUrl: string
  /** Тип подключения (протокол). Не указан → OpenAI-совместимый. */
  protocol?: ConnectionProtocol
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
    id: 'anthropic',
    label: 'Anthropic (Claude)',
    baseUrl: 'https://api.anthropic.com/v1',
    // Claude несовместим с OpenAI-протоколом: у него Messages API,
    // ключ в x-api-key и инструменты через tool_use/tool_result.
    protocol: 'anthropic',
    modelHint: 'claude-sonnet-4-5',
    keyUrl: 'https://console.anthropic.com/settings/keys',
  },
  {
    id: 'google',
    label: 'Google Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    modelHint: 'gemini-2.5-flash',
    keyUrl: 'https://aistudio.google.com/apikey',
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
    id: 'xai',
    label: 'xAI Grok',
    baseUrl: 'https://api.x.ai/v1',
    modelHint: 'grok-4',
    keyUrl: 'https://console.x.ai',
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

/** Протокол пресета: не указан → OpenAI-совместимый. */
export function presetProtocol(preset?: ProviderPreset): ConnectionProtocol {
  return preset?.protocol ?? 'openai'
}

/**
 * Адрес похож на Anthropic (api.anthropic.com или шлюз на их домене)?
 * Нужен интерфейсу: при вставке такого адреса тип подключения
 * переключается на Claude автоматически.
 */
export function looksLikeAnthropic(baseUrl: string): boolean {
  return /(^|\.)anthropic\.com/i.test(baseUrl.trim())
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
