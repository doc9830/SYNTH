/**
 * Проверка реестра функций: целостность, чтение флагов, зависимости и переключение.
 * Запуск: npm run checks
 */
import {
  FEATURES,
  PRIMARY_FEATURES,
  featureById,
  isFeatureAvailable,
  isFeatureOn,
  setFeature,
} from '@/lib/features'
import { DEFAULT_SETTINGS, useSettings, type Settings } from '@/lib/settings'
import { check, finish } from './harness'

const base: Settings = structuredClone(DEFAULT_SETTINGS)

// 1. реестр целостен
check('в реестре есть функции', FEATURES.length >= 9)
check('id уникальны', new Set(FEATURES.map((f) => f.id)).size === FEATURES.length)
check(
  'requires ссылается на существующую функцию',
  FEATURES.every((f) => !f.requires || FEATURES.some((x) => x.id === f.requires)),
)
check(
  'у каждой функции есть чип, подсказка и иконка',
  FEATURES.every((f) => Boolean(f.chip && f.hint && f.icon)),
)
check('чипы композера определены', PRIMARY_FEATURES.length > 0)
check("featureById('memory').section === 'memory'", featureById('memory').section === 'memory')

// 2. чтение флагов из настроек
const on: Settings = structuredClone(DEFAULT_SETTINGS)
on.search.enabled = true
on.search.readPages = true
on.memory.enabled = true
check('поиск читается включённым', isFeatureOn(on, featureById('search')))
check('чтение ссылок читается включённым', isFeatureOn(on, featureById('readPages')))
check('память читается включённой', isFeatureOn(on, featureById('memory')))
check(
  'autoExtract доступен только с памятью',
  isFeatureAvailable(base, featureById('autoExtract')) === false &&
    isFeatureAvailable(on, featureById('autoExtract')) === true,
)
check('у независимой функции нет требований', isFeatureAvailable(base, featureById('calculator')))

// 3. отсутствие раздела не ломает чтение флага (старые сохранённые настройки)
const broken = structuredClone(DEFAULT_SETTINGS) as unknown as Record<string, unknown>
broken.tools = undefined
check(
  'нет раздела — флаг читается как false',
  isFeatureOn(broken as unknown as Settings, featureById('calculator')) === false,
)

// 4. доступность с учётом зависимостей
const noSearch: Settings = structuredClone(DEFAULT_SETTINGS)
noSearch.search.enabled = false
check('инструменты включены по умолчанию', isFeatureOn(base, featureById('calculator')))
check('с поиском чтение ссылок доступно', isFeatureAvailable(base, featureById('readPages')))
check('без поиска чтение ссылок недоступно', isFeatureAvailable(noSearch, featureById('readPages')) === false)

// 5. переключение пишет флаги в стор, учитывая зависимости
const flags = () => structuredClone(useSettings.getState().settings)

setFeature(featureById('search'), false)
check('выключение поиска гасит чтение ссылок', flags().search.enabled === false && flags().search.readPages === false)

setFeature(featureById('readPages'), true)
check('включение чтения ссылок включает поиск', flags().search.enabled === true && flags().search.readPages === true)

setFeature(featureById('autoExtract'), true)
check('включение авто-фактов включает память', flags().memory.enabled === true && flags().memory.autoExtract === true)

setFeature(featureById('calculator'), false)
check('обычная функция пишется в свой раздел', flags().tools.calculator === false && flags().tools.chatHistory === true)

setFeature(featureById('memory'), false)
check('память выключается без побочных эффектов', flags().memory.enabled === false)

finish()
