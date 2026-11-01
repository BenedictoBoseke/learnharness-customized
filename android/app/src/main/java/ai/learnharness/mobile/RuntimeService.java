package ai.learnharness.mobile;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.os.Process;
import android.util.AtomicFile;
import android.util.Base64;
import android.webkit.WebView;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

/** One original application runtime in the dedicated :engine process. */
public final class RuntimeService extends Service {
    public static final String ACTION_STOP="ai.learnharness.mobile.STOP_ENGINE";
    private static final String CHANNEL="learning-engine";
    private static final int NOTIFICATION_ID=1701;
    private static final long MAX_EXPANDED_BYTES=2L*1024*1024*1024;
    private static final long MAX_ENTRY_BYTES=256L*1024*1024;
    private static final int MAX_ENTRIES=150000;
    private final AtomicBoolean started=new AtomicBoolean();
    private volatile boolean destroying;
    private volatile boolean nativeAlive;
    private NativeRenderer renderer;
    private String rendererUrl;
    private Thread runtimeThread;
    private int port;
    private String sessionToken;
    private File runtimeRoot;
    private long startupBegan;
    private int extractedFiles;
    private long extractedBytes;

    @Override public void onCreate(){
        super.onCreate();
        if(Build.VERSION.SDK_INT>=28)WebView.setDataDirectorySuffix("engine");
        NotificationManager manager=getSystemService(NotificationManager.class);
        manager.createNotificationChannel(new NotificationChannel(CHANNEL,"Learning engine",NotificationManager.IMPORTANCE_LOW));
    }

    private Notification notification(){
        Intent launch=getPackageManager().getLaunchIntentForPackage(getPackageName());
        Notification.Builder builder=new Notification.Builder(this,CHANNEL)
            .setSmallIcon(android.R.drawable.stat_notify_sync)
            .setContentTitle("LearnHarness")
            .setContentText("Running the local learning engine")
            .setCategory(Notification.CATEGORY_SERVICE).setOngoing(true);
        if(launch!=null)builder.setContentIntent(PendingIntent.getActivity(this,0,launch,PendingIntent.FLAG_UPDATE_CURRENT|PendingIntent.FLAG_IMMUTABLE));
        Intent stop=new Intent(this,RuntimeService.class).setAction(ACTION_STOP);
        builder.addAction(new Notification.Action.Builder(android.R.drawable.ic_menu_close_clear_cancel,"Stop engine",PendingIntent.getService(this,1,stop,PendingIntent.FLAG_UPDATE_CURRENT|PendingIntent.FLAG_IMMUTABLE)).build());
        return builder.build();
    }

    @Override public int onStartCommand(Intent intent,int flags,int startId){
        if(intent!=null&&ACTION_STOP.equals(intent.getAction())){stopSelf();return START_NOT_STICKY;}
        if(Build.VERSION.SDK_INT>=34)startForeground(NOTIFICATION_ID,notification(),ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
        else startForeground(NOTIFICATION_ID,notification());
        if(started.compareAndSet(false,true)){
            runtimeThread=new Thread(this::boot,"LearnHarness-runtime");
            runtimeThread.start();
        }
        return START_STICKY;
    }

    private void boot(){
        try{
            startupBegan=android.os.SystemClock.elapsedRealtime();
            File files=getFilesDir().getCanonicalFile(),cache=getCacheDir().getCanonicalFile();
            requireDirectory(new File(files,"original/data"));
            requireDirectory(new File(files,"original/auth"));
            requireDirectory(new File(cache,"node-compile-cache"));
            runtimeRoot=new File(getNoBackupFilesDir(),"engine-"+BuildConfig.VERSION_CODE);
            writeInfo("extracting",null);
            runtimeRoot=extractApplication();
            if(destroying)return;
            sessionToken=randomToken();port=stablePort();
            writeInfo("starting",null);
            // Construct/start the renderer on the service main thread: it owns WebViews.
            java.util.concurrent.CountDownLatch ready=new java.util.concurrent.CountDownLatch(1);
            java.util.concurrent.atomic.AtomicReference<Throwable> failure=new java.util.concurrent.atomic.AtomicReference<>();
            new android.os.Handler(getMainLooper()).post(()->{
                try{if(destroying)throw new IOException("Engine stopped");renderer=new NativeRenderer(this);rendererUrl=renderer.start()+"/render";}
                catch(Throwable e){failure.set(e);}finally{ready.countDown();}
            });
            if(!ready.await(30,java.util.concurrent.TimeUnit.SECONDS))throw new IOException("Renderer initialization timed out");
            if(failure.get()!=null)throw new IOException("Native renderer initialization failed");
            if(destroying)return;
            writeInfo("starting",null);
            nativeAlive=true;
            int code=NativeRuntime.start(runtimeRoot.getCanonicalPath(),files.getCanonicalPath(),cache.getCanonicalPath(),port,rendererUrl,renderer.token(),sessionToken);
            nativeAlive=false;
            if(!destroying){writeInfo("failed","Learning engine stopped (exit "+code+"). Reopen the app to restart.");stopSelf();}
        }catch(Throwable failure){
            nativeAlive=false;
            try{writeInfo("failed",failure instanceof SecurityException?"Android denied access to the local runtime.":"The local learning engine could not start. Reopen the app or reinstall the APK.");}catch(Exception ignored){}
            if(!destroying)stopSelf();
        }
    }

    private static void requireDirectory(File directory)throws IOException{
        if(!directory.isDirectory()&&!directory.mkdirs())throw new IOException("Could not create private runtime directory");
    }
    private static String randomToken(){byte[] bytes=new byte[32];new SecureRandom().nextBytes(bytes);return Base64.encodeToString(bytes,Base64.NO_WRAP|Base64.URL_SAFE|Base64.NO_PADDING);}
    private int stablePort()throws IOException{
        android.content.SharedPreferences runtime=getSharedPreferences("engine-runtime",MODE_PRIVATE);
        int preferred=runtime.getInt("loopback-port",0),selected=0;
        if(preferred>0&&preferred<=65535){
            try(ServerSocket socket=new ServerSocket()){
                // Match Node/libuv's SO_REUSEADDR policy. A recently closed
                // connection in TIME_WAIT must not force a new WebView origin;
                // an actively listening owner still prevents this bind.
                socket.setReuseAddress(true);socket.bind(new InetSocketAddress(InetAddress.getByName("127.0.0.1"),preferred),1);selected=socket.getLocalPort();
            }catch(IOException occupied){/* A different process owns the saved port; allocate and remember a new origin. */}
        }
        if(selected==0)try(ServerSocket socket=new ServerSocket(0,1,InetAddress.getByName("127.0.0.1"))){selected=socket.getLocalPort();}
        if(!runtime.edit().putInt("loopback-port",selected).commit())throw new IOException("Could not save the runtime port");
        return selected;
    }

    private void writeInfo(String state,String error)throws Exception{
        JSONObject info=new JSONObject().put("state",state).put("port",port).put("token",sessionToken==null?JSONObject.NULL:sessionToken).put("pid",Process.myPid()).put("root",runtimeRoot==null?JSONObject.NULL:runtimeRoot.getCanonicalPath()).put("elapsedMs",Math.max(0,android.os.SystemClock.elapsedRealtime()-startupBegan)).put("extractedFiles",extractedFiles).put("extractedBytes",extractedBytes);
        if(renderer!=null&&rendererUrl!=null)info.put("rendererUrl",rendererUrl).put("rendererToken",renderer.token());
        if(error!=null)info.put("error",error);
        AtomicFile file=new AtomicFile(new File(getNoBackupFilesDir(),"runtime-info.json"));
        FileOutputStream stream=null;
        try{stream=file.startWrite();stream.write(info.toString().getBytes(StandardCharsets.UTF_8));file.finishWrite(stream);}
        catch(Exception e){if(stream!=null)file.failWrite(stream);throw e;}
    }

    private File extractApplication()throws Exception{
        String expected;
        try(InputStream input=getAssets().open("server.sha256")){
            java.io.ByteArrayOutputStream output=new java.io.ByteArrayOutputStream();byte[] buffer=new byte[256];int n;while((n=input.read(buffer))!=-1){if(output.size()+n>1024)throw new IOException("Invalid runtime hash file");output.write(buffer,0,n);}byte[] bytes=output.toByteArray();
            expected=new String(bytes,StandardCharsets.US_ASCII).trim().split("\\s+")[0].toLowerCase(java.util.Locale.ROOT);
        }
        if(!expected.matches("[a-f0-9]{64}"))throw new IOException("Invalid runtime hash");
        File parent=getNoBackupFilesDir().getCanonicalFile();
        // A killed process may leave only reconstructible, uncommitted bundle
        // files. Clean those on the next boot; never touch files/original.
        File[] abandoned=parent.listFiles();
        if(abandoned==null)throw new IOException("Could not inspect runtime directory");
        for(File candidate:abandoned){
            if(destroying)throw new IOException("Engine stopped");
            if(candidate.getName().matches("engine-[0-9]+-extract-[a-f0-9-]{36}"))deleteRuntimeTree(parent,candidate);
            // Installed APK upgrades retire the old engine process. These are
            // reconstructible bundles only; original files/auth/grants are elsewhere.
            else if(candidate.getName().matches("engine-[0-9]+")&&!candidate.getName().equals("engine-"+BuildConfig.VERSION_CODE))deleteRuntimeTree(parent,candidate);
        }
        String version="engine-"+BuildConfig.VERSION_CODE;
        File target=new File(parent,version);
        File marker=new File(target,".server-sha256");
        if(target.isDirectory()&&marker.isFile()&&marker.length()<=1024&&new String(Files.readAllBytes(marker.toPath()),StandardCharsets.US_ASCII).trim().equals(expected)&&new File(target,"mobile/bootstrap.mjs").isFile())return target;
        MessageDigest digest=MessageDigest.getInstance("SHA-256");
        try(InputStream input=getAssets().open("server.zip")){byte[] buffer=new byte[65536];int n;while((n=input.read(buffer))!=-1){if(destroying)throw new IOException("Engine stopped");digest.update(buffer,0,n);}}
        StringBuilder actual=new StringBuilder();for(byte b:digest.digest())actual.append(String.format(java.util.Locale.ROOT,"%02x",b&255));
        if(!actual.toString().equals(expected))throw new IOException("Runtime archive integrity check failed");
        File temporary=new File(parent,version+"-extract-"+UUID.randomUUID());requireDirectory(temporary);
        boolean complete=false;
        try{
            String canonicalRoot=temporary.getCanonicalPath()+File.separator;
            long total=0,lastProgress=android.os.SystemClock.elapsedRealtime();int count=0;
            try(ZipInputStream zip=new ZipInputStream(getAssets().open("server.zip"))){
                ZipEntry entry;byte[] buffer=new byte[65536];
                while((entry=zip.getNextEntry())!=null){
                    if(destroying)throw new IOException("Engine stopped");
                    String name=entry.getName();
                    if(++count>MAX_ENTRIES||name.isEmpty()||name.indexOf('\\')>=0||name.indexOf('\0')>=0||name.startsWith("/")||name.matches("^[A-Za-z]:.*"))throw new IOException("Invalid archive entry");
                    File output=new File(temporary,name);
                    if(!output.getCanonicalPath().startsWith(canonicalRoot))throw new IOException("Archive entry escapes runtime directory");
                    if(entry.isDirectory()){requireDirectory(output);zip.closeEntry();continue;}
                    if(entry.getSize()>MAX_ENTRY_BYTES)throw new IOException("Runtime entry exceeds size budget");
                    requireDirectory(output.getParentFile());
                    long bytes=0;
                    try(FileOutputStream stream=new FileOutputStream(output)){int n;while((n=zip.read(buffer))!=-1){bytes+=n;total+=n;if(bytes>MAX_ENTRY_BYTES||total>MAX_EXPANDED_BYTES)throw new IOException("Runtime archive exceeds size budget");stream.write(buffer,0,n);}}
                    extractedFiles++;extractedBytes=total;
                    long progress=android.os.SystemClock.elapsedRealtime();
                    if(progress-lastProgress>=1500){writeInfo("extracting",null);lastProgress=progress;}
                    zip.closeEntry();
                }
            }
            if(!new File(temporary,"mobile/bootstrap.mjs").isFile()||!new File(temporary,"server.js").isFile())throw new IOException("Runtime archive is incomplete");
            try(FileOutputStream stream=new FileOutputStream(new File(temporary,".server-sha256"))){stream.write(expected.getBytes(StandardCharsets.US_ASCII));stream.getFD().sync();}
            if(target.exists())deleteRuntimeTree(parent,target);
            if(!temporary.renameTo(target))throw new IOException("Could not commit extracted runtime");
            complete=true;return target;
        }finally{if(!complete)deleteRuntimeTree(parent,temporary);}
    }

    private static void deleteRuntimeTree(File parent,File target)throws IOException{
        String parentPath=parent.getCanonicalPath()+File.separator,targetPath=target.getCanonicalPath();
        if(!targetPath.startsWith(parentPath)||!target.getName().startsWith("engine-"))throw new IOException("Refusing unsafe runtime cleanup");
        deleteEntry(target,parentPath);
    }
    private static void deleteEntry(File target,String parentPath)throws IOException{
        if(Files.isSymbolicLink(target.toPath())){Files.deleteIfExists(target.toPath());return;}
        if(!target.getCanonicalPath().startsWith(parentPath))throw new IOException("Runtime cleanup escapes private directory");
        if(target.isDirectory()){File[] children=target.listFiles();if(children==null)throw new IOException("Could not enumerate runtime cleanup");for(File child:children)deleteEntry(child,parentPath);}
        Files.deleteIfExists(target.toPath());
    }

    @Override public void onDestroy(){
        destroying=true;
        if(renderer!=null)try{renderer.stop();}catch(Exception ignored){}
        stopForeground(STOP_FOREGROUND_REMOVE);
        super.onDestroy();
        // The manifest puts this service in :engine. Never kill the Activity process.
        // Even a naturally exited Node cannot be initialized twice. Retire this
        // dedicated process after its runtime stops; next start gets a fresh VM.
        // Retire even before native startup: an extraction worker from this
        // service must not race a new service instance in the same process.
        if(isEngineProcess()){
            if(nativeAlive){
                new Thread(()->{
                    requestGracefulStop();
                    try{Thread.sleep(350);}catch(InterruptedException ignored){Thread.currentThread().interrupt();}
                    Process.killProcess(Process.myPid());
                },"LearnHarness-stop").start();
            }else Process.killProcess(Process.myPid());
        }
    }
    private void requestGracefulStop(){
        if(port<1024||sessionToken==null)return;
        HttpURLConnection connection=null;
        try{
            connection=(HttpURLConnection)new URL("http://127.0.0.1:"+port+"/__android/stop").openConnection();
            connection.setInstanceFollowRedirects(false);
            connection.setRequestMethod("POST");
            connection.setRequestProperty("x-learnharness-android",sessionToken);
            connection.setConnectTimeout(300);connection.setReadTimeout(500);
            // The original synchronous store writes finish before the local
            // stop handler runs. It schedules process.exit on a later turn.
            connection.getResponseCode();
        }catch(IOException ignored){/* A stalled engine still has a bounded hard-stop fallback. */}
        finally{if(connection!=null)connection.disconnect();}
    }
    private boolean isEngineProcess(){
        String expected=getPackageName()+":engine";
        if(Build.VERSION.SDK_INT>=28)return expected.equals(android.app.Application.getProcessName());
        android.app.ActivityManager manager=getSystemService(android.app.ActivityManager.class);
        java.util.List<android.app.ActivityManager.RunningAppProcessInfo> processes=manager==null?null:manager.getRunningAppProcesses();
        if(processes!=null)for(android.app.ActivityManager.RunningAppProcessInfo process:processes)if(process.pid==Process.myPid())return expected.equals(process.processName);
        return false;
    }
    @Override public IBinder onBind(Intent intent){return null;}
}
