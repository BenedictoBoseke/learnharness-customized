package ai.learnharness.mobile;

import android.Manifest;
import android.app.*;
import android.content.*;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.*;
import android.provider.OpenableColumns;
import android.view.*;
import android.webkit.*;
import android.webkit.CookieManager;
import android.widget.*;
import org.json.*;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.*;
import java.util.concurrent.*;
import java.util.zip.*;

/** Android host for the ORIGINAL local LearnHarness server and UI. */
public class MainActivity extends Activity {
 private final Handler handler=new Handler(Looper.getMainLooper());
 private final ExecutorService io=Executors.newSingleThreadExecutor();
 private WebView web;private TextView status;private String origin,sessionToken;private int runtimePid;
 private boolean destroyed,loaded;private volatile boolean trustedDocument;private PermissionRequest pendingAudio;private ValueCallback<Uri[]> chooser;
 private static final int ATTACH=71,EXPORT=72,RESTORE=73,LEGACY=74,AUDIO=75,WEB_FILE=76,LINK_MARKDOWN=77;
 private volatile String documentRequest;private volatile String documentKind="markdown";
 private long startupAt;

 @android.annotation.SuppressLint("SetJavaScriptEnabled")
 @Override public void onCreate(Bundle saved){super.onCreate(saved);
  // One inset owner: Android 11+ lays out edge-to-edge, then the root applies
  // the union of bars/cutout/IME once. Older Android keeps framework resize.
  if(Build.VERSION.SDK_INT>=30){getWindow().setDecorFitsSystemWindows(false);getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_NOTHING);}
  LinearLayout root=new LinearLayout(this);root.setOrientation(LinearLayout.VERTICAL);root.setBackgroundColor(Color.rgb(20,20,20));setContentView(root);
  LinearLayout bar=new LinearLayout(this);bar.setGravity(Gravity.CENTER_VERTICAL);bar.setPadding(10,0,8,0);root.addView(bar,new LinearLayout.LayoutParams(-1,dp(52)));
  status=new TextView(this);status.setTextColor(Color.LTGRAY);status.setTextSize(12);status.setText("Preparing LearnHarness…");bar.addView(status,new LinearLayout.LayoutParams(0,-2,1));
  Button attach=new Button(this);attach.setText("Attach");attach.setTextSize(11);attach.setMinHeight(0);bar.addView(attach,new LinearLayout.LayoutParams(dp(78),dp(48)));attach.setOnClickListener(v->pick(ATTACH));
  Button more=new Button(this);more.setText("⋮");more.setContentDescription("More options");more.setTextSize(20);more.setMinWidth(0);more.setMinHeight(0);bar.addView(more,new LinearLayout.LayoutParams(dp(48),dp(48)));more.setOnClickListener(v->menu(more));
  web=new WebView(this);web.setBackgroundColor(Color.rgb(20,20,20));root.addView(web,new LinearLayout.LayoutParams(-1,0,1));
  WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG);
  WebSettings ws=web.getSettings();ws.setJavaScriptEnabled(true);ws.setDomStorageEnabled(true);ws.setAllowFileAccess(false);ws.setAllowContentAccess(false);ws.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);ws.setMediaPlaybackRequiresUserGesture(true);
  CookieManager.getInstance().setAcceptCookie(true);CookieManager.getInstance().setAcceptThirdPartyCookies(web,false);
  web.addJavascriptInterface(new AndroidHost(),"AndroidHost");
  web.setWebViewClient(new WebViewClient(){
   @Override public void onPageStarted(WebView w,String url,android.graphics.Bitmap icon){trustedDocument=isApp(Uri.parse(url));}
   @Override public boolean shouldOverrideUrlLoading(WebView w,WebResourceRequest r){if(isApp(r.getUrl()))return false;if(r.isForMainFrame()&&r.hasGesture()&&"https".equals(r.getUrl().getScheme())){try{startActivity(new Intent(Intent.ACTION_VIEW,r.getUrl()).addCategory(Intent.CATEGORY_BROWSABLE));}catch(Exception e){notice("No browser available.");}}return true;}
   @Override public void onPageFinished(WebView w,String url){trustedDocument=isApp(Uri.parse(url));if(trustedDocument){status.setText("LearnHarness · on this device");root.requestApplyInsets();}}
   @Override public void onReceivedError(WebView w,WebResourceRequest r,WebResourceError e){if(r.isForMainFrame())status.setText("Local engine unavailable · use Restart");}
  });
  web.setWebChromeClient(new WebChromeClient(){
   @Override public void onPermissionRequest(PermissionRequest request){runOnUiThread(()->{if(origin==null||!request.getOrigin().toString().equals(origin+"/")&&!request.getOrigin().toString().equals(origin)){request.deny();return;}if(!Arrays.asList(request.getResources()).contains(PermissionRequest.RESOURCE_AUDIO_CAPTURE)){request.deny();return;}pendingAudio=request;if(checkSelfPermission(Manifest.permission.RECORD_AUDIO)==PackageManager.PERMISSION_GRANTED){request.grant(new String[]{PermissionRequest.RESOURCE_AUDIO_CAPTURE});pendingAudio=null;}else requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO},AUDIO);});}
   @Override public void onPermissionRequestCanceled(PermissionRequest r){if(pendingAudio==r)pendingAudio=null;}
   @Override public boolean onShowFileChooser(WebView w,ValueCallback<Uri[]> callback,FileChooserParams params){if(chooser!=null)chooser.onReceiveValue(null);chooser=callback;pick(WEB_FILE);return true;}
  });
  if(Build.VERSION.SDK_INT>=33)getOnBackInvokedDispatcher().registerOnBackInvokedCallback(android.window.OnBackInvokedDispatcher.PRIORITY_DEFAULT,this::back);
  if(Build.VERSION.SDK_INT>=30)root.setOnApplyWindowInsetsListener((v,insets)->{android.graphics.Insets i=insets.getInsets(WindowInsets.Type.systemBars()|WindowInsets.Type.displayCutout()|WindowInsets.Type.ime());boolean compact=insets.isVisible(WindowInsets.Type.ime())&&getResources().getConfiguration().orientation==android.content.res.Configuration.ORIENTATION_LANDSCAPE;v.setPadding(i.left,i.top,i.right,i.bottom);bar.setVisibility(compact?View.GONE:View.VISIBLE);if(trustedDocument)web.evaluateJavascript("document.documentElement.toggleAttribute('data-lh-compact-ime',"+compact+")",null);return WindowInsets.CONSUMED;});
  root.requestApplyInsets();
  startEngine();
 }
 private int dp(int n){return Math.round(n*getResources().getDisplayMetrics().density);}
 private boolean isApp(Uri u){return origin!=null&&origin.equals(u.getScheme()+"://"+u.getAuthority());}
 private void notice(String message){runOnUiThread(()->Toast.makeText(this,message,Toast.LENGTH_LONG).show());}
 private void startEngine(){loaded=false;startupAt=System.currentTimeMillis();status.setText("Starting original learning engine…");try{startForegroundService(new Intent(this,RuntimeService.class));}catch(Exception e){status.setText("Engine could not start: "+e.getClass().getSimpleName());return;}poll();}
 private void poll(){if(destroyed||loaded)return;if(System.currentTimeMillis()-startupAt>180000){status.setText("Engine startup timed out · use Restart");return;}
  io.execute(()->{try{File info=new File(getNoBackupFilesDir(),"runtime-info.json");if(info.isFile()){
    JSONObject data=new JSONObject(new String(Files.readAllBytes(info.toPath()),StandardCharsets.UTF_8));
    if("failed".equals(data.optString("state"))){runOnUiThread(()->status.setText("Engine failed: "+data.optString("error","use Restart")));return;}
    if("extracting".equals(data.optString("state"))){int count=data.optInt("extractedFiles");runOnUiThread(()->status.setText("Preparing original app… "+count+" files"));handler.postDelayed(this::poll,400);return;}
    int port=data.getInt("port");String token=data.getString("token"),base="http://127.0.0.1:"+port;
    HttpURLConnection c=(HttpURLConnection)new URL(base+"/__android/health").openConnection();c.setRequestProperty("x-learnharness-android",token);c.setConnectTimeout(600);c.setReadTimeout(600);
    int code=c.getResponseCode();String body=new String(read(c.getInputStream(),65536),StandardCharsets.UTF_8);c.disconnect();
    if(code==200&&new JSONObject(body).optBoolean("ready")){runOnUiThread(()->{if(destroyed)return;origin=base;sessionToken=token;runtimePid=data.optInt("pid");loaded=true;CookieManager.getInstance().setCookie(origin,"lh_android_session="+token+"; Path=/; HttpOnly; SameSite=Strict",ok->{CookieManager.getInstance().flush();web.loadUrl(origin+"/");});});return;}
   }}catch(Exception ignored){}handler.postDelayed(this::poll,400);
  });
 }
 private void menu(View anchor){PopupMenu menu=new PopupMenu(this,anchor);for(String label:new String[]{"Reload page","Restart engine","Export learning library","Restore learning library","Export previous Android data","About this port"})menu.getMenu().add(label);menu.setOnMenuItemClickListener(item->{switch(item.getTitle().toString()){
  case "Reload page":web.reload();break;
  case "Restart engine":restart();break;
  case "Export learning library":createDocument(EXPORT,"application/zip","learnharness-library.zip");break;
  case "Restore learning library":new AlertDialog.Builder(this).setTitle("Restore learning library?").setMessage("The current library will be archived on this device before restoration. Saved account connections are preserved.").setNegativeButton("Cancel",null).setPositiveButton("Choose archive",(d,w)->pick(RESTORE)).show();break;
  case "Export previous Android data":createDocument(LEGACY,"application/json","learnharness-previous-android.json");break;
  default:new AlertDialog.Builder(this).setTitle("LearnHarness for Android").setMessage("Customized LearnHarness 0.4.1 application, running locally in embedded Node "+"24.22.1"+". Android host "+BuildConfig.VERSION_NAME+". AGPL-3.0-only. Your provider connections and browser sign-ins are managed by the original app.").setPositiveButton("Close",null).show();
  }return true;});menu.show();}
 private void restart(){stopService(new Intent(this,RuntimeService.class));loaded=false;status.setText("Restarting engine…");handler.postDelayed(this::startEngine,1600);}
 private void pick(int kind){try{Intent i=new Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*");if(kind==ATTACH)i.putExtra(Intent.EXTRA_ALLOW_MULTIPLE,true);startActivityForResult(i,kind);}catch(Exception e){notice("No document picker available.");}}
 private void createDocument(int kind,String mime,String name){try{startActivityForResult(new Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType(mime).putExtra(Intent.EXTRA_TITLE,name),kind);}catch(Exception e){notice("No document provider available.");}}
 private byte[] read(InputStream source,int limit)throws IOException{if(source==null)throw new IOException("No content");try(InputStream in=source;ByteArrayOutputStream out=new ByteArrayOutputStream()){byte[] b=new byte[8192];int n;while((n=in.read(b))!=-1){if(out.size()+n>limit)throw new IOException("File exceeds size limit");out.write(b,0,n);}return out.toByteArray();}}
 @Override protected void onActivityResult(int req,int result,Intent data){super.onActivityResult(req,result,data);if(req==LINK_MARKDOWN){completeDocumentPick(result,data);return;}if(req==WEB_FILE){if(chooser!=null){chooser.onReceiveValue(result==RESULT_OK&&data!=null?WebChromeClient.FileChooserParams.parseResult(result,data):null);chooser=null;}return;}if(result!=RESULT_OK||data==null)return;
  if(req==ATTACH){List<Uri> selected=new ArrayList<>();if(data.getClipData()!=null)for(int i=0;i<Math.min(data.getClipData().getItemCount(),16);i++)selected.add(data.getClipData().getItemAt(i).getUri());else if(data.getData()!=null)selected.add(data.getData());io.execute(()->attachFiles(selected));}
  else if(req==EXPORT||req==LEGACY){Uri uri=data.getData();io.execute(()->{try(OutputStream out=getContentResolver().openOutputStream(uri)){if(req==LEGACY){File f=new File(getFilesDir(),"learning.json");if(!f.isFile())throw new IOException("No previous Android library exists");Files.copy(f.toPath(),out);}else try(ZipOutputStream z=new ZipOutputStream(out)){addArchive(z,new File(getFilesDir(),"original/data"),"data/");addArchive(z,new File(getFilesDir(),"original/attachments"),"attachments/");}notice("Export complete.");}catch(Exception e){notice("Export failed: "+e.getMessage());}});}
  else if(req==RESTORE){Uri uri=data.getData();stopService(new Intent(this,RuntimeService.class));loaded=false;status.setText("Restoring library…");io.execute(()->restore(uri));}
 }
 private void completeDocumentPick(int result,Intent data){
  final String requestId=documentRequest,kind=documentKind;documentRequest=null;if(requestId==null||destroyed)return;
  io.execute(()->{JSONObject picked=null;try{if(result==RESULT_OK&&data!=null&&data.getData()!=null){final Uri uri=data.getData();final int grantedFlags=data.getFlags()&(Intent.FLAG_GRANT_READ_URI_PERMISSION|Intent.FLAG_GRANT_WRITE_URI_PERMISSION);final boolean folder=kind.equals("folder");
   boolean persisted=false;try{if((grantedFlags&Intent.FLAG_GRANT_READ_URI_PERMISSION)==0)throw new SecurityException();getContentResolver().takePersistableUriPermission(uri,(grantedFlags&Intent.FLAG_GRANT_WRITE_URI_PERMISSION)!=0?Intent.FLAG_GRANT_READ_URI_PERMISSION|Intent.FLAG_GRANT_WRITE_URI_PERMISSION:Intent.FLAG_GRANT_READ_URI_PERMISSION);persisted=true;}catch(SecurityException ignored){}
   boolean writable=(grantedFlags&Intent.FLAG_GRANT_WRITE_URI_PERMISSION)!=0;String name=folder?"Subject folder":"Learning note.md";
   Uri metadata=folder?android.provider.DocumentsContract.buildDocumentUriUsingTree(uri,android.provider.DocumentsContract.getTreeDocumentId(uri)):uri;
   try(android.database.Cursor cursor=getContentResolver().query(metadata,new String[]{OpenableColumns.DISPLAY_NAME,android.provider.DocumentsContract.Document.COLUMN_FLAGS},null,null,null)){if(cursor!=null&&cursor.moveToFirst()){name=cursor.getString(0);int column=cursor.getColumnIndex(android.provider.DocumentsContract.Document.COLUMN_FLAGS);if(column>=0&&!cursor.isNull(column))writable=writable&&(cursor.getInt(column)&(folder?android.provider.DocumentsContract.Document.FLAG_DIR_SUPPORTS_CREATE:android.provider.DocumentsContract.Document.FLAG_SUPPORTS_WRITE))!=0;}}
   if(name==null||(!folder&&!kind.equals("attachment")&&!name.toLowerCase(java.util.Locale.ROOT).matches(".*\\.(md|markdown)$")))throw new IOException("Choose a Markdown note or subject folder");
   final String selectedName=name;final boolean canWrite=writable,retained=persisted;
   picked=DocumentGrantStore.locked(this,()->{File file=new File(getNoBackupFilesDir(),"document-grants.json");JSONObject all=file.isFile()?new JSONObject(new String(Files.readAllBytes(file.toPath()),StandardCharsets.UTF_8)):new JSONObject();String handle="grant_"+UUID.randomUUID().toString().replace("-","");for(java.util.Iterator<String> keys=all.keys();keys.hasNext();){String key=keys.next();JSONObject grant=all.optJSONObject(key);if(grant!=null&&grant.optBoolean("directory")==folder&&FolderDocuments.sameDocument(uri,Uri.parse(grant.optString("uri")),folder)){handle=key;break;}}
    all.put(handle,new JSONObject().put("uri",uri.toString()).put("name",selectedName).put("writable",canWrite).put("directory",folder));android.util.AtomicFile atomic=new android.util.AtomicFile(file);FileOutputStream stream=null;try{stream=atomic.startWrite();stream.write(all.toString().getBytes(StandardCharsets.UTF_8));atomic.finishWrite(stream);}catch(Exception e){if(stream!=null)atomic.failWrite(stream);throw e;}
    return new JSONObject().put("handle",handle).put("name",selectedName).put("kind","android").put("writable",canWrite).put("persisted",retained);});
   if(!persisted)notice("This provider grants temporary access. Relink after restarting if needed.");
  }}catch(Exception e){notice("The provider could not link this note or folder. Choose it again or use a compatible local folder.");}
  final String detail="{requestId:"+JSONObject.quote(requestId)+",document:"+(picked==null?"null":picked.toString())+"}";
  runOnUiThread(()->{if(!destroyed)web.evaluateJavascript("window.dispatchEvent(new CustomEvent('lh:document-picked',{detail:"+detail+"}))",null);});});
 }
 private void attachFiles(List<Uri> selected){try{File dir=new File(getFilesDir(),"original/attachments");if(!dir.isDirectory()&&!dir.mkdirs())throw new IOException("Cannot create attachment folder");JSONArray paths=new JSONArray();for(Uri uri:selected){String display="attachment";try(android.database.Cursor c=getContentResolver().query(uri,new String[]{OpenableColumns.DISPLAY_NAME},null,null,null)){if(c!=null&&c.moveToFirst())display=c.getString(0);}String name=display.replaceAll("[^a-zA-Z0-9._ -]","_");if(name.length()>100)name=name.substring(name.length()-100);File dest=new File(dir,UUID.randomUUID()+"-"+name);try(InputStream in=getContentResolver().openInputStream(uri);FileOutputStream out=new FileOutputStream(dest)){byte[] bytes=read(in,64*1024*1024);out.write(bytes);}paths.put(dest.getAbsolutePath());}
   runOnUiThread(()->web.evaluateJavascript("window.dispatchEvent(new CustomEvent('lh:android-files',{detail:"+paths+"}))",null));notice("File copied into the learning library.");
  }catch(Exception e){notice("Attachment failed: "+e.getMessage());}}
 private void addArchive(ZipOutputStream out,File dir,String prefix)throws IOException{if(!dir.isDirectory())return;out.putNextEntry(new ZipEntry(prefix));out.closeEntry();File[] files=dir.listFiles();if(files==null)return;for(File file:files){if(prefix.equals("data/")&&(file.getName().equals(".sync-local")||file.getName().equals(".documents-local")||file.getName().equals(".local")))continue;if(Files.isSymbolicLink(file.toPath()))continue;if(file.isDirectory())addArchive(out,file,prefix+file.getName()+"/");else{out.putNextEntry(new ZipEntry(prefix+file.getName()));Files.copy(file.toPath(),out);out.closeEntry();}}}
 private void restore(Uri uri){File base=new File(getFilesDir(),"original"),stage=new File(getCacheDir(),"restore-"+UUID.randomUUID()),archive=new File(base,"pre-restore-"+System.currentTimeMillis());List<String> archived=new ArrayList<>(),installed=new ArrayList<>();try{
   // The separate engine must retire before files owned by its stores move.
   long deadline=System.currentTimeMillis()+6000;
   while(runtimePid>0&&new File("/proc/"+runtimePid).exists()&&System.currentTimeMillis()<deadline)Thread.sleep(50);
   if(runtimePid>0&&new File("/proc/"+runtimePid).exists())throw new IOException("Engine is still stopping; retry Restore");
   if(!stage.mkdirs())throw new IOException("Cannot prepare restoration");long total=0;int count=0;Set<String> entries=new HashSet<>();try(ZipInputStream zip=new ZipInputStream(getContentResolver().openInputStream(uri))){ZipEntry e;while((e=zip.getNextEntry())!=null){if(++count>50000)throw new IOException("Too many archive entries");String name=e.getName().replace('\\','/');if(!name.startsWith("data/")&&!name.startsWith("attachments/"))throw new IOException("Expected a LearnHarness library archive");File target=new File(stage,name).getCanonicalFile();if(!target.getPath().startsWith(stage.getCanonicalPath()+File.separator)||!entries.add(target.getPath()))throw new IOException("Invalid or duplicate archive path");if(e.isDirectory()){if(!target.isDirectory()&&!target.mkdirs())throw new IOException("Cannot create archive folder");continue;}if(!target.getParentFile().isDirectory()&&!target.getParentFile().mkdirs())throw new IOException("Cannot create archive folder");try(FileOutputStream out=new FileOutputStream(target)){byte[] bytes=new byte[8192];int n;while((n=zip.read(bytes))!=-1){total+=n;if(total>512L*1024*1024)throw new IOException("Archive exceeds 512 MB");out.write(bytes,0,n);}out.getFD().sync();}}}
   if(!new File(stage,"data").isDirectory())throw new IOException("Archive has no learning data");if(!archive.mkdirs())throw new IOException("Cannot archive current library");
   for(String name:new String[]{"data","attachments"}){File old=new File(base,name),next=new File(stage,name);if(old.exists()){Files.move(old.toPath(),new File(archive,name).toPath());archived.add(name);}if(next.exists()){Files.move(next.toPath(),old.toPath());installed.add(name);}}
   stage.delete();notice("Library restored; previous data archived on device.");
  }catch(Exception e){
   // Roll back every completed move if committing either directory fails.
   try{for(int i=installed.size()-1;i>=0;i--){String name=installed.get(i);Files.move(new File(base,name).toPath(),new File(stage,name).toPath());}for(int i=archived.size()-1;i>=0;i--){String name=archived.get(i);Files.move(new File(archive,name).toPath(),new File(base,name).toPath());}notice("Restore failed; current library preserved: "+e.getMessage());}
   catch(Exception rollback){notice("Restore interrupted. Your previous library is preserved in "+archive.getName()+". Restart before retrying.");}
  }runOnUiThread(this::startEngine);}
 @Override public void onRequestPermissionsResult(int req,String[] permissions,int[] grants){super.onRequestPermissionsResult(req,permissions,grants);if(req==AUDIO&&pendingAudio!=null){if(grants.length>0&&grants[0]==PackageManager.PERMISSION_GRANTED)pendingAudio.grant(new String[]{PermissionRequest.RESOURCE_AUDIO_CAPTURE});else pendingAudio.deny();pendingAudio=null;}}
 public class AndroidHost {
  @JavascriptInterface public synchronized String chooseMarkdownDocument(String requestId,String kind){if(!trustedDocument||requestId==null||!requestId.matches("[a-f0-9-]{36}")||documentRequest!=null)return "Selection unavailable";documentRequest=requestId;documentKind="folder".equals(kind)?"folder":"attachment".equals(kind)?"attachment":"markdown";handler.postDelayed(()->{try{Intent pick=new Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*").putExtra(Intent.EXTRA_MIME_TYPES,documentKind.equals("attachment")?new String[]{"*/*"}:new String[]{"text/markdown","text/plain","text/x-markdown"}).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION|Intent.FLAG_GRANT_WRITE_URI_PERMISSION|Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);if(documentKind.equals("folder"))pick=new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION|Intent.FLAG_GRANT_WRITE_URI_PERMISSION|Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION|Intent.FLAG_GRANT_PREFIX_URI_PERMISSION);startActivityForResult(pick,LINK_MARKDOWN);}catch(Exception e){completeDocumentPick(RESULT_CANCELED,null);}},100);return "";}

  @JavascriptInterface public String openSubscriptionBrowser(String action){if(!trustedDocument||origin==null||sessionToken==null||action==null||!action.matches("/api/subscriptions/browser\\?id=[0-9a-f-]{36}"))return "Invalid sign-in action";try{HttpURLConnection c=(HttpURLConnection)new URL(origin+action).openConnection();c.setRequestMethod("POST");c.setInstanceFollowRedirects(false);c.setRequestProperty("Origin",origin);c.setRequestProperty("x-learnharness-subscriptions","1");c.setRequestProperty("x-learnharness-android",sessionToken);c.setConnectTimeout(10000);c.setReadTimeout(15000);int code=c.getResponseCode();String location=c.getHeaderField("Location");c.disconnect();if(code!=303||location==null)return "Sign-in action is no longer available";Uri u=Uri.parse(location);if(!"https".equals(u.getScheme())||u.getHost()==null||u.getUserInfo()!=null)return "Invalid sign-in destination";runOnUiThread(()->{try{startActivity(new Intent(Intent.ACTION_VIEW,u).addCategory(Intent.CATEGORY_BROWSABLE));}catch(Exception e){notice("No sign-in browser is available.");}});return "";}catch(Exception e){return "Sign-in browser could not be opened";}}
 }
 private void back(){if(!loaded){moveTaskToBack(true);return;}web.evaluateJavascript("(()=>{if(window.lhDismissTop?.())return true;if(document.querySelector('[data-lh-menu]')){document.querySelector('[data-lh-menu]').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));return true;}if(document.querySelector('[role=dialog]')){document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));return true;}const sidebar=document.querySelector('aside.sidebar-motion');if(sidebar&&sidebar.getBoundingClientRect().width>0){window.dispatchEvent(new CustomEvent('lh:kbd-toggle-sidebar'));return true;}return false;})()",handled->{if(!"true".equals(handled)){if(web.canGoBack())web.goBack();else moveTaskToBack(true);}});}
 @android.annotation.SuppressLint("GestureBackNavigation") @Override public void onBackPressed(){back();}
 @Override protected void onDestroy(){destroyed=true;handler.removeCallbacksAndMessages(null);if(pendingAudio!=null)pendingAudio.deny();if(chooser!=null)chooser.onReceiveValue(null);web.removeJavascriptInterface("AndroidHost");web.destroy();io.shutdownNow();super.onDestroy();}
}
