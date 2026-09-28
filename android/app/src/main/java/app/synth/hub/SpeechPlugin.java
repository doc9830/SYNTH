package app.synth.hub;

import android.Manifest;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.speech.tts.Voice;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Logger;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import org.json.JSONException;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Set;

/**
 * SYNTH Speech — системный синтез (задача 06) и распознавание речи (задача 07).
 *
 * Оба движка — только системные средства Android:
 *   - {@link android.speech.tts.TextToSpeech} — озвучка ответов (разрешения не нужны);
 *   - {@link android.speech.SpeechRecognizer} — голосовой ввод (нужен RECORD_AUDIO).
 *
 * Никаких сторонних моделей, скачиваемых весов и облачных STT: распознаёт либо
 * офлайн-сервис устройства (`createOnDeviceSpeechRecognizer()`, API 31+), либо
 * системный сервис распознавания. Аудио нигде не хранится и никуда не
 * отправляется приложением; микрофон отпускается сразу после записи.
 *
 * Оба движка работают в главном потоке приложения: `SpeechRecognizer` требует
 * этого прямо (его методы вызываются только из главного потока), а методы
 * плагина Capacitor выполняются в фоновом потоке `CapacitorPlugins` — поэтому
 * входы распознавания проходят через {@code onMainThread()} (см. ниже).
 *
 * Методы для JS:
 *   available()                  → { available, reason?, engine?, voice?, language?, needsNetwork }
 *   speak({chunks, rate, pitch}) → ставит фрагменты в очередь, шлёт события "progress"
 *   stop()                       → мгновенно обрывает чтение
 *   shutdown()                   → освобождает движок (при уходе с экрана)
 *   asrAvailable()               → { available, reason?, onDevice, language, permission }
 *   requestMic()                 → запрос разрешения RECORD_AUDIO (первое использование)
 *   startRecognize({lang, silenceMs}) → старт записи, шлёт события "recognize"
 *   stopRecognize()              → «закончить»: система отдаёт итоговый текст
 *   cancelRecognize()            → «отменить»: результат выбрасывается, микрофон отпущен
 *
 * События "progress": { index, count, state: start|done|error|stopped, message?, reason? }.
 * События "recognize": { state: ready|speech|partial|silence|final|error|cancelled, text?, code?, reason? }.
 *
 * Плагин локальный (не из npm): регистрируется в MainActivity через registerPlugin().
 * Имя плагина — SynthSpeech: с задачи 07 он отвечает и за распознавание, поэтому
 * старое имя SynthTts больше не описывало то, что делает класс. Методы синтеза
 * не менялись, поменялось только имя плагина (его видит только наша JS-обёртка).
 */
@CapacitorPlugin(
    name = "SynthSpeech",
    permissions = { @Permission(alias = "microphone", strings = { Manifest.permission.RECORD_AUDIO }) }
)
public class SpeechPlugin extends Plugin implements TextToSpeech.OnInitListener, RecognitionListener {

    private static final String TAG = "SynthSpeech";
    /** Сколько ждём ответа движка: молчащий движок не должен вешать интерфейс. */
    private static final long INIT_TIMEOUT_MS = 6000;

    private TextToSpeech tts;
    private boolean initializing = false;
    private boolean ready = false;
    /** Код причины, если движок не готов: ENGINE_UNAVAILABLE | ENGINE_TIMEOUT | NO_RU_VOICE. */
    private String initError;

    private String engineName;
    private String voiceName;
    private String voiceLanguage;
    private boolean voiceNeedsNetwork;

    private int totalChunks = 0;
    private int lastIndex = -1;

    /** Вызовы available(), ждущие инициализацию движка. */
    private final List<PluginCall> waiting = new ArrayList<>();
    /** Вызовы speak(), ждущие инициализацию (после shutdown движок поднимается заново). */
    private final List<Runnable> deferred = new ArrayList<>();

    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Runnable initTimeout = new Runnable() {
        @Override
        public void run() {
            if (!initializing) return;
            initializing = false;
            ready = false;
            initError = "ENGINE_TIMEOUT";
            Logger.warn(TAG, "движок TTS не ответил за " + INIT_TIMEOUT_MS + " мс");
            resolveWaiting();
        }
    };

    // ── Распознавание речи: поля ─────────────────────────────────────────

    /** Язык распознавания: русский — тот же, что у озвучки. */
    private static final String ASR_LANGUAGE = "ru-RU";
    /** Молчание, после которого сервис сам завершает запись. */
    private static final int ASR_SILENCE_MS = 1100;
    /**
     * Пауза между созданием распознавателя и `startListening()`: сервису нужно
     * успеть подключиться (`bindService`). Старт, отданный до подключения,
     * системный класс теряет молча — тогда в ответ не приходит ни одного
     * колбэка, и запись висит до страховочного таймаута, то есть человек видит
     * «сервис распознавания не ответил» при полностью живом сервисе.
     */
    private static final long ASR_BIND_DELAY_MS = 350;
    /** Страховка: сервис не отозвался — сообщаем об ошибке, а не висим «слушаю». */
    private static final long ASR_START_TIMEOUT_MS = 8000;
    /** Страховка после «закончить»: молчащий сервис не держит микрофон открытым. */
    private static final long ASR_STOP_TIMEOUT_MS = 4000;
    /**
     * Сколько стартов делаем, прежде чем признать, что сервис не отвечает.
     * Вторая попытка идёт другим распознавателем (офлайн → системный): на части
     * прошивок офлайн-сервис объявлен, но молчит без скачанного пакета языка.
     */
    private static final int ASR_MAX_ATTEMPTS = 2;
    /**
     * Код отказа создания распознавателя: система не смогла его поднять. Второй
     * код отказа — `NO_SERVICE`: движка распознавания на устройстве нет вовсе.
     */
    private static final String ASR_CREATE_FAILED = "CREATE_FAILED";
    /**
     * Ключ настройки Android «выбранный сервис распознавания речи». Константа
     * `Settings.Secure.VOICE_RECOGNITION_SERVICE` помечена `@hide` и в публичном
     * SDK недоступна, а имя настройки стабильно — держим его строкой, как и коды
     * ошибок API 31+ (`ERROR_CODE_*`).
     */
    private static final String SETTING_VOICE_RECOGNITION_SERVICE = "voice_recognition_service";

    /**
     * Коды ошибок сервиса распознавания, добавленные в API 31 — там они
     * называются `SpeechRecognizer.ERROR_*`. Держим числами: так классу не нужны
     * новые API на этапе выполнения, а комментарий объясняет, откуда числа.
     */
    private static final int ERROR_CODE_TOO_MANY_REQUESTS = 10;
    private static final int ERROR_CODE_SERVER_DISCONNECTED = 11;
    private static final int ERROR_CODE_LANGUAGE_NOT_SUPPORTED = 12;
    private static final int ERROR_CODE_LANGUAGE_UNAVAILABLE = 13;
    private static final int ERROR_CODE_CANNOT_CHECK_SUPPORT = 14;
    private static final int ERROR_CODE_CANNOT_LISTEN_TO_DOWNLOAD_EVENTS = 15;

    private SpeechRecognizer recognizer;
    private boolean recognizing = false;
    /** true — распознаёт офлайн-сервис устройства (API 31+), false — системный. */
    private boolean recognizerOnDevice = false;
    /** Отмена своей же записи: ошибку ERROR_CLIENT после неё показывать нельзя. */
    private boolean cancelRequested = false;
    /** Интент последнего старта: по нему повторяем попытку другим распознавателем. */
    private Intent asrIntent;
    /** Сколько стартов сделано в текущей сессии (для повтора другим сервисом). */
    private int asrAttempts = 0;
    /** true — «слушай» уже ушло в сервис (до этого «закончить» нечего). */
    private boolean asrListening = false;
    /**
     * Офлайн-сервис уже молчал: до перезапуска приложения берём системный.
     * Ждать второй раз тот же сервис незачем — состояние чужого сервиса не наша
     * ошибка, но и не повод показывать «не ответил» на каждой попытке записи.
     */
    private static boolean onDeviceSilent = false;

    /**
     * Почему распознаватель не создан в текущей попытке старта: `CREATE_FAILED`
     * ставится, когда система не смогла создать объект распознавателя; null —
     * создания не было или оно прошло. Код уходит в JS при отказе старта.
     */
    private String asrCreateError;

    private static final String TAG_ASR = "SynthSpeech/ASR";

    /** Старт, отложенный до подключения сервиса (см. `ASR_BIND_DELAY_MS`). */
    private final Runnable asrStart = new Runnable() {
        @Override
        public void run() {
            startListeningNow();
        }
    };

    private final Runnable asrStartTimeout = new Runnable() {
        @Override
        public void run() {
            if (!recognizing) return;
            Logger.warn(TAG_ASR, "старт без ответа за " + ASR_START_TIMEOUT_MS + " мс" + asrAttemptInfo());
            retryWithOtherRecognizer();
        }
    };

    /**
     * Сервис не отдал результат после stopListening(): молчание не должно
     * оставлять микрофон открытым и кнопку в состоянии «слушаю».
     */
    private final Runnable asrStopTimeout = new Runnable() {
        @Override
        public void run() {
            if (!recognizing) return;
            Logger.warn(TAG_ASR, "сервис не отдал результат за " + ASR_STOP_TIMEOUT_MS + " мс");
            emitRecognition("error", null, "NO_RESULT", null);
            destroyRecognizer();
        }
    };

    // ── Инициализация движка и голоса ────────────────────────────────────

    private void ensureEngine() {
        if (tts != null || initializing) return;
        initializing = true;
        initError = null;
        try {
            Context context = getContext().getApplicationContext();
            tts = new TextToSpeech(context, this);
        } catch (Exception e) {
            // движка нет вовсе — это не краш, а «озвучка недоступна»
            initializing = false;
            tts = null;
            ready = false;
            initError = "ENGINE_UNAVAILABLE";
            Logger.warn(TAG, "TextToSpeech не создался: " + e.getMessage());
            return;
        }
        handler.postDelayed(initTimeout, INIT_TIMEOUT_MS);
    }

    @Override
    public void onInit(int status) {
        initializing = false;
        handler.removeCallbacks(initTimeout);
        if (status != TextToSpeech.SUCCESS || tts == null) {
            ready = false;
            initError = "ENGINE_UNAVAILABLE";
            Logger.warn(TAG, "движок TTS не поднялся, status=" + status);
        } else {
            pickVoice();
        }
        resolveWaiting();
    }

    /**
     * Голос: русский по умолчанию, но из фактически доступных на устройстве.
     *
     * Порядок важен. Сначала смотрим список голосов: русский голос часто есть
     * даже тогда, когда офлайн-данные для него не скачаны, и
     * `isLanguageAvailable()` в этом случае отвечает `LANG_MISSING_DATA`.
     * Раньше такой телефон считался «без русского голоса» и озвучка пряталась
     * целиком, хотя сетевой голос исправно читает. Теперь берём его и один раз
     * предупреждаем, что нужен интернет (см. `needsNetwork`).
     */
    private void pickVoice() {
        engineName = tts.getDefaultEngine();

        Voice best = chooseRussianVoice();
        if (best != null && tts.setVoice(best) == TextToSpeech.SUCCESS) {
            voiceName = best.getName();
            Locale locale = best.getLocale();
            voiceLanguage = locale != null ? locale.toLanguageTag() : "ru";
            voiceNeedsNetwork = best.isNetworkConnectionRequired();
            ready = true;
            initError = null;
            return;
        }

        Locale ru = Locale.forLanguageTag("ru-RU");
        if (isUnavailable(tts.isLanguageAvailable(ru))) {
            ru = Locale.forLanguageTag("ru");
        }
        if (isUnavailable(tts.isLanguageAvailable(ru))) {
            ready = false;
            initError = "NO_RU_VOICE";
            Logger.warn(TAG, "нет голоса для локали ru");
            return;
        }

        // Голосов списком движок не отдал — читаем языком по умолчанию.
        if (isUnavailable(tts.setLanguage(ru))) {
            ready = false;
            initError = "NO_RU_VOICE";
            Logger.warn(TAG, "setLanguage(ru) не принят движком");
            return;
        }
        voiceLanguage = ru.toLanguageTag();
        voiceNeedsNetwork = false;
        ready = true;
        initError = null;
    }

    private static boolean isUnavailable(int status) {
        return status == TextToSpeech.LANG_MISSING_DATA || status == TextToSpeech.LANG_NOT_SUPPORTED;
    }

    /** Среди голосов с русской локалью предпочитаем офлайновый. */
    private Voice chooseRussianVoice() {
        Set<Voice> voices = tts.getVoices();
        if (voices == null) return null;
        Voice offline = null;
        Voice any = null;
        for (Voice voice : voices) {
            Locale locale = voice.getLocale();
            if (locale == null || !"ru".equalsIgnoreCase(locale.getLanguage())) continue;
            if (voice.isNetworkConnectionRequired()) {
                if (any == null) any = voice;
            } else if (offline == null) {
                offline = voice;
            }
        }
        return offline != null ? offline : any;
    }

    private void resolveWaiting() {
        List<PluginCall> pending = new ArrayList<>(waiting);
        waiting.clear();
        for (PluginCall call : pending) {
            call.resolve(info());
        }
        // Отложенные speak(): движок уже готов (или окончательно не поднялся).
        List<Runnable> tasks = new ArrayList<>(deferred);
        deferred.clear();
        for (Runnable task : tasks) {
            task.run();
        }
    }

    /** Ответ о доступности: используется и методом available(), и событиями. */
    private JSObject info() {
        JSObject ret = new JSObject();
        ret.put("available", ready);
        ret.put("needsNetwork", ready && voiceNeedsNetwork);
        if (engineName != null) ret.put("engine", engineName);
        if (ready) {
            if (voiceName != null) ret.put("voice", voiceName);
            if (voiceLanguage != null) ret.put("language", voiceLanguage);
        } else {
            ret.put("reason", initError != null ? initError : "ENGINE_UNAVAILABLE");
        }
        return ret;
    }

    // ── Методы для JS ────────────────────────────────────────────────────

    /** Проверка перед использованием: движок, русский голос, сетевое требование. */
    @PluginMethod
    public void available(PluginCall call) {
        ensureEngine();
        if (ready || initError != null) {
            call.resolve(info());
            return;
        }
        // Движок инициализируется: ответим, когда он отзовётся (или по таймауту).
        waiting.add(call);
    }

    /**
     * Ставит фрагменты в очередь движка. Первый фрагмент идёт с QUEUE_FLUSH:
     * так гарантированно не остаётся хвост от прошлой озвучки (stop() движка
     * завершается асинхронно и сам по себе очередь не всегда чистит).
     */
    @PluginMethod
    public void speak(final PluginCall call) {
        ensureEngine();
        if (!ready) {
            if (initError != null) {
                call.reject("Системный синтез речи недоступен.", initError);
                return;
            }
            // Движок ещё инициализируется: прочитаем, как только он отзовётся.
            deferred.add(() -> {
                if (ready) doSpeak(call);
                else call.reject("Системный синтез речи недоступен.", repairReason());
            });
            return;
        }
        doSpeak(call);
    }

    private String repairReason() {
        return initError != null ? initError : "ENGINE_UNAVAILABLE";
    }

    private void doSpeak(PluginCall call) {
        List<String> chunks = readChunks(call);
        if (chunks.isEmpty()) {
            call.reject("Пустой текст для озвучки.", "EMPTY_TEXT");
            return;
        }

        Float rate = call.getFloat("rate");
        Float pitch = call.getFloat("pitch");
        if (rate != null) tts.setSpeechRate(clamp(rate, 0.4f, 2.0f));
        if (pitch != null) tts.setPitch(clamp(pitch, 0.5f, 2.0f));

        tts.stop();
        totalChunks = chunks.size();
        lastIndex = -1;
        attachListener();

        for (int i = 0; i < chunks.size(); i++) {
            int mode = i == 0 ? TextToSpeech.QUEUE_FLUSH : TextToSpeech.QUEUE_ADD;
            tts.speak(chunks.get(i), mode, null, String.valueOf(i));
        }

        JSObject ret = new JSObject();
        ret.put("count", chunks.size());
        call.resolve(ret);
    }

    private List<String> readChunks(PluginCall call) {
        List<String> chunks = new ArrayList<>();
        JSArray array = call.getArray("chunks");
        if (array == null) return chunks;
        try {
            for (Object item : array.toList()) {
                if (item == null) continue;
                String text = String.valueOf(item).trim();
                if (!text.isEmpty()) chunks.add(text);
            }
        } catch (JSONException e) {
            Logger.warn(TAG, "не удалось разобрать фрагменты: " + e.getMessage());
        }
        return chunks;
    }

    private static float clamp(float value, float min, float max) {
        return Math.max(min, Math.min(max, value));
    }

    /** Остановка: движок обрывает текущий фрагмент и чистит очередь. */
    @PluginMethod
    public void stop(PluginCall call) {
        boolean speaking = tts != null && tts.isSpeaking();
        if (tts != null) {
            tts.stop();
        }
        JSObject ret = new JSObject();
        ret.put("stopped", speaking);
        call.resolve(ret);
    }

    /** Освобождение ресурсов: shutdown() движка (при уходе с экрана). */
    @PluginMethod
    public void shutdown(PluginCall call) {
        shutdownEngine();
        call.resolve();
    }

    // ── События прогресса ────────────────────────────────────────────────

    private void attachListener() {
        tts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
            @Override
            public void onStart(String utteranceId) {
                lastIndex = parseIndex(utteranceId);
                emit("start", lastIndex, null, null);
            }

            @Override
            public void onDone(String utteranceId) {
                int index = parseIndex(utteranceId);
                lastIndex = index;
                emit("done", index, null, null);
            }

            @Override
            public void onError(String utteranceId) {
                emit("error", parseIndex(utteranceId), "Движок TTS не смог прочитать фрагмент.", null);
            }

            @Override
            public void onError(String utteranceId, int errorCode) {
                emit(
                        "error",
                        parseIndex(utteranceId),
                        "Движок TTS вернул ошибку " + errorCode + ".",
                        null);
            }

            /** Пользователь свернул приложение — чтение прервано системой. */
            @Override
            public void onStop(String utteranceId, boolean interrupted) {
                emit("stopped", parseIndex(utteranceId), null, "lifecycle");
            }
        });
    }

    private static int parseIndex(String utteranceId) {
        try {
            return Integer.parseInt(utteranceId);
        } catch (Exception e) {
            return -1;
        }
    }

    private void emit(String state, int index, String message, String reason) {
        JSObject data = new JSObject();
        data.put("index", index);
        data.put("count", totalChunks);
        data.put("state", state);
        if (message != null) data.put("message", message);
        if (reason != null) data.put("reason", reason);
        notifyListeners("progress", data);
    }

    // ── Распознавание речи: методы для JS ────────────────────────────────

    /**
     * Что есть на устройстве: сервис распознавания, офлайн-движок (API 31+) и
     * состояние разрешения на микрофон.
     *
     * Наличие сервиса проверяем двумя независимыми способами, потому что
     * `isRecognitionAvailable()` — это запрос к PackageManager, а он на Android
     * 11+ подчиняется видимости пакетов: чужой распознаватель система может не
     * показать этому приложению, хотя он установлен и работает. Второе мнение —
     * выбранный пользователем сервис из `Settings.Secure.VOICE_RECOGNITION_SERVICE`:
     * ровно его берёт сама платформа, когда создаёт системный распознаватель.
     * Офлайн-движок объявлен в конфигурации прошивки, поэтому он дополняет
     * системный сервис, а не заменяет его.
     *
     * Причина отказа называется конкретно (`NO_SERVICE` — движка нет вовсе,
     * `ONDEVICE_SILENT` — офлайн-движок молчит, а системного не видно), чтобы её
     * было понятно без logcat. Диагностические поля `systemService` и
     * `deviceModel` показывают, что именно нашлось на устройстве.
     */
    @PluginMethod
    public void asrAvailable(PluginCall call) {
        Context context = getContext().getApplicationContext();
        // Офлайн-сервис, который уже промолчал, за рабочий не считаем: интерфейс
        // должен обещать ровно тот движок, который будет использован на записи.
        boolean deviceModel = onDeviceAvailable(context);
        boolean onDevice = !onDeviceSilent && deviceModel;
        boolean service = SpeechRecognizer.isRecognitionAvailable(context);
        boolean selected = selectedRecognizer(context) != null;
        // Системный распознаватель считаем живым и по выбору пользователя: запрос к
        // PackageManager может его скрыть (см. `systemRecognizerPossible`).
        boolean available = systemRecognizerPossible(context) || onDevice;

        JSObject ret = new JSObject();
        ret.put("available", available);
        ret.put("onDevice", onDevice);
        ret.put("deviceModel", deviceModel);
        ret.put("systemService", service);
        // Разрешение отдаём отдельным полем: интерфейс спрашивает его при первом
        // нажатии на микрофон, и отказ в доступе не должен выглядеть как
        // «сервиса распознавания нет».
        PermissionState permission = getPermissionState("microphone");
        ret.put("language", ASR_LANGUAGE);
        ret.put("permission", permission.toString());
        if (!available) ret.put("reason", deviceModel ? "ONDEVICE_SILENT" : "NO_SERVICE");
        Logger.info(TAG_ASR, "asrAvailable: available=" + available
                + ", systemService=" + service
                + ", selectedService=" + selected
                + ", deviceModel=" + deviceModel
                + ", permission=" + permission);
        call.resolve(ret);
    }

    /** Разрешение на микрофон запрашиваем при первом использовании записи. */
    @PluginMethod
    public void requestMic(PluginCall call) {
        if (getPermissionState("microphone") == PermissionState.GRANTED) {
            JSObject ret = new JSObject();
            ret.put("granted", true);
            ret.put("permission", PermissionState.GRANTED.toString());
            call.resolve(ret);
            return;
        }
        requestPermissionForAlias("microphone", call, "micPermissionCallback");
    }

    /** Ответ системы на запрос разрешения: JS получает честное «да/нет». */
    @PermissionCallback
    private void micPermissionCallback(PluginCall call) {
        if (call == null) return;
        JSObject ret = new JSObject();
        ret.put("granted", getPermissionState("microphone") == PermissionState.GRANTED);
        ret.put("permission", getPermissionState("microphone").toString());
        call.resolve(ret);
    }

    /**
     * Выполняет задачу в главном потоке приложения.
     *
     * `SpeechRecognizer` документирует это как обязательное условие: его методы
     * вызываются только из главного потока приложения. Поэтому
     * `createSpeechRecognizer()` вне главного потока бросает исключение, а
     * подключённый в главном потоке сервис остаётся невидимым для фонового:
     * `startListening()` уходит в никуда, и запись выглядит как молчащая.
     *
     * Методы плагина Capacitor выполняются не в главном потоке, а в фоновом
     * `CapacitorPlugins` (`Bridge.callPluginMethod` → `taskHandler.post`),
     * поэтому вход в распознавание проходит через этот шлюз. В 1.7.3 из-за него
     * человек видел «Система не смогла создать распознаватель речи», а в 1.7.2 —
     * «сервис распознавания не ответил».
     */
    private void onMainThread(Runnable task) {
        if (Looper.myLooper() == Looper.getMainLooper()) {
            task.run();
            return;
        }
        handler.post(task);
    }

    /**
     * Старт записи. Офлайн-сервис устройства берём, когда он есть (API 31+);
     * иначе — системный сервис с `EXTRA_PREFER_OFFLINE`: система может уйти в
     * сеть, и об этом честно предупреждает интерфейс.
     *
     * Сервису отдаём старт не в этом же кадре, а короткой задержкой
     * (`ASR_BIND_DELAY_MS`): свежий распознаватель только начинает подключаться,
     * и `startListening()` до подключения пропадает молча. Если сервис так и не
     * отозвался — пробуем другой распознаватель (`retryWithOtherRecognizer`),
     * и только потом JS узнаёт о неудаче событием `error` с кодом `NO_START`.
     */
    @PluginMethod
    public void startRecognize(PluginCall call) {
        // `SpeechRecognizer` живёт в главном потоке — см. `onMainThread`.
        onMainThread(() -> startRecognizeOnMain(call));
    }

    /**
     * Тело `startRecognize`: выполняется в главном потоке, там же, где потом
     * приходят колбэки сервиса. Иначе создание распознавателя падало бы на
     * проверке потока внутри `SpeechRecognizer`, и старт выглядел бы как отказ
     * системы создать распознаватель.
     */
    private void startRecognizeOnMain(PluginCall call) {
        if (getPermissionState("microphone") != PermissionState.GRANTED) {
            call.reject("Нет разрешения на микрофон.", "PERMISSION_DENIED");
            return;
        }
        if (!ensureRecognizer()) {
            // Причина отказа конкретная: движка нет вовсе или система не смогла
            // создать распознаватель — подменять её общей фразой нельзя.
            boolean created = ASR_CREATE_FAILED.equals(asrCreateError);
            call.reject(
                    created
                            ? "Система не смогла создать распознаватель речи."
                            : "Сервиса распознавания речи на устройстве нет.",
                    created ? ASR_CREATE_FAILED : "NO_SERVICE");
            return;
        }

        String language = call.getString("lang", ASR_LANGUAGE);
        int silenceMs = call.getInt("silenceMs", ASR_SILENCE_MS);

        asrIntent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
        asrIntent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
        asrIntent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, language);
        asrIntent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_PREFERENCE, language);
        asrIntent.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true);
        asrIntent.putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1);
        asrIntent.putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, getContext().getPackageName());
        // Автостоп по тишине: сервис завершает запись сам, без кнопки «стоп».
        asrIntent.putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS, (long) silenceMs);
        asrIntent.putExtra(
                RecognizerIntent.EXTRA_SPEECH_INPUT_POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS,
                (long) Math.max(400, silenceMs / 2));
        if (!recognizerOnDevice) {
            // Старый Android: офлайн — только предпочтение, сервис может уйти в облако.
            asrIntent.putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true);
        }

        cancelRequested = false;
        recognizing = true;
        asrAttempts = 0;
        asrListening = false;
        handler.removeCallbacks(asrStopTimeout);
        scheduleStart();

        JSObject ret = new JSObject();
        ret.put("onDevice", recognizerOnDevice);
        ret.put("language", language);
        call.resolve(ret);
    }

    /** Старт после паузы на подключение сервиса: см. `ASR_BIND_DELAY_MS`. */
    private void scheduleStart() {
        handler.removeCallbacks(asrStart);
        handler.removeCallbacks(asrStartTimeout);
        handler.postDelayed(asrStart, ASR_BIND_DELAY_MS);
    }

    /** Отдаёт сервису «слушай»; ответа ждём страховочным таймаутом. */
    private void startListeningNow() {
        if (!recognizing || recognizer == null || asrIntent == null) return;
        asrAttempts++;
        try {
            recognizer.startListening(asrIntent);
            asrListening = true;
        } catch (Exception e) {
            Logger.warn(TAG_ASR, "startListening: " + e.getMessage() + asrAttemptInfo());
            asrListening = false;
            retryWithOtherRecognizer();
            return;
        }
        Logger.info(TAG_ASR, "слушаю: " + sourceName() + asrAttemptInfo());
        handler.removeCallbacks(asrStartTimeout);
        handler.postDelayed(asrStartTimeout, ASR_START_TIMEOUT_MS);
    }

    /**
     * Сервис молчит: отпускаем распознаватель и пробуем другой. Офлайн-сервис
     * вполне может быть объявлен на устройстве, но не работать без скачанного
     * пакета языка — тогда системный отвечает там, где офлайн промолчал.
     * Когда попытки кончились, JS получает `error` с кодом `NO_START`: начать
     * запись не удалось, и об этом человеку говорят словами, а не тишиной.
     */
    private void retryWithOtherRecognizer() {
        boolean wasOnDevice = recognizerOnDevice;
        if (wasOnDevice) onDeviceSilent = true;
        String failed = sourceName();
        int attempts = asrAttempts;
        destroyRecognizer();
        // Повтор смысл имеет, только если он будет другим распознавателем: тот же
        // самый молчащий сервис со второй попытки не ответит, а человек ждал бы
        // ошибку вдвое дольше.
        Context context = getContext().getApplicationContext();
        // «Есть ли другой распознаватель» решает та же проверка, что и при старте:
        // один запрос к PackageManager ещё не приговор (см. `systemRecognizerPossible`).
        boolean alternate = wasOnDevice
                ? systemRecognizerPossible(context)
                : (!onDeviceSilent && onDeviceAvailable(context));
        if (alternate && asrAttempts < ASR_MAX_ATTEMPTS) {
            recognizing = true;
            cancelRequested = false;
            asrListening = false;
            if (ensureRecognizer()) {
                Logger.warn(TAG_ASR, "повторяем старт: " + sourceName());
                scheduleStart();
                return;
            }
            recognizing = false;
        }
        Logger.warn(TAG_ASR, "распознавание не ответило: " + failed + ", попытки: " + attempts);
        emitRecognition("error", null, "NO_START", null);
        destroyRecognizer();
    }

    /** Имя распознавателя и номер попытки — для журнала устройства. */
    private String asrAttemptInfo() {
        return " (" + sourceName() + ", попытка " + asrAttempts + ")";
    }

    private String sourceName() {
        return recognizerOnDevice ? "офлайн-сервис" : "системный сервис";
    }

    /**
     * Любой колбэк сервиса означает, что он жив: страховка старта больше не
     * нужна. Так молчание отличается от медленного, но работающего сервиса —
     * иначе запись обрывалась бы на середине фразы.
     */
    private void markAlive() {
        handler.removeCallbacks(asrStartTimeout);
    }

    /** «Закончить»: сервис отдаёт итоговый текст (частичный сохраняется в JS). */
    @PluginMethod
    public void stopRecognize(PluginCall call) {
        // `SpeechRecognizer.stopListening()` вызывается только из главного потока.
        onMainThread(() -> stopRecognizeOnMain(call));
    }

    /** Тело `stopRecognize`: см. `onMainThread`. */
    private void stopRecognizeOnMain(PluginCall call) {
        boolean active = recognizing && recognizer != null;
        if (active && !asrListening) {
            // «Закончить» пришло раньше самого старта (запись ещё поднималась):
            // слушать было нечего — отдаём пустой итог, а не ошибку сервиса.
            handler.removeCallbacks(asrStart);
            emitRecognition("final", null, null, null);
            destroyRecognizer();
            active = false;
        } else if (active) {
            try {
                // «Закончить» — уже не старт: отложенный повтор отменяем, иначе
                // запись может начаться заново после того, как человек её закрыл.
                handler.removeCallbacks(asrStartTimeout);
                recognizer.stopListening();
                // Сервис может промолчать: тогда сработает страховка ниже.
                handler.postDelayed(asrStopTimeout, ASR_STOP_TIMEOUT_MS);
            } catch (Exception e) {
                Logger.warn(TAG_ASR, "stopListening: " + e.getMessage());
                active = false;
            }
        }
        JSObject ret = new JSObject();
        ret.put("stopped", active);
        call.resolve(ret);
    }

    /**
     * «Отменить»: результат выбрасывается, микрофон отпускается сразу.
     * Распознаватель разрушаем — следующий старт создаст его заново.
     */
    @PluginMethod
    public void cancelRecognize(PluginCall call) {
        // `cancel()`/`destroy()` распознавателя — тоже только главный поток.
        onMainThread(() -> cancelRecognizeOnMain(call));
    }

    /** Тело `cancelRecognize`: см. `onMainThread`. */
    private void cancelRecognizeOnMain(PluginCall call) {
        boolean active = recognizing;
        cancelRequested = true;
        destroyRecognizer();
        if (active) emitRecognition("cancelled", null, null, "user");
        JSObject ret = new JSObject();
        ret.put("cancelled", active);
        call.resolve(ret);
    }

    /**
     * Создаёт распознаватель: офлайн-движок устройства, иначе системный.
     *
     * Системный распознаватель пробуем всегда (если офлайн не поднялся или уже
     * молчал). Раньше здесь стоял приговор по `isRecognitionAvailable()` — и на
     * Android 11+ он врал: запрос к PackageManager подчиняется видимости пакетов,
     * поэтому установленный и рабочий распознаватель мог быть не виден, и живой
     * Gboard уживался с сообщением «распознавание речи недоступно». Правду знает
     * только сам сервис: если его нет, система ответит `onError(ERROR_CLIENT)`.
     *
     * Вызывать только из главного потока: `createSpeechRecognizer()` проверяет
     * поток и вне главного падает — см. {@code onMainThread()}.
     */
    private boolean ensureRecognizer() {
        if (recognizer != null) return true;
        asrCreateError = null;
        Context context = getContext().getApplicationContext();

        // Офлайн-сервис пропускаем, если он уже молчал: ждать его второй раз
        // незачем, а системный сервис на таком устройстве отвечает.
        if (!onDeviceSilent && onDeviceAvailable(context)) {
            try {
                recognizer = SpeechRecognizer.createOnDeviceSpeechRecognizer(context);
                recognizerOnDevice = true;
            } catch (Exception e) {
                // Офлайн-сервис объявлен, но не поднимается — берём системный.
                Logger.warn(TAG_ASR, "createOnDeviceSpeechRecognizer: " + e.getMessage() + " — берём системный сервис");
                recognizer = null;
                recognizerOnDevice = false;
            }
        }
        if (recognizer == null) {
            if (!systemRecognizerPossible(context)) {
                Logger.warn(TAG_ASR, "системного распознавателя не видно ни в пакетах, ни в настройках — пробуем подключить всё равно");
            }
            try {
                recognizer = SpeechRecognizer.createSpeechRecognizer(context);
            } catch (Exception e) {
                // Полный текст исключения: по нему видно, что именно не дало
                // создать распознаватель (например, вызов не из главного потока).
                Logger.warn(TAG_ASR, "createSpeechRecognizer: " + e);
                recognizer = null;
                asrCreateError = ASR_CREATE_FAILED;
                return false;
            }
            if (recognizer == null) {
                // Системный класс вернул пустой объект — создать не удалось.
                Logger.warn(TAG_ASR, "createSpeechRecognizer вернул null: распознаватель не поднялся");
                asrCreateError = ASR_CREATE_FAILED;
                return false;
            }
            recognizerOnDevice = false;
        }
        recognizer.setRecognitionListener(this);
        Logger.info(TAG_ASR, "распознаватель создан: " + sourceName());
        return true;
    }

    /**
     * Может ли работать системный распознаватель. `isRecognitionAvailable()` —
     * это запрос к PackageManager, и на Android 11+ его ответ зависит от
     * видимости пакетов: «нет» здесь ещё не значит, что сервиса нет. Второе
     * мнение — выбранный пользователем сервис (`Settings.Secure.
     * VOICE_RECOGNITION_SERVICE`): его берёт сама платформа, когда создаёт
     * системный распознаватель.
     */
    private static boolean systemRecognizerPossible(Context context) {
        return SpeechRecognizer.isRecognitionAvailable(context) || selectedRecognizer(context) != null;
    }

    /**
     * Выбранный пользователем сервис распознавания (компонент из настроек
     * Android). Пустое значение — честный признак того, что системного
     * распознавателя на устройстве нет.
     */
    private static ComponentName selectedRecognizer(Context context) {
        try {
            String component = Settings.Secure.getString(
                    context.getContentResolver(), SETTING_VOICE_RECOGNITION_SERVICE);
            return component == null ? null : ComponentName.unflattenFromString(component);
        } catch (Exception e) {
            Logger.warn(TAG_ASR, "выбранный распознаватель недоступен: " + e.getMessage());
            return null;
        }
    }

    private static boolean onDeviceAvailable(Context context) {
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.S
                && SpeechRecognizer.isOnDeviceRecognitionAvailable(context);
    }

    /** Освобождает распознаватель и микрофон (`destroy()` по документации). */
    private void destroyRecognizer() {
        handler.removeCallbacks(asrStart);
        handler.removeCallbacks(asrStartTimeout);
        handler.removeCallbacks(asrStopTimeout);
        recognizing = false;
        asrListening = false;
        SpeechRecognizer current = recognizer;
        recognizer = null;
        recognizerOnDevice = false;
        if (current == null) return;
        try {
            current.cancel();
            current.destroy();
        } catch (Exception e) {
            Logger.warn(TAG_ASR, "destroy распознавателя: " + e.getMessage());
        }
    }

    // ── Распознавание речи: колбэки системы ──────────────────────────────

    @Override
    public void onReadyForSpeech(Bundle params) {
        markAlive();
        emitRecognition("ready", null, null, null);
    }

    @Override
    public void onBeginningOfSpeech() {
        markAlive();
        emitRecognition("speech", null, null, null);
    }

    /** Уровень сигнала не показываем: индикатор громкости только отвлекает. */
    @Override
    public void onRmsChanged(float rmsdB) {
        // Звук пошёл — сервис слушает: страховка старта больше не нужна.
        markAlive();
    }

    @Override
    public void onBufferReceived(byte[] buffer) {
        // Аудио живёт только внутри сервиса распознавания: приложением не сохраняется.
    }

    /** Тишина: сервис сам завершает запись и вот-вот отдаст итоговый текст. */
    @Override
    public void onEndOfSpeech() {
        markAlive();
        emitRecognition("silence", null, null, null);
    }

    @Override
    public void onResults(Bundle results) {
        recognizing = false;
        asrListening = false;
        handler.removeCallbacks(asrStartTimeout);
        handler.removeCallbacks(asrStopTimeout);
        emitRecognition("final", firstResult(results), null, null);
    }

    @Override
    public void onPartialResults(Bundle partialResults) {
        // Частичный текст — тоже признак живого сервиса.
        markAlive();
        String text = firstResult(partialResults);
        if (text == null || text.isEmpty()) return;
        emitRecognition("partial", text, null, null);
    }

    @Override
    public void onError(int error) {
        recognizing = false;
        asrListening = false;
        handler.removeCallbacks(asrStartTimeout);
        handler.removeCallbacks(asrStopTimeout);
        if (cancelRequested) {
            // ERROR_CLIENT сразу после нашей же отмены — это не ошибка.
            cancelRequested = false;
            return;
        }
        String code = errorCode(error);
        Logger.warn(TAG_ASR, "ошибка распознавания: " + code + " (" + error + ")");
        if ("CLIENT".equals(code)) {
            // ERROR_CLIENT приходит и тогда, когда система не смогла подключить
            // распознаватель: обычно в настройках Android не выбран сервис
            // распознавания речи.
            Logger.warn(TAG_ASR, "распознаватель не подключился: проверьте выбор сервиса распознавания речи в настройках Android");
        }
        emitRecognition("error", null, code, null);
    }

    @Override
    public void onEvent(int eventType, Bundle params) {
        // Частные события сервиса не нужны: частичный текст приходит в onPartialResults.
    }

    /** API 33+: сегментные результаты приходят вместе с обычными — не дублируем. */
    @Override
    public void onSegmentResults(Bundle segmentResults) {
        // намеренно пусто
    }

    @Override
    public void onEndOfSegmentedSession() {
        // намеренно пусто
    }

    /** Лучший текст из ответа сервиса (список отсортирован по уверенности). */
    private static String firstResult(Bundle results) {
        if (results == null) return null;
        List<String> list = results.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
        if (list == null || list.isEmpty()) return null;
        for (String item : list) {
            if (item != null && !item.trim().isEmpty()) return item.trim();
        }
        return null;
    }

    /** Коды ошибок распознавания — стабильные строки для JS. */
    private static String errorCode(int error) {
        switch (error) {
            case SpeechRecognizer.ERROR_AUDIO:
                return "AUDIO";
            case SpeechRecognizer.ERROR_CLIENT:
                return "CLIENT";
            case SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS:
                return "PERMISSION_DENIED";
            case SpeechRecognizer.ERROR_NETWORK:
            case SpeechRecognizer.ERROR_NETWORK_TIMEOUT:
                return "NETWORK";
            case SpeechRecognizer.ERROR_NO_MATCH:
                return "NO_MATCH";
            case SpeechRecognizer.ERROR_RECOGNIZER_BUSY:
                return "BUSY";
            case SpeechRecognizer.ERROR_SERVER:
                return "SERVER";
            case SpeechRecognizer.ERROR_SPEECH_TIMEOUT:
                return "SILENCE";
            // API 31+: сервис умеет сообщать про загруженность, отключение и
            // отсутствие языка. Коды берём своими числами (см. ERROR_CODE_*).
            case ERROR_CODE_TOO_MANY_REQUESTS:
                return "TOO_MANY";
            case ERROR_CODE_SERVER_DISCONNECTED:
                return "NETWORK";
            case ERROR_CODE_LANGUAGE_NOT_SUPPORTED:
                return "NO_LANGUAGE";
            case ERROR_CODE_LANGUAGE_UNAVAILABLE:
            case ERROR_CODE_CANNOT_CHECK_SUPPORT:
            case ERROR_CODE_CANNOT_LISTEN_TO_DOWNLOAD_EVENTS:
                return "NO_PACK";
            default:
                return "UNKNOWN";
        }
    }

    private void emitRecognition(String state, String text, String code, String reason) {
        JSObject data = new JSObject();
        data.put("state", state);
        if (text != null) data.put("text", text);
        if (code != null) data.put("code", code);
        if (reason != null) data.put("reason", reason);
        if ("partial".equals(state) || "final".equals(state)) {
            data.put("onDevice", recognizerOnDevice);
        }
        notifyListeners("recognize", data);
    }

    // ── Жизненный цикл ───────────────────────────────────────────────────

    /**
     * Сворачивание приложения и уход с экрана: чтение останавливаем сразу,
     * движок не держим в фоне (см. также handleOnStop). Запись с микрофоном
     * обрываем и отпускаем распознаватель: приложение не должно слушать из
     * кармана, а «слушаю» не должно переживать уход в фон.
     */
    @Override
    protected void handleOnPause() {
        super.handleOnPause();
        stopFromLifecycle();
        stopRecognitionFromLifecycle();
    }

    @Override
    protected void handleOnStop() {
        super.handleOnStop();
        stopFromLifecycle();
        stopRecognitionFromLifecycle();
    }

    /** Приложение закрывается — освобождаем и движок, и распознаватель. */
    @Override
    protected void handleOnDestroy() {
        shutdownEngine();
        destroyRecognizer();
        super.handleOnDestroy();
    }

    /** Уход в фон во время записи: сообщаем JS и разрушаем распознаватель. */
    private void stopRecognitionFromLifecycle() {
        if (recognizer == null) return;
        if (recognizing) emitRecognition("cancelled", null, null, "lifecycle");
        cancelRequested = true;
        destroyRecognizer();
    }

    private void stopFromLifecycle() {
        if (tts == null || !tts.isSpeaking()) return;
        tts.stop();
        emit("stopped", lastIndex, null, "lifecycle");
    }

    private void shutdownEngine() {
        handler.removeCallbacks(initTimeout);
        initializing = false;
        ready = false;
        initError = null;
        voiceName = null;
        voiceLanguage = null;
        voiceNeedsNetwork = false;
        totalChunks = 0;
        lastIndex = -1;
        if (tts != null) {
            TextToSpeech engine = tts;
            tts = null;
            try {
                engine.stop();
                engine.shutdown();
            } catch (Exception e) {
                Logger.warn(TAG, "shutdown движка: " + e.getMessage());
            }
        }
        resolveWaiting();
    }
}
