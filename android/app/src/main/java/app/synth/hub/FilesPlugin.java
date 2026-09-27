package app.synth.hub;

import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;

/**
 * SYNTH Files — сохранение файлов из WebView в файловую систему Android.
 *
 * Зачем: в WebView тег &lt;a download&gt; ничего не делает — у WebView нет
 * DownloadListener, поэтому «Экспорт в .md» и «Скачать» картинку в APK
 * молча пропадали. Здесь тот же сценарий выполняется нативно.
 *
 * Методы для JS:
 *   saveText({fileName, text, mime})     → сохраняет текстовый файл
 *   saveBase64({fileName, base64, mime}) → сохраняет бинарный файл (картинка)
 *
 * Куда сохраняется:
 *   • Android 10+ (API 29) — в общие папки через MediaStore: картинки в
 *     «Pictures/SYNTH» (видны в галерее), остальное — в «Download/SYNTH».
 *     Разрешения не нужны.
 *   • Android 9- — в песочницу приложения (getExternalFilesDir(DOWNLOADS)):
 *     тоже без разрешений, путь возвращается в JS.
 *
 * Ответ: { path, visible } — visible=true, если файл лёг в общую папку.
 */
@CapacitorPlugin(name = "SynthFiles")
public class FilesPlugin extends Plugin {

    /** Подпапка, в которую складываются файлы SYNTH. */
    private static final String SUBDIR = "SYNTH";

    @PluginMethod
    public void saveText(PluginCall call) {
        String fileName = sanitize(call.getString("fileName", "synth.txt"));
        String text = call.getString("text", "");
        String mime = call.getString("mime", "text/plain");

        try {
            Saved saved = write(fileName, text.getBytes("UTF-8"), mime);
            call.resolve(saved.toJSObject());
        } catch (Exception e) {
            call.reject("Не удалось сохранить файл: " + e.getMessage(), e);
        }
    }

    @PluginMethod
    public void saveBase64(PluginCall call) {
        String fileName = sanitize(call.getString("fileName", "synth.bin"));
        String mime = call.getString("mime", "application/octet-stream");
        String data = call.getString("base64", "");

        if (data == null || data.isEmpty()) {
            call.reject("Пустое содержимое файла.");
            return;
        }

        // принимаем и «чистый» base64, и data URL целиком
        if (data.startsWith("data:")) {
            int comma = data.indexOf(',');
            if (comma < 0) {
                call.reject("Повреждённый data URL.");
                return;
            }
            data = data.substring(comma + 1);
        }

        try {
            byte[] bytes = Base64.decode(data, Base64.DEFAULT);
            Saved saved = write(fileName, bytes, mime);
            call.resolve(saved.toJSObject());
        } catch (Exception e) {
            call.reject("Не удалось сохранить файл: " + e.getMessage(), e);
        }
    }

    private static final class Saved {
        final String path;
        final boolean visible;

        Saved(String path, boolean visible) {
            this.path = path;
            this.visible = visible;
        }

        JSObject toJSObject() {
            JSObject ret = new JSObject();
            ret.put("path", path);
            ret.put("visible", visible);
            return ret;
        }
    }

    private Saved write(String fileName, byte[] data, String mime) throws Exception {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            Uri uri = insertIntoMediaStore(fileName, data, mime);
            if (uri != null) return new Saved(uri.toString(), true);
        }

        Context ctx = getContext();
        File dir = ctx.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
        if (dir == null) throw new Exception("внешнее хранилище недоступно");
        if (!dir.exists() && !dir.mkdirs()) throw new Exception("не удалось создать каталог");
        File target = new File(dir, fileName);
        try (FileOutputStream out = new FileOutputStream(target)) {
            out.write(data);
        }
        return new Saved(target.getAbsolutePath(), false);
    }

    /** API 29+: файл сразу попадает в общие «Pictures/SYNTH» или «Download/SYNTH». */
    private Uri insertIntoMediaStore(String fileName, byte[] data, String mime) {
        boolean image = mime != null && mime.startsWith("image/");
        Uri collection = image
                ? MediaStore.Images.Media.EXTERNAL_CONTENT_URI
                : MediaStore.Downloads.EXTERNAL_CONTENT_URI;
        String relativePath = (image ? Environment.DIRECTORY_PICTURES : Environment.DIRECTORY_DOWNLOADS)
                + "/" + SUBDIR;

        ContentValues values = new ContentValues();
        values.put(MediaStore.MediaColumns.DISPLAY_NAME, fileName);
        values.put(MediaStore.MediaColumns.MIME_TYPE, mime);
        values.put(MediaStore.MediaColumns.RELATIVE_PATH, relativePath);
        values.put(MediaStore.MediaColumns.IS_PENDING, 1);

        ContentResolver resolver = getContext().getContentResolver();
        Uri uri = resolver.insert(collection, values);
        if (uri == null) return null;

        try (OutputStream out = resolver.openOutputStream(uri)) {
            if (out == null) throw new Exception("не удалось открыть поток записи");
            out.write(data);
        } catch (Exception e) {
            resolver.delete(uri, null, null);
            return null;
        }

        ContentValues done = new ContentValues();
        done.put(MediaStore.MediaColumns.IS_PENDING, 0);
        resolver.update(uri, done, null, null);
        return uri;
    }

    /** Имя файла без путей и запрещённых символов. */
    private String sanitize(String name) {
        String clean = name == null ? "" : name.replaceAll("[\\\\/:*?\"<>|]+", "_").trim();
        if (clean.isEmpty()) clean = "synth.txt";
        return clean;
    }
}
