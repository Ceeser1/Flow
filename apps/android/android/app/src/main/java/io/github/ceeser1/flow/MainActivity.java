package io.github.ceeser1.flow;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Flow's own plugin, before the bridge starts and loads the page.
        registerPlugin(FlowNative.class);
        super.onCreate(savedInstanceState);
    }
}
