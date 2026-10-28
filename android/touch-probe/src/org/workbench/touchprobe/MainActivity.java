package org.workbench.touchprobe;

import android.app.Activity;
import android.os.Bundle;
import android.view.InputDevice;
import android.view.MotionEvent;
import android.view.View;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import org.json.JSONObject;
import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;

/** Records only events delivered to this diagnostic activity. */
public final class MainActivity extends Activity {
    private File output;
    private ProbeView probe;
    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        String run = getIntent().getStringExtra("run");
        if (run == null || !run.matches("[A-Za-z0-9_-]{1,64}")) run = "events";
        output = new File(getFilesDir(), run + ".jsonl");
        probe = new ProbeView();
        setContentView(probe);
    }
    @Override public boolean dispatchTouchEvent(MotionEvent event) {
        try {
            JSONObject row = new JSONObject();
            row.put("action", event.getActionMasked());
            row.put("time", event.getEventTime());
            row.put("downTime", event.getDownTime());
            row.put("deviceId", event.getDeviceId());
            InputDevice device = event.getDevice();
            row.put("deviceName", device == null ? JSONObject.NULL : device.getName());
            row.put("source", event.getSource());
            row.put("flags", event.getFlags());
            row.put("toolType", event.getToolType(0));
            row.put("pressure", event.getPressure());
            row.put("size", event.getSize());
            row.put("touchMajor", event.getTouchMajor());
            row.put("touchMinor", event.getTouchMinor());
            row.put("toolMajor", event.getToolMajor());
            row.put("toolMinor", event.getToolMinor());
            row.put("orientation", event.getOrientation());
            row.put("x", event.getRawX()); row.put("y", event.getRawY());
            row.put("historySize", event.getHistorySize());
            if (output.length() < 1048576) {
                try (FileOutputStream stream = new FileOutputStream(output, true)) {
                    stream.write((row.toString() + "\n").getBytes(StandardCharsets.UTF_8));
                }
            }
            probe.x = event.getX(); probe.y = event.getY(); probe.invalidate();
        } catch (Exception error) { android.util.Log.e("WorkbenchTouchProbe", "Event recording failed", error); }
        return true;
    }
    private final class ProbeView extends View {
        float x = -1, y = -1;
        final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
        ProbeView() { super(MainActivity.this); setBackgroundColor(Color.WHITE); paint.setColor(Color.BLUE); }
        @Override protected void onDraw(Canvas canvas) {
            super.onDraw(canvas);
            if (x >= 0) canvas.drawCircle(x, y, 18, paint);
        }
    }
}
