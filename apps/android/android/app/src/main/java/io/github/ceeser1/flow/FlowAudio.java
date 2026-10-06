package io.github.ceeser1.flow;

import android.content.Intent;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * The page's way to FlowPlayer, for its audio engine (apps/android/src/engine.js):
 * run({ ops }) applies a list of operations and answers the state after them,
 * state() answers where it is, attach() what the page starting finds (see
 * FlowPlayer.attach). Events: "state", "ended" { id }, "error" { id, message, status },
 * "advance" { from, id, key, heard, reason } and "signedIn" { token } (the
 * player signed in to the server again itself). keepSession(state) hands
 * SessionKeeper what the page last told the server, for while Flow is out of sight.
 */
@CapacitorPlugin(name = "FlowAudio")
public class FlowAudio extends Plugin implements FlowPlayer.Events {
    private FlowPlayer player;
    private SessionKeeper keeper;

    @Override
    public void load() {
        player = FlowPlayer.get(getContext());
        player.setEvents(this);
        keeper = SessionKeeper.get(getContext());
        startService();
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
        if (player.getEvents() == this) player.setEvents(null);
    }
}
