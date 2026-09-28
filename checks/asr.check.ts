/**
 * Проверка голосового ввода системным распознаванием речи (задача 07).
 *
 * Запуск: npm run checks
 *
 * Системного `SpeechRecognizer` в Node нет, поэтому проверяем то, что от него не
 * зависит: события плагина и тексты (`src/lib/asr.ts`), чистое состояние сессии
 * (`src/lib/useDictation.ts`) и — по исходникам — обвязку Android и интерфейс.
 * Главное, что здесь держится: без плагина, сервиса распознавания или разрешения
 * приложение остаётся с текстовым вводом и говорит об этом словами.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  ASR_LANGUAGE,
  ASR_SILENCE_MS,
  DICTATION_TAP_HINT,
  asrErrorMessage,
  asrEventFromNative,
  asrFailureCode,
  asrSupported,
  cancelDictation,
  describeAsrUnavailable,
  describeDictationButton,
  describeDictationNetwork,
  describeDictationSource,
  describeMicDenied,
  describeStartFailure,
  probeAsr,
  requestMicAccess,
  stopDictation,
  type AsrUnavailableReason,
} from '@/lib/asr'
import { nativeAsrAvailable, nativeAsrInfo } from '@/lib/nativeAsr'
import {
  canDictate,
  composeDictation,
  dictationValue,
  reduceDictation,
  useDictation,
  type DictationDraft,
} from '@/lib/useDictation'
import { useToasts } from '@/lib/toast'
import { check, finish } from './harness'

const source = (relative: string) =>
  readFileSync(fileURLToPath(new URL(`../src/${relative}`, import.meta.url)), 'utf8')
const androidSource = (relative: string) =>
  readFileSync(fileURLToPath(new URL(`../android/${relative}`, import.meta.url)), 'utf8')

// ── События нативного распознавания ────────────────────────────────────

check('готовность сервиса доходит до слоя платформы', asrEventFromNative({ state: 'ready' })?.kind === 'ready')
check(
  'начало речи и тишина — отдельные состояния',
  asrEventFromNative({ state: 'speech' })?.kind === 'speech' &&
    asrEventFromNative({ state: 'silence' })?.kind === 'silence',
)

const partial = asrEventFromNative({ state: 'partial', text: 'погода на' })
check('частичный текст виден по мере речи', partial?.kind === 'partial' && partial.text === 'погода на')
check('пустой частичный текст отбрасывается', asrEventFromNative({ state: 'partial', text: '' }) === null)

const final = asrEventFromNative({ state: 'final', text: 'погода на завтра', onDevice: true })
check(
  'итог приходит с текстом и источником распознавания',
  final?.kind === 'final' && final.text === 'погода на завтра' && final.onDevice === true,
)
const finalEmpty = asrEventFromNative({ state: 'final' })
check(
  'пустой итог не выдумывает текст',
  finalEmpty?.kind === 'final' && finalEmpty.text === null && finalEmpty.onDevice === false,
)
const finalSystem = asrEventFromNative({ state: 'final', text: 'да' })
check(
  'без флага офлайна итог считается системным',
  finalSystem?.kind === 'final' && finalSystem.onDevice === false,
)
check(
  'незнакомые состояния не доходят до интерфейса',
  asrEventFromNative({ state: 'audio-level' }) === null && asrEventFromNative({}) === null,
)

const failed = asrEventFromNative({ state: 'error', code: 'NO_MATCH' })
check(
  'ошибка приходит понятной фразой, а не кодом',
  failed?.kind === 'error' && failed.message === asrErrorMessage('NO_MATCH'),
)
const noPack = asrEventFromNative({ state: 'error', code: 'NO_PACK' })
check(
  'код ошибки сервиса доходит до диагностики',
  noPack?.kind === 'error' && noPack.code === 'NO_PACK' && noPack.message === asrErrorMessage('NO_PACK'),
)
const cancelUser = asrEventFromNative({ state: 'cancelled' })
const cancelLifecycle = asrEventFromNative({ state: 'cancelled', reason: 'lifecycle' })
check(
  'отмена пользователем отличается от ухода в фон',
  cancelUser?.kind === 'cancelled' &&
    cancelUser.reason === 'user' &&
    cancelLifecycle?.kind === 'cancelled' &&
    cancelLifecycle.reason === 'lifecycle',
)

// ── Тексты: что видит пользователь ─────────────────────────────────────

const codes = [
  'NO_MATCH',
  'SILENCE',
  'NETWORK',
  'PERMISSION_DENIED',
  'CLIENT',
  'BUSY',
  'AUDIO',
  'SERVER',
  'NO_START',
  'NO_RESULT',
  'TOO_MANY',
  'NO_LANGUAGE',
  'NO_PACK',
]
check(
  'каждый код ошибки сервиса объяснён словами',
  codes.every((code) => asrErrorMessage(code).length > 15 && asrErrorMessage(code) !== asrErrorMessage('НЕИЗВЕСТНО')),
)
check(
  'неизвестный код даёт общую фразу',
  asrErrorMessage() === 'Не удалось распознать речь.' && asrErrorMessage('ЧТО-ТО') === asrErrorMessage(),
)
check('сетевая ошибка напоминает про офлайн-пакет', /офлайн-пакет/.test(asrErrorMessage('NETWORK')))
check('отказ в микрофоне отправляет в настройки Android', /настройках Android/i.test(asrErrorMessage('PERMISSION_DENIED')))
check(
  'нет русского языка — сказано, где его включить',
  /русск/i.test(asrErrorMessage('NO_LANGUAGE')) && /Android/.test(asrErrorMessage('NO_LANGUAGE')),
)
check('нет офлайн-пакета — сказано, где его скачать', /офлайн-пакет/.test(asrErrorMessage('NO_PACK')))
check('перегруженный сервис просит подождать', /попробуйте/i.test(asrErrorMessage('TOO_MANY')))
// ERROR_CLIENT приходит, когда система не подключила распознаватель: обычно в
// настройках Android не выбран сервис распознавания речи. Раньше этот код
// попадал в общую фразу «не удалось распознать речь» и ни о чём не говорил.
check(
  'неподключённый системный распознаватель объясняется отдельно',
  /не подключился/i.test(asrErrorMessage('CLIENT')) && /настройках Android/i.test(asrErrorMessage('CLIENT')),
)
check('код CLIENT не выдаётся за неудачное распознавание', asrErrorMessage('CLIENT') !== asrErrorMessage())

// ── Отказ старта: причина не подменяется общей фразой ──────────────────

check(
  'отказ плагина читается по error.code',
  asrFailureCode({ code: 'NO_SERVICE', message: 'что-то' }) === 'NO_SERVICE' &&
    asrFailureCode(new Error('плагин не ответил')) === 'плагин не ответил' &&
    asrFailureCode('NO_START') === 'NO_START' &&
    asrFailureCode(null) === null &&
    asrFailureCode('') === null,
)
const startFailures = [
  { code: 'PERMISSION_DENIED' },
  { code: 'NO_SERVICE' },
  { code: 'CREATE_FAILED' },
  { code: 'CLIENT' },
  { code: 'NO_START' },
  {},
  undefined,
]
check(
  'любой отказ старта объяснён по-русски',
  startFailures.every((error) => /[а-яА-Я]/.test(describeStartFailure(error))),
)
check(
  'отказ в микрофоне не выдаётся за «сервис не ответил»',
  describeStartFailure({ code: 'PERMISSION_DENIED' }) === describeMicDenied(),
)
check(
  'отсутствие сервиса объясняется отдельно',
  describeStartFailure({ code: 'NO_SERVICE' }).includes('текстом'),
)
check(
  'неизвестный отказ зовёт попробовать снова',
  describeStartFailure({ code: 'ЧТО-ТО' }) === asrErrorMessage('NO_START') &&
    /попробуйте ещё раз/i.test(describeStartFailure(undefined)),
)
check(
  'отказ создания распознавателя не выдаётся за отсутствие сервиса',
  /создать распознаватель/.test(describeStartFailure({ code: 'CREATE_FAILED' })) &&
    describeStartFailure({ code: 'CREATE_FAILED' }) !== describeStartFailure({ code: 'NO_SERVICE' }),
)
check('подпись кнопки в покое объясняет тапы', describeDictationButton(false).includes(DICTATION_TAP_HINT))
check('во время записи кнопка говорит «закончить»', describeDictationButton(true) === 'Закончить запись')
check(
  'источник распознавания называется словами',
  describeDictationSource(true).includes('офлайн') && describeDictationSource(false).includes('системный'),
)
check(
  'нет сервиса распознавания — понятное сообщение, не тишина',
  describeAsrUnavailable({ available: false, reason: 'NO_SERVICE' })?.includes('недоступно') === true &&
    describeAsrUnavailable(null)?.includes('недоступно') === true,
)
check(
  'в браузере сказано, что голосовой ввод живёт в приложении',
  describeAsrUnavailable({ available: false, reason: 'unsupported' })?.includes('Android') === true,
)
// 1.7.3: причина недоступности была одной фразой «распознавание недоступно» —
// «сервиса нет» и «офлайн-движок молчит» выглядели одинаково, хотя делать нужно
// разное. Именно на это жаловались: сообщение приходило при живом Gboard.
const unavailableReasons: AsrUnavailableReason[] = ['NO_SERVICE', 'ONDEVICE_SILENT', 'PLUGIN_ERROR']
const unavailableTexts = unavailableReasons.map(
  (reason) => describeAsrUnavailable({ available: false, reason }) ?? '',
)
check(
  'каждая причина недоступности объяснена словами',
  unavailableTexts.every((text) => text.length > 20 && /[а-яА-Я]/.test(text)),
)
check(
  'причины недоступности не подменяются друг другом',
  new Set(unavailableTexts).size === unavailableTexts.length,
)
check('молчащий офлайн-движок назван офлайн-движком', /офлайн/.test(unavailableTexts[1] as string))
check('неответивший плагин назван плагином', /плагин/.test(unavailableTexts[2] as string))
check(
  'отказ в микрофоне не выглядит как отсутствие сервиса',
  describeAsrUnavailable({ available: false, reason: 'NO_SERVICE', permission: 'denied' }) ===
    describeMicDenied(),
)
check('сервис есть — сообщений нет', describeAsrUnavailable({ available: true }) === null)
check(
  'отказ в доступе объясняет, что включить',
  /микрофон/.test(describeMicDenied()) && /Разрешения/.test(describeMicDenied()),
)
check('сетевой сервис предупреждает о сети', /сеть/.test(describeDictationNetwork()))
check('язык распознавания — русский', ASR_LANGUAGE === 'ru-RU')
check('автостоп по тишине настроен', ASR_SILENCE_MS > 0 && ASR_SILENCE_MS <= 3000)

// ── Платформа: без плагина всё остаётся живым ──────────────────────────

check('в Node системного распознавания нет', !asrSupported() && !nativeAsrAvailable())
const nativeInfo = await nativeAsrInfo()
check(
  'проверка без плагина не бросает: сервиса нет',
  nativeInfo.available === false && nativeInfo.reason === 'NO_SERVICE',
)
const probed = await probeAsr()
check('в веб-сборке распознавание считается недоступным', probed.available === false && probed.reason === 'unsupported')
check('разрешение в веб-сборке не выдаётся', (await requestMicAccess()) === 'denied')

let quiet = true
try {
  await stopDictation()
  await cancelDictation()
} catch {
  quiet = false
}
check('«закончить» и «отменить» без записи ничего не ломают', quiet)

// ── Состояние сессии: чистое применение событий ────────────────────────

const emptySession: DictationDraft = { base: 'уже было', partial: '', result: null, onDevice: false }
const said = reduceDictation(emptySession, { kind: 'partial', text: 'погода' })
check('частичный текст сразу виден в поле', said.partial === 'погода')
check(
  'во время речи поле показывает текст вместе с распознанным',
  dictationValue({ ...said, status: 'listening' }) === 'уже было погода',
)

const done = reduceDictation(said, { kind: 'final', text: 'погода на завтра', onDevice: true })
check('итог сервиса замещает частичный текст', done.result?.text === 'погода на завтра' && done.partial === '')
check('источник распознавания запоминается', done.onDevice === true)
check(
  'итог приклеивается к тому, что было в поле',
  dictationValue({ ...done, status: 'idle' }) === 'уже было погода на завтра',
)

const emptyFinal = reduceDictation(said, { kind: 'final', text: null, onDevice: false })
check('пустой итог не теряет уже распознанное', emptyFinal.result?.text === 'погода')
check(
  'совсем без текста итога нет',
  reduceDictation(emptySession, { kind: 'final', text: '   ', onDevice: false }).result === null,
)
check(
  'ошибка сервиса не оставляет текста в поле',
  reduceDictation(said, { kind: 'error', message: 'нет сети' }).result === null &&
    reduceDictation(said, { kind: 'error', message: 'нет сети' }).partial === '',
)
check(
  'отмена выбрасывает распознанное',
  reduceDictation(said, { kind: 'cancelled', reason: 'user' }).result === null &&
    reduceDictation(said, { kind: 'cancelled', reason: 'user' }).partial === '',
)
check(
  'уход в фон не теряет уже распознанное',
  reduceDictation(said, { kind: 'cancelled', reason: 'lifecycle' }).result?.text === 'погода',
)
check(
  'готовность, речь и тишина текст не меняют',
  reduceDictation(said, { kind: 'ready' }) === said &&
    reduceDictation(said, { kind: 'speech' }) === said &&
    reduceDictation(said, { kind: 'silence' }) === said,
)

// ── Склейка с тем, что уже напечатано ─────────────────────────────────

check('пустое поле — только речь', composeDictation('', 'привет') === 'привет')
check('к тексту без пробела добавляется пробел', composeDictation('как дела', 'хорошо') === 'как дела хорошо')
check(
  'после пробела или переноса пробел не удваивается',
  composeDictation('конец ', 'дальше') === 'конец дальше' &&
    composeDictation('строка\n', 'дальше') === 'строка\nдальше',
)
check('без распознанного текста поле не меняется', composeDictation('текст', '   ') === 'текст')
check(
  'в покое без результата поле живёт своей жизнью',
  dictationValue({ status: 'idle', base: 'a', partial: 'b', result: null }) === null,
)
check(
  'в покое с результатом поле обновляется',
  dictationValue({ status: 'idle', base: 'a', partial: '', result: { base: 'a', text: 'b' } }) === 'a b',
)
check(
  'во время записи поле обновляется по частичным результатам',
  dictationValue({ status: 'listening', base: 'a', partial: 'b', result: null }) === 'a b',
)

// ── Стор диктовки ──────────────────────────────────────────────────────

// `notify` планирует скрытие подсказки через `window.setTimeout`, а в Node окна
// нет: подставляем минимальную заглушку (так же, как в checks/tts.check.ts).
const fakeGlobal = globalThis as Record<string, unknown>
fakeGlobal.window ??= globalThis

check('в браузере кнопка микрофона не положена', !canDictate(useDictation.getState().info))
await useDictation.getState().ensureProbe()
const unsupported = useDictation.getState().info
check(
  'проверка записала в стор: распознавания нет',
  unsupported?.available === false && unsupported?.reason === 'unsupported',
)
check('при недоступности запись не начинается', canDictate(unsupported) === false)

const toastsBefore = useToasts.getState().items.length
await useDictation.getState().start('черновик')
check(
  'тап по микрофону без сервиса не оставляет «запись идёт»',
  useDictation.getState().status === 'idle' && useDictation.getState().partial === '',
)
check(
  'и объясняет, что печатать текстом (а не молчит)',
  useToasts
    .getState()
    .items.slice(toastsBefore)
    .some((toast) => /Android/.test(toast.message)),
)

await useDictation.getState().stop()
check('«закончить» без записи ничего не меняет', useDictation.getState().status === 'idle')
await useDictation.getState().cancel()
check('«отменить» без записи ничего не ломает', useDictation.getState().status === 'idle')
await useDictation.getState().release()
check('уход в фон без записи тоже безопасен', useDictation.getState().status === 'idle')

useDictation.setState({ base: 'уже было', result: { base: 'уже было', text: 'привет' } })
useDictation.getState().acknowledge()
check(
  'поле забрало распознанное — сессия закрыта',
  useDictation.getState().result === null && useDictation.getState().base === '',
)

// ── Android: системное распознавание, офлайн и разрешение ──────────────

const manifest = androidSource('app/src/main/AndroidManifest.xml')
check(
  'в манифесте запрошен доступ к микрофону',
  /<uses-permission[^>]*android\.permission\.RECORD_AUDIO/.test(manifest),
)

const plugin = androidSource('app/src/main/java/app/synth/hub/SpeechPlugin.java')
check('распознавание идёт через системный SpeechRecognizer', plugin.includes('SpeechRecognizer'))
check('на API 31+ берётся офлайн-сервис устройства', plugin.includes('createOnDeviceSpeechRecognizer'))
check('перед этим проверяется наличие офлайн-пакета', plugin.includes('isOnDeviceRecognitionAvailable'))
check('на старых версиях просим офлайн: EXTRA_PREFER_OFFLINE', plugin.includes('EXTRA_PREFER_OFFLINE'))
check('частичные результаты запрошены у сервиса', plugin.includes('EXTRA_PARTIAL_RESULTS'))
check('автостоп по тишине передан сервису', plugin.includes('EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS'))
check('микрофон освобождается (destroy) после сессии', /\.destroy\(\)/.test(plugin))
check(
  'разрешение микрофона запрашивается при первом использовании',
  plugin.includes('requestMic') && plugin.includes('RECORD_AUDIO'),
)
check(
  'отмена из-за ухода в фон отличается от отмены пользователем',
  /emitRecognition\("cancelled"[^;]*"lifecycle"\)/.test(plugin) && /"cancelled"[^;]*"user"/.test(plugin),
)
check('аудио не пишется на диск и не отправляется из плагина', !/OutputStream|MediaRecorder/.test(plugin))

// 1.7.1: «Озвучить» пропала из-за расхождения имён плагина, 1.7.2: голосовой
// ввод отвечал «сервис распознавания не ответил» — потому что старт уходил в
// свежий распознаватель до того, как сервис успевал подключиться. Эти проверки
// держат путь старта: пауза на подключение, повтор другим распознавателем,
// отличие молчания от работающего сервиса.

check(
  'старт отдаётся сервису после паузы на подключение',
  plugin.includes('ASR_BIND_DELAY_MS') && /postDelayed\(asrStart, ASR_BIND_DELAY_MS\)/.test(plugin),
)
check(
  'молчащий сервис — не конец: старт повторяют другим распознавателем',
  /asrAttempts < ASR_MAX_ATTEMPTS/.test(plugin) && /retryWithOtherRecognizer\(\)/.test(plugin),
)
check(
  'молчащий офлайн-сервис запоминается, чтобы не ждать его каждый раз',
  /onDeviceSilent = true/.test(plugin) && /!onDeviceSilent/.test(plugin),
)
check(
  'любой отклик сервиса снимает страховку старта',
  /markAlive\(\)/.test(plugin) &&
    /onRmsChanged[\s\S]{0,200}markAlive\(\)/.test(plugin) &&
    /onPartialResults[\s\S]{0,200}markAlive\(\)/.test(plugin),
)
check(
  'коды API 31+ (язык, офлайн-пакет, загруженность) переведены в причины',
  /ERROR_CODE_LANGUAGE_UNAVAILABLE/.test(plugin) &&
    plugin.includes('return "NO_PACK"') &&
    plugin.includes('return "NO_LANGUAGE"') &&
    plugin.includes('return "TOO_MANY"'),
)
check(
  'повтор идёт только к другому распознавателю — молчащий дважды не ждут',
  /boolean alternate = wasOnDevice/.test(plugin) && /alternate && asrAttempts < ASR_MAX_ATTEMPTS/.test(plugin),
)
check(
  '«закончить» отменяет отложенный старт: после стопа запись не начинается',
  /else if \(active\) \{[\s\S]{0,300}removeCallbacks\(asrStartTimeout\)[\s\S]{0,200}stopListening\(\)/.test(plugin),
)
check('«закончить» до старта не выдаёт ошибку сервиса', /active && !asrListening/.test(plugin))

// 1.7.3: «распознавание речи недоступно» приходило на устройстве, где системное
// распознавание работает (в Gboard диктовка живая). Причина — приговор по
// SpeechRecognizer.isRecognitionAvailable(): на Android 11+ это запрос к
// PackageManager, и видимость пакетов может скрыть установленный распознаватель.
// Сама платформа берёт сервис из Settings.Secure.VOICE_RECOGNITION_SERVICE и
// подключает его в системном процессе, а если сервиса нет — отвечает
// onError(ERROR_CLIENT). Поэтому теперь: не отказываем по запросу, пробуем
// создать распознаватель и называем причину конкретно.

check(
  'наличие сервиса проверяется не только запросом к PackageManager',
  plugin.includes('SETTING_VOICE_RECOGNITION_SERVICE') &&
    plugin.includes('"voice_recognition_service"') &&
    /systemRecognizerPossible\(context\)/.test(plugin) &&
    /systemRecognizerPossible\(Context context\)[\s\S]{0,220}isRecognitionAvailable\(context\)[\s\S]{0,120}selectedRecognizer\(context\)/.test(
      plugin,
    ),
)
check(
  'запрос к пакетам больше не приговор: распознаватель пробуют создать всё равно',
  !/if \(!SpeechRecognizer\.isRecognitionAvailable\(context\)\) \{[\s\S]{0,200}return false;/.test(plugin) &&
    /системного распознавателя не видно ни в пакетах, ни в настройках[\s\S]{0,400}createSpeechRecognizer\(context\)/.test(
      plugin,
    ),
)
check(
  'повтор после молчания офлайн-движка тоже не зависит от запроса к пакетам',
  /\? systemRecognizerPossible\(context\)/.test(plugin),
)
check(
  'причина недоступности названа конкретно: движка нет / офлайн-движок молчит',
  /ret\.put\("reason", deviceModel \? "ONDEVICE_SILENT" : "NO_SERVICE"\)/.test(plugin) &&
    plugin.includes('ret.put("deviceModel", deviceModel)') &&
    plugin.includes('ret.put("systemService", service)'),
)
check(
  'отказ создания распознавателя отличается от отсутствия сервиса',
  plugin.includes('ASR_CREATE_FAILED') &&
    /asrCreateError = ASR_CREATE_FAILED/.test(plugin) &&
    /created \? ASR_CREATE_FAILED : "NO_SERVICE"/.test(plugin),
)
check(
  'доступность и причина уходят в журнал устройства',
  /Logger\.info\(TAG_ASR, "asrAvailable: available="/.test(plugin) &&
    /Logger\.warn\(TAG_ASR, "распознаватель не подключился/.test(plugin),
)

// ── Интерфейс: кнопка, отмена, уход в фон ──────────────────────────────

const composer = source('ui/Composer.tsx')
check(
  'кнопка микрофона есть только там, где есть распознавание',
  composer.includes('{dictationSupported && !listening && ('),
)
check('второй тап заканчивает запись (тап-старт вместо удержания)', composer.includes('if (listening) void stopVoice()'))
check('во время записи есть кнопка отмены', composer.includes('title="Отменить запись и выбросить текст"'))
check('распознанный текст виден в поле по мере речи', composer.includes('const value = dictationText ?? text'))
check(
  'распознанное только вставляется в поле — автоотправки нет',
  /if \(!dictationResult\) return\s*\n\s*setText\(composeDictation\(dictationResult\.base, dictationResult\.text\)\)\s*\n\s*acknowledgeVoice\(\)/.test(
    composer,
  ),
)
check('при смене чата запись обрывается', composer.includes('void cancelVoice()'))
check(
  'кнопка не исчезает, а приглушается, если сервиса нет',
  composer.includes("asrInfo && !asrReady && 'opacity-50'") &&
    composer.includes('title={describeDictationButton(false)}'),
)

const app = source('App.tsx')
check('уход приложения в фон обрывает запись', app.includes('onAppPause(() => void releaseDictation())'))

const nativeAsr = source('lib/nativeAsr.ts')
check('отмена отпускает микрофон плагина', /cancelRecognize/.test(nativeAsr))
check('после сессии слушатель событий снимается', /await detachListener\(\)/.test(nativeAsr))

// Имя плагина в мосте — то же, что в @CapacitorPlugin(name = "SynthSpeech"):
// при расхождении Capacitor отвечает «plugin is not implemented on android»,
// и приложение считает, что сервиса распознавания нет (в 1.7.0 так потерялась
// озвучка — там мост TTS звал старое имя SynthTts).

const javaSpeechPlugin = androidSource('app/src/main/java/app/synth/hub/SpeechPlugin.java')
const javaPluginName = /@CapacitorPlugin\(\s*name\s*=\s*"([^"]+)"/.exec(javaSpeechPlugin)?.[1]
const asrPluginName = /registerPlugin<[^>]+>\('([^']+)'\)/.exec(nativeAsr)?.[1]
check(
  'мост распознавания зовёт плагин тем же именем, что и Java',
  javaPluginName === 'SynthSpeech' && asrPluginName === javaPluginName,
)
check(
  'MainActivity регистрирует общий плагин речи',
  androidSource('app/src/main/java/app/synth/hub/MainActivity.java').includes(
    'registerPlugin(SpeechPlugin.class)',
  ),
)

const asrLayer = source('lib/asr.ts')
check('события прошлых сессий игнорируются', /const alive = \(\) => session === mySession/.test(asrLayer))
check('вне Android распознавание не стартует', /if \(!asrSupported\(\)\) return/.test(asrLayer))
// 1.7.3: `probeAsr()` терял причину плагина — любая осечка проверки выглядела
// как 'no-service', и в интерфейсе все они были одной серой фразой. Теперь
// причина доходит как есть, а «плагин не ответил» отличается от «сервиса нет».
check(
  'причина недоступности берётся у плагина, а не подменяется',
  /reason: info\.available \? undefined : \(\(info\.reason as AsrUnavailableReason\) \?\? 'NO_SERVICE'\)/.test(
    asrLayer,
  ) && !/'no-service'/.test(asrLayer),
)
check(
  '«плагин не ответил» отличается от «сервиса нет»',
  /catch \{[\s\S]{0,160}reason: 'PLUGIN_ERROR'/.test(asrLayer) &&
    /catch \{[\s\S]{0,160}reason: 'PLUGIN_ERROR'/.test(nativeAsr),
)
check(
  'диагностика плагина (офлайн-движок, видимость сервиса) доходит до интерфейса',
  /deviceModel: info\.deviceModel/.test(asrLayer) && /systemService: info\.systemService/.test(asrLayer),
)

// Причина отказа старта должна доходить до человека и до Debug Console: раньше
// `catch {}` в `useDictation.ts` превращал любой отказ в одну фразу «сервис
// распознавания не ответил», и по ней нельзя было понять, что случилось.

const dictationStore = source('lib/useDictation.ts')
check(
  'причина отказа старта не прячется за общей фразой',
  /catch \(error\)[\s\S]{0,400}describeStartFailure\(error\)/.test(dictationStore) &&
    !/catch \{\s*\n\s*set\(IDLE\)/.test(dictationStore),
)
check(
  'отказ старта и код ошибки сервиса уходят в Debug Console',
  /debugLog\('error', 'Голосовой ввод: запись не началась'/.test(dictationStore) &&
    /debugLog\('error', 'Голосовой ввод: сервис распознавания вернул ошибку'/.test(dictationStore) &&
    /event\.code/.test(dictationStore),
)

const dictationSources = [asrLayer, nativeAsr, source('lib/useDictation.ts')].join('\n')
check(
  'аудио не пишется на диск и не хранится в браузере',
  !/MediaRecorder|localStorage|sessionStorage|Filesystem/i.test(dictationSources),
)
check('слой распознавания не отправляет речь на свои серверы', !/fetch\(|XMLHttpRequest|axios/i.test(dictationSources))

finish()
