package io.github.ceeser1.flow;

import android.app.Activity;
import android.content.ContentResolver;
import android.content.Context;
import android.content.Intent;
import android.database.Cursor;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.media.AudioAttributes;
import android.media.AudioDeviceCallback;
import android.media.AudioDeviceInfo;
import android.media.AudioManager;
import android.media.MediaMetadataRetriever;
import android.media.MediaRoute2Info;
import android.media.MediaRouter2;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.provider.DocumentsContract;
import android.provider.OpenableColumns;
import android.provider.Settings;

import androidx.activity.OnBackPressedCallback;
import androidx.activity.result.ActivityResult;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.HttpURLConnection;
import java.net.InetAddress;
import java.net.InterfaceAddress;
import java.net.NetworkInterface;
import java.net.SocketTimeoutException;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.Iterator;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * What the page asks of the phone that takes a while, as window.flow's Android
 * shim (apps/android/src) calls it: a server's file saved straight to storage,
 * Flow Servers looked for on the network, a link opened. It also puts
 * window.FlowSync (FlowSync.java) into the page before it loads, and hands the
 * Back button to the page ("back"), which closes what is open or, with nothing
 * left, calls leave(). Where the sound comes out: output() names it,
 * chooseOutput() opens Android's own chooser, "outputChanged" says it changed.
 * Songs of the phone's own: pickAudio() lets the user pick files or a folder,
 * importAudio() copies one into Flow's storage and reads its names and cover,
 * upload() sends a file to a server.
 */
@CapacitorPlugin(name = "FlowNative")
public class FlowNative extends Plugin {
    private static final int DISCOVERY_PORT = 7878;
    private static final byte[] DISCOVER = "{\"app\":\"flow-discover\",\"v\":1}".getBytes(StandardCharsets.UTF_8);
    // What Flow plays as it is (@flow/core/formats AUDIO_EXTS); no ffmpeg on the phone to make anything else playable.
    private static final List<String> AUDIO_EXTS = Arrays.asList("mp3", "m4a", "aac", "opus", "ogg", "oga", "flac", "wav");
    // A folder is looked through for at most this many songs (as the desktop's localScan MAX_FILES).
    private static final int MAX_FILES = 2000;
    // Covers are squares this big (@flow/core/cover SIZE).
    private static final int COVER_SIZE = 512;

    private final ExecutorService work = Executors.newCachedThreadPool();

    @Override
    public void load() {
        // Before the page loads (Capacitor loads it after its plugins), so it is there from the start.
        bridge.getWebView().addJavascriptInterface(new FlowSync(getContext()), "FlowSync");
        getActivity().getOnBackPressedDispatcher().addCallback(getActivity(), new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                // Nobody listening (the page did not start): Back leaves, as it would.
                if (hasListeners("back")) notifyListeners("back", new JSObject());
                else getActivity().moveTaskToBack(true);
            }
        });
        audioManager().registerAudioDeviceCallback(new AudioDeviceCallback() {
            @Override
            public void onAudioDevicesAdded(AudioDeviceInfo[] added) {
                notifyListeners("outputChanged", new JSObject());
            }

            @Override
            public void onAudioDevicesRemoved(AudioDeviceInfo[] removed) {
                notifyListeners("outputChanged", new JSObject());
            }
        }, new Handler(Looper.getMainLooper()));
    }

    private AudioManager audioManager() {
        return (AudioManager) getContext().getSystemService(Context.AUDIO_SERVICE);
    }

    /** Where music comes out now: { name } (this phone, headphones, a Bluetooth device's own name). */
    @PluginMethod
    public void output(PluginCall call) {
        String name = "";
        if (Build.VERSION.SDK_INT >= 33) {
            AudioAttributes media = new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).build();
            List<AudioDeviceInfo> devices = audioManager().getAudioDevicesForAttributes(media);
            if (!devices.isEmpty()) name = deviceName(devices.get(0));
        }
        if (name.isEmpty() && Build.VERSION.SDK_INT >= 30) {
            try {
                List<MediaRoute2Info> routes = MediaRouter2.getInstance(getContext()).getSystemController().getSelectedRoutes();
                if (!routes.isEmpty()) name = String.valueOf(routes.get(0).getName());
            } catch (RuntimeException ignored) {
                // Named below.
            }
        }
        JSObject r = new JSObject();
        r.put("name", name.isEmpty() ? "This phone" : name);
        call.resolve(r);
    }

    private static String deviceName(AudioDeviceInfo d) {
        switch (d.getType()) {
            case AudioDeviceInfo.TYPE_BUILTIN_SPEAKER:
            case AudioDeviceInfo.TYPE_BUILTIN_EARPIECE:
                return "This phone";
            case AudioDeviceInfo.TYPE_WIRED_HEADPHONES:
            case AudioDeviceInfo.TYPE_WIRED_HEADSET:
                return "Headphones";
            default: {
                CharSequence product = d.getProductName();
                return product == null ? "" : product.toString();
            }
        }
    }

    /**
     * Android's own chooser of where the sound comes out (this phone,
     * headphones, Bluetooth, a speaker on the network): the output switcher
     * (Android 14 and later), else the media output panel, else the Bluetooth
     * settings. Resolves { shown }.
     */
    @PluginMethod
    public void chooseOutput(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            boolean shown = false;
            if (Build.VERSION.SDK_INT >= 34) {
                try {
                    shown = MediaRouter2.getInstance(getContext()).showSystemOutputSwitcher();
                } catch (RuntimeException ignored) {
                    // The panel below.
                }
            }
            if (!shown && Build.VERSION.SDK_INT >= 30) {
                shown = start(new Intent("com.android.settings.panel.action.MEDIA_OUTPUT")
                        .putExtra("com.android.settings.panel.extra.PACKAGE_NAME", getContext().getPackageName()));
            }
            if (!shown) shown = start(new Intent(Settings.ACTION_BLUETOOTH_SETTINGS));
            JSObject r = new JSObject();
            r.put("shown", shown);
            call.resolve(r);
        });
    }

    private boolean start(Intent intent) {
        try {
            getActivity().startActivity(intent);
            return true;
        } catch (RuntimeException e) {
            return false;
        }
    }

    /** Back with nothing left to close: Flow goes to the background, playing on. */
    @PluginMethod
    public void leave(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            getActivity().moveTaskToBack(true);
            call.resolve();
        });
    }

    /** A link opened outside the app (the browser, YouTube). Web links only. */
    @PluginMethod
    public void openUrl(PluginCall call) {
        String url = call.getString("url", "");
        if (!url.startsWith("https://") && !url.startsWith("http://")) {
            call.reject("Only web links open from Flow.");
            return;
        }
        try {
            Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            call.resolve();
        } catch (Exception e) {
            call.reject("No app opens that link.");
        }
    }

    /**
     * GET `url` into the file `path` (in the app's storage), with `headers`.
     * Resolves { status, bytes } for 200; any other answer { status, text }
     * and no file. Unreachable, timed out or cut off: rejected with code OFFLINE.
     * Progress goes out as "downloadProgress" { id, frac } when `id` is given.
     */
    @PluginMethod
    public void download(PluginCall call) {
        String url = call.getString("url", "");
        String path = call.getString("path", "");
        String id = call.getString("id", "");
        int timeout = call.getInt("timeout", 30000);
        JSObject headers = call.getObject("headers", new JSObject());
        work.execute(() -> {
            HttpURLConnection conn = null;
            File dest = null;
            try {
                dest = new File(path).getCanonicalFile();
                File files = getContext().getFilesDir().getCanonicalFile();
                File cache = getContext().getCacheDir().getCanonicalFile();
                if (!dest.getPath().startsWith(files.getPath() + File.separator) && !dest.getPath().startsWith(cache.getPath() + File.separator)) {
                    call.reject("Not one of Flow's files: " + path);
                    return;
                }
                conn = (HttpURLConnection) new URL(url).openConnection();
                conn.setConnectTimeout(timeout);
                conn.setReadTimeout(timeout);
                for (Iterator<String> it = headers.keys(); it.hasNext(); ) {
                    String k = it.next();
                    conn.setRequestProperty(k, headers.getString(k));
                }
                int status = conn.getResponseCode();
                JSObject result = new JSObject();
                result.put("status", status);
                if (status != 200) {
                    InputStream err = conn.getErrorStream();
                    result.put("text", err == null ? "" : readAll(err));
                    call.resolve(result);
                    return;
                }
                long total = conn.getContentLengthLong();
                long got = 0;
                long told = 0;
                File dir = dest.getParentFile();
                if (dir != null && !dir.isDirectory()) dir.mkdirs();
                try (InputStream in = conn.getInputStream(); OutputStream out = new FileOutputStream(dest)) {
                    byte[] buf = new byte[65536];
                    int n;
                    while ((n = in.read(buf)) > 0) {
                        out.write(buf, 0, n);
                        got += n;
                        if (!id.isEmpty() && total > 0 && (got - told > total / 50 || got == total)) {
                            told = got;
                            JSObject p = new JSObject();
                            p.put("id", id);
                            p.put("frac", (double) got / total);
                            notifyListeners("downloadProgress", p);
                        }
                    }
                }
                if (total > 0 && got != total) {
                    dest.delete();
                    call.reject("The download was cut off.", "OFFLINE");
                    return;
                }
                result.put("bytes", got);
                call.resolve(result);
            } catch (SocketTimeoutException e) {
                if (dest != null) dest.delete();
                call.reject("The server did not answer in time.", "OFFLINE");
            } catch (IOException e) {
                if (dest != null) dest.delete();
                call.reject(e.getMessage() == null ? "The connection failed." : e.getMessage(), "OFFLINE");
            } catch (Exception e) {
                if (dest != null) dest.delete();
                call.reject(e.getMessage() == null ? "The download failed." : e.getMessage());
            } finally {
                if (conn != null) conn.disconnect();
            }
        });
    }

    private static String readAll(InputStream in) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = in.read(buf)) > 0 && out.size() < 65536) out.write(buf, 0, n);
        in.close();
        return out.toString("UTF-8");
    }

    /**
     * Asks the local network who is a Flow Server (@flow/core/discovery: the
     * question on UDP port 7878, each server answering the asker). Resolves
     * { answers: [{ address, text }], own: [this phone's addresses] } after
     * `timeout` ms; the page reads the answers. Never rejects.
     */
    @PluginMethod
    public void discover(PluginCall call) {
        int timeout = call.getInt("timeout", 2500);
        int sends = call.getInt("sends", 3);
        work.execute(() -> {
            JSArray answers = new JSArray();
            JSArray own = new JSArray();
            Set<InetAddress> targets = new LinkedHashSet<>();
            try {
                targets.add(InetAddress.getByName("255.255.255.255"));
                for (NetworkInterface ni : Collections.list(NetworkInterface.getNetworkInterfaces())) {
                    if (!ni.isUp() || ni.isLoopback()) continue;
                    for (InterfaceAddress a : ni.getInterfaceAddresses()) {
                        if (a.getAddress() == null || a.getAddress().getAddress().length != 4) continue;
                        own.put(a.getAddress().getHostAddress());
                        if (a.getBroadcast() != null) targets.add(a.getBroadcast());
                    }
                }
            } catch (Exception e) {
                // No network: nothing will answer.
            }
            try (DatagramSocket socket = new DatagramSocket()) {
                socket.setBroadcast(true);
                socket.setSoTimeout(150);
                long start = System.currentTimeMillis();
                long end = start + timeout;
                int sent = 0;
                byte[] buf = new byte[2048];
                while (System.currentTimeMillis() < end) {
                    // The question a few times, spread over the first part: a datagram can get lost.
                    if (sent < sends && System.currentTimeMillis() >= start + (long) sent * 400) {
                        for (InetAddress t : targets) {
                            try {
                                socket.send(new DatagramPacket(DISCOVER, DISCOVER.length, t, DISCOVERY_PORT));
                            } catch (IOException e) {
                                // That network refuses broadcasts; the others may not.
                            }
                        }
                        sent += 1;
                    }
                    DatagramPacket packet = new DatagramPacket(buf, buf.length);
                    try {
                        socket.receive(packet);
                    } catch (SocketTimeoutException e) {
                        continue;
                    }
                    if (packet.getLength() > 1024) continue;
                    JSObject a = new JSObject();
                    a.put("address", packet.getAddress().getHostAddress());
                    a.put("text", new String(packet.getData(), 0, packet.getLength(), StandardCharsets.UTF_8));
                    answers.put(a);
                }
            } catch (Exception e) {
                // No socket: none found.
            }
            JSObject result = new JSObject();
            result.put("answers", answers);
            result.put("own", own);
            call.resolve(result);
        });
    }

    // ---- songs of the phone's own ----

    /**
     * Android's picker: audio files (several), or with `folder` a folder, looked
     * through for audio files (at most MAX_FILES). Resolves { items: [{ uri,
     * name, size }], name (the folder's), truncated }, or { cancelled: true }.
     */
    @PluginMethod
    public void pickAudio(PluginCall call) {
        Intent intent;
        if (call.getBoolean("folder", false)) {
            intent = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
            startActivityForResult(call, intent, "pickedFolder");
        } else {
            intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
            intent.addCategory(Intent.CATEGORY_OPENABLE);
            intent.setType("audio/*");
            intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
            startActivityForResult(call, intent, "pickedFiles");
        }
    }

    private static JSObject cancelledPick() {
        JSObject r = new JSObject();
        r.put("cancelled", true);
        return r;
    }

    @ActivityCallback
    private void pickedFiles(PluginCall call, ActivityResult result) {
        if (call == null) return;
        Intent data = result.getData();
        if (result.getResultCode() != Activity.RESULT_OK || data == null) {
            call.resolve(cancelledPick());
            return;
        }
        List<Uri> uris = new ArrayList<>();
        if (data.getClipData() != null) {
            for (int i = 0; i < data.getClipData().getItemCount(); i++) uris.add(data.getClipData().getItemAt(i).getUri());
        } else if (data.getData() != null) {
            uris.add(data.getData());
        }
        work.execute(() -> {
            JSArray items = new JSArray();
            ContentResolver cr = getContext().getContentResolver();
            for (Uri uri : uris) {
                String name = "";
                long size = -1;
                try (Cursor c = cr.query(uri, new String[] { OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE }, null, null, null)) {
                    if (c != null && c.moveToFirst()) {
                        name = c.isNull(0) ? "" : c.getString(0);
                        size = c.isNull(1) ? -1 : c.getLong(1);
                    }
                } catch (RuntimeException e) {
                    // Named by its address below.
                }
                JSObject it = new JSObject();
                it.put("uri", uri.toString());
                it.put("name", name.isEmpty() ? uri.getLastPathSegment() : name);
                it.put("size", size);
                items.put(it);
            }
            JSObject r = new JSObject();
            r.put("items", items);
            r.put("name", "");
            r.put("truncated", false);
            call.resolve(r);
        });
    }

    @ActivityCallback
    private void pickedFolder(PluginCall call, ActivityResult result) {
        if (call == null) return;
        Intent data = result.getData();
        if (result.getResultCode() != Activity.RESULT_OK || data == null || data.getData() == null) {
            call.resolve(cancelledPick());
            return;
        }
        Uri tree = data.getData();
        work.execute(() -> {
            JSArray items = new JSArray();
            boolean[] truncated = { false };
            String rootId = DocumentsContract.getTreeDocumentId(tree);
            String name = "";
            try (Cursor c = getContext().getContentResolver().query(DocumentsContract.buildDocumentUriUsingTree(tree, rootId),
                    new String[] { DocumentsContract.Document.COLUMN_DISPLAY_NAME }, null, null, null)) {
                if (c != null && c.moveToFirst() && !c.isNull(0)) name = c.getString(0);
            } catch (RuntimeException e) {
                // Unnamed.
            }
            walk(tree, rootId, items, truncated, 0);
            JSObject r = new JSObject();
            r.put("items", items);
            r.put("name", name);
            r.put("truncated", truncated[0]);
            call.resolve(r);
        });
    }

    /** The audio files in a picked folder, then those of the folders in it, A to Z within each. */
    private void walk(Uri tree, String parentId, JSArray items, boolean[] truncated, int depth) {
        if (depth > 12 || truncated[0]) return;
        List<String[]> dirs = new ArrayList<>();
        List<JSObject> found = new ArrayList<>();
        String[] cols = {
            DocumentsContract.Document.COLUMN_DOCUMENT_ID, DocumentsContract.Document.COLUMN_DISPLAY_NAME,
            DocumentsContract.Document.COLUMN_MIME_TYPE, DocumentsContract.Document.COLUMN_SIZE,
        };
        try (Cursor c = getContext().getContentResolver().query(DocumentsContract.buildChildDocumentsUriUsingTree(tree, parentId), cols, null, null, null)) {
            while (c != null && c.moveToNext()) {
                String id = c.getString(0);
                String name = c.isNull(1) ? "" : c.getString(1);
                String mime = c.isNull(2) ? "" : c.getString(2);
                if (DocumentsContract.Document.MIME_TYPE_DIR.equals(mime)) {
                    if (!name.startsWith(".")) dirs.add(new String[] { id, name });
                    continue;
                }
                if (!AUDIO_EXTS.contains(extOf(name))) continue;
                JSObject it = new JSObject();
                it.put("uri", DocumentsContract.buildDocumentUriUsingTree(tree, id).toString());
                it.put("name", name);
                it.put("size", c.isNull(3) ? -1 : c.getLong(3));
                found.add(it);
            }
        } catch (RuntimeException e) {
            return;
        }
        found.sort((a, b) -> a.getString("name", "").compareToIgnoreCase(b.getString("name", "")));
        for (JSObject it : found) {
            if (items.length() >= MAX_FILES) {
                truncated[0] = true;
                return;
            }
            items.put(it);
        }
        dirs.sort((a, b) -> a[1].compareToIgnoreCase(b[1]));
        for (String[] d : dirs) walk(tree, d[0], items, truncated, depth + 1);
    }

    private static String extOf(String name) {
        int i = name.lastIndexOf('.');
        return i <= 0 ? "" : name.substring(i + 1).toLowerCase(Locale.ROOT);
    }

    /** The kind of file by its type, for a picked file whose name says nothing. */
    private static String extOfMime(String mime) {
        switch (mime == null ? "" : mime.toLowerCase(Locale.ROOT)) {
            case "audio/mpeg": case "audio/mp3": return "mp3";
            case "audio/mp4": case "audio/x-m4a": case "audio/m4a": return "m4a";
            case "audio/aac": case "audio/aacp": return "aac";
            case "audio/flac": case "audio/x-flac": return "flac";
            case "audio/ogg": case "application/ogg": return "ogg";
            case "audio/opus": return "opus";
            case "audio/wav": case "audio/x-wav": case "audio/wave": return "wav";
            default: return "";
        }
    }

    /** True for a file in Flow's own storage (its files or its cache). */
    private boolean ours(File f) throws IOException {
        String p = f.getCanonicalPath();
        String files = getContext().getFilesDir().getCanonicalPath() + File.separator;
        String cache = getContext().getCacheDir().getCanonicalPath() + File.separator;
        return p.startsWith(files) || p.startsWith(cache);
    }

    /**
     * A picked file (`uri`) copied to `stem` + its extension in Flow's storage,
     * with what its tags say, and its picture (when it has one) as a square
     * JPEG at `cover`. Resolves { path, format, title, artist, album,
     * duration (s), cover (true when written), bytes }. A file that is no
     * audio, or of a kind Flow cannot play, is refused and not kept.
     */
    @PluginMethod
    public void importAudio(PluginCall call) {
        String uri = call.getString("uri", "");
        String stem = call.getString("stem", "");
        String coverPath = call.getString("cover", "");
        work.execute(() -> {
            File dest = null;
            try {
                ContentResolver cr = getContext().getContentResolver();
                Uri u = Uri.parse(uri);
                String name = "";
                try (Cursor c = cr.query(u, new String[] { OpenableColumns.DISPLAY_NAME }, null, null, null)) {
                    if (c != null && c.moveToFirst() && !c.isNull(0)) name = c.getString(0);
                } catch (RuntimeException e) {
                    // By its type below.
                }
                String ext = extOf(name);
                if (!AUDIO_EXTS.contains(ext)) ext = extOfMime(cr.getType(u));
                if (ext.isEmpty()) {
                    call.reject("Flow cannot play this kind of file on the phone (MP3, M4A, AAC, Opus, Ogg, FLAC and WAV play).");
                    return;
                }
                dest = new File(stem + "." + ext);
                if (!ours(dest)) {
                    call.reject("Not one of Flow's files: " + stem);
                    return;
                }
                File dir = dest.getParentFile();
                if (dir != null && !dir.isDirectory()) dir.mkdirs();
                long bytes = 0;
                try (InputStream in = cr.openInputStream(u); OutputStream out = new FileOutputStream(dest)) {
                    if (in == null) throw new IOException("The file could not be opened.");
                    byte[] buf = new byte[65536];
                    int n;
                    while ((n = in.read(buf)) > 0) {
                        out.write(buf, 0, n);
                        bytes += n;
                    }
                }
                JSObject r = new JSObject();
                MediaMetadataRetriever mmr = new MediaMetadataRetriever();
                try {
                    mmr.setDataSource(dest.getPath());
                    String hasAudio = mmr.extractMetadata(MediaMetadataRetriever.METADATA_KEY_HAS_AUDIO);
                    String ms = mmr.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION);
                    double duration = ms == null ? 0 : Long.parseLong(ms) / 1000.0;
                    if ("no".equals(hasAudio) || duration <= 0) throw new IOException("This file has no audio in it.");
                    r.put("duration", duration);
                    r.put("title", text(mmr.extractMetadata(MediaMetadataRetriever.METADATA_KEY_TITLE)));
                    String artist = text(mmr.extractMetadata(MediaMetadataRetriever.METADATA_KEY_ARTIST));
                    if (artist.isEmpty()) artist = text(mmr.extractMetadata(MediaMetadataRetriever.METADATA_KEY_ALBUMARTIST));
                    r.put("artist", artist);
                    r.put("album", text(mmr.extractMetadata(MediaMetadataRetriever.METADATA_KEY_ALBUM)));
                    boolean cover = false;
                    if (!coverPath.isEmpty()) cover = writeCover(mmr.getEmbeddedPicture(), new File(coverPath));
                    r.put("cover", cover);
                } catch (RuntimeException e) {
                    throw new IOException("The file could not be read as audio.");
                } finally {
                    try {
                        mmr.release();
                    } catch (Exception ignored) {
                        // Released either way.
                    }
                }
                r.put("path", dest.getPath());
                r.put("format", ext);
                r.put("bytes", bytes);
                call.resolve(r);
            } catch (Exception e) {
                if (dest != null) dest.delete();
                call.reject(e.getMessage() == null ? "The file could not be opened." : e.getMessage());
            }
        });
    }

    private static String text(String s) {
        return s == null ? "" : s.trim();
    }

    /** A file's picture as a COVER_SIZE square JPEG (the middle of it), as the desktop makes covers. */
    private boolean writeCover(byte[] picture, File dest) {
        if (picture == null || picture.length == 0) return false;
        try {
            if (!ours(dest)) return false;
            Bitmap full = BitmapFactory.decodeByteArray(picture, 0, picture.length);
            if (full == null) return false;
            int side = Math.min(full.getWidth(), full.getHeight());
            Bitmap square = Bitmap.createBitmap(full, (full.getWidth() - side) / 2, (full.getHeight() - side) / 2, side, side);
            Bitmap scaled = Bitmap.createScaledBitmap(square, COVER_SIZE, COVER_SIZE, true);
            File dir = dest.getParentFile();
            if (dir != null && !dir.isDirectory()) dir.mkdirs();
            try (OutputStream out = new FileOutputStream(dest)) {
                scaled.compress(Bitmap.CompressFormat.JPEG, 90, out);
            }
            return true;
        } catch (Exception e) {
            dest.delete();
            return false;
        }
    }

    /**
     * Sends the file `path` (in Flow's storage) to `url` as the body (`method`,
     * PUT by default), with `headers`. Resolves { status, text }. Unreachable,
     * timed out or cut off: rejected with code OFFLINE. Progress goes out as
     * "uploadProgress" { id, frac } when `id` is given.
     */
    @PluginMethod
    public void upload(PluginCall call) {
        String url = call.getString("url", "");
        String path = call.getString("path", "");
        String method = call.getString("method", "PUT");
        String id = call.getString("id", "");
        int timeout = call.getInt("timeout", 120000);
        JSObject headers = call.getObject("headers", new JSObject());
        work.execute(() -> {
            HttpURLConnection conn = null;
            try {
                File file = new File(path);
                if (!ours(file) || !file.isFile()) {
                    call.reject("Not one of Flow's files: " + path);
                    return;
                }
                long total = file.length();
                conn = (HttpURLConnection) new URL(url).openConnection();
                conn.setConnectTimeout(Math.min(timeout, 30000));
                conn.setReadTimeout(timeout);
                conn.setRequestMethod(method);
                conn.setDoOutput(true);
                conn.setFixedLengthStreamingMode(total);
                for (Iterator<String> it = headers.keys(); it.hasNext(); ) {
                    String k = it.next();
                    conn.setRequestProperty(k, headers.getString(k));
                }
                long sent = 0;
                long told = 0;
                try (InputStream in = new FileInputStream(file); OutputStream out = conn.getOutputStream()) {
                    byte[] buf = new byte[65536];
                    int n;
                    while ((n = in.read(buf)) > 0) {
                        out.write(buf, 0, n);
                        sent += n;
                        if (!id.isEmpty() && total > 0 && (sent - told > total / 50 || sent == total)) {
                            told = sent;
                            JSObject p = new JSObject();
                            p.put("id", id);
                            p.put("frac", (double) sent / total);
                            notifyListeners("uploadProgress", p);
                        }
                    }
                }
                int status = conn.getResponseCode();
                InputStream body = status >= 400 ? conn.getErrorStream() : conn.getInputStream();
                JSObject result = new JSObject();
                result.put("status", status);
                result.put("text", body == null ? "" : readAll(body));
                call.resolve(result);
            } catch (SocketTimeoutException e) {
                call.reject("The server did not answer in time.", "OFFLINE");
            } catch (IOException e) {
                call.reject(e.getMessage() == null ? "The connection failed." : e.getMessage(), "OFFLINE");
            } catch (Exception e) {
                call.reject(e.getMessage() == null ? "The upload failed." : e.getMessage());
            } finally {
                if (conn != null) conn.disconnect();
            }
        });
    }

    @Override
    protected void handleOnDestroy() {
        work.shutdownNow();
    }
}
