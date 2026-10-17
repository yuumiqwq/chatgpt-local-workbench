package org.workbench.ime;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.inputmethodservice.InputMethodService;
import android.os.Build;
import android.util.Base64;
import android.view.inputmethod.ExtractedText;
import android.view.inputmethod.ExtractedTextRequest;
import android.view.inputmethod.InputConnection;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.nio.charset.CodingErrorAction;

/** Shell-only ordered broadcast receiver; no networking, storage, or input logging. */
public final class WorkbenchIme extends InputMethodService {
    private final BroadcastReceiver receiver = new BroadcastReceiver() {
        @Override public void onReceive(Context context, Intent intent) {
            setResultCode(0);
            if (!"org.workbench.ime.INPUT".equals(intent.getAction())) return;
            InputConnection connection = getCurrentInputConnection();
            if (connection == null || getCurrentInputEditorInfo() == null) return;
            String payload = intent.getStringExtra("payload"), mode = intent.getStringExtra("mode");
            if (payload == null || payload.length() > 24000 || !("append".equals(mode) || "replace".equals(mode))) return;
            try {
                String text = StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
                    .decode(ByteBuffer.wrap(Base64.decode(payload, Base64.NO_WRAP))).toString();
                if (text.length() == 0 || text.length() > 4096) return;
                // Full extraction is required to give append/replace an unambiguous meaning.
                ExtractedTextRequest request = new ExtractedTextRequest();
                request.hintMaxChars = 65536;
                ExtractedText current = connection.getExtractedText(request, 0);
                if (current == null || current.text == null || current.startOffset != 0 || current.partialStartOffset != -1 || current.text.length() > 65536) return;
                int end = current.text.length();
                connection.beginBatchEdit();
                try {
                    if (!connection.setSelection("replace".equals(mode) ? 0 : end, end)) return;
                    if (connection.commitText(text, 1)) setResultCode(1);
                } finally { connection.endBatchEdit(); }
            } catch (Exception ignored) { /* Never log user input. */ }
        }
    };
    @Override public void onCreate() {
        super.onCreate();
        IntentFilter filter = new IntentFilter("org.workbench.ime.INPUT");
        // DUMP is held by adb shell; ordinary applications cannot invoke this receiver.
        if (Build.VERSION.SDK_INT >= 33) registerReceiver(receiver, filter, "android.permission.DUMP", null, Context.RECEIVER_EXPORTED);
        else registerReceiver(receiver, filter, "android.permission.DUMP", null);
    }
    @Override public void onDestroy() { unregisterReceiver(receiver); super.onDestroy(); }
}
