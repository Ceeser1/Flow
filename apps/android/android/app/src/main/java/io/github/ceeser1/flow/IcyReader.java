package io.github.ceeser1.flow;

import android.net.Uri;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.annotation.OptIn;
import androidx.media3.common.C;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.datasource.DataSource;
import androidx.media3.datasource.DataSpec;
import androidx.media3.datasource.TransferListener;

import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.CharBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.Charset;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * What an Internet Radio station plays (5.3.1), read from its stream: a
 * station asked for it (Icy-MetaData: 1, which ExoPlayer asks for itself)
 * mixes a block of text into the sound every icy-metaint bytes, whose
 * StreamTitle is the song ("Artist - Title"). This takes the blocks out
 * before the player sees them and tells each new title (listener, on the
 * loader's thread), as core radioStream.js does for the computer.
 *
 * ExoPlayer would read them itself (its IcyDataSource), but then put the
 * song in the place of the notification's title, the station's name; so the
 * player is not told that the stream has them (icy-metaint is left out of
 * the answer's headers). On every connection the listener first hears
 * whether the station tells what it plays at all (meta).
 */
@OptIn(markerClass = UnstableApi.class)
final class IcyReader implements DataSource {
    interface Listener {
        /** `meta`: the station tells what it plays; `title`: what that is now ('' none). */
        void onSongInfo(boolean meta, String title);
    }

    static final class Factory implements DataSource.Factory {
        private final DataSource.Factory upstream;
        private final Listener listener;

        Factory(DataSource.Factory upstream, Listener listener) {
            this.upstream = upstream;
            this.listener = listener;
        }

        @NonNull
        @Override
        public DataSource createDataSource() {
            return new IcyReader(upstream.createDataSource(), listener);
        }
    }

    private static final Pattern TITLE = Pattern.compile("StreamTitle='(.*?)';(?=\\s*(?:[A-Za-z]+=|$))", Pattern.DOTALL);
    private static final Pattern TITLE_LAST = Pattern.compile("StreamTitle='(.*)'?;?\\s*$", Pattern.DOTALL);
    private static final int TITLE_MAX = 300;

    private final DataSource upstream;
    private final Listener listener;
    private final byte[] one = new byte[1];
    private int metaint;
    private int left;
    @Nullable private String last;

    private IcyReader(DataSource upstream, Listener listener) {
        this.upstream = upstream;
        this.listener = listener;
    }

    @Override
    public void addTransferListener(@NonNull TransferListener transferListener) {
        upstream.addTransferListener(transferListener);
    }

    @Override
    public long open(@NonNull DataSpec spec) throws IOException {
        long length = upstream.open(spec);
        metaint = 0;
        String value = header(upstream.getResponseHeaders(), "icy-metaint");
        if (value != null) {
            try {
                metaint = Math.max(0, Integer.parseInt(value.trim()));
            } catch (NumberFormatException e) {
                metaint = 0;
            }
        }
        left = metaint;
        last = null;
        listener.onSongInfo(metaint > 0, "");
        return length;
    }

    @Override
    public int read(@NonNull byte[] buffer, int offset, int length) throws IOException {
        if (length == 0) return 0;
        if (metaint <= 0) return upstream.read(buffer, offset, length);
        if (left == 0) {
            if (!readBlock()) return C.RESULT_END_OF_INPUT;
            left = metaint;
        }
        int n = upstream.read(buffer, offset, Math.min(length, left));
        if (n > 0) left -= n;
        return n;
    }

    /** The metadata block where the sound pauses for it; false: the stream ended. */
    private boolean readBlock() throws IOException {
        if (readFully(one, 1) < 1) return false;
        int size = (one[0] & 0xFF) * 16;
        if (size == 0) return true;
        byte[] block = new byte[size];
        if (readFully(block, size) < size) return false;
        String title = titleOf(block);
        if (title != null && !title.equals(last)) {
            last = title;
            listener.onSongInfo(true, title);
        }
        return true;
    }

    private int readFully(byte[] into, int length) throws IOException {
        int got = 0;
        while (got < length) {
            int n = upstream.read(into, got, length - got);
            if (n == C.RESULT_END_OF_INPUT) break;
            got += n;
        }
        return got;
    }

    /** A block's StreamTitle, cleaned ('' for an empty one); null when it has none. */
    static String titleOf(byte[] block) {
        String text = decode(block).replaceAll("\u0000+$", "");
        Matcher m = TITLE.matcher(text);
        if (!m.find()) {
            m = TITLE_LAST.matcher(text);
            if (!m.find()) return null;
        }
        String t = m.group(1).replaceAll("[\\u0000-\\u001f]+", " ").replaceAll("\\s+", " ").trim();
        if (t.matches("^[-\\u2013\\u2014|.:\\s]*$")) return "";
        return t.length() > TITLE_MAX ? t.substring(0, TITLE_MAX) : t;
    }

    /** UTF-8 when it is that, else Windows-1252 (as most older stations send). */
    private static String decode(byte[] bytes) {
        try {
            CharBuffer chars = StandardCharsets.UTF_8.newDecoder()
                    .onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT)
                    .decode(ByteBuffer.wrap(bytes));
            return chars.toString();
        } catch (CharacterCodingException e) {
            try {
                return new String(bytes, Charset.forName("windows-1252"));
            } catch (RuntimeException unknown) {
                return new String(bytes, StandardCharsets.ISO_8859_1);
            }
        }
    }

    @Nullable
    private static String header(Map<String, List<String>> headers, String name) {
        for (Map.Entry<String, List<String>> e : headers.entrySet()) {
            if (e.getKey() != null && e.getKey().equalsIgnoreCase(name) && e.getValue() != null && !e.getValue().isEmpty()) return e.getValue().get(0);
        }
        return null;
    }

    @Nullable
    @Override
    public Uri getUri() {
        return upstream.getUri();
    }

    /** The answer's headers, but icy-metaint: the player must not read the blocks again (see the top). */
    @NonNull
    @Override
    public Map<String, List<String>> getResponseHeaders() {
        Map<String, List<String>> out = new HashMap<>();
        for (Map.Entry<String, List<String>> e : upstream.getResponseHeaders().entrySet()) {
            if (e.getKey() != null && e.getKey().equalsIgnoreCase("icy-metaint")) continue;
            out.put(e.getKey(), e.getValue());
        }
        return out;
    }

    @Override
    public void close() throws IOException {
        upstream.close();
    }
}
