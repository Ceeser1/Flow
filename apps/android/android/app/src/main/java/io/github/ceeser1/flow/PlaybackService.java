package io.github.ceeser1.flow;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;

import androidx.annotation.OptIn;
import androidx.core.app.NotificationCompat;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.session.DefaultMediaNotificationProvider;
import androidx.media3.session.MediaSession;
import androidx.media3.session.MediaSessionService;

/**
 * Keeps Flow playing in the background: the media session around FlowPlayer,
 * which Media3 shows as the notification and on the lock screen, and for which
 * it runs this service in the foreground while a song plays. A tap on the
 * notification opens Flow.
 *
 * The Alarm Clock's music starts here too (ALARM, sent by FlowAlarm when it
 * rings): Flow is in the background then, and Android lets only an app in
 * the foreground take the sound. So the service goes to the foreground at
 * once, with a notification in the place of Media3's own (which takes its
 * place as soon as the song plays), and only then starts the music.
 */
public class PlaybackService extends MediaSessionService {
    /** The Alarm Clock rings: in the foreground now, then its music (FlowPlayer.alarmPlay). */
    static final String ALARM = "io.github.ceeser1.flow.service.ALARM";
    private static final String CHANNEL_STARTING = "flow-starting";

    /** Whether the service runs (the widget starts it before playing, if not). */
    static boolean running;

    private MediaSession session;

    @Override
    public void onCreate() {
        super.onCreate();
        running = true;
        FlowPlayer player = FlowPlayer.get(this);
        Intent open = new Intent(this, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent tap = PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        session = new MediaSession.Builder(this, player.exo).setSessionActivity(tap).build();
        // Shown from the start, not only once something connects to the session.
        addSession(session);
        FlowLog.i("service started");
    }

    @Override
    public MediaSession onGetSession(MediaSession.ControllerInfo controllerInfo) {
        return session;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ALARM.equals(intent.getAction())) {
            toForeground();
            FlowPlayer.get(this).alarmPlay();
        }
        return super.onStartCommand(intent, flags, startId);
    }

    /**
     * In the foreground before a song plays, with a notification under the
     * number Media3 gives its own: that one replaces this as soon as the
     * player plays (or, if it cannot, takes it away again).
     */
    @OptIn(markerClass = UnstableApi.class)
    private void toForeground() {
        try {
            NotificationManager manager = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
            if (manager != null) {
                manager.createNotificationChannel(new NotificationChannel(CHANNEL_STARTING, "Flow", NotificationManager.IMPORTANCE_LOW));
            }
            Notification n = new NotificationCompat.Builder(this, CHANNEL_STARTING)
                    .setSmallIcon(R.drawable.ic_stat_flow)
                    .setContentTitle("Flow")
                    .setOngoing(true)
                    .setSilent(true)
                    .build();
            int id = DefaultMediaNotificationProvider.DEFAULT_NOTIFICATION_ID;
            if (Build.VERSION.SDK_INT >= 29) startForeground(id, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
            else startForeground(id, n);
        } catch (RuntimeException e) {
            // Android refused (the alarm came late, not as an alarm clock's): the music may still play with Flow in front.
            FlowLog.i("alarm: not in the foreground: " + e.getMessage());
        }
    }

    /** Flow swiped away from the recent apps: closed, so the music stops (the widget can start it again). */
    @Override
    public void onTaskRemoved(Intent rootIntent) {
        FlowLog.i("task removed, stopping");
        FlowPlayer.get(this).letGo();
        stopSelf();
    }

    @Override
    public void onDestroy() {
        FlowLog.i("service stopped");
        running = false;
        session.release();
        session = null;
        super.onDestroy();
    }
}
