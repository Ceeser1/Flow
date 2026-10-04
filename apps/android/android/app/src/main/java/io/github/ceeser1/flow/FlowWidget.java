package io.github.ceeser1.flow;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.net.Uri;
import android.widget.RemoteViews;

import androidx.media3.common.MediaMetadata;

/**
 * Flow on the home screen: the song playing (cover, title, artist), Play/Pause
 * and Next, and below them the timeline (where the song is, its length). While the player has a song, the buttons go to it (without
 * opening Flow); with none (Flow not opened since the process started) Play
 * opens Flow and the page plays its last song (FlowPlayer.attach: play), and
 * Next opens Flow. A tap anywhere else opens Flow. FlowPlayer draws it again
 * whenever its song or playing changes, and while playing moves the timeline
 * on every second (time()).
 *
 * Play always comes here first, never straight to Flow's window: a window
 * opened with a "play" of its own would keep it, and play again whenever
 * Android makes that window anew.
 */
public class FlowWidget extends AppWidgetProvider {
    static final String TOGGLE = "io.github.ceeser1.flow.widget.TOGGLE";
    static final String NEXT = "io.github.ceeser1.flow.widget.NEXT";

    // The cover drawn last, so a pause does not read the file again.
    private static Uri coverUri;
    private static Bitmap coverBitmap;

    @Override
    public void onUpdate(Context context, AppWidgetManager manager, int[] ids) {
        draw(context, manager, ids);
    }

    @Override
    public void onReceive(Context context, Intent intent) {
        String action = intent.getAction();
        if (TOGGLE.equals(action) || NEXT.equals(action)) {
            FlowPlayer player = FlowPlayer.peek();
            if (player == null || !player.hasSong()) {
                // Nothing loaded: Flow opens, and Play plays there (Android lets a widget's tap open it).
                refresh(context);
                if (TOGGLE.equals(action)) FlowPlayer.get(context).playOnAttach();
                try {
                    context.startActivity(new Intent(context, MainActivity.class).setAction(Intent.ACTION_MAIN)
                            .setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP));
                } catch (RuntimeException e) {
                    FlowLog.i("widget: Flow not opened: " + e.getMessage());
                }
                return;
            }
            if (TOGGLE.equals(action)) player.widgetToggle(context);
            else player.widgetNext();
            return;
        }
        super.onReceive(context, intent);
    }

    /** Draws every Flow widget on the home screen again (none: nothing to do). */
    static void refresh(Context context) {
        AppWidgetManager manager = AppWidgetManager.getInstance(context);
        int[] ids = manager.getAppWidgetIds(new ComponentName(context, FlowWidget.class));
        if (ids.length > 0) draw(context, manager, ids);
    }

    private static void draw(Context context, AppWidgetManager manager, int[] ids) {
        FlowPlayer player = FlowPlayer.peek();
        boolean has = player != null && player.hasSong();
        MediaMetadata md = has ? player.exo.getMediaMetadata() : MediaMetadata.EMPTY;
        boolean playing = has && player.exo.getPlayWhenReady();

        RemoteViews v = new RemoteViews(context.getPackageName(), R.layout.flow_widget);
        v.setTextViewText(R.id.widget_title, has && md.title != null ? md.title : "Flow");
        v.setTextViewText(R.id.widget_artist, has ? (md.artist != null ? md.artist : "") : "Tap play to listen");
        Bitmap cover = has ? cover(md.artworkUri) : null;
        if (cover != null) v.setImageViewBitmap(R.id.widget_cover, cover);
        else v.setImageViewResource(R.id.widget_cover, R.drawable.widget_note);
        timeline(v, has ? player.exo.getCurrentPosition() : 0, has ? player.length() : 0);
        v.setImageViewResource(R.id.widget_play, playing ? R.drawable.widget_pause : R.drawable.widget_play);
        v.setContentDescription(R.id.widget_play, playing ? "Pause" : "Play");

        PendingIntent open = activity(context, Intent.ACTION_MAIN, 0);
        v.setOnClickPendingIntent(R.id.widget_root, open);
        v.setOnClickPendingIntent(R.id.widget_play, broadcast(context, TOGGLE, 1));
        v.setOnClickPendingIntent(R.id.widget_next, has ? broadcast(context, NEXT, 2) : open);
        manager.updateAppWidget(ids, v);
    }

    /** The timeline moved on (only it is drawn again): where the song is, its length (ms; 0: not known). */
    static void time(Context context, long at, long length) {
        AppWidgetManager manager = AppWidgetManager.getInstance(context);
        int[] ids = manager.getAppWidgetIds(new ComponentName(context, FlowWidget.class));
        if (ids.length == 0) return;
        RemoteViews v = new RemoteViews(context.getPackageName(), R.layout.flow_widget);
        timeline(v, at, length);
        manager.partiallyUpdateAppWidget(ids, v);
    }

    private static void timeline(RemoteViews v, long at, long length) {
        at = Math.max(0, length > 0 ? Math.min(at, length) : at);
        v.setTextViewText(R.id.widget_time, clock(at));
        v.setTextViewText(R.id.widget_length, length > 0 ? clock(length) : "0:00");
        v.setProgressBar(R.id.widget_progress, 1000, length > 0 ? (int) (at * 1000 / length) : 0, false);
    }

    /** 3:07, or 1:02:07 from an hour on. */
    private static String clock(long ms) {
        long s = ms / 1000;
        long h = s / 3600;
        long m = (s / 60) % 60;
        s %= 60;
        return h > 0 ? String.format(java.util.Locale.ROOT, "%d:%02d:%02d", h, m, s)
                : String.format(java.util.Locale.ROOT, "%d:%02d", m, s);
    }

    /** The cover (a file in the app's storage), small enough for the widget; null without one. */
    private static Bitmap cover(Uri uri) {
        if (uri == null || uri.getPath() == null) return null;
        if (uri.equals(coverUri)) return coverBitmap;
        BitmapFactory.Options size = new BitmapFactory.Options();
        size.inJustDecodeBounds = true;
        BitmapFactory.decodeFile(uri.getPath(), size);
        BitmapFactory.Options opts = new BitmapFactory.Options();
        opts.inSampleSize = 1;
        while (Math.max(size.outWidth, size.outHeight) / (opts.inSampleSize * 2) >= 192) opts.inSampleSize *= 2;
        coverUri = uri;
        coverBitmap = BitmapFactory.decodeFile(uri.getPath(), opts);
        return coverBitmap;
    }

    private static PendingIntent broadcast(Context context, String action, int code) {
        Intent i = new Intent(context, FlowWidget.class).setAction(action);
        return PendingIntent.getBroadcast(context, code, i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    private static PendingIntent activity(Context context, String action, int code) {
        Intent i = new Intent(context, MainActivity.class).setAction(action).setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        return PendingIntent.getActivity(context, code, i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }
}
