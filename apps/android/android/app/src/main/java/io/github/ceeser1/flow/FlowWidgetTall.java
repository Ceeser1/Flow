package io.github.ceeser1.flow;

/**
 * "Flow with timeline", two rows high: as FlowWidget, with the song's
 * timeline and Previous. FlowWidget draws both.
 */
public class FlowWidgetTall extends FlowWidget {
    @Override
    boolean tall() {
        return true;
    }
}
