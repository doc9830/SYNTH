# SYNTH для Android

Как из веб-сборки получается нативный APK и как выпускать обновления.

- `applicationId` / `namespace`: **`app.synth.hub`**
- Название: **SYNTH** (`android/app/src/main/res/values/strings.xml`)
- Версия: `versionCode 9`, `versionName "1.5.1"` (`android/app/build.gradle`)
- minSdk 24, target/compile SDK — из `android/variables.gradle`

## Сборка

```bash
npm install
npm run android:apk       # debug   → android/app/build/outputs/apk/debug/app-debug.apk
npm run android:release   # release → android/app/build/outputs/apk/release/app-release.apk
npm run android:install   # собрать и поставить debug APK на подключённый телефон
```

`android:apk` и `android:release` сначала выполняют `npm run build` и `cap sync android`,
поэтому в APK всегда попадает свежий веб-бандл (`android/app/src/main/assets/public`, в `.gitignore`).

Открыть проект в Android Studio: `npm run android:open` (или `npx cap open android`).

## Подпись релиза

1. Ключ уже создан: `android/synth-release.jks` (alias `synth`), пароли — в `android/keystore.properties`.
   Оба файла в `.gitignore` — **сделайте бэкап**: обновления ставятся только поверх сборок,
   подписанных тем же ключом.
2. Создать заново (если потеряли):

```bash
cd android
keytool -genkeypair -v -keystore synth-release.jks -alias synth \
  -keyalg RSA -keysize 4096 -validity 10950 \
  -storepass 'ПАРОЛЬ' -keypass 'ПАРОЛЬ' -dname 'CN=SYNTH, O=SYNTH, C=RU'
```

3. `android/keystore.properties`:

```properties
storeFile=synth-release.jks
storePassword=...
keyAlias=synth
keyPassword=...
```

Если файла нет, `assembleRelease` соберёт неподписанный APK (для debug это не мешает).

Проверить подпись:

```bash
"$ANDROID_HOME/build-tools/$(ls "$ANDROID_HOME/build-tools" | tail -1)/apksigner" \
  verify --print-certs android/app/build/outputs/apk/release/app-release.apk
```

## Иконки и сплэши

Знак SYNTH («нейронный хаб») рисуется программно в `scripts/brand.mjs`, оттуда берут ассеты
и PWA, и Android:

```bash
npm run brand            # = icons + android:assets
npm run icons            # public/favicon.svg, public/icons/*
npm run android:assets   # mipmap-*/ic_launcher*, drawable-*/splash.png
```

- `ic_launcher.png` / `ic_launcher_round.png` — legacy-иконки (density-specific).
- `ic_launcher_foreground.png` + `drawable/ic_launcher_background.xml` — adaptive-иконка (API 26+).
- `drawable-v24/ic_launcher_foreground.xml` — векторная версия того же знака.
- `drawable-port-*/splash.png`, `drawable-land-*/splash.png` — сплэш-экраны (тема `AppTheme.NoActionBarLaunch`).

Палитра: градиент `#7C3AED → #0B0D12`, акцент `#22D3EE`.

## Обновление из приложения (SynthUpdater)

Локальный плагин `android/app/src/main/java/app/synth/hub/UpdaterPlugin.java`
(регистрируется в `MainActivity` через `registerPlugin`) даёт JS-мосту `src/lib/nativeUpdater.ts`:

| Метод | Что делает |
| --- | --- |
| `appInfo()` | `versionName` / `versionCode` установленного пакета |
| `canInstall()` | разрешена ли установка APK из SYNTH (API 26+) |
| `openInstallSettings()` | системный экран «Установка неизвестных приложений» |
| `download({url, fileName})` | качает APK в `getExternalFilesDir(DOWNLOADS)`, шлёт события `progress` |
| `install({path})` | запускает системный установщик через `FileProvider` |

Как это работает вместе:

1. При запуске (через 2 с после загрузки) `src/lib/appUpdate.ts` запрашивает
   `releases/latest` на GitHub — не чаще раза в 6 часов, «пропущенные» версии не предлагаются.
2. `UpdateDialog` показывает описание релиза; «Скачать и установить» качает APK с прогрессом
   и вызывает `install()`.
3. Если Android ещё не разрешил установку из этого источника, плагин отдаёт
   ошибку с кодом `INSTALL_PERMISSION_REQUIRED`, приложение открывает системный экран
   «Установка неизвестных приложений» и **само продолжает установку**, когда вы вернётесь
   (один автоповтор; дальше — кнопка «Установить»). Экран открывается по цепочке
   `ACTION_MANAGE_UNKNOWN_APP_SOURCES(package:)` → без пакета → `ACTION_APPLICATION_DETAILS_SETTINGS`
   → общие настройки, поэтому работает и на прошивках без пакетного экрана.

Важно: код ошибки нельзя искать в тексте сообщения — в тексте «Разрешите установку приложений
из этого источника…» строки `INSTALL_PERMISSION_REQUIRED` нет (это была причина бага 1.1.0).
Проверка — `isInstallPermissionError()` в `src/lib/nativeUpdater.ts`.

Требуемые разрешения и пути:

- `AndroidManifest.xml`: `android.permission.REQUEST_INSTALL_PACKAGES`;
- `res/xml/file_paths.xml`: `external-files-path name="synth_updates" path="Download/"`
  (иначе `FileProvider` не отдаст установщику скачанный файл).

## Файлы из приложения (SynthFiles)

Локальный плагин `android/app/src/main/java/app/synth/hub/FilesPlugin.java` (тоже
регистрируется в `MainActivity`) решает проблему WebView: у него нет DownloadListener,
поэтому `<a download>` в APK не работал — экспорт чата и «Скачать» у картинки ничего не делали.

| Метод | Что делает |
| --- | --- |
| `saveText({fileName, text, mime})` | сохраняет текстовый файл (UTF-8) |
| `saveBase64({fileName, base64, mime})` | сохраняет файл из data URL (картинка) |

Куда попадает файл (ответ `{path, visible}`):

- **Android 10+** — общие папки через `MediaStore`: картинки в `Pictures/SYNTH` (видны в галерее),
  остальное — в `Download/SYNTH`; разрешения не нужны, `visible = true`;
- **Android 9−** — песочница приложения (`getExternalFilesDir(DOWNLOADS)`), путь возвращается в JS.

JS-обёртка — `src/lib/files.ts` (`saveTextFile`, `saveImageFile`): в APK вызывается плагин,
в браузере — обычное скачивание.

## Речь: озвучка и распознавание (SynthSpeech)

Локальный плагин `android/app/src/main/java/app/synth/hub/SpeechPlugin.java` (регистрируется в
`MainActivity`) построен на системных средствах речи Android: `android.speech.tts.TextToSpeech`
для озвучки и `android.speech.SpeechRecognizer` для голосового ввода. Сторонних моделей, облачных
STT и скачиваемых весов нет — движки берутся у системы. До 1.7.0 плагин назывался `SynthTts`
(`TtsPlugin.java`) и умел только озвучку.

Имя в `registerPlugin()` на стороне JS обязано совпадать с `@CapacitorPlugin(name = "SynthSpeech")`:
под этим именем нативный плагин и виден WebView. При расхождении Capacitor ничего внятного не
подсказывает — на каждый вызов приходит «plugin is not implemented on android», и приложение
считает, что движка нет (в 1.7.0 так пропала озвучка: мост TTS звал старое имя `SynthTts`, см.
CHANGELOG 1.7.1). Соответствие держат проверки `checks/tts.check.ts` и `checks/asr.check.ts`.

Озвучка: JS-обёртка — `src/lib/tts.ts`, состояние и очередь — `src/lib/useSpeech.ts`, разбор
markdown на фрагменты — `src/lib/ttsText.ts`.
Голосовой ввод: `src/lib/asr.ts` (платформенный слой и тексты), `src/lib/nativeAsr.ts` (мост),
состояние записи — `src/lib/useDictation.ts`, кнопка — `src/ui/Composer.tsx`.

### Синтез речи (TextToSpeech)

| Метод | Что делает |
| --- | --- |
| `available()` | есть ли движок и русский голос: `{available, reason?, engine?, voice?, language?, needsNetwork}` |
| `speak({chunks, rate, pitch})` | ставит фрагменты в очередь движка, шлёт события `progress` |
| `stop()` | мгновенно обрывает чтение (очищает очередь движка) |
| `shutdown()` | освобождает движок (`TextToSpeech.shutdown()`) |

Коды причин: `ENGINE_UNAVAILABLE` (движка нет), `ENGINE_TIMEOUT` (не ответил за 6 с),
`NO_RU_VOICE` (нет голоса для локали `ru`).

### Распознавание речи (SpeechRecognizer)

| Метод | Что делает |
| --- | --- |
| `asrAvailable()` | есть ли сервис распознавания: `{available, reason?, onDevice?, language?, permission?}` |
| `requestMic()` | запрашивает `RECORD_AUDIO` при первом использовании (системный диалог) |
| `startRecognize({lang, silenceMs})` | начинает сессию записи, шлёт события `recognize` |
| `stopRecognize()` | заканчивает запись: система отдаёт итоговый текст (`final`) |
| `cancelRecognize()` | обрывает запись, результат выбрасывается (`cancelled`) |

События `recognize` (`state`): `ready`, `speech`, `partial` (частичный текст — показывается в поле
ввода сразу), `silence`, `final`, `error` (`NO_MATCH`, `SILENCE`, `NETWORK`, `PERMISSION_DENIED`,
`BUSY`, `AUDIO`, `SERVER`, `NO_START`, `NO_RESULT`), `cancelled` (`reason: user` или `lifecycle`).

Как выбирается движок: на API 31+ — `createOnDeviceSpeechRecognizer()`, если
`isOnDeviceRecognitionAvailable()` подтверждает офлайн-пакет (распознавание офлайн); на более
старых версиях — обычный системный сервис с `EXTRA_PREFER_OFFLINE`, который может уйти в облако
(приложение предупреждает об этом один раз). Язык — `ru-RU`, автостоп по тишине — 1100 мс.

Что важно знать по устройству плагина:

- **Озвучке разрешения не нужны**, аудио никуда не отправляется; микрофон она не использует — его
  берёт только голосовой ввод (разрешение `RECORD_AUDIO`, см. ниже). Голос берётся из
  установленных на устройстве; среди русских предпочитается голос без `isNetworkConnectionRequired()`
  (офлайн). Если русский голос только сетевой — приложение предупреждает об этом один раз и не блокирует.
- **`<queries>` для `android.intent.action.TTS_SERVICE`** в `AndroidManifest.xml` обязателен на
  Android 11+ (API 30): без него `TextToSpeech` не видит установленные движки, и «голос не найден»
  на исправном устройстве. Рядом с уже существующими записями `IMAGE_CAPTURE`/`VIDEO_CAPTURE`.
- **Озвучка идёт по абзацам**, а не сообщением: первый фрагмент — `QUEUE_FLUSH`, остальные —
  `QUEUE_ADD`. Поэтому «Стоп» срабатывает в пределах абзаца, а `progress` приходит на каждый фрагмент.
- **`speak()` умеет ждать инициализации**: после `shutdown()` движок поднимается заново, и вызов
  не падает с ошибкой, а выполняется, как только движок отзовётся (или по таймауту 6 с).
- **Ресурсы освобождаются**: `handleOnPause`/`handleOnStop` глушат чтение, `handleOnDestroy` и
  JS-метод `shutdown()` освобождают движок. Со стороны JS тем же занимается `onAppPause()` из
  `src/lib/nativeShell.ts`: сворачивание приложения глушит озвучку и сбрасывает состояние кнопки.
- **Нет русского голоса — кнопка всё равно на месте**: она приглушена, а по нажатию объясняет причину
  и где поставить голосовые данные (Система → Языки и ввод → Синтез речи). Перед сообщением движок
  переспрашивается (короткое ожидание 400 мс), поэтому если голос поставили только что, чтение начнётся
  с этого же нажатия. Причина каждой проверки пишется в «Консоль отладки» (`debugLog` в
  `src/lib/useSpeech.ts`): `available`, `reason`, `engine`, `voice`, `needsNetwork` — по этой записи
  видно, что именно ответил движок на конкретном телефоне. Озвучка не «сломанная кнопка», но и не
  спрятанная: найти её можно всегда.
- **Голос ищется сначала в списке `getVoices()`** (офлайновый предпочтительнее сетевого), и только
  если русского голоса нет вовсе — `NO_RU_VOICE`. Это важно: на телефонах без скачанных офлайн-данных
  `isLanguageAvailable(ru)` отвечает `LANG_MISSING_DATA`, хотя сетевой русский голос читает нормально.
- **Один локальный плагин на оба движка** (`SynthSpeech`): методы озвучки и распознавания живут в
  одном классе, `MainActivity` регистрирует его один раз. JS-мосты разделены (`nativeTts.ts`,
  `nativeAsr.ts`) — так у каждой задачи свои состояния и своя диагностика.
- **Запись просит разрешение при первом использовании** (`requestMic` → `RECORD_AUDIO`): при отказе
  показывается понятное сообщение со ссылкой на настройки, а текстовый ввод продолжает работать.
  Слушатель событий `recognize` снимается в конце сессии — «висит» он не дольше самой записи.
- **`<queries>` для `android.speech.RecognitionService`** обязателен на Android 11+ (API 30): без
  этой записи `SpeechRecognizer.isRecognitionAvailable()` отвечает false, хотя сервис распознавания
  на устройстве есть, и голосовой ввод молча считался бы недоступным.
- **Распознанный текст только вставляется в поле ввода**: автоотправки нет — сообщение уходит
  отдельным действием пользователя. Частичные результаты (`partial`) показываются сразу, готовый
  текст заменяет их при `final`, а результат отменённой сессии выбрасывается. Записи не пишутся на
  диск и никуда не отправляются: аудио обрабатывает сервис Android, приложение его не хранит.
- **Запись прерывается при уходе в фон** (`onAppPause()` в `src/App.tsx` → `release()` в
  `useDictation.ts`): микрофон не остаётся работать в кармане, а уже распознанный текст остаётся в
  поле ввода. На нативной стороне те же `handleOnPause`/`handleOnStop`/`handleOnDestroy` вызывают
  `destroyRecognizer()` — по документации это единственный корректный способ освободить микрофон.
- **Нет сервиса распознавания — нет и кнопки**: на де-Гугленных прошивках и части китайских ромов
  кнопка микрофона не рисуется вовсе, текстовый ввод работает как раньше. В браузере её тоже нет:
  системного `SpeechRecognizer` там не существует, а `SpeechRecognition` работает через облако —
  облачные STT запрещены ограничениями задачи.
- **Строка кнопок у сообщения на телефоне видна всегда** (`@media (hover: none)` для класса
  `msg-actions` в `index.css`): на тач-экране наведения курсора нет, и «Озвучить»/«Копировать»/
  «Поделиться» иначе остаются невидимыми.
- **В APK service worker не регистрируется** (`src/main.tsx`): ассеты лежат внутри приложения, а
  precache workbox после обновления APK мог отдать из кэша бандл прошлой сборки вместе со старым
  `index.html` — тогда нативный мост Capacitor в страницу не попадал и нативные возможности
  (озвучка, обновления, файлы) молча пропадали. Приложение снимает регистрацию, чистит кэши и один
  раз перезагружается, показывая установленную сборку.
- В браузере (PWA) используется `speechSynthesis` с русским голосом; если его нет — кнопки нет.

## Кнопка «Назад» и камера

- Аппаратная «Назад» обрабатывается стеком `src/lib/backStack.ts`: каждая открытая панель
  (шторка `Sheet`, диалог обновления, меню чата, настройки, консоль отладки, сайдбар)
  кладёт туда обработчик, нажатие достаётся верхнему; если закрывать нечего — `App.minimizeApp()`.
  Так «Назад» не сворачивает приложение поверх открытой шторки.
- `AndroidManifest.xml` содержит `<queries>` для `IMAGE_CAPTURE`/`VIDEO_CAPTURE`:
  без них на Android 11+ `resolveActivity()` в `BridgeWebChromeClient` возвращает `null`,
  и «Прикрепить → Камера» молча открывает файловый менеджер вместо съёмки.
- Вложения определяются по MIME, а при пустом/неизвестном типе (частый случай у Android-провайдеров) —
  по расширению (`imageMimeOf()` в `src/lib/attachments.ts`).

Проверенные настройки, которые менять не нужно: `server.cleartext: true` работает — атрибут
`android:usesCleartextTraffic="true"` приезжает в APK из `android/capacitor-cordova-android-plugins`;
`android:allowMixedContent` и `CapacitorHttp: { enabled: false }` (стриминг SSE идёт через WebView);
`INTERNET`; `FileProvider` с путями `Download/`, `cache-path`, `external-path`.

Важно: обновление устанавливается **поверх** приложения только при совпадении подписи.
Если раньше был установлен debug APK (или APK со старым `applicationId`
`ai.ruapi.deepseekchat`), его нужно удалить и поставить release-сборку SYNTH.

## Полезные детали

- Стриминг SSE идёт через WebView (`fetch`), а не через CapacitorHttp: нативный слой
  буферизует ответ и сломал бы потоковую выдачу (`src/lib/nativeHttp.ts` отправляет
  через нативный мост только не-стриминговые запросы).
- В APK поиск и чтение страниц работают без локального backend: запросы идут через нативный
  сетевой слой, где нет CORS. Скриншоты страниц делает только backend (headless Chrome).
- Отладка WebView: `chrome://inspect` (devtools включены в `capacitor.config.ts`).
- Логи сборки: `cd android && ./gradlew assembleRelease --stacktrace`.
- Частые проблемы:
  - `Failed to parse XML file ... ic_launcher_foreground.xml` — битый ресурс, пересоберите: `npm run android:assets`;
  - `INSTALL_FAILED_UPDATE_INCOMPATIBLE` — подписи APK разные (см. выше про debug/старый appId);
  - пустой экран после установки — проверьте, что `cap sync android` скопировал `dist` в `assets/public`.

## Выпуск новой версии

```bash
# 1. версия веб-бандла (попадает в appInfo → APP_VERSION)
#    package.json → "version": "1.7.1"
# 2. версия пакета
#    android/app/build.gradle → versionCode 13, versionName "1.7.1"
npm run android:release
cp android/app/build/outputs/apk/release/app-release.apk synth-v1.7.1.apk
# 3. GitHub → Releases → Draft a new release: tag v1.7.1, приложить synth-v1.7.1.apk
```

После публикации релиза приложения на телефонах увидят обновление при следующем запуске.
