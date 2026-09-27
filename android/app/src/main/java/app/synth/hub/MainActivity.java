package app.synth.hub;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Локальные плагины (до super.onCreate):
        //   SynthUpdater — загрузка и установка APK-обновлений;
        //   SynthFiles   — сохранение файлов (экспорт чата, картинки) из WebView;
        //   SynthSpeech  — озвучка ответов (TextToSpeech) и голосовой ввод
        //                  (SpeechRecognizer): обе задачи — системные средства.
        registerPlugin(UpdaterPlugin.class);
        registerPlugin(FilesPlugin.class);
        registerPlugin(SpeechPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
