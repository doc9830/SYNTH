import type { ComponentType, SVGProps } from 'react'
import {
  IconBrain,
  IconCalculator,
  IconClock,
  IconGlobe,
  IconHistory,
  IconImage,
  IconLink,
  IconSliders,
  IconSparkles,
} from '@/ui/icons'
import { useSettings, type Settings } from './settings'

/**
 * Реестр «функций» — переключателей, которые чаще всего нужны прямо в чате:
 * поиск, картинки, инструменты, память, вид ленты.
 *
 * Зачем отдельный модуль: раньше подсказки о включённых функциях и настройки
 * жили в разных местах (шапка показывала иконки, композер — список строк,
 * выключить флаг можно было только из большого диалога настроек). Теперь
 * описание функции одно: где лежит флаг, как выглядит чип, что в подсказке.
 */

export type FeatureId =
  | 'search'
  | 'readPages'
  | 'image'
  | 'calculator'
  | 'currentTime'
  | 'chatHistory'
  | 'memory'
  | 'autoExtract'
  | 'reasoning'
  | 'toolActivity'

export type FeatureGroup = 'web' | 'image' | 'tools' | 'memory' | 'view'
export type FeatureSection = 'search' | 'image' | 'tools' | 'memory' | 'ui'

type IconComponent = ComponentType<SVGProps<SVGSVGElement> & { size?: number }>

export interface Feature {
  id: FeatureId
  /** Полное название для шторки */
  label: string
  /** Короткая подпись чипа в композере */
  chip: string
  hint: string
  group: FeatureGroup
  icon: IconComponent
  /** Раздел настроек, где лежит флаг */
  section: FeatureSection
  /** Имя булева поля в разделе */
  key: string
  /** Без этой функции текущая не имеет смысла (read_url без поиска) */
  requires?: FeatureId
  /** Показывать чип прямо в композере (быстрый переключатель) */
  primary?: boolean
}
export const FEATURES: Feature[] = [
  {
    id: 'search',
    label: 'Веб-поиск',
    chip: 'Поиск',
    hint: 'Модель получает инструмент web_search и сама решает, когда искать в интернете.',
    group: 'web',
    icon: IconGlobe,
    section: 'search',
    key: 'enabled',
    primary: true,
  },
  {
    id: 'readPages',
    label: 'Чтение ссылок',
    chip: 'Ссылки',
    hint: 'Инструмент read_url: открывает присланную ссылку, забирает текст и скриншот (нужен backend).',
    group: 'web',
    icon: IconLink,
    section: 'search',
    key: 'readPages',
    requires: 'search',
  },
  {
    id: 'image',
    label: 'Генерация изображений',
    chip: 'Картинки',
    hint: 'Модель может рисовать: появляется инструмент generate_image, настройки — в разделе «Подключение».',
    group: 'image',
    icon: IconImage,
    section: 'image',
    key: 'enabled',
    primary: true,
  },
  {
    id: 'calculator',
    label: 'Калькулятор',
    chip: 'Счёт',
    hint: 'Точная арифметика вместо устного счёта модели: проценты, степени, скобки, функции.',
    group: 'tools',
    icon: IconCalculator,
    section: 'tools',
    key: 'calculator',
  },
  {
    id: 'currentTime',
    label: 'Текущее время',
    chip: 'Время',
    hint: 'Модель запрашивает настоящие дату и время — иначе она ошибается в «сегодня» и днях недели.',
    group: 'tools',
    icon: IconClock,
    section: 'tools',
    key: 'currentTime',
  },
  {
    id: 'chatHistory',
    label: 'Поиск по чатам',
    chip: 'История',
    hint: 'Инструмент search_chats: модель ищет по прошлым чатам приложения («мы обсуждали…»). Локально.',
    group: 'tools',
    icon: IconHistory,
    section: 'tools',
    key: 'chatHistory',
  },
  {
    id: 'memory',
    label: 'Долговременная память',
    chip: 'Память',
    hint: 'Факты о вас хранятся только на устройстве и подмешиваются в новые чаты. Секреты не сохраняются.',
    group: 'memory',
    icon: IconBrain,
    section: 'memory',
    key: 'enabled',
    primary: true,
  },
  {
    id: 'autoExtract',
    label: 'Извлекать факты после ответа',
    chip: 'Авто-факты',
    hint: 'После ответа отдельный короткий запрос просит модель вытащить устойчивые факты из диалога.',
    group: 'memory',
    icon: IconSparkles,
    section: 'memory',
    key: 'autoExtract',
    requires: 'memory',
  },
  {
    id: 'reasoning',
    label: 'Показывать размышления',
    chip: 'Мысли',
    hint: 'Свёрнутый блок с рассуждениями модели (если провайдер их отдаёт).',
    group: 'view',
    icon: IconSliders,
    section: 'ui',
    key: 'showReasoning',
  },
  {
    id: 'toolActivity',
    label: 'Показывать вызовы инструментов',
    chip: 'Инструменты',
    hint: 'Строки «ищу в интернете», «читаю страницу», «запоминаю» внутри ответа.',
    group: 'view',
    icon: IconSliders,
    section: 'ui',
    key: 'showToolActivity',
  },
]

export const FEATURE_GROUP_LABELS: Record<FeatureGroup, string> = {
  web: 'Интернет',
  image: 'Изображения',
  tools: 'Инструменты',
  memory: 'Память',
  view: 'Вид ленты',
}

export const FEATURE_GROUPS: FeatureGroup[] = ['web', 'image', 'tools', 'memory', 'view']

export function featureById(id: FeatureId): Feature {
  const found = FEATURES.find((f) => f.id === id)
  if (!found) throw new Error(`Неизвестная функция: ${id}`)
  return found
}

/** Включена ли функция в текущих настройках. */
export function isFeatureOn(settings: Settings, feature: Feature): boolean {
  // Раздела может не быть в старых сохранениях — читаем безопасно.
  const section = settings[feature.section] as unknown as Record<string, unknown> | undefined
  return Boolean(section?.[feature.key])
}

/** Доступна ли функция: у включённого read_url должен быть включён поиск. */
export function isFeatureAvailable(settings: Settings, feature: Feature): boolean {
  if (!feature.requires) return true
  return isFeatureOn(settings, featureById(feature.requires))
}

/**
 * Переключение функции с учётом зависимостей:
 * · включая read_url/авторазбор, включаем и родителя;
 * · выключая поиск, гасим чтение ссылок (иначе флаг остаётся «висящим»).
 */
export function setFeature(feature: Feature, value: boolean): void {
  const store = useSettings.getState()

  if (feature.id === 'readPages' && value) {
    store.updateSection('search', { enabled: true, readPages: true })
    return
  }
  if (feature.id === 'search' && !value) {
    store.updateSection('search', { enabled: false, readPages: false })
    return
  }
  if (feature.id === 'autoExtract' && value) {
    store.updateSection('memory', { enabled: true, autoExtract: true })
    return
  }

  store.updateSection(feature.section, { [feature.key]: value } as never)
}

/** Главные функции — их чипы всегда видны под полем ввода. */
export const PRIMARY_FEATURES = FEATURES.filter((f) => f.primary)

