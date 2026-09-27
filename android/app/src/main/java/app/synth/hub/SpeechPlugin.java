package app.synth.hub;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
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
    /** Страховка: сервис не отозвался — сообщаем об ошибке, а не висим «слушаю». */
    private static final long ASR_START_TIMEOUT_MS = 8000;
    /** Страховка после «закончить»: молчащий сервис не держит микрофон открытым. */
    private static final long ASR_STOP_TIMEOUT_MS = 4000;

    private SpeechRecognizer recognizer;
    private boolean recognizing = false;
    /** true — распознаёт офлайн-сервис устройства (API 31+), false — системный. */
    private boolean recognizerOnDevice = false;
    /** Отмена своей же записи: ошибку ERROR_CLIENT после неё показывать нельзя. */
    private boolean cancelRequested = false;

    private static final String TAG_ASR = "SynthSpeech/ASR";

    private final Runnable asrStartTimeout = new Runnable() {
        @Override
        public void run() {
            if (!recognizing) return;
            Logger.warn(TAG_ASR, "сервис распознавания не отозвался за " + ASR_START_TIMEOUT_MS + " мс");
            emitRecognition("error", null, "NO_START", null);
            destroyRecognizer();
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
     * Что есть на устройстве: сервис распознавания, офлайн-пакет (API 31+) и
     * состояние разрешения на микрофон. Причина `NO_SERVICE` означает, что
     * распознавания нет вовсе (де-Гугленные прошивки, часть китайских ромов) —
     * интерфейс в этом случае остаётся текстовым, без падений.
     */
    @PluginMethod
    public void asrAvailable(PluginCall call) {
        Context context = getContext().getApplicationContext();
        boolean onDevice = onDeviceAvailable(context);
        boolean service = SpeechRecognizer.isRecognitionAvailable(context);

        JSObject ret = new JSObject();
        ret.put("available", service || onDevice);
        if (!service && !onDevice) ret.put("reason", "NO_SERVICE");
        ret.put("onDevice", onDevice);
        ret.put("language", ASR_LANGUAGE);
        ret.put("permission", getPermissionState("microphone").toString());
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
     * Старт записи. Офлайн-сервис устройства берём, когда он есть (API 31+);
     * иначе — системный сервис с `EXTRA_PREFER_OFFLINE`: система может уйти в
     * сеть, и об этом честно предупреждает интерфейс.
     */
    @PluginMethod
    public void startRecognize(PluginCall call) {
        if (getPermissionState("microphone") != PermissionState.GRANTED) {
            call.reject("Нет разрешения на микрофон.", "PERMISSION_DENIED");
            return;
        }
        if (!ensureRecognizer()) {
            call.reject("Распознавание речи недоступно на этом устройстве.", "NO_SERVICE");
            return;
        }

        String language = call.getString("lang", ASR_LANGUAGE);
        int silenceMs = call.getInt("silenceMs", ASR_SILENCE_MS);

        Intent intent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
        intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
        intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, language);
        intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_PREFERENCE, language);
        intent.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true);
        intent.putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1);
        intent.putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, getContext().getPackageName());
        // Автостоп по тишине: сервис завершает запись сам, без кнопки «стоп».
        intent.putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS, (long) silenceMs);
        intent.putExtra(
                RecognizerIntent.EXTRA_SPEECH_INPUT_POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS,
                (long) Math.max(400, silenceMs / 2));
        if (!recognizerOnDevice) {
            // Старый Android: офлайн — только предпочтение, сервис может уйти в облако.
            intent.putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true);
        }

        try {
            cancelRequested = false;
            recognizing = true;
            handler.removeCallbacks(asrStopTimeout);
            recognizer.startListening(intent);
        } catch (Exception e) {
            recognizing = false;
            Logger.warn(TAG_ASR, "startListening: " + e.getMessage());
            call.reject("Не удалось начать запись.", "NO_START");
            return;
        }
        handler.postDelayed(asrStartTimeout, ASR_START_TIMEOUT_MS);

        JSObject ret = new JSObject();
        ret.put("onDevice", recognizerOnDevice);
        ret.put("language", language);
        call.resolve(ret);
    }

    /** «Закончить»: сервис отдаёт итоговый текст (частичный сохраняется в JS). */
    @PluginMethod
    public void stopRecognize(PluginCall call) {
        boolean active = recognizing && recognizer != null;
        if (active) {
            try {
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
        boolean active = recognizing;
        cancelRequested = true;
        destroyRecognizer();
        if (active) emitRecognition("cancelled", null, null, "user");
        JSObject ret = new JSObject();
        ret.put("cancelled", active);
        call.resolve(ret);
    }

    /** Создаёт распознаватель: офлайн-сервис устройства, иначе системный. */
    private boolean ensureRecognizer() {
        if (recognizer != null) return true;
        Context context = getContext().getApplicationContext();

        if (onDeviceAvailable(context)) {
            try {
                recognizer = SpeechRecognizer.createOnDeviceSpeechRecognizer(context);
                recognizerOnDevice = true;
            } catch (Exception e) {
                // Офлайн-сервис объявлен, но не поднимается — берём системный.
                Logger.warn(TAG_ASR, "createOnDeviceSpeechRecognizer: " + e.getMessage() + " — берём системный сервис");
                recognizer = null;
            }
        }
        if (recognizer == null) {
            if (!SpeechRecognizer.isRecognitionAvailable(context)) {
                Logger.warn(TAG_ASR, "сервис распознавания речи не найден");
                return false;
            }
            try {
                recognizer = SpeechRecognizer.createSpeechRecognizer(context);
            } catch (Exception e) {
                Logger.warn(TAG_ASR, "createSpeechRecognizer: " + e.getMessage());
                recognizer = null;
                return false;
            }
            recognizerOnDevice = false;
        }
        recognizer.setRecognitionListener(this);
        return true;
    }

    private static boolean onDeviceAvailable(Context context) {
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.S
                && SpeechRecognizer.isOnDeviceRecognitionAvailable(context);
    }

    /** Освобождает распознаватель и микрофон (`destroy()` по документации). */
    private void destroyRecognizer() {
        handler.removeCallbacks(asrStartTimeout);
        handler.removeCallbacks(asrStopTimeout);
        recognizing = false;
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
        handler.removeCallbacks(asrStartTimeout);
        emitRecognition("ready", null, null, null);
    }

    @Override
    public void onBeginningOfSpeech() {
        handler.removeCallbacks(asrStartTimeout);
        emitRecognition("speech", null, null, null);
    }

    /** Уровень сигнала не показываем: индикатор громкости только отвлекает. */
    @Override
    public void onRmsChanged(float rmsdB) {
        // намеренно пусто
    }

    @Override
    public void onBufferReceived(byte[] buffer) {
        // Аудио живёт только внутри сервиса распознавания: приложением не сохраняется.
    }

    /** Тишина: сервис сам завершает запись и вот-вот отдаст итоговый текст. */
    @Override
    public void onEndOfSpeech() {
        emitRecognition("silence", null, null, null);
    }

    @Override
    public void onResults(Bundle results) {
        recognizing = false;
        handler.removeCallbacks(asrStartTimeout);
        handler.removeCallbacks(asrStopTimeout);
        emitRecognition("final", firstResult(results), null, null);
    }

    @Override
    public void onPartialResults(Bundle partialResults) {
        String text = firstResult(partialResults);
        if (text == null || text.isEmpty()) return;
        emitRecognition("partial", text, null, null);
    }

    @Override
    public void onError(int error) {
        recognizing = false;
        handler.removeCallbacks(asrStartTimeout);
        handler.removeCallbacks(asrStopTimeout);
        if (cancelRequested) {
            // ERROR_CLIENT сразу после нашей же отмены — это не ошибка.
            cancelRequested = false;
            return;
        }
        String code = errorCode(error);
        Logger.warn(TAG_ASR, "ошибка распознавания: " + code + " (" + error + ")");
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
