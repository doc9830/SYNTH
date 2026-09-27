# SYNTH для Android

Как из веб-сборки получается нативный APK и как выпускать обновления.

- `applicationId` / `namespace`: **`app.synth.hub`**
- Название: **SYNTH** (`android/app/src/main/res/values/strings.xml`)
- Версия: `versionCode 2`, `versionName "1.1.0"` (`android/app/build.gradle`)
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
3. Если Android ещё не разрешил установку из этого источника, приложение откроет
   системные настройки, а после включения тумблера достаточно нажать «Установить» повторно
   (путь к файлу сохраняется в состоянии).

Требуемые разрешения и пути:

- `AndroidManifest.xml`: `android.permission.REQUEST_INSTALL_PACKAGES`;
- `res/xml/file_paths.xml`: `external-files-path name="synth_updates" path="Download/"`
  (иначе `FileProvider` не отдаст установщику скачанный файл).

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
#    package.json → "version": "1.1.0"
# 2. версия пакета
#    android/app/build.gradle → versionCode 2, versionName "1.1.0"
npm run android:release
cp android/app/build/outputs/apk/release/app-release.apk synth-v1.1.0.apk
# 3. GitHub → Releases → Draft a new release: tag v1.1.0, приложить synth-v1.1.0.apk
```

После публикации релиза приложения на телефонах увидят обновление при следующем запуске.
