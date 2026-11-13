package io.github.ceeser1.flow;

import android.content.Intent;
import android.os.Build;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

/**
 * The page's way to FlowPlayer, for its audio engine (apps/android/src/engine.js):
 * run({ ops }) applies a list of operations and answers the state after them,
 * state() answers where it is, attach() what the page starting finds (see
 * FlowPlayer.attach). Events: "state", "ended" { id }, "error" { id, message, status },
 * "advance" { from, id, key, heard, reason } and "signedIn" { token } (the
 * player signed in to the server again itself). keepSession(state) hands
 * SessionKeeper what the page last told the server, for while Flow is out of sight.
 *
 * The Alarm Clock (FlowAlarm, 5.0) too: alarmGet() answers how it is set,
 * alarmSet({ on, hour, minute, days, texts, plan }) sets it or turns it off
 * (plan: the songs to start with nothing loaded), alarmAct({ action: stop |
 * snooze }) answers a ringing one, alarmNotifications() asks Android whether
 * Flow may show notifications; each answers the alarm's state, which "alarm"
 * also tells whenever it changes. "adopt" { state }: the player loaded songs
 * itself (the alarm rang with nothing loaded), for the page to take.
 */
@CapacitorPlugin(name = "FlowAudio", permissions = {
    @Permission(alias = "notifications", strings = { "android.permission.POST_NOTIFICATIONS" })
})
public class FlowAudio extends Plugin implements FlowPlayer.Events {
    private FlowPlayer player;
    private SessionKeeper keeper;

    @Override
    public void load() {
        player = FlowPlayer.get(getContext());
        player.setEvents(this);
        keeper = SessionKeeper.get(getContext());
        FlowAlarm.setListener((state) -> notifyListeners("alarm", state));
        startService();
    }

    @PluginMethod
    public void alarmGet(PluginCall call) {
        call.resolve(FlowAlarm.state(getContext()));
    }

    @PluginMethod
    public void alarmSet(PluginCall call) {
        JSObject o = call.getData();
        bridge.executeOnMainThread(() -> {
            boolean on = o.optBoolean("on", false);
            FlowAlarm.set(getContext(), on, o.optInt("hour", 7), o.optInt("minute", 0), o.optInt("days", 0), o.optJSONObject("texts"));
            if (on) player.givePlan(o.optJSONArray("plan"));
            else player.forgetPlan();
            call.resolve(FlowAlarm.state(getContext()));
        });
    }

    @PluginMethod
    public void alarmAct(PluginCall call) {
        String action = call.getString("action", "");
        bridge.executeOnMainThread(() -> {
            if ("snooze".equals(action) && FlowAlarm.ringing()) FlowAlarm.snooze(getContext());
            else if ("stop".equals(action)) FlowAlarm.stop(getContext());
            call.resolve(FlowAlarm.state(getContext()));
        });
    }

    /** Android's "Allow Flow to send you notifications?" (from Android 13 on; before, they are allowed). */
    @PluginMethod
    public void alarmNotifications(PluginCall call) {
        if (Build.VERSION.SDK_INT < 33 || getPermissionState("notifications") == PermissionState.GRANTED) {
            call.resolve(FlowAlarm.state(getContext()));
            return;
        }
        requestPermissionForAlias("notifications", call, "notificationsAnswered");
    }

    @PermissionCallback
    private void notificationsAnswered(PluginCall call) {
        call.resolve(FlowAlarm.state(getContext()));
    }

    @PluginMethod
    public void run(PluginCall call) {
        JSArray ops = call.getArray("ops", new JSArray());
        bridge.executeOnMainThread(() -> {
            try {
                if (player.apply(ops)) startService();
                // The state after them: what the page goes by from now on.
                call.resolve(player.state());
            } catch (Exception e) {
                FlowLog.i("operations failed: " + e);
                call.reject(e.getMessage() == null ? "The player refused." : e.getMessage());
            }
        });
    }

    /** What this app last told the server it plays, for SessionKeeper ({ off: true }: hosting nothing). */
    @PluginMethod
    public void keepSession(PluginCall call) {
        JSObject o = call.getData();
        bridge.executeOnMainThread(() -> {
            keeper.keep(o);
            call.resolve();
        });
    }

    @PluginMethod
    public void attach(PluginCall call) {
        bridge.executeOnMainThread(() -> call.resolve(player.attach()));
    }

    @PluginMethod
    public void state(PluginCall call) {
        bridge.executeOnMainThread(() -> call.resolve(player.state()));
    }

    /** The service runs while Flow plays; starting it again is harmless. */
    private void startService() {
        try {
            getContext().startService(new Intent(getContext(), PlaybackService.class));
        } catch (IllegalStateException e) {
            // In the background Android may refuse; playing keeps it in the foreground once it runs.
            FlowLog.i("service not started: " + e.getMessage());
        }
    }

    @Override
    public void onState(JSObject state) {
        notifyListeners("state", state);
    }

    @Override
    public void onEnded(String id) {
        JSObject e = new JSObject();
        e.put("id", id);
        notifyListeners("ended", e);
    }

    @Override
    public void onError(String id, String message, int status) {
        JSObject e = new JSObject();
        e.put("id", id);
        e.put("message", message);
        e.put("status", status);
        notifyListeners("error", e);
    }

    @Override
    public void onSignedIn(String token) {
        JSObject e = new JSObject();
        e.put("token", token);
        notifyListeners("signedIn", e);
    }

    @Override
    public void onAdvance(String from, String id, String key, double heard, String reason) {
        JSObject e = new JSObject();
        e.put("from", from);
        e.put("id", id);
        e.put("key", key);
        e.put("heard", heard);
        e.put("reason", reason);
        notifyListeners("advance", e);
    }

    @Override
    public void onPrevious() {
        notifyListeners("previous", new JSObject());
    }

    @Override
    public void onAdopt(JSObject state) {
        JSObject e = new JSObject();
        e.put("state", state);
        notifyListeners("adopt", e);
    }

    @Override
    protected void handleOnStart() {
        keeper.away(false);
    }

    @Override
    protected void handleOnStop() {
        keeper.away(true);
    }

    @Override
    protected void handleOnDestroy() {
        // The page is gone; the player and its music stay.
        if (player.getEvents() == this) {
            player.setEvents(null);
            FlowAlarm.setListener(null);
        }
    }
}
