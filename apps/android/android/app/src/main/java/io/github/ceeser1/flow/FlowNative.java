package io.github.ceeser1.flow;

import android.content.Context;
import android.content.Intent;
import android.media.AudioAttributes;
import android.media.AudioDeviceCallback;
import android.media.AudioDeviceInfo;
import android.media.AudioManager;
import android.media.MediaRoute2Info;
import android.media.MediaRouter2;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;

import androidx.activity.OnBackPressedCallback;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.ByteArrayOutputStream;
import java.io.File;
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
import java.util.Collections;
import java.util.Iterator;
import java.util.LinkedHashSet;
import java.util.List;
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
 */
@CapacitorPlugin(name = "FlowNative")
public class FlowNative extends Plugin {
    private static final int DISCOVERY_PORT = 7878;
    private static final byte[] DISCOVER = "{\"app\":\"flow-discover\",\"v\":1}".getBytes(StandardCharsets.UTF_8);

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

    @Override
    protected void handleOnDestroy() {
        work.shutdownNow();
    }
}
