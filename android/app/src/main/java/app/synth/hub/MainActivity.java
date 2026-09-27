package app.synth.hub;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Локальный плагин обновлений (загрузка и установка APK) — до super.onCreate()
        registerPlugin(UpdaterPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
