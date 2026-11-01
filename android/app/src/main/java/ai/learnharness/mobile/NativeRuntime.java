package ai.learnharness.mobile;

/** Blocking Node entry point. Run once, in RuntimeService's dedicated process. */
public final class NativeRuntime {
    static {
        android.util.Log.i("LearnHarnessRuntime","Loading embedded Node library");
        System.loadLibrary("node");
        android.util.Log.i("LearnHarnessRuntime","Embedded Node library loaded; loading JNI host");
        System.loadLibrary("learnharness-runtime");
        android.util.Log.i("LearnHarnessRuntime","JNI host loaded");
    }

    private NativeRuntime() {}

    /** Returns only when Node exits. Arguments contain paths/capabilities, never provider credentials. */
    public static native int start(String root, String privateRoot, String cacheDir, int port,
                                   String renderUrl, String renderToken, String sessionToken);
}
