package io.github.ceeser1.flow;

import android.app.usage.UsageStatsManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.media.AudioAttributes;
import android.media.AudioDeviceCallback;
import android.media.AudioDeviceInfo;
import android.media.AudioManager;
import android.media.MediaRoute2Info;
import android.media.MediaRouter2;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;

import androidx.core.content.ContextCompat;

import java.util.List;

/**
 * What the phone does around playback, for the log (FlowLog): the network
 * Flow is on (Wi-Fi, mobile data, a VPN such as Tailscale, none), the screen,
 * Doze, battery saver, how Android ranks Flow (its standby bucket) and the
 * sound devices coming and going (with where music goes then). Read
 * beside what the player did: a stream that stopped, was the network gone,
 * was the phone dozing? Started once, with the player.
 */
final class DeviceLog {
    private static boolean started;

    private DeviceLog() {}

    static synchronized void start(Context context) {
        if (started) return;
        started = true;
        final Context app = context.getApplicationContext();
        FlowLog.i("phone: " + power(app));
        try {
            ConnectivityManager cm = (ConnectivityManager) app.getSystemService(Context.CONNECTIVITY_SERVICE);
            cm.registerDefaultNetworkCallback(new ConnectivityManager.NetworkCallback() {
                // Capabilities change often (signal strength): only a different kind is told.
                private String last = "";

                @Override
                public void onCapabilitiesChanged(Network network, NetworkCapabilities caps) {
                    String now = kind(caps);
                    if (now.equals(last)) return;
                    last = now;
                    FlowLog.i("network: " + now);
                }

                @Override
                public void onLost(Network network) {
                    last = "";
                    FlowLog.i("network: none");
                }
            });
        } catch (RuntimeException e) {
            FlowLog.i("network not watched: " + e.getMessage());
        }
        AudioManager audio = (AudioManager) app.getSystemService(Context.AUDIO_SERVICE);
        audio.registerAudioDeviceCallback(new AudioDeviceCallback() {
            // Called at once with the devices there: told as they are.
            private boolean first = true;

            @Override
            public void onAudioDevicesAdded(AudioDeviceInfo[] added) {
                FlowLog.i((first ? "sound devices: " : "sound device added: ") + names(added) + ", music to " + output(app));
                first = false;
            }

            @Override
            public void onAudioDevicesRemoved(AudioDeviceInfo[] removed) {
                FlowLog.i("sound device removed: " + names(removed) + ", music to " + output(app));
            }
        }, new Handler(Looper.getMainLooper()));
        IntentFilter filter = new IntentFilter();
        filter.addAction(Intent.ACTION_SCREEN_ON);
        filter.addAction(Intent.ACTION_SCREEN_OFF);
        filter.addAction(PowerManager.ACTION_DEVICE_IDLE_MODE_CHANGED);
        filter.addAction(PowerManager.ACTION_POWER_SAVE_MODE_CHANGED);
        ContextCompat.registerReceiver(app, new BroadcastReceiver() {
            @Override
            public void onReceive(Context c, Intent intent) {
                String action = intent.getAction();
                if (Intent.ACTION_SCREEN_ON.equals(action)) FlowLog.i("screen on");
                else if (Intent.ACTION_SCREEN_OFF.equals(action)) FlowLog.i("screen off");
                else FlowLog.i("phone: " + power(app));
            }
        }, filter, ContextCompat.RECEIVER_NOT_EXPORTED);
    }

    /**
     * Where music comes out now: "This phone", "Headphones" or a Bluetooth
     * device's own name (Android 13 and later from its audio policy, with an
     * output pinned in its output switcher; before, its selected route).
     */
    static String output(Context context) {
        String name = "";
        if (Build.VERSION.SDK_INT >= 33) {
            AudioManager audio = (AudioManager) context.getSystemService(Context.AUDIO_SERVICE);
            AudioAttributes media = new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).build();
            List<AudioDeviceInfo> devices = audio.getAudioDevicesForAttributes(media);
            if (!devices.isEmpty()) name = deviceName(devices.get(0));
        }
        if (name.isEmpty() && Build.VERSION.SDK_INT >= 30) {
            try {
                List<MediaRoute2Info> routes = MediaRouter2.getInstance(context).getSystemController().getSelectedRoutes();
                if (!routes.isEmpty()) name = String.valueOf(routes.get(0).getName());
            } catch (RuntimeException ignored) {
                // Named below.
            }
        }
        return name.isEmpty() ? "This phone" : name;
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

    /** The output devices among these: "Galaxy Buds (bluetooth a2dp)", the phone's own left out. */
    private static String names(AudioDeviceInfo[] devices) {
        StringBuilder s = new StringBuilder();
        for (AudioDeviceInfo d : devices) {
            if (!d.isSink()) continue;
            int t = d.getType();
            if (t == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER || t == AudioDeviceInfo.TYPE_BUILTIN_EARPIECE
                    || t == AudioDeviceInfo.TYPE_TELEPHONY || t == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER_SAFE) continue;
            if (s.length() > 0) s.append(", ");
            s.append(d.getProductName()).append(" (").append(type(t)).append(')');
        }
        return s.length() == 0 ? "only this phone's" : s.toString();
    }

    private static String type(int t) {
        switch (t) {
            case AudioDeviceInfo.TYPE_BLUETOOTH_A2DP: return "bluetooth music";
            case AudioDeviceInfo.TYPE_BLUETOOTH_SCO: return "bluetooth calls";
            case 26: return "bluetooth le"; // TYPE_BLE_HEADSET, API 31
            case 27: return "bluetooth le speaker"; // TYPE_BLE_SPEAKER, API 31
            case AudioDeviceInfo.TYPE_WIRED_HEADPHONES:
            case AudioDeviceInfo.TYPE_WIRED_HEADSET: return "wired";
            case AudioDeviceInfo.TYPE_USB_HEADSET:
            case AudioDeviceInfo.TYPE_USB_DEVICE: return "usb";
            default: return "type " + t;
        }
    }

    /** "wifi", "mobile data, metered", "vpn, wifi", with "no internet" when Android found none. */
    private static String kind(NetworkCapabilities caps) {
        StringBuilder s = new StringBuilder();
        if (caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN)) s.append("vpn, ");
        if (caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) s.append("wifi, ");
        if (caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR)) s.append("mobile data, ");
        if (caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET)) s.append("ethernet, ");
        if (s.length() == 0) s.append("other, ");
        if (!caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED)) s.append("metered, ");
        if (!caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)) s.append("no internet, ");
        return s.substring(0, s.length() - 2);
    }

    /** "doze off, battery saver off, battery optimised, bucket active". */
    private static String power(Context app) {
        PowerManager pm = (PowerManager) app.getSystemService(Context.POWER_SERVICE);
        String s = "doze " + (pm.isDeviceIdleMode() ? "on" : "off")
                + ", battery saver " + (pm.isPowerSaveMode() ? "on" : "off")
                + ", " + (pm.isIgnoringBatteryOptimizations(app.getPackageName()) ? "not battery optimised" : "battery optimised");
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            UsageStatsManager usage = (UsageStatsManager) app.getSystemService(Context.USAGE_STATS_SERVICE);
            if (usage != null) s += ", bucket " + bucket(usage.getAppStandbyBucket());
        }
        return s;
    }

    private static String bucket(int b) {
        switch (b) {
            case UsageStatsManager.STANDBY_BUCKET_ACTIVE: return "active";
            case UsageStatsManager.STANDBY_BUCKET_WORKING_SET: return "working set";
            case UsageStatsManager.STANDBY_BUCKET_FREQUENT: return "frequent";
            case UsageStatsManager.STANDBY_BUCKET_RARE: return "rare";
            case 45: return "restricted"; // STANDBY_BUCKET_RESTRICTED, API 30
            case 5: return "exempted"; // not battery optimised
            default: return String.valueOf(b);
        }
    }
}
