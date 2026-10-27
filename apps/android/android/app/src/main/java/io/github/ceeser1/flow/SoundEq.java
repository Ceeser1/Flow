package io.github.ceeser1.flow;

import android.annotation.SuppressLint;
import android.media.AudioManager;
import android.media.audiofx.DynamicsProcessing;
import android.os.Build;

import androidx.annotation.RequiresApi;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Settings' Equalizer on one player's sound (FlowPlayer's, and the tail's
 * during a song transition): Android's DynamicsProcessing, its pre-EQ given
 * the curve the page drew, read at 128 frequencies (soundEq.js sampled), each
 * band from halfway to the one before to halfway to the next. While the curve
 * raises a band its limiter catches the peaks (as the desktop's does: -2 dB,
 * 20:1, 2 ms, 150 ms). A flat curve: no effect at all.
 *
 * Android 9 and newer; before, it does nothing (the page offers no Equalizer
 * there).
 */
final class SoundEq {
    /** The curve: dB at each frequency (Hz), rising; none for flat. */
    static final class Curve {
        final float[] hz;
        final float[] db;

        Curve(float[] hz, float[] db) {
            this.hz = hz;
            this.db = db;
        }

        static final Curve FLAT = new Curve(new float[0], new float[0]);

        boolean flat() {
            for (float d : db) if (d != 0f) return false;
            return true;
        }

        boolean boosts() {
            for (float d : db) if (d > 0f) return true;
            return false;
        }

        /** From the page's { hz, db } (or the file's); FLAT for anything else. */
        static Curve of(JSONObject o) {
            if (o == null) return FLAT;
            JSONArray h = o.optJSONArray("hz");
            JSONArray d = o.optJSONArray("db");
            if (h == null || d == null || h.length() != d.length() || h.length() < 2) return FLAT;
            float[] hz = new float[h.length()];
            float[] db = new float[d.length()];
            for (int i = 0; i < hz.length; i += 1) {
                hz[i] = (float) h.optDouble(i, 0);
                db[i] = (float) Math.max(-24, Math.min(24, d.optDouble(i, 0)));
                if (!(hz[i] > 0) || (i > 0 && hz[i] <= hz[i - 1]) || Float.isNaN(db[i])) return FLAT;
            }
            return new Curve(hz, db);
        }

        JSONObject toJson() throws JSONException {
            JSONArray h = new JSONArray();
            JSONArray d = new JSONArray();
            for (int i = 0; i < hz.length; i += 1) {
                h.put(Math.round(hz[i] * 10) / 10.0);
                d.put(Math.round(db[i] * 100) / 100.0);
            }
            return new JSONObject().put("hz", h).put("db", d);
        }
    }

    private final String name;   // whose sound, for the log
    private DynamicsProcessing dp;
    private int session = AudioManager.AUDIO_SESSION_ID_GENERATE;
    private int bands = 0;

    SoundEq(String name) {
        this.name = name;
    }

    /** The curve on this audio session (made again when the session or the number of bands changed). */
    void apply(int audioSession, Curve curve) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.P) return;
        if (curve.flat() || audioSession == AudioManager.AUDIO_SESSION_ID_GENERATE) {
            release();
            return;
        }
        int n = curve.hz.length;
        try {
            if (dp == null || session != audioSession || bands != n) {
                release();
                dp = make(audioSession, curve);
                session = audioSession;
                bands = n;
                dp.setEnabled(true);
                FlowLog.i("sound equalizer on the " + name + " (" + n + " bands)");
                return;
            }
            float[] cut = cutoffs(curve.hz);
            for (int i = 0; i < n; i += 1) dp.setPreEqBandAllChannelsTo(i, new DynamicsProcessing.EqBand(true, cut[i], curve.db[i]));
            dp.setLimiterAllChannelsTo(limiter(curve.boosts()));
        } catch (RuntimeException e) {
            FlowLog.i("no sound equalizer on the " + name + ": " + e.getMessage());
            release();
        }
    }

    // Only ever made on Android 9 and newer (apply).
    @SuppressLint("NewApi")
    void release() {
        if (dp == null) return;
        try {
            dp.release();
        } catch (RuntimeException ignored) {
            // Gone already.
        }
        dp = null;
        session = AudioManager.AUDIO_SESSION_ID_GENERATE;
        bands = 0;
        FlowLog.i("sound equalizer off the " + name);
    }

    @RequiresApi(Build.VERSION_CODES.P)
    private static DynamicsProcessing make(int audioSession, Curve curve) {
        int n = curve.hz.length;
        DynamicsProcessing.Config.Builder b = new DynamicsProcessing.Config.Builder(
                DynamicsProcessing.VARIANT_FAVOR_FREQUENCY_RESOLUTION, 2,
                true, n, false, 0, false, 0, true);
        DynamicsProcessing.Eq eq = new DynamicsProcessing.Eq(true, true, n);
        float[] cut = cutoffs(curve.hz);
        for (int i = 0; i < n; i += 1) eq.setBand(i, new DynamicsProcessing.EqBand(true, cut[i], curve.db[i]));
        b.setPreEqAllChannelsTo(eq);
        b.setLimiterAllChannelsTo(limiter(curve.boosts()));
        return new DynamicsProcessing(0, audioSession, b.build());
    }

    @RequiresApi(Build.VERSION_CODES.P)
    private static DynamicsProcessing.Limiter limiter(boolean on) {
        return new DynamicsProcessing.Limiter(true, on, 0, 2f, 150f, 20f, -2f, 0f);
    }

    /** Each band's top: halfway (on the log scale) to the next frequency, the last one past all hearing. */
    private static float[] cutoffs(float[] hz) {
        float[] cut = new float[hz.length];
        for (int i = 0; i < hz.length - 1; i += 1) cut[i] = (float) Math.sqrt(hz[i] * (double) hz[i + 1]);
        cut[hz.length - 1] = 24000f;
        return cut;
    }
}
