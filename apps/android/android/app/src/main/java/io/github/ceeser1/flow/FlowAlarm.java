package io.github.ceeser1.flow;

import android.app.AlarmManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.media.AudioAttributes;
import android.os.Build;
import android.provider.Settings;

import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;

import org.json.JSONObject;

import java.util.Calendar;
import java.util.Locale;

/**
 * Flow's Alarm Clock (5.0): at a set time Flow starts playing, the music
 * fading in over a minute (FlowPlayer.alarmPlay, started by PlaybackService
 * once that is in the foreground), and a notification on the lock screen
 * says "Alarm at 07:00" with Stop Alarm and Snooze (5 min).
 *
 * The alarm is Android's own (AlarmManager.setAlarmClock): it wakes the phone
 * and this receiver at the minute, whether Flow runs or not, and shows in the
 * status bar. It is kept in the app's preferences: on, hour and minute, the
 * days it rings on (a bit each, Monday 1 to Sunday 64; none: it rings once,
 * then turns itself off), a snooze running, and the notification's texts in
 * the app's language (the page hands them along; there may be no page when
 * it rings). Android forgets alarms over a restart, an update of Flow, and
 * its clock or time zone changing: set again then (the manifest's filters).
 *
 * Stop Alarm pauses the music; Snooze pauses it and rings again in five
 * minutes. Pausing Flow any other way while it rings stops the alarm too.
 * If no song can be played (nothing to play, the server out of reach), the
 * notification rings with the phone's own alarm sound instead.
 */
public class FlowAlarm extends BroadcastReceiver {
    static final String FIRE = "io.github.ceeser1.flow.alarm.FIRE";
    static final String STOP = "io.github.ceeser1.flow.alarm.STOP";
    static final String SNOOZE = "io.github.ceeser1.flow.alarm.SNOOZE";
    static final long SNOOZE_MS = 5 * 60 * 1000;

    private static final String PREFS = "flow-alarm";
    // Silent (the music is the alarm), and one that rings with the phone's alarm sound.
    private static final String CHANNEL = "flow-alarm";
    private static final String CHANNEL_TONE = "flow-alarm-tone";
    private static final int NOTE = 7301;
    // The alarm's notification goes by itself after this long.
    private static final long NOTE_MS = 2 * 60 * 60 * 1000;

    /** Told whenever the alarm changes (the page shows it). */
    interface Listener {
        void onAlarm(JSObject state);
    }

    private static Listener listener;
    // Whether it rings now (the music it started plays, or its sound rings).
    private static boolean ringing;

    static void setListener(Listener l) {
        listener = l;
    }

    @Override
    public void onReceive(Context context, Intent intent) {
        String action = intent.getAction();
        FlowLog.init(context);
        if (FIRE.equals(action)) ring(context);
        else if (STOP.equals(action)) stop(context);
        else if (SNOOZE.equals(action)) snooze(context);
        // The phone started, Flow was updated, or the clock or the time zone changed.
        else schedule(context);
    }

    private static SharedPreferences prefs(Context context) {
        return context.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    /** Whether an alarm waits to ring (set, or snoozed): the player keeps its songs for it. */
    static boolean waiting(Context context) {
        SharedPreferences p = prefs(context);
        return p.getBoolean("on", false) || p.getLong("snoozeAt", 0) > System.currentTimeMillis();
    }

    static boolean ringing() {
        return ringing;
    }

    /**
     * { on, hour, minute, days, ringing, snoozeAt (ms; 0: none), nextAt (when it rings next, ms; 0: not),
     * notify (Flow may show notifications) }
     */
    static JSObject state(Context context) {
        SharedPreferences p = prefs(context);
        long now = System.currentTimeMillis();
        long snoozeAt = p.getLong("snoozeAt", 0);
        JSObject s = new JSObject();
        s.put("on", p.getBoolean("on", false));
        s.put("hour", p.getInt("hour", 7));
        s.put("minute", p.getInt("minute", 0));
        s.put("days", p.getInt("days", 0));
        s.put("ringing", ringing);
        s.put("snoozeAt", snoozeAt > now ? (double) snoozeAt : 0);
        s.put("nextAt", (double) dueAt(context, now));
        s.put("notify", NotificationManagerCompat.from(context).areNotificationsEnabled());
        return s;
    }

    /**
     * The alarm set (or with `on` false turned off) from the page, with the
     * notification's texts: { title, stop, snooze, snoozed ("... {time}"), tone, channel }.
     */
    static void set(Context context, boolean on, int hour, int minute, int days, JSONObject texts) {
        SharedPreferences.Editor e = prefs(context).edit()
                .putBoolean("on", on)
                .putInt("hour", Math.max(0, Math.min(23, hour)))
                .putInt("minute", Math.max(0, Math.min(59, minute)))
                .putInt("days", days & 0x7f)
                .putLong("snoozeAt", 0);
        if (texts != null) {
            for (String key : new String[] {"title", "stop", "snooze", "snoozed", "tone", "channel"}) {
                String text = texts.optString(key, "");
                if (!text.isEmpty()) e.putString("text." + key, text);
            }
        }
        e.apply();
        // One ringing or snoozed is over with a new setting.
        quiet(context);
        schedule(context);
        FlowLog.i("alarm " + (on ? "set for " + clock(hour, minute) + (days == 0 ? ", once" : ", days " + Integer.toBinaryString(days)) : "off"));
        tell(context);
    }

    /**
     * When an alarm at hour:minute rings next after `now`: on the next of its
     * days (a bit each, Monday 1 to Sunday 64), or with none today or tomorrow.
     */
    static long nextAt(int hour, int minute, int days, long now) {
        Calendar c = Calendar.getInstance();
        c.setTimeInMillis(now);
        for (int i = 0; i < 8; i += 1) {
            c.set(Calendar.HOUR_OF_DAY, hour);
            c.set(Calendar.MINUTE, minute);
            c.set(Calendar.SECOND, 0);
            c.set(Calendar.MILLISECOND, 0);
            int bit = 1 << ((c.get(Calendar.DAY_OF_WEEK) + 5) % 7);
            if (c.getTimeInMillis() > now && (days == 0 || (days & bit) != 0)) return c.getTimeInMillis();
            c.add(Calendar.DAY_OF_MONTH, 1);
        }
        return 0;
    }

    /** When it rings next: a snooze running, else the alarm's next time; 0: not at all. */
    private static long dueAt(Context context, long now) {
        SharedPreferences p = prefs(context);
        long snoozeAt = p.getLong("snoozeAt", 0);
        if (snoozeAt > now) return snoozeAt;
        if (!p.getBoolean("on", false)) return 0;
        return nextAt(p.getInt("hour", 7), p.getInt("minute", 0), p.getInt("days", 0), now);
    }

    /** Android's alarm for when it rings next (none: taken away). */
    static void schedule(Context context) {
        AlarmManager alarms = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
        if (alarms == null) return;
        PendingIntent fire = broadcast(context, FIRE, 1);
        alarms.cancel(fire);
        long at = dueAt(context, System.currentTimeMillis());
        if (at <= 0) return;
        try {
            // An alarm clock's alarm: at the minute, out of the phone's sleep, shown in the status bar.
            if (Build.VERSION.SDK_INT < 31 || alarms.canScheduleExactAlarms()) {
                alarms.setAlarmClock(new AlarmManager.AlarmClockInfo(at, open(context)), fire);
            } else {
                FlowLog.i("alarm: no exact alarms allowed, it may ring late");
                alarms.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, fire);
            }
        } catch (SecurityException e) {
            FlowLog.i("alarm: " + e.getMessage());
            alarms.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, fire);
        }
        FlowLog.i("alarm: rings in " + Math.round((at - System.currentTimeMillis()) / 1000.0) + " s");
    }

    /** The time has come: the music starts (fading in), the notification shows. */
    private static void ring(Context context) {
        SharedPreferences p = prefs(context);
        boolean snoozed = p.getLong("snoozeAt", 0) > 0;
        if (!p.getBoolean("on", false) && !snoozed) return;
        SharedPreferences.Editor e = p.edit().putLong("snoozeAt", 0);
        // No day ticked: it rings this once (a snooze of it still rings).
        if (!snoozed && p.getInt("days", 0) == 0) e.putBoolean("on", false);
        e.apply();
        ringing = true;
        FlowLog.i("alarm rings");
        schedule(context);
        FlowPlayer player = FlowPlayer.get(context);
        boolean plays = player.alarmReady();
        if (plays) {
            Intent service = new Intent(context, PlaybackService.class).setAction(PlaybackService.ALARM);
            try {
                // Android lets an alarm clock's alarm start it in the foreground; it starts the music.
                ContextCompat.startForegroundService(context, service);
            } catch (RuntimeException refused) {
                // Refused (the alarm came late, not as an alarm clock's): from here, which plays with Flow in front.
                FlowLog.i("alarm: service not started: " + refused.getMessage());
                player.alarmPlay();
            }
        }
        show(context, plays ? CHANNEL : CHANNEL_TONE, true);
        tell(context);
    }

    /** The music the alarm started cannot play (the player says): the phone's own alarm sound rings instead. */
    static void cannotPlay(Context context) {
        if (!ringing) return;
        FlowLog.i("alarm: no song plays, the phone's alarm sound rings");
        show(context, CHANNEL_TONE, true);
    }

    /** Stop Alarm (the notification's, the page's), or Flow paused while it rang. */
    static void stop(Context context) {
        FlowLog.i("alarm stopped");
        prefs(context).edit().putLong("snoozeAt", 0).apply();
        quiet(context);
        schedule(context);
        tell(context);
    }

    /** Snooze: quiet now, ringing again in five minutes. */
    static void snooze(Context context) {
        long at = System.currentTimeMillis() + SNOOZE_MS;
        FlowLog.i("alarm snoozed");
        quiet(context);
        prefs(context).edit().putLong("snoozeAt", at).apply();
        schedule(context);
        show(context, CHANNEL, false);
        tell(context);
    }

    /** No longer ringing: the music pauses (at its full volume again), the notification goes. */
    private static void quiet(Context context) {
        boolean was = ringing;
        ringing = false;
        FlowPlayer player = FlowPlayer.peek();
        if (player != null) player.alarmStop(was);
        NotificationManagerCompat.from(context).cancel(NOTE);
    }

    private static void tell(Context context) {
        if (listener != null) listener.onAlarm(state(context));
    }

    /**
     * The notification: ringing ("Alarm at 07:00", Stop Alarm and Snooze), or
     * snoozed ("Alarm snoozed until 07:05", Stop Alarm). On `channel`:
     * silent, or ringing with the phone's alarm sound until it is answered.
     */
    private static void show(Context context, String channel, boolean rings) {
        SharedPreferences p = prefs(context);
        NotificationManager manager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) return;
        String name = p.getString("text.channel", "Alarm Clock");
        NotificationChannel silent = new NotificationChannel(CHANNEL, name, NotificationManager.IMPORTANCE_HIGH);
        silent.setSound(null, null);
        silent.enableVibration(false);
        silent.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
        manager.createNotificationChannel(silent);
        NotificationChannel tone = new NotificationChannel(CHANNEL_TONE, name + " (♪)", NotificationManager.IMPORTANCE_HIGH);
        tone.setSound(Settings.System.DEFAULT_ALARM_ALERT_URI, new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_ALARM)
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .build());
        tone.enableVibration(true);
        tone.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
        manager.createNotificationChannel(tone);

        long snoozeAt = p.getLong("snoozeAt", 0);
        String title = rings
                ? p.getString("text.title", "Alarm at " + clock(p.getInt("hour", 7), p.getInt("minute", 0)))
                : p.getString("text.snoozed", "Alarm snoozed until {time}").replace("{time}", clock(snoozeAt));
        NotificationCompat.Builder b = new NotificationCompat.Builder(context, channel)
                .setSmallIcon(R.drawable.ic_stat_flow)
                .setColor(0xFF018EBF)
                .setContentTitle(title)
                .setCategory(NotificationCompat.CATEGORY_ALARM)
                .setPriority(NotificationCompat.PRIORITY_MAX)
                .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                .setOngoing(true)
                .setOnlyAlertOnce(false)
                .setShowWhen(true)
                .setWhen(System.currentTimeMillis())
                .setTimeoutAfter(NOTE_MS)
                .setContentIntent(open(context))
                .addAction(0, p.getString("text.stop", "Stop Alarm"), broadcast(context, STOP, 3));
        if (rings) b.addAction(0, p.getString("text.snooze", "Snooze (5 min)"), broadcast(context, SNOOZE, 4));
        if (CHANNEL_TONE.equals(channel)) b.setContentText(p.getString("text.tone", ""));
        Notification n = b.build();
        // The phone's alarm sound over and over until it is answered.
        if (CHANNEL_TONE.equals(channel)) n.flags |= Notification.FLAG_INSISTENT;
        try {
            manager.notify(NOTE, n);
        } catch (SecurityException e) {
            FlowLog.i("alarm: no notification: " + e.getMessage());
        }
    }

    /** 07:05, as Flow writes the time of day. */
    private static String clock(int hour, int minute) {
        return String.format(Locale.ROOT, "%02d:%02d", hour, minute);
    }

    private static String clock(long at) {
        Calendar c = Calendar.getInstance();
        c.setTimeInMillis(at);
        return clock(c.get(Calendar.HOUR_OF_DAY), c.get(Calendar.MINUTE));
    }

    private static PendingIntent broadcast(Context context, String action, int code) {
        Intent i = new Intent(context, FlowAlarm.class).setAction(action);
        return PendingIntent.getBroadcast(context, code, i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    private static PendingIntent open(Context context) {
        Intent i = new Intent(context, MainActivity.class).setAction(Intent.ACTION_MAIN)
                .setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        return PendingIntent.getActivity(context, 5, i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }
}
