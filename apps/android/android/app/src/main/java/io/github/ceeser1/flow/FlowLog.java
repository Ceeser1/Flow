package io.github.ceeser1.flow;

import android.content.Context;
import android.util.Log;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * What playback did, kept in the app's storage to read afterwards (a phone
 * that played unplugged for an hour): files/logs/flow.log, moved to
 * flow.1.log once it reaches MAX_BYTES, so at most two of them. Read with
 * `adb exec-out run-as io.github.ceeser1.flow cat files/logs/flow.log`.
 * Lines also go to logcat (tag Flow). Written on a thread of its own.
 */
final class FlowLog {
    private static final long MAX_BYTES = 512 * 1024;
    private static final ExecutorService writer = Executors.newSingleThreadExecutor();
    private static File file;

    private FlowLog() {}

    static synchronized void init(Context context) {
        if (file != null) return;
        File dir = new File(context.getApplicationContext().getFilesDir(), "logs");
        if (!dir.isDirectory()) dir.mkdirs();
        file = new File(dir, "flow.log");
    }

    static void i(String text) {
        Log.i("Flow", text);
        final File f = file;
        if (f == null) return;
        final String line = new SimpleDateFormat("yyyy-MM-dd HH:mm:ss.SSS", Locale.ROOT).format(new Date()) + " " + text + "\n";
        writer.execute(() -> {
            try {
                if (f.length() > MAX_BYTES) {
                    File old = new File(f.getParentFile(), "flow.1.log");
                    old.delete();
                    f.renameTo(old);
                }
                try (OutputStream out = new FileOutputStream(f, true)) {
                    out.write(line.getBytes(StandardCharsets.UTF_8));
                }
            } catch (IOException e) {
                Log.w("Flow", "log: " + e.getMessage());
            }
        });
    }
}
