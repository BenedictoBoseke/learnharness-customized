package ai.learnharness.mobile;

import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.Process;
import android.os.SystemClock;
import android.system.ErrnoException;
import android.system.Os;
import android.system.OsConstants;
import android.app.Instrumentation;
import android.os.Bundle;
import org.json.JSONObject;
import java.io.File;
import java.io.IOException;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.UUID;

/** Real embedded-Node lifecycle regression; intentionally restricted to an emulator. */
public class RuntimeLifecycleTest extends Instrumentation {
    private Context app;

    @Override public void onCreate(Bundle arguments){super.onCreate(arguments);start();}
    @Override public void onStart(){
        Bundle result=new Bundle();
        try{
            testStopRestartKeepsOriginAndLibraryButRotatesCapabilities();
            result.putString("stream","Runtime lifecycle: PASS (stop, restart, PID isolation, stable origin, token rotation, library fixture)\n");
            finish(android.app.Activity.RESULT_OK,result);
        }catch(Throwable failure){
            // Assertion messages contain only test labels, never capabilities.
            result.putString("stream","Runtime lifecycle: FAIL: "+failure.getClass().getSimpleName()+": "+failure.getMessage()+"\n");
            finish(android.app.Activity.RESULT_CANCELED,result);
        }
    }

    public void testStopRestartKeepsOriginAndLibraryButRotatesCapabilities()throws Exception{
        assertTrue("Run this lifecycle test only on a test emulator",Build.HARDWARE.contains("ranchu")||Build.HARDWARE.contains("goldfish"));
        app=getTargetContext();
        Intent launch=app.getPackageManager().getLaunchIntentForPackage(app.getPackageName());
        assertNotNull(launch);
        launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        app.startActivity(launch);
        Intent service=new Intent(app,RuntimeService.class);
        app.startForegroundService(service);
        JSONObject before=awaitReady(0,180000);
        int mainPid=Process.myPid(),oldPid=before.getInt("pid"),oldPort=before.getInt("port");
        assertTrue("Node must run outside the Activity process",oldPid!=mainPid);
        File fixture=new File(app.getFilesDir(),"original/attachments/runtime-lifecycle-"+UUID.randomUUID()+".txt");
        assertTrue(fixture.getParentFile().isDirectory()||fixture.getParentFile().mkdirs());
        final String content="Invented lifecycle test attachment\n";
        Files.write(fixture.toPath(),content.getBytes(StandardCharsets.UTF_8));
        File abandoned=new File(app.getNoBackupFilesDir(),"engine-100-extract-"+UUID.randomUUID());
        assertTrue(abandoned.mkdir());
        File partial=new File(abandoned,"partial-bundle-fixture");
        Files.write(partial.toPath(),new byte[]{1,2,3});
        try{
            // Repeated start commands must reuse the one native runtime.
            app.startForegroundService(service);app.startForegroundService(service);
            SystemClock.sleep(300);
            JSONObject same=awaitReady(0,5000);
            assertEquals(oldPid,same.getInt("pid"));
            assertTrue("Repeated starts preserve the active capability",before.getString("token").equals(same.getString("token")));
            assertTrue(app.stopService(service));
            long deadline=SystemClock.elapsedRealtime()+6000;
            while(alive(oldPid)&&SystemClock.elapsedRealtime()<deadline)SystemClock.sleep(50);
            assertFalse("Stopped Node process must retire before a restart",alive(oldPid));
            assertEquals("Stopping the engine must preserve the Activity process",mainPid,Process.myPid());
            app.startForegroundService(service);
            JSONObject after=awaitReady(oldPid,30000);
            assertTrue("Restart must use a fresh native process",oldPid!=after.getInt("pid"));
            assertEquals("Stable loopback origin preserves browser storage",oldPort,after.getInt("port"));
            assertFalse("Per-start session capability must rotate",before.getString("token").equals(after.getString("token")));
            assertEquals("Old capability must be rejected",403,health(oldPort,before.getString("token")));
            assertEquals(content,new String(Files.readAllBytes(fixture.toPath()),StandardCharsets.UTF_8));
            assertFalse("Next boot removes an abandoned immutable extraction",abandoned.exists());
        }finally{Files.deleteIfExists(fixture.toPath());Files.deleteIfExists(partial.toPath());Files.deleteIfExists(abandoned.toPath());}
    }

    private JSONObject awaitReady(int previousPid,long timeout)throws Exception{
        long deadline=SystemClock.elapsedRealtime()+timeout;
        File info=new File(app.getNoBackupFilesDir(),"runtime-info.json");
        while(SystemClock.elapsedRealtime()<deadline){
            try{
                JSONObject state=new JSONObject(new String(Files.readAllBytes(info.toPath()),StandardCharsets.UTF_8));
                int pid=state.optInt("pid"),port=state.optInt("port");
                String token=state.optString("token","");
                if(pid>0&&pid!=previousPid&&port>=1024&&token.length()>=43&&alive(pid)&&health(port,token)==200)return state;
            }catch(Exception ignored){}
            SystemClock.sleep(100);
        }
        throw new IOException("Local runtime did not become healthy within its startup budget");
    }
    private int health(int port,String token)throws IOException{
        HttpURLConnection request=(HttpURLConnection)new URL("http://127.0.0.1:"+port+"/__android/health").openConnection();
        try{
            request.setRequestProperty("x-learnharness-android",token);
            request.setInstanceFollowRedirects(false);request.setConnectTimeout(500);request.setReadTimeout(500);
            return request.getResponseCode();
        }finally{request.disconnect();}
    }
    private boolean alive(int pid){
        try{Os.kill(pid,0);return true;}
        catch(ErrnoException absent){return absent.errno!=OsConstants.ESRCH;}
    }
    private static void assertTrue(String message,boolean value){if(!value)throw new AssertionError(message);}
    private static void assertTrue(boolean value){assertTrue("Expected true",value);}
    private static void assertFalse(String message,boolean value){assertTrue(message,!value);}
    private static void assertNotNull(Object value){assertTrue("Expected a launch intent",value!=null);}
    private static void assertEquals(Object expected,Object actual){assertTrue("Fixture values differ",expected.equals(actual));}
    private static void assertEquals(String message,int expected,int actual){assertTrue(message,expected==actual);}
}
