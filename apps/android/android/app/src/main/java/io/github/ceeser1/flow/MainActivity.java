package io.github.ceeser1.flow;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Flow's own plugins, before the bridge starts and loads the page.
        registerPlugin(FlowNative.class);
        registerPlugin(FlowAudio.class);
        super.onCreate(savedInstanceState);
    }
}
