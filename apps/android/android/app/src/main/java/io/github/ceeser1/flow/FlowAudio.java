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
 * state() answers where it is.
 * Events: "state", "ended" { id } and "error" { id, message }.
 */
@CapacitorPlugin(name = "FlowAudio")
public class FlowAudio extends Plugin implements FlowPlayer.Events {
    private FlowPlayer player;

    @Override
    public void load() {
        player = FlowPlayer.get(getContext());
        player.setEvents(this);
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
    public void onError(String id, String message) {
        JSObject e = new JSObject();
        e.put("id", id);
        e.put("message", message);
        notifyListeners("error", e);
    }

    @Override
    protected void handleOnDestroy() {
        // The page is gone; the player and its music stay.
        if (player.getEvents() == this) player.setEvents(null);
    }
}
