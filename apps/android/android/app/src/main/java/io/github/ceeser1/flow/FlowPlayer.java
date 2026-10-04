package io.github.ceeser1.flow;

import android.content.Context;
import android.media.audiofx.LoudnessEnhancer;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.os.SystemClock;

import androidx.media3.common.AudioAttributes;
import androidx.media3.common.C;
import androidx.media3.common.MediaItem;
import androidx.media3.common.MediaMetadata;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.Player;
import androidx.media3.datasource.HttpDataSource;
import androidx.media3.exoplayer.ExoPlayer;

import com.getcapacitor.JSObject;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.List;

/**
 * The phone's player: one ExoPlayer for as long as the app's process lives,
 * whether the page is there or not. PlaybackService puts a media session
 * (notification, lock screen, headset buttons) around it; the page drives it
 * through FlowAudio as its audio engine (apps/android/src/engine.js), with
 * lists of operations, and hears back its state.
 *
 * Its playlist is the song playing and the songs the page says come after it
 * (its queue), so it moves on by itself, without a gap, even while the page
 * sleeps or is gone; Next in the notification goes there too. Each move is
 * told to the page ("advance", with how long the song before was heard).
 * Without a page, those listens are kept in a file until one asks (attach).
 *
 * Equalize volume: a song is turned down by the player's volume and up by a
 * LoudnessEnhancer on its sound, which also keeps the peaks of a song turned
 * up from clipping (the desktop's limiter).
 *
 * The sleep timer runs here too (the page's timers stop with the screen off):
 * the music fades out over its last seconds, then pauses.
 *
 * It takes audio focus (a call or another player pauses it), pauses when
 * headphones are pulled out, and keeps the CPU and Wi-Fi awake while it plays.
 * Everything here runs on the main thread, as ExoPlayer wants.
 */
final class FlowPlayer {
    /** What the page hears; every event carries the id of the song it is about. */
    interface Events {
        void onState(JSObject state);
        void onEnded(String id);
        /** `status`: the server's answer when it refused the song (401: signed out), else 0. */
        void onError(String id, String message, int status);
        /** On to the next song (`reason`: auto, next pressed, repeat); `heard`: seconds of the one before. */
        void onAdvance(String from, String id, String key, double heard, String reason);
    }

    /** What the page knows a song in the playlist by: its id there, the song's id, its gain. */
    private static final class Tag {
        final String id;
        final String key;
        final float gain;

        Tag(String id, String key, float gain) {
            this.id = id;
            this.key = key;
            this.gain = gain;
        }
    }

    private static final int TICK_MS = 250;
    private static FlowPlayer instance;

    static FlowPlayer get(Context context) {
        if (instance == null) instance = new FlowPlayer(context.getApplicationContext());
        return instance;
    }

    /** The player if this process has made one, else null (the widget does not start one). */
    static FlowPlayer peek() {
        return instance;
    }

    final ExoPlayer exo;
    private final Context context;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final File heardFile;
    private final File lastFile;
    private JSONArray heardWhileAway;
    // When the widget's Play opened Flow with nothing loaded (elapsed ms; 0: not): a page
    // starting soon after plays. Not one much later (Android may not have let Flow open).
    private long playAskedAt;
    private static final long PLAY_ASKED_MS = 20000;
    private final Runnable widget = this::drawWidget;
    private Events events;
    private String id = "";      // the page's id of the song playing
    private String key = "";     // the song's own id
    private float volume = 1f;   // the app's volume (the sleep timer's fade)
    private float gain = 1f;     // the song's own (Equalize volume)
    private boolean endedTold;
    private long durationMs = 0; // the song playing's length, as last known
    // How long the song playing has been heard: playing time, not places.
    private long heardMs = 0;
    private long playingSince = -1;
    private LoudnessEnhancer enhancer;
    private int enhancerSession = C.AUDIO_SESSION_ID_UNSET;
    private int boostMb = -1;
    // The sleep timer: when it runs out (wall clock, ms; 0: none), over how long it fades, how far it is.
    private long sleepAt = 0;
    private long sleepFadeMs = 10000;
    private float sleepFade = 1f;
    private final Runnable sleepTick = this::sleepCheck;

    // While playing, the place goes to the page four times a second, and to the
    // widget's timeline when its second changes (not with the screen off).
    private final Runnable tick = new Runnable() {
        @Override
        public void run() {
            if (!exo.isPlaying()) return;
            tellState();
            long second = exo.getCurrentPosition() / 1000;
            if (second != widgetSecond && screenOn()) {
                widgetSecond = second;
                FlowWidget.time(context, exo.getCurrentPosition(), length());
            }
            main.postDelayed(this, TICK_MS);
        }
    };
    private long widgetSecond = -1;

    private FlowPlayer(Context context) {
        this.context = context;
        FlowLog.init(context);
        heardFile = new File(context.getFilesDir(), "audio-heard.json");
        lastFile = new File(context.getFilesDir(), "audio-last.json");
        heardWhileAway = readHeard();
        AudioAttributes music = new AudioAttributes.Builder()
                .setUsage(C.USAGE_MEDIA)
                .setContentType(C.AUDIO_CONTENT_TYPE_MUSIC)
                .build();
        exo = new ExoPlayer.Builder(context)
                .setAudioAttributes(music, true)
                .setHandleAudioBecomingNoisy(true)
                .setWakeMode(C.WAKE_MODE_NETWORK)
                .build();
        exo.addListener(new Player.Listener() {
            @Override
            public void onEvents(Player player, Player.Events ev) {
                if (ev.containsAny(Player.EVENT_PLAY_WHEN_READY_CHANGED, Player.EVENT_PLAYBACK_STATE_CHANGED,
                        Player.EVENT_IS_PLAYING_CHANGED, Player.EVENT_POSITION_DISCONTINUITY,
                        Player.EVENT_TIMELINE_CHANGED, Player.EVENT_PLAYBACK_PARAMETERS_CHANGED)) {
                    tellState();
                }
                if (ev.contains(Player.EVENT_PLAYBACK_STATE_CHANGED) && player.getPlaybackState() == Player.STATE_ENDED && !endedTold) {
                    endedTold = true;
                    FlowLog.i("ended " + id);
                    if (events != null) events.onEnded(id);
                    else away(key, takeHeard());
                }
                if (ev.contains(Player.EVENT_IS_PLAYING_CHANGED)) {
                    main.removeCallbacks(tick);
                    if (player.isPlaying()) main.postDelayed(tick, TICK_MS);
                }
                if (ev.containsAny(Player.EVENT_PLAY_WHEN_READY_CHANGED, Player.EVENT_MEDIA_ITEM_TRANSITION,
                        Player.EVENT_MEDIA_METADATA_CHANGED, Player.EVENT_TIMELINE_CHANGED,
                        Player.EVENT_POSITION_DISCONTINUITY)) {
                    main.removeCallbacks(widget);
                    main.postDelayed(widget, 100);
                }
            }

            @Override
            public void onIsPlayingChanged(boolean isPlaying) {
                long now = SystemClock.elapsedRealtime();
                if (isPlaying && playingSince < 0) playingSince = now;
                if (!isPlaying && playingSince >= 0) {
                    heardMs += now - playingSince;
                    playingSince = -1;
                }
            }

            @Override
            public void onMediaItemTransition(MediaItem item, int reason) {
                if (item == null || reason == Player.MEDIA_ITEM_TRANSITION_REASON_PLAYLIST_CHANGED) return;
                advanced(item, reason);
            }

            @Override
            public void onAudioSessionIdChanged(int audioSessionId) {
                applyVolume();
            }

            @Override
            public void onPlayWhenReadyChanged(boolean playWhenReady, int reason) {
                FlowLog.i((playWhenReady ? "play" : "pause") + " " + id + " (" + playReason(reason) + ")");
            }

            @Override
            public void onPlaybackSuppressionReasonChanged(int reason) {
                if (reason != Player.PLAYBACK_SUPPRESSION_REASON_NONE) FlowLog.i("held back " + id + " (reason " + reason + ")");
                else FlowLog.i("no longer held back " + id);
            }

            @Override
            public void onPlayerError(PlaybackException error) {
                String text = error.getErrorCodeName() + ": " + error.getMessage();
                int status = 0;
                for (Throwable c = error; c != null; c = c.getCause()) {
                    if (c instanceof HttpDataSource.InvalidResponseCodeException) {
                        status = ((HttpDataSource.InvalidResponseCodeException) c).responseCode;
                        break;
                    }
                }
                FlowLog.i("error " + id + " " + text + (status > 0 ? " (" + status + ")" : ""));
                if (events != null) events.onError(id, text, status);
            }
        });
        FlowLog.i("player ready");
    }

    void setEvents(Events events) {
        this.events = events;
    }

    Events getEvents() {
        return events;
    }

    /**
     * A page starts: what is loaded (the state, the song's id and how long it
     * has been heard), and the listens kept while there was no page, which it
     * now records (they are forgotten here). With nothing loaded (the process
     * started again), the song Flow was swiped away on: `last` { key, at, heard }.
     * `play`: the widget's Play opened Flow, so the page plays.
     */
    JSObject attach() {
        JSObject a = new JSObject();
        a.put("state", state());
        a.put("heard", heardSoFar() / 1000.0);
        a.put("away", heardWhileAway);
        if (key.isEmpty() && lastFile.isFile()) {
            try {
                a.put("last", new JSONObject(new String(Files.readAllBytes(lastFile.toPath()), StandardCharsets.UTF_8)));
            } catch (JSONException | IOException e) {
                FlowLog.i("the last song could not be read: " + e.getMessage());
            }
        }
        boolean play = playAskedAt > 0 && SystemClock.elapsedRealtime() - playAskedAt < PLAY_ASKED_MS;
        a.put("play", play);
        FlowLog.i("page attached, " + (key.isEmpty() ? "nothing loaded" : id + " loaded") + ", " + heardWhileAway.length() + " listens kept"
                + (play ? ", plays" : ""));
        playAskedAt = 0;
        heardWhileAway = new JSONArray();
        heardFile.delete();
        lastFile.delete();
        return a;
    }

    /** The widget's Play with nothing loaded opens Flow: the page that starts plays (one already there is not asked). */
    void playOnAttach() {
        if (events == null) playAskedAt = SystemClock.elapsedRealtime();
    }

    /**
     * Flow swiped away from the recent apps: the music stops. The song stays
     * loaded for a page that starts while this process lives; for one that
     * starts later, its place and how long it was heard go into a file.
     */
    void letGo() {
        sleepAt = 0;
        main.removeCallbacks(sleepTick);
        if (sleepFade != 1f) {
            sleepFade = 1f;
            applyVolume();
        }
        exo.pause();
        if (key.isEmpty()) return;
        try {
            JSONObject last = new JSONObject();
            last.put("key", key);
            last.put("at", exo.getCurrentPosition() / 1000.0);
            last.put("heard", heardSoFar() / 1000.0);
            try (OutputStream out = new FileOutputStream(lastFile)) {
                out.write(last.toString().getBytes(StandardCharsets.UTF_8));
            }
        } catch (JSONException | IOException e) {
            FlowLog.i("could not keep the last song: " + e.getMessage());
        }
    }

    boolean hasSong() {
        return exo.getMediaItemCount() > 0;
    }

    /** The widget's Play/Pause; playing needs the service (it keeps the music in the foreground). */
    void widgetToggle(Context from) {
        if (exo.getPlayWhenReady()) {
            exo.pause();
            return;
        }
        if (!PlaybackService.running) {
            try {
                androidx.core.content.ContextCompat.startForegroundService(from, new android.content.Intent(from, PlaybackService.class));
            } catch (RuntimeException e) {
                FlowLog.i("widget: service not started: " + e.getMessage());
                return;
            }
        }
        if (exo.getPlaybackState() == Player.STATE_ENDED) {
            exo.seekTo(0);
            endedTold = false;
        }
        if (exo.getPlaybackState() == Player.STATE_IDLE) exo.prepare();
        exo.play();
    }

    private void drawWidget() {
        widgetSecond = exo.getCurrentPosition() / 1000;
        FlowWidget.refresh(context);
    }

    /** The song playing's length (ms; 0: not known yet). */
    long length() {
        long d = exo.getDuration();
        return d != C.TIME_UNSET && d > 0 ? d : Math.max(0, durationMs);
    }

    private boolean screenOn() {
        PowerManager power = (PowerManager) context.getSystemService(Context.POWER_SERVICE);
        return power == null || power.isInteractive();
    }

    /** The widget's Next: as Next in the notification. */
    void widgetNext() {
        if (exo.hasNextMediaItem()) exo.seekToNextMediaItem();
    }

    /**
     * Applies the page's operations in order. True when one of them starts
     * playing (PlaybackService must be running then).
     */
    boolean apply(JSONArray ops) throws JSONException {
        boolean plays = false;
        for (int i = 0; i < ops.length(); i += 1) {
            JSONObject op = ops.getJSONObject(i);
            switch (op.getString("op")) {
                case "load": {
                    id = op.optString("id", "");
                    key = op.optString("key", "");
                    endedTold = false;
                    durationMs = 0;
                    takeHeard();
                    gain = (float) op.optDouble("gain", 1);
                    String src = op.optString("src", "");
                    boolean play = op.optBoolean("play", false);
                    if (src.isEmpty()) {
                        exo.stop();
                        exo.clearMediaItems();
                        play = false;
                    } else {
                        exo.setMediaItem(item(id, key, gain, src, op.optJSONObject("meta")), (long) (op.optDouble("at", 0) * 1000));
                        exo.prepare();
                    }
                    exo.setPlaybackSpeed(1f);
                    exo.setPlayWhenReady(play);
                    applyVolume();
                    plays |= play;
                    FlowLog.i("load " + id + " " + redact(src) + (play ? " playing" : ""));
                    break;
                }
                case "next":
                    setNext(op.optJSONArray("items"), op.optBoolean("repeat", false));
                    break;
                case "sleep":
                    sleepAt = (long) op.optDouble("at", 0);
                    sleepFadeMs = Math.max(1, (long) op.optDouble("fade", 10000));
                    main.removeCallbacks(sleepTick);
                    if (sleepAt > 0) {
                        FlowLog.i("sleep timer: stops in " + Math.round((sleepAt - System.currentTimeMillis()) / 1000.0) + " s");
                        sleepCheck();
                    } else if (sleepFade != 1f) {
                        sleepFade = 1f;
                        applyVolume();
                    }
                    break;
                case "unload":
                    exo.stop();
                    exo.clearMediaItems();
                    exo.setPlayWhenReady(false);
                    takeHeard();
                    break;
                case "play":
                    if (exo.getMediaItemCount() == 0) break;
                    // As an <audio> does: an ended song starts again, a failed one is tried again.
                    if (exo.getPlaybackState() == Player.STATE_ENDED) {
                        exo.seekTo(0);
                        endedTold = false;
                    }
                    if (exo.getPlaybackState() == Player.STATE_IDLE) exo.prepare();
                    exo.play();
                    plays = true;
                    break;
                case "pause":
                    exo.pause();
                    break;
                case "seek":
                    exo.seekTo((long) (op.optDouble("t", 0) * 1000));
                    endedTold = false;
                    break;
                case "rate":
                    exo.setPlaybackSpeed((float) op.optDouble("rate", 1));
                    break;
                case "gain":
                    gain = (float) op.optDouble("gain", 1);
                    applyVolume();
                    break;
                case "volume":
                    volume = (float) op.optDouble("volume", 1);
                    applyVolume();
                    break;
                case "meta": {
                    MediaItem current = exo.getCurrentMediaItem();
                    if (current != null) {
                        exo.replaceMediaItem(exo.getCurrentMediaItemIndex(),
                                current.buildUpon().setMediaMetadata(metadata(op.optJSONObject("meta"))).build());
                    }
                    break;
                }
                default:
                    FlowLog.i("unknown operation " + op.getString("op"));
            }
        }
        return plays;
    }

    /**
     * The songs after the one playing, as the page's queue has them; those
     * already in place stay (one being loaded ahead keeps what it has).
     * `repeat`: the song playing over and over instead (Next still leaves it).
     */
    private void setNext(JSONArray items, boolean repeat) throws JSONException {
        exo.setRepeatMode(repeat ? Player.REPEAT_MODE_ONE : Player.REPEAT_MODE_OFF);
        if (items == null || exo.getMediaItemCount() == 0) return;
        int after = exo.getCurrentMediaItemIndex() + 1;
        int have = exo.getMediaItemCount() - after;
        int keep = 0;
        while (keep < have && keep < items.length() && same(exo.getMediaItemAt(after + keep), items.getJSONObject(keep))) keep += 1;
        if (keep < have) exo.removeMediaItems(after + keep, exo.getMediaItemCount());
        List<MediaItem> add = new ArrayList<>();
        for (int i = keep; i < items.length(); i += 1) {
            JSONObject it = items.getJSONObject(i);
            add.add(item(it.optString("id", ""), it.optString("key", ""), (float) it.optDouble("gain", 1),
                    it.optString("src", ""), it.optJSONObject("meta")));
        }
        if (!add.isEmpty()) exo.addMediaItems(add);
    }

    private static boolean same(MediaItem item, JSONObject it) {
        Tag tag = tagOf(item);
        if (tag == null || item.localConfiguration == null) return false;
        return tag.key.equals(it.optString("key", ""))
                && tag.gain == (float) it.optDouble("gain", 1)
                && item.localConfiguration.uri.equals(uriOf(it.optString("src", "")));
    }

    /** On to the next song by itself, by Next, or the same one again (Repeat). */
    private void advanced(MediaItem item, int reason) {
        Tag tag = tagOf(item);
        String from = id;
        String fromKey = key;
        double heard = takeHeard();
        id = tag == null ? "" : tag.id;
        key = tag == null ? "" : tag.key;
        gain = tag == null ? 1f : tag.gain;
        endedTold = false;
        durationMs = 0;
        applyVolume();
        String why = reason == Player.MEDIA_ITEM_TRANSITION_REASON_AUTO ? "auto"
                : reason == Player.MEDIA_ITEM_TRANSITION_REASON_REPEAT ? "repeat" : "next";
        FlowLog.i("on to " + id + " (" + why + "), " + from + " heard " + Math.round(heard) + " s");
        // The songs before it are done with (after this event, not inside it).
        main.post(() -> {
            int at = exo.getCurrentMediaItemIndex();
            if (at > 0) exo.removeMediaItems(0, at);
        });
        if (events != null) events.onAdvance(from, id, key, heard, why);
        else away(fromKey, heard);
    }

    /** A listen while there is no page to record it. */
    private void away(String songKey, double heard) {
        if (songKey.isEmpty() || heard < 1) return;
        try {
            JSONObject l = new JSONObject();
            l.put("key", songKey);
            l.put("heard", heard);
            l.put("at", System.currentTimeMillis());
            heardWhileAway.put(l);
            try (OutputStream out = new FileOutputStream(heardFile)) {
                out.write(heardWhileAway.toString().getBytes(StandardCharsets.UTF_8));
            }
        } catch (JSONException | IOException e) {
            FlowLog.i("could not keep a listen: " + e.getMessage());
        }
    }

    private JSONArray readHeard() {
        try {
            if (heardFile.isFile()) return new JSONArray(new String(Files.readAllBytes(heardFile.toPath()), StandardCharsets.UTF_8));
        } catch (JSONException | IOException e) {
            FlowLog.i("listens kept could not be read: " + e.getMessage());
        }
        return new JSONArray();
    }

    private long heardSoFar() {
        return heardMs + (playingSince >= 0 ? SystemClock.elapsedRealtime() - playingSince : 0);
    }

    /** How long the song playing was heard, in seconds; counting starts again. */
    private double takeHeard() {
        long total = heardSoFar();
        heardMs = 0;
        if (playingSince >= 0) playingSince = SystemClock.elapsedRealtime();
        return total / 1000.0;
    }

    /** { id, key, pwr: play when ready, st: 1 idle 2 buffering 3 ready 4 ended, t, d (-1 unknown), rate, vol (the player's volume), songs (this one and those after it) } */
    JSObject state() {
        JSObject s = new JSObject();
        s.put("id", id);
        s.put("key", key);
        s.put("pwr", exo.getPlayWhenReady());
        s.put("st", exo.getPlaybackState());
        s.put("t", exo.getCurrentPosition() / 1000.0);
        long d = exo.getDuration();
        if (d != C.TIME_UNSET) durationMs = d;
        s.put("d", d == C.TIME_UNSET ? -1 : d / 1000.0);
        s.put("rate", (double) exo.getPlaybackParameters().speed);
        s.put("vol", (double) exo.getVolume());
        s.put("songs", exo.getMediaItemCount() - Math.max(0, exo.getCurrentMediaItemIndex()));
        return s;
    }

    private void tellState() {
        JSObject s = state();
        if (events != null) events.onState(s);
    }

    /** The sleep timer: fading over its last seconds, then the music pauses. */
    private void sleepCheck() {
        if (sleepAt <= 0) return;
        long left = sleepAt - System.currentTimeMillis();
        if (left <= 0) {
            sleepAt = 0;
            exo.pause();
            sleepFade = 1f;
            applyVolume();
            FlowLog.i("sleep timer ran out: paused");
            return;
        }
        float f = left < sleepFadeMs ? (float) left / sleepFadeMs : 1f;
        if (f != sleepFade) {
            sleepFade = f;
            applyVolume();
        }
        // Rarely until the fade, then four times a second.
        main.postDelayed(sleepTick, left > sleepFadeMs + 1000 ? Math.min(left - sleepFadeMs, 30000) : 250);
    }

    /** The app's volume times the song's gain: down by the player's volume, up by the enhancer. */
    private void applyVolume() {
        exo.setVolume(Math.max(0f, Math.min(1f, volume * sleepFade * Math.min(1f, gain))));
        int mb = gain > 1f ? Math.round(2000f * (float) Math.log10(gain)) : 0;
        LoudnessEnhancer e = enhancer();
        if (e == null || mb == boostMb) return;
        try {
            e.setTargetGain(mb);
            e.setEnabled(mb > 0);
            boostMb = mb;
            FlowLog.i("turned up " + (mb / 100.0) + " dB");
        } catch (RuntimeException ex) {
            FlowLog.i("could not turn up: " + ex.getMessage());
        }
    }

    /** The enhancer on the player's sound, made again when that changes; null when the phone has none. */
    private LoudnessEnhancer enhancer() {
        int session = exo.getAudioSessionId();
        if (session == C.AUDIO_SESSION_ID_UNSET) return null;
        if (enhancer != null && enhancerSession == session) return enhancer;
        if (enhancer != null) enhancer.release();
        enhancer = null;
        boostMb = -1;
        try {
            enhancer = new LoudnessEnhancer(session);
            enhancerSession = session;
        } catch (RuntimeException ex) {
            FlowLog.i("no loudness enhancer: " + ex.getMessage());
        }
        return enhancer;
    }

    /** A song's file (a path in the app's storage) or stream (an address). */
    private static Uri uriOf(String src) {
        return src.startsWith("/") ? Uri.fromFile(new File(src)) : Uri.parse(src);
    }

    private static MediaItem item(String itemId, String songKey, float itemGain, String src, JSONObject meta) {
        return new MediaItem.Builder()
                .setMediaId(itemId)
                .setUri(uriOf(src))
                .setTag(new Tag(itemId, songKey, itemGain))
                .setMediaMetadata(metadata(meta))
                .build();
    }

    private static Tag tagOf(MediaItem item) {
        Object tag = item.localConfiguration == null ? null : item.localConfiguration.tag;
        return tag instanceof Tag ? (Tag) tag : null;
    }

    /** What the notification and the lock screen show: { title, artist, album, artwork (a file) }. */
    private static MediaMetadata metadata(JSONObject meta) {
        MediaMetadata.Builder md = new MediaMetadata.Builder();
        if (meta == null) return md.build();
        md.setTitle(meta.optString("title", ""));
        md.setArtist(meta.optString("artist", ""));
        md.setAlbumTitle(meta.optString("album", ""));
        String artwork = meta.optString("artwork", "");
        if (!artwork.isEmpty()) md.setArtworkUri(Uri.fromFile(new File(artwork)));
        return md.build();
    }

    /** An address without the server's token, for the log. */
    private static String redact(String src) {
        return src.replaceAll("([?&]t=)[^&]*", "$1...");
    }

    private static String playReason(int reason) {
        switch (reason) {
            case Player.PLAY_WHEN_READY_CHANGE_REASON_USER_REQUEST: return "asked";
            case Player.PLAY_WHEN_READY_CHANGE_REASON_AUDIO_FOCUS_LOSS: return "audio focus lost";
            case Player.PLAY_WHEN_READY_CHANGE_REASON_AUDIO_BECOMING_NOISY: return "headphones out";
            case Player.PLAY_WHEN_READY_CHANGE_REASON_REMOTE: return "remote";
            case Player.PLAY_WHEN_READY_CHANGE_REASON_END_OF_MEDIA_ITEM: return "end of song";
            default: return "reason " + reason;
        }
    }
}
