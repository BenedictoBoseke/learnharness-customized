package ai.learnharness.mobile;

import android.app.Activity;
import android.os.Build;
import android.os.Bundle;
import android.util.AtomicFile;
import android.webkit.WebView;
import android.widget.TextView;
import org.json.JSONObject;
import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;

/** Debug-only native-renderer QA. It never loads Node or user learning data. */
public final class RendererQaActivity extends Activity {
    private NativeRenderer renderer;
    private File descriptor;
    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        TextView text = new TextView(this); text.setText("Renderer QA"); text.setPadding(24, 32, 24, 24); setContentView(text);
        descriptor = new File(getNoBackupFilesDir(), "renderer-qa.json");
        try {
            // Launch this Activity in a fresh process. Its profile cannot inherit
            // the normal application WebView's account cookies or local storage.
            if (Build.VERSION.SDK_INT >= 28) WebView.setDataDirectorySuffix("renderer-qa");
            renderer = new NativeRenderer(this);
            String url = renderer.start() + "/render";
            AtomicFile output = new AtomicFile(descriptor);
            FileOutputStream stream = null;
            try {
                stream = output.startWrite();
                stream.write(new JSONObject().put("url", url).put("token", renderer.token()).toString().getBytes(StandardCharsets.UTF_8));
                output.finishWrite(stream);
            } catch (Exception error) { if (stream != null) output.failWrite(stream); throw error; }
        } catch (Exception error) {
            if (renderer != null) renderer.stop();
            if (descriptor != null) descriptor.delete();
            text.setText("Renderer QA could not start. Force-stop the app and launch this debug Activity again.");
        }
    }
    @Override protected void onDestroy() {
        if (renderer != null) renderer.stop();
        if (descriptor != null) descriptor.delete();
        super.onDestroy();
    }
}
