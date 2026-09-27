package app.synth.hub;

import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.Settings;

import androidx.core.content.FileProvider;

import com.getcapacitor.JSObject;
import com.getcapacitor.Logger;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * SYNTH Updater — загрузка и установка APK-обновлений средствами самого приложения.
 *
 * Методы для JS:
 *   appInfo()                 → { versionName, versionCode }
 *   canInstall()              → { allowed } (разрешена ли установка из этого источника)
 *   openInstallSettings()     → системный экран «Установка неизвестных приложений»
 *   download({url, fileName}) → качает APK, по ходу шлёт события "progress" {received,total}
 *   cancelDownload()          → прерывает текущую загрузку
 *   install({path})           → запускает системный установщик пакета (FileProvider-URI)
 *
 * Плагин локальный (не из npm): регистрируется в MainActivity через registerPlugin().
 */
@CapacitorPlugin(name = "SynthUpdater")
public class UpdaterPlugin extends Plugin {

    private volatile boolean cancelRequested = false;

    private String extVersionName() {
        try {
            Context ctx = getContext();
            return ctx.getPackageManager().getPackageInfo(ctx.getPackageName(), 0).versionName;
        } catch (Exception e) {
            return "0";
        }
    }

    private long extVersionCode() {
        try {
            Context ctx = getContext();
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                return ctx.getPackageManager()
                        .getPackageInfo(ctx.getPackageName(), 0)
                        .getLongVersionCode();
            }
            return ctx.getPackageManager().getPackageInfo(ctx.getPackageName(), 0).versionCode;
        } catch (Exception e) {
            return 0;
        }
    }

    @PluginMethod
    public void appInfo(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("versionName", extVersionName());
        ret.put("versionCode", extVersionCode());
        call.resolve(ret);
    }

    @PluginMethod
    public void canInstall(PluginCall call) {
        Context ctx = getContext();
        boolean allowed = Build.VERSION.SDK_INT < Build.VERSION_CODES.O
                || ctx.getPackageManager().canRequestPackageInstalls();
        JSObject ret = new JSObject();
        ret.put("allowed", allowed);
        call.resolve(ret);
    }

    @PluginMethod
    public void openInstallSettings(PluginCall call) {
        Context ctx = getContext();
        String pkg = ctx.getPackageName();

        // Экран «Установка неизвестных приложений» для конкретного пакета есть
        // не на всех прошивках: пробуем по очереди от самого точного к общему.
        Intent[] candidates = new Intent[] {
                new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + pkg)),
                new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES),
                new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + pkg)),
                new Intent(Settings.ACTION_SETTINGS),
        };

        for (Intent intent : candidates) {
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            try {
                ctx.startActivity(intent);
                JSObject ret = new JSObject();
                ret.put("opened", true);
                ret.put("action", intent.getAction());
                call.resolve(ret);
                return;
            } catch (Exception e) {
                // на этой прошивке такого экрана нет — пробуем следующий вариант
                Logger.warn("Не удалось открыть " + intent.getAction() + ": " + e.getMessage());
            }
        }

        call.reject(
                "Системные настройки недоступны. Включите «Установка неизвестных приложений» для SYNTH вручную.",
                "SETTINGS_UNAVAILABLE");
    }

    @PluginMethod
    public void download(final PluginCall call) {
        final String url = call.getString("url");
        final String fileName = call.getString("fileName", "synth-update.apk");
        if (url == null || url.isEmpty()) {
            call.reject("Не передан адрес файла (url).");
            return;
        }

        cancelRequested = false;

        new Thread(() -> {
            HttpURLConnection connection = null;
            try {
                File dir = getContext().getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
                if (dir != null && !dir.exists() && !dir.mkdirs()) {
                    call.reject("Не удалось создать каталог для загрузки.");
                    return;
                }
                File target = new File(dir, fileName);
                if (target.exists() && !target.delete()) {
                    call.reject("Не удалось перезаписать файл обновления.");
                    return;
                }

                connection = (HttpURLConnection) new URL(url).openConnection();
                connection.setInstanceFollowRedirects(true);
                connection.setConnectTimeout(20000);
                connection.setReadTimeout(60000);
                connection.connect();

                int status = connection.getResponseCode();
                if (status < 200 || status >= 300) {
                    call.reject("Сервер вернул HTTP " + status + " при загрузке обновления.");
                    return;
                }

                final int total = connection.getContentLength();
                long received = 0;
                long lastEmit = 0;

                try (InputStream in = connection.getInputStream();
                     FileOutputStream out = new FileOutputStream(target)) {
                    byte[] buffer = new byte[64 * 1024];
                    int read;
                    while ((read = in.read(buffer)) > 0) {
                        if (cancelRequested) {
                            call.reject("Загрузка отменена.");
                            return;
                        }
                        out.write(buffer, 0, read);
                        received += read;
                        long now = System.currentTimeMillis();
                        if (now - lastEmit > 150) {
                            lastEmit = now;
                            JSObject progress = new JSObject();
                            progress.put("received", received);
                            progress.put("total", total);
                            notifyListeners("progress", progress);
                        }
                    }
                }

                JSObject ret = new JSObject();
                ret.put("path", target.getAbsolutePath());
                ret.put("size", target.length());
                call.resolve(ret);
            } catch (Exception e) {
                call.reject("Не удалось скачать обновление: " + e.getMessage(), e);
            } finally {
                if (connection != null) {
                    connection.disconnect();
                }
            }
        }).start();
    }

    @PluginMethod
    public void cancelDownload(PluginCall call) {
        cancelRequested = true;
        call.resolve();
    }

    @PluginMethod
    public void install(PluginCall call) {
        final String path = call.getString("path");
        if (path == null || path.isEmpty()) {
            call.reject("Не передан путь к файлу обновления.");
            return;
        }

        Context ctx = getContext();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                && !ctx.getPackageManager().canRequestPackageInstalls()) {
            call.reject(
                    "Разрешите установку приложений из этого источника: включите переключатель для SYNTH в системных настройках.",
                    "INSTALL_PERMISSION_REQUIRED");
            return;
        }

        try {
            File file = new File(path);
            if (!file.exists()) {
                call.reject("Файл обновления не найден.");
                return;
            }
            Uri uri = FileProvider.getUriForFile(ctx, ctx.getPackageName() + ".fileprovider", file);
            Intent intent = new Intent(Intent.ACTION_VIEW);
            intent.setDataAndType(uri, "application/vnd.android.package-archive");
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_GRANT_READ_URI_PERMISSION);
            ctx.startActivity(intent);

            JSObject ret = new JSObject();
            ret.put("started", true);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("Не удалось запустить установку: " + e.getMessage(), e);
        }
    }
}
