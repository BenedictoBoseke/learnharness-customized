package ai.learnharness.mobile;

import android.app.Instrumentation;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.SystemClock;
import android.view.accessibility.AccessibilityNodeInfo;
import android.webkit.WebView;
import org.json.JSONObject;
import java.io.*;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.lang.reflect.Field;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/** Real system picker -> persisted URI -> embedded Node -> original provider file. */
public final class LinkedDocumentTest extends Instrumentation {
 private Context app;private MainActivity activity;private WebView web;private JSONObject runtime;private String phase;
 public void onCreate(Bundle args){phase=args==null?"first":args.getString("phase","first");super.onCreate(args);start();}
 public void onStart(){Bundle b=new Bundle();try{test();b.putString("stream","Linked document "+phase+": PASS\n");finish(-1,b);}catch(Throwable e){b.putString("stream","Linked document "+phase+": FAIL "+e.getClass().getSimpleName()+": "+e.getMessage()+"\n");finish(0,b);}}
 private void test()throws Exception{
  check(Build.HARDWARE.contains("ranchu")||Build.HARDWARE.contains("goldfish"),"Disposable emulator required");app=getTargetContext();
  Intent launch=app.getPackageManager().getLaunchIntentForPackage(app.getPackageName());launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK|Intent.FLAG_ACTIVITY_CLEAR_TASK);activity=(MainActivity)startActivitySync(launch);
  Field f=MainActivity.class.getDeclaredField("web");f.setAccessible(true);web=(WebView)f.get(activity);
  long end=SystemClock.elapsedRealtime()+180000;while(SystemClock.elapsedRealtime()<end){try{runtime=new JSONObject(new String(Files.readAllBytes(new File(app.getNoBackupFilesDir(),"runtime-info.json").toPath()),StandardCharsets.UTF_8));if(api("/api/sync",null).has("configured"))break;}catch(Exception ignored){}SystemClock.sleep(200);}
  check(runtime!=null,"Runtime started");for(int i=0;i<100&&!js("Boolean(window.lh?.documents?.pick)").equals("true");i++)SystemClock.sleep(200);
  File state=new File(app.getNoBackupFilesDir(),"document-qa-state.json");JSONObject saved;
  if(phase.equals("revoke")){
   Uri uri=android.provider.DocumentsContract.buildDocumentUri("ai.learnharness.mobile.test.documents","existing.md");
   app.getContentResolver().releasePersistableUriPermission(uri,Intent.FLAG_GRANT_READ_URI_PERMISSION|Intent.FLAG_GRANT_WRITE_URI_PERMISSION);return;
  }
  if(phase.equals("revoked")){
   saved=new JSONObject(new String(Files.readAllBytes(state.toPath()),StandardCharsets.UTF_8));
   JSONObject cached=api("/api/documents?id="+saved.getString("id"),null);
   check(cached.getJSONObject("document").has("error"),"Revoked access is surfaced");
   check(cached.getString("text").contains("A paragraph written by a person."),"Revoked access preserves cached note");
   JSONObject rebound=pick("existing.md");
   api("/api/documents",new JSONObject().put("op","link").put("documentId",saved.getString("id")).put("chatId",saved.getString("chatId")).put("handle",rebound.getString("handle")).put("kind","android").put("name",rebound.getString("name")).put("writable",rebound.getBoolean("writable")).put("mode","app"));
   check(!api("/api/documents?id="+saved.getString("id"),null).getJSONObject("document").has("error"),"Explicit relink restores access");return;
  }
  if(phase.equals("first")){
   JSONObject chat=api("/api/chats",new JSONObject().put("title","SAF integration QA"));
   JSONObject pick=pick("existing.md");check(pick.optBoolean("persisted"),"SAF permission must be persisted");check(pick.optBoolean("writable"),"Writable grant");
   JSONObject d=api("/api/documents",new JSONObject().put("op","link").put("chatId",chat.getString("id")).put("handle",pick.getString("handle")).put("kind","android").put("name",pick.getString("name")).put("writable",true).put("mode","app"));
   saved=new JSONObject().put("id",d.getString("id")).put("chatId",chat.getString("id"));Files.write(state.toPath(),saved.toString().getBytes(StandardCharsets.UTF_8));
   String before=original();check(before.contains("A paragraph written by a person."),"Original provider note read");
   JSONObject read=api("/api/documents?id="+saved.getString("id"),null);
   JSONObject p=api("/api/documents",new JSONObject().put("op","propose").put("documentId",saved.getString("id")).put("chatId",saved.getString("chatId")).put("baseRevision",read.getJSONObject("document").getString("revision")).put("before","A paragraph written by a person.").put("after","A paragraph edited through the actual Android provider."));
   check(original().equals(before),"Proposal does not write before approval");
   review(saved,p,"apply");check(original().contains("edited through the actual Android provider"),"Apply writes selected original, not imported copy");
   review(saved,p,"undo");check(original().equals(before),"Undo restores original provider file");
   JSONObject ro=pick("read-only.md");
   JSONObject rod=api("/api/documents",new JSONObject().put("op","link").put("chatId",saved.getString("chatId")).put("handle",ro.getString("handle")).put("kind","android").put("name",ro.getString("name")).put("writable",ro.getBoolean("writable")).put("mode","app"));check(!rod.getBoolean("writable"),"Read-only grant stays read-only");JSONObject rp=api("/api/documents",new JSONObject().put("op","propose").put("documentId",rod.getString("id")).put("chatId",saved.getString("chatId")).put("baseRevision",rod.getString("revision")).put("before","A paragraph written by a person.").put("after","Must never be written."));try{review(rod,rp,"apply");throw new AssertionError("Read-only write accepted");}catch(IOException expected){}
  }else{
   saved=new JSONObject(new String(Files.readAllBytes(state.toPath()),StandardCharsets.UTF_8));
   JSONObject read=api("/api/documents?id="+saved.getString("id"),null);check(!read.getJSONObject("document").has("error"),"Persisted binding readable after force-stop");
   check(original().contains("A paragraph written by a person."),"Original permission survives restart");
   JSONObject p=api("/api/documents",new JSONObject().put("op","propose").put("documentId",saved.getString("id")).put("chatId",saved.getString("chatId")).put("baseRevision",read.getJSONObject("document").getString("revision")).put("before","A paragraph written by a person.").put("after","Saved after a process restart."));review(saved,p,"apply");check(original().contains("Saved after a process restart."),"Persisted write grant works after restart");review(saved,p,"undo");
  }
 }
 private void review(JSONObject d,JSONObject p,String action)throws Exception{api("/api/documents",new JSONObject().put("op","review").put("documentId",d.getString("id")).put("proposalId",p.getString("id")).put("action",action));}
 private String original()throws Exception{Uri uri=android.provider.DocumentsContract.buildDocumentUri("ai.learnharness.mobile.test.documents","existing.md");try(InputStream in=app.getContentResolver().openInputStream(uri)){return new String(in.readAllBytes(),StandardCharsets.UTF_8);}}
 private JSONObject pick(String name)throws Exception{
  js("window.__qaPick=null;window.lh.documents.pick().then(p=>window.__qaPick=p);true");
  boolean selected=false;
  for(int i=0;i<60;i++){AccessibilityNodeInfo root=getUiAutomation().getRootInActiveWindow();if(click(root,name)){selected=true;break;}if(!click(root,"LearnHarness QA")&&i==8)click(root,"Show roots");SystemClock.sleep(300);}
  check(selected,"System picker document available");
  for(int i=0;i<100;i++){String value=js("window.__qaPick");if(value.startsWith("{"))return new JSONObject(value);SystemClock.sleep(200);}throw new IOException("System picker did not return document");
 }
 private boolean click(AccessibilityNodeInfo n,String text){if(n==null)return false;if((n.getText()!=null&&text.contentEquals(n.getText()))||(n.getContentDescription()!=null&&text.contentEquals(n.getContentDescription()))){AccessibilityNodeInfo p=n;while(p!=null){if(p.isClickable())return p.performAction(AccessibilityNodeInfo.ACTION_CLICK);p=p.getParent();}}for(int i=0;i<n.getChildCount();i++)if(click(n.getChild(i),text))return true;return false;}
 private String js(String code)throws Exception{String[] result={null};CountDownLatch done=new CountDownLatch(1);runOnMainSync(()->web.evaluateJavascript(code,v->{result[0]=v;done.countDown();}));check(done.await(10,TimeUnit.SECONDS),"WebView script callback");return result[0];}
 private JSONObject api(String route,JSONObject body)throws Exception{
  HttpURLConnection c=(HttpURLConnection)new URL("http://127.0.0.1:"+runtime.getInt("port")+route).openConnection();c.setConnectTimeout(3000);c.setReadTimeout(15000);c.setRequestProperty("x-learnharness-android",runtime.getString("token"));c.setRequestProperty("Origin","http://127.0.0.1:"+runtime.getInt("port"));
  try{if(body!=null){c.setRequestMethod("POST");c.setDoOutput(true);c.setRequestProperty("Content-Type","application/json");try(OutputStream out=c.getOutputStream()){out.write(body.toString().getBytes(StandardCharsets.UTF_8));}}int status=c.getResponseCode();InputStream in=status<400?c.getInputStream():c.getErrorStream();JSONObject b=new JSONObject(new String(in.readAllBytes(),StandardCharsets.UTF_8));if(status>=400)throw new IOException(b.optString("error","API failure"));return b;}finally{c.disconnect();}
 }
 private static void check(boolean valid,String message){if(!valid)throw new AssertionError(message);}
}
