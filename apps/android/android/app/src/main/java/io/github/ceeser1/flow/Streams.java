package io.github.ceeser1.flow;

import android.content.Context;
import android.net.Uri;

import androidx.annotation.OptIn;
import androidx.media3.common.C;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.datasource.DataSpec;
import androidx.media3.datasource.DefaultDataSource;
import androidx.media3.datasource.HttpDataSource;
import androidx.media3.datasource.ResolvingDataSource;
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory;
import androidx.media3.exoplayer.source.MediaSource;
import androidx.media3.exoplayer.upstream.DefaultLoadErrorHandlingPolicy;
import androidx.media3.exoplayer.upstream.LoadErrorHandlingPolicy;

import java.io.IOException;

/**
 * How the players fetch songs from a Flow Server.
 *
 * With the newest token: a song's address carries the token it was made
 * with (?t=), and a server reached from the internet ends a session after a
 * while. Every request (the song playing reads on in pieces, the songs after
 * it start later) goes with the token in use now, whichever address it has:
 * the page's newest (a token it signed in to), or the player's own after it
 * signed in again by itself (ServerSignIn).
 *
 * Patiently: a stream that breaks off (no network, the server away a moment)
 * is tried again and again, at most every RETRY_MAX_MS, for about RETRY_FOR_MS,
 * while the player waits as it would for a slow network (still "playing",
 * kept awake), and carries on where it stopped once the server answers. A
 * refusal (401 signed out, 403, 404) is not waited out: it fails at once.
 * Anything else (a broken file) is tried a few times, as ExoPlayer would.
 */
@OptIn(markerClass = UnstableApi.class)
final class Streams {
    private static final long RETRY_MAX_MS = 10000;
    private static final long RETRY_FOR_MS = 10 * 60 * 1000;
    // Waits of 1, 2, 4, 8 s, then RETRY_MAX_MS each: about RETRY_FOR_MS in all.
    private static final int RETRIES = 4 + (int) ((RETRY_FOR_MS - 15000) / RETRY_MAX_MS);

    // The token every request goes with ('': each address's own).
    private static volatile String token = "";
    // The page's newest, as its addresses carry it: one it sends again (an address
    // made before it took the player's) does not undo the player's own.
    private static String pageToken = "";

    private Streams() {}

    /** The players' songs: fetched with the newest token, a broken stream tried again. */
    static MediaSource.Factory factory(Context context) {
        ResolvingDataSource.Factory sources = new ResolvingDataSource.Factory(
                new DefaultDataSource.Factory(context), Streams::withToken);
        return new DefaultMediaSourceFactory(sources).setLoadErrorHandlingPolicy(new Patience());
    }

    /** An address the page sent: the token in it is the one to use, if the page has a new one. */
    static synchronized void fromPage(String src) {
        String t = tokenOf(src);
        if (t.isEmpty() || t.equals(pageToken)) return;
        pageToken = t;
        token = t;
    }

    /** The player signed in again itself. */
    static synchronized void signedIn(String t) {
        token = t;
    }

    /** A Flow Server's address of a song's sound ("https://host/flow/api/songs/<id>/audio?t=..."): the server's, else "". */
    static String baseOf(Uri uri) {
        if (uri == null) return "";
        String s = uri.toString();
        int at = s.indexOf("/api/songs/");
        if (at <= 0 || !(s.startsWith("http://") || s.startsWith("https://"))) return "";
        return s.substring(0, at);
    }

    private static String tokenOf(String src) {
        if (src == null || !(src.startsWith("http://") || src.startsWith("https://"))) return "";
        String t = Uri.parse(src).getQueryParameter("t");
        return t == null ? "" : t;
    }

    private static DataSpec withToken(DataSpec spec) {
        String t = token;
        if (t.isEmpty()) return spec;
        Uri uri = spec.uri;
        if (baseOf(uri).isEmpty()) return spec;
        String old = uri.getQueryParameter("t");
        if (old == null || old.equals(t)) return spec;
        return spec.withUri(Uri.parse(uri.toString().replaceFirst("([?&]t=)[^&]*", "$1" + Uri.encode(t))));
    }

    /** A broken stream tried again for a while; a refusal not. */
    private static final class Patience extends DefaultLoadErrorHandlingPolicy {
        @Override
        public long getRetryDelayMsFor(LoadErrorHandlingPolicy.LoadErrorInfo info) {
            IOException e = info.exception;
            int n = info.errorCount;
            if (!passing(e)) {
                // A refusal fails at once; anything else as ExoPlayer would, a few tries.
                if (e instanceof HttpDataSource.InvalidResponseCodeException || n > DEFAULT_MIN_LOADABLE_RETRY_COUNT) return C.TIME_UNSET;
                return super.getRetryDelayMsFor(info);
            }
            if (n > RETRIES) {
                FlowLog.i("stream given up after " + n + " tries: " + e);
                return C.TIME_UNSET;
            }
            if (n == 1) FlowLog.i("stream broke off (" + e + "), trying again");
            return n <= 4 ? 1000L << (n - 1) : RETRY_MAX_MS;
        }

        @Override
        public int getMinimumLoadableRetryCount(int dataType) {
            // The player waits rather than fails while a stream is tried again.
            return Integer.MAX_VALUE;
        }

        /** Whether this may pass: no network or no server for a moment, not the server saying no. */
        private static boolean passing(IOException e) {
            if (e instanceof HttpDataSource.InvalidResponseCodeException) {
                int code = ((HttpDataSource.InvalidResponseCodeException) e).responseCode;
                // A server busy or away behind its proxy (502-504), or one that asked to wait.
                return code >= 500 || code == 408 || code == 429;
            }
            if (!(e instanceof HttpDataSource.HttpDataSourceException)) return false;
            int reason = ((HttpDataSource.HttpDataSourceException) e).reason;
            return reason == PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_FAILED
                    || reason == PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_TIMEOUT;
        }
    }
}
