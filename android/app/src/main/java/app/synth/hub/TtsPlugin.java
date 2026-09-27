package app.synth.hub;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.speech.tts.Voice;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Logger;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONException;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Set;

/**
 * SYNTH TTS — озвучка ответов системным синтезом речи Android.
 *
 * Только системные средства: {@link android.speech.tts.TextToSpeech}.
 * Никаких сторонних моделей и облаков, разрешения не нужны, микрофон не
 * используется, аудио никуда не отправляется. Работает офлайн, если у голоса
 * не выставлен флаг «требуется сеть».
 *
 * Методы для JS:
 *   available()                  → { available, reason?, engine?, voice?, language?, needsNetwork }
 *   speak({chunks, rate, pitch}) → ставит фрагменты в очередь, шлёт события "progress"
 *   stop()                       → мгновенно обрывает чтение
 *   shutdown()                   → освобождает движок (при уходе с экрана)
 *
 * События "progress": { index, count, state: start|done|error|stopped, message?, reason? }.
 * Фрагменты приходят из JS уже разобранными по абзацам (src/lib/ttsText.ts):
 * короткая очередь — быстрый «стоп» и подсветка текущего фрагмента.
 *
 * Плагин локальный (не из npm): регистрируется в MainActivity через registerPlugin().
 */
@CapacitorPlugin(name = "SynthTts")
public class TtsPlugin extends Plugin implements TextToSpeech.OnInitListener {

    private static final String TAG = "SynthTts";
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

    /** Голос: русский по умолчанию, но из фактически доступных на устройстве. */
    private void pickVoice() {
        engineName = tts.getDefaultEngine();
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

        Voice best = chooseRussianVoice();
        if (best != null) {
            tts.setVoice(best);
            voiceName = best.getName();
            Locale locale = best.getLocale();
            voiceLanguage = locale != null ? locale.toLanguageTag() : "ru";
            voiceNeedsNetwork = best.isNetworkConnectionRequired();
        } else {
            // Голосов списком движок не отдал — читаем языком по умолчанию.
            tts.setLanguage(ru);
            voiceLanguage = ru.toLanguageTag();
            voiceNeedsNetwork = false;
        }

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

    // ── Жизненный цикл ───────────────────────────────────────────────────

    /**
     * Сворачивание приложения и уход с экрана: чтение останавливаем сразу,
     * движок не держим в фоне (см. также handleOnStop).
     */
    @Override
    protected void handleOnPause() {
        super.handleOnPause();
        stopFromLifecycle();
    }

    @Override
    protected void handleOnStop() {
        super.handleOnStop();
        stopFromLifecycle();
    }

    /** Приложение закрывается — движок нужно освободить (shutdown). */
    @Override
    protected void handleOnDestroy() {
        shutdownEngine();
        super.handleOnDestroy();
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
