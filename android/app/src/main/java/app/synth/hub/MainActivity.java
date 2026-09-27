package app.synth.hub;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Локальные плагины (до super.onCreate):
        //   SynthUpdater — загрузка и установка APK-обновлений;
        //   SynthFiles   — сохранение файлов (экспорт чата, картинки) из WebView;
        //   SynthTts     — озвучка ответов системным синтезом речи (TextToSpeech).
        registerPlugin(UpdaterPlugin.class);
        registerPlugin(FilesPlugin.class);
        registerPlugin(TtsPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
