package io.github.ceeser1.flow;

import android.content.Context;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;

import androidx.media3.common.AudioAttributes;
import androidx.media3.common.C;
import androidx.media3.common.MediaItem;
import androidx.media3.common.MediaMetadata;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.Player;
import androidx.media3.exoplayer.ExoPlayer;

import com.getcapacitor.JSObject;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;

/**
 * The phone's player: one ExoPlayer for as long as the app's process lives,
 * whether the page is there or not. PlaybackService puts a media session
 * (notification, lock screen, headset buttons) around it; the page drives it
 * through FlowAudio as its audio engine (apps/android/src/engine.js), with
 * lists of operations, and hears back its state.
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
        void onError(String id, String message);
    }

    private static final int TICK_MS = 250;
    private static FlowPlayer instance;

    static FlowPlayer get(Context context) {
        if (instance == null) instance = new FlowPlayer(context.getApplicationContext());
        return instance;
    }

    final ExoPlayer exo;
    private final Handler main = new Handler(Looper.getMainLooper());
    private Events events;
    private String id = "";      // the page's id of the song loaded
    private float volume = 1f;   // the app's volume (the sleep timer's fade)
    private float gain = 1f;     // the song's own (Equalize volume)
    private boolean endedTold;

    // While playing, the place goes to the page four times a second.
    private final Runnable tick = new Runnable() {
        @Override
        public void run() {
            if (!exo.isPlaying()) return;
            tellState();
            main.postDelayed(this, TICK_MS);
        }
    };

    private FlowPlayer(Context context) {
        FlowLog.init(context);
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
                }
                if (ev.contains(Player.EVENT_IS_PLAYING_CHANGED)) {
                    main.removeCallbacks(tick);
                    if (player.isPlaying()) main.postDelayed(tick, TICK_MS);
                }
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
                FlowLog.i("error " + id + " " + text);
                if (events != null) events.onError(id, text);
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
                    endedTold = false;
                    gain = (float) op.optDouble("gain", 1);
                    String src = op.optString("src", "");
                    boolean play = op.optBoolean("play", false);
                    if (src.isEmpty()) {
                        exo.stop();
                        exo.clearMediaItems();
                        play = false;
                    } else {
                        exo.setMediaItem(item(src, op.optJSONObject("meta")), (long) (op.optDouble("at", 0) * 1000));
                        exo.prepare();
                    }
                    exo.setPlaybackSpeed(1f);
                    exo.setPlayWhenReady(play);
                    applyVolume();
                    plays |= play;
                    FlowLog.i("load " + id + " " + redact(src) + (play ? " playing" : ""));
                    break;
                }
                case "unload":
                    exo.stop();
                    exo.clearMediaItems();
                    exo.setPlayWhenReady(false);
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

    /** { id, pwr: play when ready, st: 1 idle 2 buffering 3 ready 4 ended, t, d (-1 unknown), rate } */
    JSObject state() {
        JSObject s = new JSObject();
        s.put("id", id);
        s.put("pwr", exo.getPlayWhenReady());
        s.put("st", exo.getPlaybackState());
        s.put("t", exo.getCurrentPosition() / 1000.0);
        long d = exo.getDuration();
        s.put("d", d == C.TIME_UNSET ? -1 : d / 1000.0);
        s.put("rate", (double) exo.getPlaybackParameters().speed);
        return s;
    }

    private void tellState() {
        if (events != null) events.onState(state());
    }

    // Equalize volume may turn a song up, which a player's volume (at most 1) cannot yet.
    private void applyVolume() {
        exo.setVolume(Math.max(0f, Math.min(1f, volume * gain)));
    }

    /** A song's file (a path in the app's storage) or stream (an address). */
    private MediaItem item(String src, JSONObject meta) {
        Uri uri = src.startsWith("/") ? Uri.fromFile(new File(src)) : Uri.parse(src);
        return new MediaItem.Builder().setMediaId(id).setUri(uri).setMediaMetadata(metadata(meta)).build();
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
