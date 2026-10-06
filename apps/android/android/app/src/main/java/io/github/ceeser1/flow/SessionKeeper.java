package io.github.ceeser1.flow;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;

import androidx.media3.common.MediaMetadata;
import androidx.media3.common.Player;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.IOException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Keeps this phone's Active Session on the Flow Server while Flow is out of
 * sight.
 *
 * The page tells the server what plays (renderer/app/session.js), but about a
 * minute after Flow leaves the screen the WebView freezes it: no timers, no
 * network, not even the player's events reach it. The server keeps a session
 * while its host's live channel is open; once that breaks (another network,
 * the server restarted, its sign-in ended) the session was gone until the page
 * woke, and other devices did not see what this phone plays.
 *
 * So after each time it told the server, the page hands over what it told
 * (keep()), and while Flow is out of sight this tells it again every
 * EVERY_MS, with the song, place and playing as the player has them now
 * (paused: once). A 401 signs in again (ServerSignIn), the token going to the
 * players and the page. Once Flow is seen again, the page tells it itself.
 */
final class SessionKeeper {
    private static final long EVERY_MS = 5000;
    private static final int TIMEOUT_MS = 8000;
    private static SessionKeeper instance;

    private final Context context;
    private final FlowPlayer player;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final Runnable tick = this::tick;

    // What the page told last: the server's address, the token, this app's id,
    // the state (without its lists), the output delay's shift of the place (s),
    // and server time minus the phone's (ms). No state: not hosting.
    private String base = "";
    private String token = "";
    private String client = "";
    private JSONObject state;
    private double shift;
    private long offset;
    private boolean away;
    private boolean sending;
    private boolean signingIn;
    private boolean refused;     // could not sign in again: nothing more until the page speaks
    private Boolean toldPlaying; // what it last told: playing or not (null: nothing yet)
    private boolean toldAway;    // whether the log says it keeps the session (once each time away)
    private String problem = ""; // the last failure logged (each once)

    static synchronized SessionKeeper get(Context context) {
        if (instance == null) instance = new SessionKeeper(context.getApplicationContext());
        return instance;
    }

    private SessionKeeper(Context context) {
        this.context = context;
        this.player = FlowPlayer.get(context);
    }

    /**
     * The page's last word: { base, token, client, state, shift, offset }, or
     * { off: true } when this app hosts nothing (stopped, in another's session).
     */
    void keep(JSONObject o) {
        JSONObject st = o == null || o.optBoolean("off", false) ? null : o.optJSONObject("state");
        if (st == null) {
            state = null;
            main.removeCallbacks(tick);
            return;
        }
        try {
            state = new JSONObject(st.toString());
        } catch (JSONException e) {
            state = null;
            return;
        }
        // The lists stay as the server has them.
        state.remove("ids");
        state.remove("queue");
        base = o.optString("base", "");
        client = o.optString("client", "");
        String t = o.optString("token", "");
        if (!t.isEmpty()) token = t;
        shift = o.optDouble("shift", 0);
        offset = o.optLong("offset", 0);
        toldPlaying = null;
        refused = false;
        schedule();
    }

    /** Flow out of sight (its window stopped) or seen again. */
    void away(boolean away) {
        this.away = away;
        toldAway = false;
        schedule();
    }

    /** The player signed in again itself: the token this uses from now. */
    static void signedIn(String token) {
        if (instance != null) instance.token = token;
    }

    private void schedule() {
        main.removeCallbacks(tick);
        if (away && state != null) main.postDelayed(tick, EVERY_MS);
    }

    private void tick() {
        if (!away || state == null || base.isEmpty()) return;
        main.postDelayed(tick, EVERY_MS);
        int at = player.exo.getPlaybackState();
        boolean playing = player.exo.getPlayWhenReady() && at != Player.STATE_ENDED;
        // Paused: told once; the server lists it a while, as the page's would be.
        if (!playing && Boolean.FALSE.equals(toldPlaying)) return;
        if (sending || signingIn || refused) return;
        JSONObject now = now(playing);
        if (now != null) send(now, playing);
    }

    /** The state the page told, as the player is now. */
    private JSONObject now(boolean playing) {
        String key = player.songKey();
        if (key.isEmpty()) return null;
        try {
            JSONObject st = new JSONObject(state.toString());
            // On to another song since (the page could not say).
            if (!key.equals(st.optString("songId", ""))) {
                MediaMetadata md = player.exo.getMediaMetadata();
                st.put("songId", key);
                st.put("title", md.title == null ? "" : md.title.toString());
                st.put("artist", md.artist == null ? "" : md.artist.toString());
                st.put("mix", "");
                st.put("duration", player.length() / 1000.0);
            }
            st.put("playing", playing);
            st.put("position", Math.max(0, player.exo.getCurrentPosition() / 1000.0 + shift));
            st.put("at", System.currentTimeMillis() + offset);
            return st;
        } catch (JSONException e) {
            return null;
        }
    }

    private void send(JSONObject st, boolean playing) {
        final JSONObject body;
        try {
            body = new JSONObject().put("type", "state").put("state", st).put("client", client);
        } catch (JSONException e) {
            return;
        }
        final String url = base + "/api/sessions";
        final String t = token;
        sending = true;
        worker.execute(() -> {
            int status;
            String error = "";
            try {
                status = ServerSignIn.post(url, body, t, TIMEOUT_MS).status;
            } catch (IOException | RuntimeException e) {
                status = -1;
                error = e.getClass().getSimpleName();
            }
            final int s = status;
            final String why = error;
            main.post(() -> sent(s, why, playing));
        });
    }

    private void sent(int status, String error, boolean playing) {
        sending = false;
        if (status == 200) {
            toldPlaying = playing;
            if (!toldAway) {
                toldAway = true;
                FlowLog.i("Flow out of sight: the player keeps its session on the server");
            }
            if (!problem.isEmpty()) FlowLog.i("session told again");
            problem = "";
            return;
        }
        if (status == 401) {
            signIn();
            return;
        }
        String now = status < 0 ? "no answer (" + error + ")" : "answered " + status;
        if (!now.equals(problem)) FlowLog.i("session not told: " + now);
        problem = now;
    }

    /** The server ended this app's sign-in: again, as the player does; the next tick tells it. */
    private void signIn() {
        signingIn = true;
        FlowLog.i("session refused (signed out): signing in again");
        ServerSignIn.start(context, base, (r) -> {
            signingIn = false;
            if (r.token == null) {
                FlowLog.i("could not sign in again: " + r.problem);
                refused = true;
                return;
            }
            token = r.token;
            player.tookToken(r.token, r.profileOk);
            FlowLog.i("signed in again" + (r.profileOk ? "" : " (" + r.problem + ")"));
        });
    }
}
