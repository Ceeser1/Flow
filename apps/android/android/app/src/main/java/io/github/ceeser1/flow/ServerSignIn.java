package io.github.ceeser1.flow;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Signs in to the Flow Server again without the page, as the page's client
 * does at its start (packages/core/src/client/remote.js login and
 * restoreProfile): the server's password, then the profile this phone was
 * signed in to, with its PIN. For the player, when the server ended its
 * session (a song refused with 401) while the page slept or was gone.
 *
 * What it needs the client keeps in the app's files: settings.json
 * (serverSecret, clientId) and server-sync.json (profile, profilePin), the
 * secrets encrypted with the phone's Keystore key (FlowSync). It sends the
 * same app id (clientId), so the server replaces this app's old token.
 */
final class ServerSignIn {
    /** What came of it: a token, and whether it is the profile's (or there is none). */
    static final class Result {
        final String token;
        final boolean profileOk;
        final String problem;

        Result(String token, boolean profileOk, String problem) {
            this.token = token;
            this.profileOk = profileOk;
            this.problem = problem;
        }
    }

    interface Done {
        void signedIn(Result result);
    }

    private static final int TIMEOUT_MS = 20000;
    private static final ExecutorService worker = Executors.newSingleThreadExecutor();

    private ServerSignIn() {}

    /** Signs in to the server at `base` on a thread of its own; `done` is called on the main thread. */
    static void start(Context context, String base, Done done) {
        final Context app = context.getApplicationContext();
        final Handler main = new Handler(Looper.getMainLooper());
        worker.execute(() -> {
            Result r;
            try {
                r = signIn(app, base);
            } catch (IOException | JSONException | RuntimeException e) {
                r = new Result(null, false, e.getClass().getSimpleName() + ": " + e.getMessage());
            }
            final Result result = r;
            main.post(() -> done.signedIn(result));
        });
    }

    private static Result signIn(Context app, String base) throws IOException, JSONException {
        File files = app.getFilesDir();
        JSONObject settings = readJson(new File(files, "settings.json"));
        JSONObject sync = readJson(new File(files, "server-sync.json"));
        FlowSync secrets = new FlowSync(app);
        String password = secrets.decrypt(settings.optString("serverSecret", ""));
        if (password.isEmpty()) return new Result(null, false, "no password kept");
        String client = settings.optString("clientId", "");
        String device = secrets.deviceName();

        JSONObject login = new JSONObject().put("password", password).put("device", device).put("client", client);
        Answer a = post(base + "/api/login", login, "");
        if (a.status != 200 || a.json.optString("token", "").isEmpty()) {
            return new Result(null, false, a.status == 401 ? "wrong password" : "login answered " + a.status);
        }
        String token = a.json.getString("token");

        JSONObject profile = sync.optJSONObject("profile");
        String profileId = profile == null ? "" : profile.optString("id", "");
        if (profileId.isEmpty()) return new Result(token, true, null);
        boolean hasPin = profile.optBoolean("pin", false);
        String pin = hasPin ? secrets.decrypt(sync.optString("profilePin", "")) : "";
        if (hasPin && pin.isEmpty()) return new Result(token, false, "the profile's PIN is not kept");
        JSONObject which = new JSONObject().put("profileId", profileId).put("pin", pin).put("device", device).put("client", client);
        Answer p = post(base + "/api/profiles/login", which, token);
        if (p.status != 200 || p.json.optString("token", "").isEmpty()) {
            return new Result(token, false, "profile login answered " + p.status);
        }
        return new Result(p.json.getString("token"), true, null);
    }

    private static JSONObject readJson(File f) throws IOException, JSONException {
        if (!f.isFile()) return new JSONObject();
        String text = new String(Files.readAllBytes(f.toPath()), StandardCharsets.UTF_8).trim();
        return text.isEmpty() || text.equals("null") ? new JSONObject() : new JSONObject(text);
    }

    private static final class Answer {
        final int status;
        final JSONObject json;

        Answer(int status, JSONObject json) {
            this.status = status;
            this.json = json;
        }
    }

    private static Answer post(String url, JSONObject body, String token) throws IOException {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        try {
            c.setConnectTimeout(TIMEOUT_MS);
            c.setReadTimeout(TIMEOUT_MS);
            c.setRequestMethod("POST");
            c.setDoOutput(true);
            c.setRequestProperty("Content-Type", "application/json");
            if (!token.isEmpty()) c.setRequestProperty("Authorization", "Bearer " + token);
            byte[] bytes = body.toString().getBytes(StandardCharsets.UTF_8);
            c.setFixedLengthStreamingMode(bytes.length);
            try (OutputStream out = c.getOutputStream()) {
                out.write(bytes);
            }
            int status = c.getResponseCode();
            InputStream in = status >= 400 ? c.getErrorStream() : c.getInputStream();
            JSONObject json = new JSONObject();
            if (in != null) {
                try (InputStream s = in) {
                    ByteArrayOutputStream buf = new ByteArrayOutputStream();
                    byte[] chunk = new byte[4096];
                    for (int n; (n = s.read(chunk)) > 0; ) buf.write(chunk, 0, n);
                    json = new JSONObject(buf.toString(StandardCharsets.UTF_8.name()));
                } catch (JSONException e) {
                    // Not JSON (a proxy's page): the status says enough.
                }
            }
            return new Answer(status, json);
        } finally {
            c.disconnect();
        }
    }
}
