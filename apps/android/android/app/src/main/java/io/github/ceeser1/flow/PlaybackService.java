package io.github.ceeser1.flow;

import android.app.PendingIntent;
import android.content.Intent;

import androidx.media3.session.MediaSession;
import androidx.media3.session.MediaSessionService;

/**
 * Keeps Flow playing in the background: the media session around FlowPlayer,
 * which Media3 shows as the notification and on the lock screen, and for which
 * it runs this service in the foreground while a song plays. A tap on the
 * notification opens Flow.
 */
public class PlaybackService extends MediaSessionService {
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
