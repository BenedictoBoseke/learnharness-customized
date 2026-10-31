package ai.learnharness.mobile;

import android.app.Instrumentation;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.SystemClock;
import org.json.JSONObject;
import java.io.*;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.util.*;
import java.util.zip.*;

/** Exercises the actual Activity export/restore implementation with invented fixtures. */
public final class LibraryRestoreTest extends RuntimeLifecycleTest {
    private Context app;
    private MainActivity activity;
    private Method restore,addArchive;
    private final List<String> passed=new ArrayList<>();
    private boolean lifecycleOnly;
    @Override public void onCreate(Bundle args){lifecycleOnly=args!=null&&"lifecycle".equals(args.getString("suite"));super.onCreate(args);}
    @Override public void onStart(){
        if(lifecycleOnly){super.onStart();return;}
        Bundle result=new Bundle();
        try{
            runRestoreRegression();
            result.putString("stream","Library restore: PASS ("+String.join(", ",passed)+")\n");
            finish(android.app.Activity.RESULT_OK,result);
        }catch(Throwable failure){
            // Never print file contents, auth digests, or session capabilities.
            result.putString("stream","Library restore: FAIL: "+failure.getClass().getSimpleName()+": "+failure.getMessage()+"\n");
            finish(android.app.Activity.RESULT_CANCELED,result);
        }
    }
    private void runRestoreRegression()throws Exception{
        check(Build.HARDWARE.contains("ranchu")||Build.HARDWARE.contains("goldfish"),"Run only on a disposable test emulator");
        app=getTargetContext();
        Intent launch=app.getPackageManager().getLaunchIntentForPackage(app.getPackageName());
        check(launch!=null,"Application launch intent missing");
        launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        activity=(MainActivity)startActivitySync(launch);
        restore=MainActivity.class.getDeclaredMethod("restore",Uri.class);restore.setAccessible(true);
        addArchive=MainActivity.class.getDeclaredMethod("addArchive",ZipOutputStream.class,File.class,String.class);addArchive.setAccessible(true);
        JSONObject initial=awaitReady(0,180000);awaitActivityPid(initial.getInt("pid"));
        stopEngine();waitDead(initial.getInt("pid"));
        File original=new File(app.getFilesDir(),"original"),auth=new File(original,"auth");
        Map<String,String> authBefore=hashTree(auth);
        String id=UUID.randomUUID().toString();
        String fixtureName="restore-regression-"+id+".txt",laterName="restore-later-"+id+".txt";
        File fixture=new File(original,"attachments/"+fixtureName),later=new File(original,"attachments/"+laterName);
        check(fixture.getParentFile().isDirectory()||fixture.getParentFile().mkdirs(),"Fixture directory unavailable");
        File backup=new File(app.getCacheDir(),"backup-regression-"+id+".zip"),bad=new File(app.getCacheDir(),"invalid-backup-"+id+".zip");
        File escaped=new File(app.getCacheDir(),"escape-regression-"+id);
        String beforeText="Invented attachment before native backup\n",afterText="Invented attachment modified after native backup\n";
        Set<String> cacheBefore=directoryNames(app.getCacheDir(),"restore-");
        try{
            Files.write(fixture.toPath(),beforeText.getBytes(StandardCharsets.UTF_8));
            try(ZipOutputStream zip=new ZipOutputStream(new FileOutputStream(backup))){
                addArchive.invoke(activity,zip,new File(original,"data"),"data/");
                addArchive.invoke(activity,zip,new File(original,"attachments"),"attachments/");
            }
            try(ZipFile zip=new ZipFile(backup)){
                check(zip.getEntry("data/")!=null,"Native export must retain the learning-data directory");
                check(zip.getEntry("attachments/"+fixtureName)!=null,"Native export omitted the attachment fixture");
                Enumeration<? extends ZipEntry> entries=zip.entries();
                while(entries.hasMoreElements()){
                    String name=entries.nextElement().getName();
                    check(name.startsWith("data/")||name.startsWith("attachments/"),"Native library export included a path outside its data boundary");
                }
            }
            passed.add("native archive export");
            Files.write(fixture.toPath(),afterText.getBytes(StandardCharsets.UTF_8));
            Files.write(later.toPath(),"Invented post-backup attachment\n".getBytes(StandardCharsets.UTF_8));
            Map<String,String> previousLibrary=libraryHashes(original);
            Set<String> archivesBefore=directoryNames(original,"pre-restore-");
            restore.invoke(activity,Uri.fromFile(backup)); // Instrumentation thread, never the UI thread.
            check(!new File("/proc/"+initial.getInt("pid")).exists(),"Restore committed before the old engine retired");
            check(beforeText.equals(new String(Files.readAllBytes(fixture.toPath()),StandardCharsets.UTF_8)),"Restored attachment differs from the exported fixture");
            check(!later.exists(),"Restore retained a post-backup attachment in the active library");
            Set<String> newArchives=directoryNames(original,"pre-restore-");newArchives.removeAll(archivesBefore);
            check(newArchives.size()==1,"Restore did not create exactly one previous-library archive");
            File previous=new File(original,newArchives.iterator().next());
            check(previousLibrary.equals(libraryHashes(previous)),"The archived previous library differs from the pre-restore library");
            check(afterText.equals(new String(Files.readAllBytes(new File(previous,"attachments/"+fixtureName).toPath()),StandardCharsets.UTF_8)),"Previous library did not preserve the changed attachment");
            check(authBefore.equals(hashTree(auth)),"Restoration changed account connection files");
            passed.add("attachment roundtrip");passed.add("previous-library archive");passed.add("auth hash unchanged");
            JSONObject restarted=awaitReady(initial.getInt("pid"),30000);awaitActivityPid(restarted.getInt("pid"));
            stopEngine();waitDead(restarted.getInt("pid"));
            Map<String,String> validLibrary=libraryHashes(original);
            Set<String> beforeInvalid=directoryNames(original,"pre-restore-");
            try(ZipOutputStream zip=new ZipOutputStream(new FileOutputStream(bad))){
                zip.putNextEntry(new ZipEntry("data/"));zip.closeEntry();
                zip.putNextEntry(new ZipEntry("data/not-installed-fixture.txt"));zip.write(new byte[]{1,2,3});zip.closeEntry();
                zip.putNextEntry(new ZipEntry("data/../../"+escaped.getName()));zip.write(new byte[]{4,5,6});zip.closeEntry();
            }
            restore.invoke(activity,Uri.fromFile(bad));
            check(!escaped.exists(),"Traversal ZIP wrote outside its staging directory");
            check(validLibrary.equals(libraryHashes(original)),"Rejected traversal ZIP changed the current library");
            check(beforeInvalid.equals(directoryNames(original,"pre-restore-")),"Rejected traversal ZIP archived or replaced the current library");
            check(authBefore.equals(hashTree(auth)),"Rejected traversal ZIP changed account connection files");
            passed.add("traversal rejected without mutation");
            awaitReady(restarted.getInt("pid"),30000);
        }finally{
            Files.deleteIfExists(fixture.toPath());Files.deleteIfExists(later.toPath());
            Files.deleteIfExists(backup.toPath());Files.deleteIfExists(bad.toPath());
            // Remove only staging directories created by this runner. Existing
            // staging attempts and the archived actual library remain untouched.
            Set<String> ownStages=directoryNames(app.getCacheDir(),"restore-");ownStages.removeAll(cacheBefore);
            for(String name:ownStages)deleteStage(new File(app.getCacheDir(),name),app.getCacheDir().getCanonicalPath()+File.separator);
        }
    }
    private void stopEngine(){app.stopService(new Intent(app,RuntimeService.class));}
    private void waitDead(int pid)throws Exception{
        long deadline=SystemClock.elapsedRealtime()+7000;
        while(new File("/proc/"+pid).exists()&&SystemClock.elapsedRealtime()<deadline)SystemClock.sleep(50);
        check(!new File("/proc/"+pid).exists(),"Stopped engine did not retire");
    }
    private void awaitActivityPid(int wanted)throws Exception{
        Field field=MainActivity.class.getDeclaredField("runtimePid");field.setAccessible(true);
        long deadline=SystemClock.elapsedRealtime()+10000;
        while(SystemClock.elapsedRealtime()<deadline){
            int[] actual={0};runOnMainSync(()->{try{actual[0]=field.getInt(activity);}catch(Exception ignored){}});
            if(actual[0]==wanted)return;SystemClock.sleep(100);
        }
        throw new AssertionError("Activity did not attach to the healthy engine");
    }
    private JSONObject awaitReady(int previousPid,long timeout)throws Exception{
        long deadline=SystemClock.elapsedRealtime()+timeout;
        while(SystemClock.elapsedRealtime()<deadline){
            try{
                JSONObject state=new JSONObject(new String(Files.readAllBytes(new File(app.getNoBackupFilesDir(),"runtime-info.json").toPath()),StandardCharsets.UTF_8));
                int pid=state.optInt("pid"),port=state.optInt("port");String token=state.optString("token","");
                if(pid>0&&pid!=previousPid&&port>=1024&&token.length()>=43&&new File("/proc/"+pid).exists()){
                    HttpURLConnection request=(HttpURLConnection)new URL("http://127.0.0.1:"+port+"/__android/health").openConnection();
                    try{request.setRequestProperty("x-learnharness-android",token);request.setConnectTimeout(500);request.setReadTimeout(500);if(request.getResponseCode()==200)return state;}finally{request.disconnect();}
                }
            }catch(Exception ignored){}
            SystemClock.sleep(100);
        }
        throw new IOException("Local runtime did not become ready");
    }
    private Map<String,String> libraryHashes(File original)throws Exception{
        Map<String,String> hashes=new TreeMap<>();
        for(String name:new String[]{"data","attachments"})for(Map.Entry<String,String> entry:hashTree(new File(original,name)).entrySet())hashes.put(name+"/"+entry.getKey(),entry.getValue());
        return hashes;
    }
    private Map<String,String> hashTree(File root)throws Exception{
        Map<String,String> hashes=new TreeMap<>();if(root.exists())hashFiles(root,root,hashes);return hashes;
    }
    private void hashFiles(File root,File entry,Map<String,String> output)throws Exception{
        check(!Files.isSymbolicLink(entry.toPath()),"Unexpected symlink in test library");
        if(entry.isDirectory()){
            File[] children=entry.listFiles();check(children!=null,"Library directory could not be enumerated");
            for(File child:children)hashFiles(root,child,output);
        }else{
            MessageDigest digest=MessageDigest.getInstance("SHA-256");
            try(InputStream input=new FileInputStream(entry)){byte[] bytes=new byte[65536];int n;while((n=input.read(bytes))!=-1)digest.update(bytes,0,n);}
            output.put(root.toPath().relativize(entry.toPath()).toString(),Base64.getEncoder().encodeToString(digest.digest()));
        }
    }
    private Set<String> directoryNames(File root,String prefix){
        Set<String> names=new HashSet<>();File[] files=root.listFiles();if(files!=null)for(File file:files)if(file.isDirectory()&&file.getName().startsWith(prefix))names.add(file.getName());return names;
    }
    private void deleteStage(File entry,String parent)throws Exception{
        check(entry.getCanonicalPath().startsWith(parent),"Refusing staging cleanup outside private cache");
        if(!Files.isSymbolicLink(entry.toPath())&&entry.isDirectory()){File[] children=entry.listFiles();check(children!=null,"Cannot inspect test staging directory");for(File child:children)deleteStage(child,parent);}
        Files.deleteIfExists(entry.toPath());
    }
    private static void check(boolean condition,String message){if(!condition)throw new AssertionError(message);}
}
