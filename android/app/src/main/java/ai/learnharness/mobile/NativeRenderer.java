package ai.learnharness.mobile;

import android.annotation.SuppressLint;
import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.pdf.PdfRenderer;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Handler;
import android.os.Looper;
import android.os.ParcelFileDescriptor;
import android.util.Base64;
import android.view.View;
import android.webkit.ConsoleMessage;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.SslErrorHandler;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;
import java.io.BufferedInputStream;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Loopback-only renderer for the original Node HeadlessApi.
 * Runs in the dedicated renderer/service process, after its WebView data
 * directory suffix is set. No JavascriptInterface or application origin is
 * exposed to demo HTML. Every WebView operation runs on the main Looper.
 */
public final class NativeRenderer {
    private static final int MAX_BODY = 32 * 1024 * 1024;
    private static final int MAX_OUTPUT = 32 * 1024 * 1024;
    private static final long MAX_PIXELS = 8L * 1024 * 1024;
    private static final long TIMEOUT_MS = 30000;
    private static final int MAX_ERRORS = 100;
    private static final Set<String> CDN = Collections.unmodifiableSet(new HashSet<>(Arrays.asList(
        "cdn.jsdelivr.net", "fastly.jsdelivr.net", "unpkg.com", "cdnjs.cloudflare.com",
        "esm.sh", "cdn.tailwindcss.com", "fonts.googleapis.com", "fonts.gstatic.com")));
    private static final String CDN_SOURCES = "https://cdn.jsdelivr.net https://fastly.jsdelivr.net https://unpkg.com https://cdnjs.cloudflare.com https://esm.sh https://cdn.tailwindcss.com https://fonts.googleapis.com https://fonts.gstatic.com";
    private final Context context;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ThreadPoolExecutor requests = new ThreadPoolExecutor(2, 2, 30, TimeUnit.SECONDS, new ArrayBlockingQueue<>(8));
    private final ExecutorService pdfWork = Executors.newSingleThreadExecutor();
    private final Set<Job> jobs = ConcurrentHashMap.newKeySet();
    private final Set<Socket> clients = ConcurrentHashMap.newKeySet();
    private final String secret;
    private volatile ServerSocket listener;
    private volatile boolean stopped;

    public NativeRenderer(Context context) {
        this.context = context.getApplicationContext();
        byte[] bytes = new byte[32]; new SecureRandom().nextBytes(bytes);
        secret = Base64.encodeToString(bytes, Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING);
    }

    public String token() { return secret; }
    public String getToken() { return secret; }

    public synchronized String start() throws IOException {
        if (stopped) throw new IOException("Renderer has been stopped");
        if (listener != null) return "http://127.0.0.1:" + listener.getLocalPort();
        ServerSocket server = new ServerSocket(0, 8, InetAddress.getByName("127.0.0.1"));
        listener = server;
        Thread accept = new Thread(() -> {
            while (!stopped) {
                try {
                    Socket socket = server.accept(); socket.setSoTimeout(10000); clients.add(socket);
                    try { requests.execute(() -> serve(socket)); }
                    catch (RuntimeException full) { clients.remove(socket); try { socket.close(); } catch (IOException ignored) {} }
                } catch (IOException e) { if (stopped || server.isClosed()) return; }
            }
        }, "learnharness-renderer-http");
        accept.setDaemon(true); accept.start();
        return "http://127.0.0.1:" + server.getLocalPort();
    }

    public synchronized void stop() {
        if (stopped) return; stopped = true;
        try { if (listener != null) listener.close(); } catch (IOException ignored) {}
        for (Socket socket : clients) try { socket.close(); } catch (IOException ignored) {}
        for (Job job : jobs) job.fail("Renderer stopped");
        requests.shutdownNow();
        pdfWork.shutdownNow();
    }

    private void serve(Socket socket) {
        String operation = "unknown";
        try {
            Socket client = socket;
            InputStream in = new BufferedInputStream(client.getInputStream());
            String first = line(in, 4096);
            boolean document = "POST /document HTTP/1.1".equals(first) || "POST /document HTTP/1.0".equals(first);
            boolean folder = first.startsWith("POST /folder HTTP/");
            if (!document && !folder && !"POST /render HTTP/1.1".equals(first) && !"POST /render HTTP/1.0".equals(first)) {
                reply(client, 404, failure(operation, "Unknown renderer operation")); return;
            }
            Map<String,String> headers = new HashMap<>(); int headerBytes = first.length();
            for (;;) {
                String row = line(in, 8192); headerBytes += row.length() + 2;
                if (headerBytes > 16384) throw new IOException("Request headers exceed limit");
                if (row.isEmpty()) break;
                int colon = row.indexOf(':'); if (colon < 1) throw new IOException("Malformed header");
                String name = row.substring(0, colon).trim().toLowerCase(Locale.ROOT);
                if (headers.put(name, row.substring(colon + 1).trim()) != null) throw new IOException("Duplicate header");
            }
            byte[] supplied = headers.getOrDefault("authorization", "").getBytes(StandardCharsets.UTF_8);
            if (!MessageDigest.isEqual(("Bearer " + secret).getBytes(StandardCharsets.UTF_8), supplied)) {
                reply(client, 401, failure(operation, "Renderer authorization required")); return;
            }
            if (headers.containsKey("transfer-encoding")) throw new IOException("Chunked requests are not supported");
            String length = headers.get("content-length");
            if (length == null || !length.matches("[0-9]{1,9}")) throw new IOException("Content-Length required");
            int size = Integer.parseInt(length); if (size < 2 || size > MAX_BODY) throw new IOException("Renderer request exceeds 32 MB limit");
            String contentType = headers.getOrDefault("content-type", "").split(";",2)[0].trim();
            if (!contentType.equalsIgnoreCase("application/json")) throw new IOException("Expected application/json");
            byte[] body = new byte[size]; int offset = 0;
            while (offset < size) { int count = in.read(body, offset, size-offset); if (count < 0) throw new IOException("Incomplete body"); offset += count; }
            JSONObject request = new JSONObject(new String(body, StandardCharsets.UTF_8));
            if(folder){reply(client,200,FolderDocuments.request(context,request));return;}
            if(document){reply(client,200,documentRequest(request));return;}
            if (!(request.opt("version") instanceof Number) || ((Number)request.opt("version")).doubleValue() != 1) throw new IOException("Unsupported renderer version");
            operation = request.getString("operation"); JSONObject input = request.getJSONObject("input");
            JSONObject options = request.optJSONObject("options"); if (options == null) options = new JSONObject();
            JSONObject result;
            if (operation.equals("runDemo") || operation.equals("renderSvg")) result = web(operation, input, options);
            else if (operation.equals("renderPdfPages")) {
                final JSONObject pdfOptions=options;
                Future<JSONObject> task=pdfWork.submit(()->pdf(input,pdfOptions));
                try { result=task.get(TIMEOUT_MS,TimeUnit.MILLISECONDS); }
                catch(TimeoutException e){task.cancel(true);throw e;}
                catch(InterruptedException e){task.cancel(true);Thread.currentThread().interrupt();throw e;}
            }
            else throw new IOException("Unsupported renderer operation");
            reply(client, 200, new JSONObject().put("version",1).put("operation",operation).put("result",result));
        } catch (TimeoutException e) {
            safeReply(socket, 504, failure(operation, "Renderer timed out after 30 seconds"));
        } catch (OutOfMemoryError e) {
            safeReply(socket, 503, failure(operation, "Renderer memory budget exceeded"));
        } catch (Exception e) {
            safeReply(socket, 400, failure(operation, safeMessage(e)));
        } finally { clients.remove(socket); try { socket.close(); } catch (IOException ignored) {} }
    }

    private synchronized JSONObject documentRequest(JSONObject request) throws Exception {
        String handle=request.optString("handle"),operation=request.optString("operation");
        if(!handle.matches("grant_[a-f0-9]{32}"))throw new IOException("Relink the document to grant access");
        File registry=new File(context.getNoBackupFilesDir(),"document-grants.json");
        if(!registry.isFile())throw new IOException("Document permission missing. Relink the note");
        JSONObject all=new JSONObject(new String(java.nio.file.Files.readAllBytes(registry.toPath()),StandardCharsets.UTF_8));
        JSONObject grant=all.optJSONObject(handle);if(grant==null)throw new IOException("Document permission missing. Relink the note");
        Uri uri=FolderDocuments.boundUri(context,grant);if(!"content".equals(uri.getScheme()))throw new IOException("Invalid document provider");
        if(operation.equals("copy")){
            File parent=new File(context.getFilesDir(),"original/attachments");if(!parent.isDirectory()&&!parent.mkdirs())throw new IOException("Attachment folder unavailable");
            String name=grant.optString("name","attachment").replaceAll("[^a-zA-Z0-9._ -]","_");if(name.length()>100)name=name.substring(name.length()-100);
            File target=new File(parent,UUID.randomUUID()+"-"+name);long total=0;try(InputStream input=context.getContentResolver().openInputStream(uri);FileOutputStream output=new FileOutputStream(target)){
                if(input==null)throw new IOException("Selected file unavailable");byte[] buffer=new byte[16384];int count;while((count=input.read(buffer))!=-1){total+=count;if(total>64L*1024*1024)throw new IOException("Attachment exceeds 64 MB");output.write(buffer,0,count);}output.getFD().sync();
            }catch(Exception failure){target.delete();throw failure;}
            return new JSONObject().put("path",target.getAbsolutePath());
        }
        byte[] before=documentBytes(uri);String hash=hex(MessageDigest.getInstance("SHA-256").digest(before));
        if(!Arrays.equals(before,new String(before,StandardCharsets.UTF_8).getBytes(StandardCharsets.UTF_8)))throw new IOException("Choose a UTF-8 Markdown file");
        if(operation.equals("read"))return new JSONObject().put("text",new String(before,StandardCharsets.UTF_8)).put("revision",hash);
        if(!operation.equals("write"))throw new IOException("Unsupported document action");
        if(!grant.optBoolean("writable"))throw new IOException("This document is read-only. Relink with write permission");
        if(!hash.equals(request.optString("expectedHash")))throw new IOException("The document changed outside LearnHarness. Read it again before saving");
        byte[] next=request.getString("text").getBytes(StandardCharsets.UTF_8);if(next.length>5*1024*1024)throw new IOException("Markdown exceeds 5 MB");
        File recovery=new File(context.getNoBackupFilesDir(),"document-recovery/"+handle);if(!recovery.isDirectory()&&!recovery.mkdirs())throw new IOException("Cannot preserve the previous document");
        File backup=new File(recovery,hash+".md");if(!backup.isFile())try(FileOutputStream saved=new FileOutputStream(backup)){saved.write(before);saved.getFD().sync();}
        try(ParcelFileDescriptor descriptor=context.getContentResolver().openFileDescriptor(uri,"rwt")){
            if(descriptor==null)throw new IOException("The provider did not open the document for writing");
            try(FileOutputStream output=new ParcelFileDescriptor.AutoCloseOutputStream(descriptor)){output.write(next);output.flush();try{output.getFD().sync();}catch(IOException providerNoSync){/* Some document providers return a pipe; verify below. */}}
        }
        String after=hex(MessageDigest.getInstance("SHA-256").digest(documentBytes(uri)));
        if(!after.equals(hex(MessageDigest.getInstance("SHA-256").digest(next))))throw new IOException("The provider did not retain the complete save. A recovery copy is preserved");
        return new JSONObject().put("revision",after);
    }
    private byte[] documentBytes(Uri uri)throws IOException{
        try(InputStream input=context.getContentResolver().openInputStream(uri);ByteArrayOutputStream output=new ByteArrayOutputStream()){
            if(input==null)throw new IOException("The document is unavailable. Relink it");byte[] buffer=new byte[8192];int count;
            while((count=input.read(buffer))!=-1){if(output.size()+count>5*1024*1024)throw new IOException("Markdown exceeds 5 MB");output.write(buffer,0,count);}return output.toByteArray();
        }catch(SecurityException denied){throw new IOException("Document access was revoked. Relink the note");}
    }
    private static String hex(byte[] bytes){StringBuilder text=new StringBuilder();for(byte b:bytes)text.append(String.format(Locale.ROOT,"%02x",b&255));return text.toString();}

    private static String safeMessage(Exception e) {
        Throwable cause = e instanceof ExecutionException && e.getCause() != null ? e.getCause() : e;
        String message = cause.getMessage();
        if (message == null || message.length() > 250) return "Renderer could not complete the request";
        // Renderer errors are our own validation messages. Never echo request
        // authorization, input data, native paths, or arbitrary exception text.
        if (cause instanceof JSONException) return "Invalid renderer JSON payload";
        if (cause instanceof IOException && !message.contains("/") && !message.contains("\\")) return message;
        return "Renderer could not complete the request";
    }
    private static JSONObject failure(String operation, String error) {
        JSONObject o = new JSONObject(); try { o.put("version",1).put("operation",operation).put("error",error); } catch (JSONException ignored) {} return o;
    }
    private static String line(InputStream in, int max) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream(); int b;
        while ((b = in.read()) != -1) {
            if (b == '\n') { byte[] bytes=out.toByteArray(); int n=bytes.length; if(n>0&&bytes[n-1]=='\r')n--; return new String(bytes,0,n,StandardCharsets.US_ASCII); }
            if (out.size() >= max) throw new IOException("Request line exceeds limit"); out.write(b);
        }
        throw new IOException("Incomplete headers");
    }
    private static void safeReply(Socket socket, int status, JSONObject result) { try { reply(socket,status,result); } catch (Exception ignored) {} }
    private static void reply(Socket socket, int status, JSONObject result) throws IOException {
        byte[] body = result.toString().getBytes(StandardCharsets.UTF_8);
        if (body.length > MAX_OUTPUT) throw new IOException("Renderer response exceeds 32 MB limit");
        OutputStream out = socket.getOutputStream();
        String text = status == 200 ? "OK" : status == 401 ? "Unauthorized" : status == 404 ? "Not Found" : status == 504 ? "Gateway Timeout" : status == 503 ? "Service Unavailable" : "Bad Request";
        out.write(("HTTP/1.1 "+status+" "+text+"\r\nContent-Type: application/json; charset=utf-8\r\nCache-Control: no-store\r\nConnection: close\r\nContent-Length: "+body.length+"\r\n\r\n").getBytes(StandardCharsets.US_ASCII));
        out.write(body); out.flush();
    }
    private static int number(JSONObject o, String key, int fallback, int min, int max) throws IOException {
        if (!o.has(key)) return fallback;
        Object value=o.opt(key); if (!(value instanceof Number)) throw new IOException("Invalid numeric renderer option");
        double d=((Number)value).doubleValue();
        if (!Double.isFinite(d) || d != Math.rint(d) || d < min || d > max) throw new IOException("Renderer option out of bounds");
        return (int)d;
    }
    private static void geometry(int width, int height) throws IOException {
        if (width<1||height<1||width>4096||height>4096||(long)width*height>MAX_PIXELS) throw new IOException("Image dimensions exceed renderer pixel budget");
    }
    private static String png(Bitmap bitmap) throws IOException {
        ByteArrayOutputStream bytes=new ByteArrayOutputStream();
        if (!bitmap.compress(Bitmap.CompressFormat.PNG,100,bytes)) throw new IOException("PNG encoding failed");
        if (bytes.size()>12*1024*1024) throw new IOException("PNG exceeds renderer size budget");
        return Base64.encodeToString(bytes.toByteArray(),Base64.NO_WRAP);
    }

    private JSONObject pdf(JSONObject input, JSONObject options) throws Exception {
        long deadline=android.os.SystemClock.elapsedRealtime()+TIMEOUT_MS;
        int dpi=number(options,"dpi",150,72,200);
        JSONArray wanted=input.getJSONArray("pages"); if(wanted.length()>20)throw new IOException("At most 20 PDF pages can be rendered");
        String encoded=input.getString("pdfBase64"); if(encoded.length()>MAX_BODY)throw new IOException("PDF exceeds renderer size budget");
        byte[] bytes; try { bytes=Base64.decode(encoded,Base64.DEFAULT); } catch(IllegalArgumentException e){throw new IOException("Invalid PDF encoding");}
        File temp=File.createTempFile("lh-render-",".pdf",context.getCacheDir());
        try {
            try(FileOutputStream out=new FileOutputStream(temp)){out.write(bytes);}
            JSONArray pages=new JSONArray(); long encodedTotal=0;
            try(ParcelFileDescriptor fd=ParcelFileDescriptor.open(temp,ParcelFileDescriptor.MODE_READ_ONLY);PdfRenderer document=new PdfRenderer(fd)){
                for(int i=0;i<wanted.length();i++){
                    if(stopped||Thread.currentThread().isInterrupted())throw new IOException("Renderer stopped");
                    if(android.os.SystemClock.elapsedRealtime()>deadline)throw new TimeoutException();
                    Object value=wanted.opt(i);if(!(value instanceof Number)||((Number)value).doubleValue()!=Math.rint(((Number)value).doubleValue()))throw new IOException("PDF pages must be integer page numbers");
                    int index=((Number)value).intValue();if(index<1||index>document.getPageCount())continue;
                    try(PdfRenderer.Page page=document.openPage(index-1)){
                        int width=(int)Math.ceil(page.getWidth()*dpi/72.0),height=(int)Math.ceil(page.getHeight()*dpi/72.0);geometry(width,height);
                        Bitmap bitmap=Bitmap.createBitmap(width,height,Bitmap.Config.ARGB_8888);
                        String image;try{bitmap.eraseColor(Color.WHITE);page.render(bitmap,null,null,PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY);image=png(bitmap);}finally{bitmap.recycle();}
                        encodedTotal+=image.length();if(encodedTotal>MAX_OUTPUT-65536)throw new IOException("PDF response exceeds renderer size budget");
                        pages.put(new JSONObject().put("page",index).put("pngBase64",image));
                    }
                }
            }
            return new JSONObject().put("pages",pages);
        }finally{if(!temp.delete())temp.deleteOnExit();}
    }

    private JSONObject web(String operation,JSONObject input,JSONObject options) throws Exception {
        boolean svg=operation.equals("renderSvg");
        String content=input.getString(svg?"svg":"html");
        if(content.length()>16*1024*1024)throw new IOException("HTML or SVG exceeds renderer size budget");
        int width=svg?number(options,"width",svgDimension(content,"width",900),1,4096):1200;
        int height=svg?number(options,"height",svgDimension(content,"height",700),1,4096):800;geometry(width,height);
        int settle=svg?250:number(options,"settleMs",2000,0,5000);
        Object rawProbe=options.opt("probe");if(rawProbe!=null&&rawProbe!=JSONObject.NULL&&!(rawProbe instanceof String))throw new IOException("Probe must be a JavaScript expression");
        String probe=svg?null:options.optString("probe",null);if(probe!=null&&probe.length()>200000)throw new IOException("Probe exceeds renderer size budget");
        Job job=new Job(operation,content,width,height,settle,probe);jobs.add(job);
        main.post(job::create);
        try{return job.result.get(TIMEOUT_MS,TimeUnit.MILLISECONDS);}
        catch(TimeoutException e){job.fail("Renderer timed out after 30 seconds");throw e;}
        finally{main.post(job::cleanup);jobs.remove(job);}
    }
    private static int svgDimension(String svg,String name,int fallback){
        Matcher root=Pattern.compile("<svg\\b[^>]*>",Pattern.CASE_INSENSITIVE).matcher(svg);
        if(!root.find())return fallback;
        Matcher dimension=Pattern.compile("\\b"+name+"\\s*=\\s*['\"]([0-9]+(?:\\.[0-9]+)?)(?:px)?['\"]",Pattern.CASE_INSENSITIVE).matcher(root.group());
        if(!dimension.find())return fallback;
        try{double d=Double.parseDouble(dimension.group(1));return d>0&&d<=4096?(int)Math.ceil(d):fallback;}catch(NumberFormatException e){return fallback;}
    }
    private static boolean allowedCdn(Uri uri){return "https".equalsIgnoreCase(uri.getScheme())&&uri.getUserInfo()==null&&(uri.getPort()==-1||uri.getPort()==443)&&CDN.contains(uri.getHost()==null?"":uri.getHost().toLowerCase(Locale.ROOT));}
    private static String requestLabel(Uri uri){return (uri.getScheme()==null?"resource":uri.getScheme())+"://"+(uri.getHost()==null?"blocked":uri.getHost())+(uri.getPath()==null?"":uri.getPath());}
    private static WebResourceResponse denied(){return new WebResourceResponse("text/plain","UTF-8",403,"Blocked",Collections.emptyMap(),new ByteArrayInputStream(new byte[0]));}

    private final class Job {
        final CompletableFuture<JSONObject> result=new CompletableFuture<>();
        final List<String> consoleErrors=Collections.synchronizedList(new ArrayList<>()),pageErrors=Collections.synchronizedList(new ArrayList<>()),failedRequests=Collections.synchronizedList(new ArrayList<>());
        final String operation,content,probe,key="__lh_render_"+UUID.randomUUID().toString().replace("-","");
        final String pageUrl="https://renderer.learnharness.invalid/"+UUID.randomUUID()+"/index.html";
        final int width,height,settle;
        WebView view; boolean loaded,cleaned;
        Job(String operation,String content,int width,int height,int settle,String probe){this.operation=operation;this.content=content;this.width=width;this.height=height;this.settle=settle;this.probe=probe;}
        void add(List<String> list,String value){if(value==null)return;synchronized(list){if(list.size()<MAX_ERRORS)list.add(value.length()>2000?value.substring(0,2000):value);}}
        void fail(String message){result.completeExceptionally(new IOException(message));main.post(this::cleanup);}
        @SuppressLint("SetJavaScriptEnabled")
        void create(){
            if(result.isDone()||stopped){fail("Renderer stopped");return;}
            try{
                view=new WebView(context);view.setBackgroundColor(Color.WHITE);view.setLayerType(View.LAYER_TYPE_SOFTWARE,null);
                WebSettings settings=view.getSettings();settings.setJavaScriptEnabled(operation.equals("runDemo"));settings.setDomStorageEnabled(false);settings.setDatabaseEnabled(false);settings.setAllowFileAccess(false);settings.setAllowContentAccess(false);settings.setAllowFileAccessFromFileURLs(false);settings.setAllowUniversalAccessFromFileURLs(false);settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);settings.setSupportMultipleWindows(false);settings.setJavaScriptCanOpenWindowsAutomatically(false);settings.setMediaPlaybackRequiresUserGesture(true);settings.setOffscreenPreRaster(true);
                // A WebView is measured in device pixels, while HTML uses CSS
                // pixels. Fit our explicit CSS viewport to the output bitmap;
                // initial-scale=1 would crop it on a high-density Android screen.
                settings.setUseWideViewPort(true);settings.setLoadWithOverviewMode(true);
                view.setWebChromeClient(new WebChromeClient(){@Override public boolean onConsoleMessage(ConsoleMessage message){if(message.messageLevel()==ConsoleMessage.MessageLevel.ERROR)add(consoleErrors,message.message());return true;}});
                view.setWebViewClient(new WebViewClient(){
                    @Override public boolean shouldOverrideUrlLoading(WebView w,WebResourceRequest request){add(failedRequests,requestLabel(request.getUrl())+" (navigation blocked)");return true;}
                    @Override public WebResourceResponse shouldInterceptRequest(WebView w,WebResourceRequest request){
                        if(request.isForMainFrame()&&request.getUrl().toString().equals(pageUrl)){
                            String policy="default-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'; object-src 'none'; worker-src 'none'; img-src data: blob: "+CDN_SOURCES+"; style-src 'unsafe-inline' "+CDN_SOURCES+"; font-src data: "+CDN_SOURCES+"; media-src 'none'; connect-src "+CDN_SOURCES+"; script-src "+(operation.equals("runDemo")?"'unsafe-inline' 'unsafe-eval' "+CDN_SOURCES:"'none'");
                            Map<String,String> headers=new HashMap<>();headers.put("Content-Security-Policy",policy);headers.put("Cache-Control","no-store");headers.put("Referrer-Policy","no-referrer");headers.put("X-Content-Type-Options","nosniff");
                            return new WebResourceResponse("text/html","UTF-8",200,"OK",headers,new ByteArrayInputStream(html().getBytes(StandardCharsets.UTF_8)));
                        }
                        if(request.isForMainFrame()||!operation.equals("runDemo")||!allowedCdn(request.getUrl())){add(failedRequests,requestLabel(request.getUrl())+" (blocked)");return denied();}
                        return null;
                    }
                    @Override public void onReceivedError(WebView w,WebResourceRequest request,WebResourceError error){add(failedRequests,requestLabel(request.getUrl())+" (network error)");}
                    @Override public void onReceivedHttpError(WebView w,WebResourceRequest request,WebResourceResponse response){add(failedRequests,requestLabel(request.getUrl())+" (HTTP "+response.getStatusCode()+")");}
                    @Override public void onReceivedSslError(WebView w,SslErrorHandler handler,SslError error){handler.cancel();add(failedRequests,"HTTPS certificate validation failed");}
                    @Override public boolean onRenderProcessGone(WebView w,RenderProcessGoneDetail detail){fail("The isolated WebView renderer stopped");return true;}
                    @Override public void onPageFinished(WebView w,String url){if(!loaded&&pageUrl.equals(url)){loaded=true;main.postDelayed(()->{if(result.isDone())return;if(operation.equals("renderSvg"))capture();else collect();},settle);}}
                });
                view.measure(View.MeasureSpec.makeMeasureSpec(width,View.MeasureSpec.EXACTLY),View.MeasureSpec.makeMeasureSpec(height,View.MeasureSpec.EXACTLY));view.layout(0,0,width,height);view.loadUrl(pageUrl);
            }catch(Throwable e){fail("Could not create the isolated WebView renderer");}
        }
        String html(){
            if(operation.equals("renderSvg"))return "<!doctype html><html><head><meta charset='utf-8'><meta name='viewport' content='width="+width+"'><style>html,body{margin:0;padding:0;background:white;width:"+width+"px;height:"+height+"px;overflow:hidden}svg{display:block;width:100%;height:100%}</style></head><body>"+content+"</body></html>";
            String script="(()=>{const errors=[];Object.defineProperty(window,"+JSONObject.quote(key)+",{value:{errors,done:false},configurable:false});addEventListener('error',e=>{if(e.message&&errors.length<100)errors.push(String(e.message).slice(0,2000))});addEventListener('unhandledrejection',e=>{if(errors.length<100)errors.push(String(e.reason&&e.reason.message||e.reason).slice(0,2000))});})();";
            return "<!doctype html><html><head><meta charset='utf-8'><meta name='viewport' content='width="+width+"'><script>"+script+"</script></head><body>"+content+"</body></html>";
        }
        void collect(){
            if(result.isDone()||view==null)return;
            String expression=probe==null||probe.trim().isEmpty()?"undefined":"(0,eval)("+JSONObject.quote(probe)+")";
            String js="(()=>{const s=window["+JSONObject.quote(key)+"];if(!s)return;Promise.resolve().then(()=>"+expression+").then(value=>{try{s.value=JSON.parse(JSON.stringify(value===undefined?null:value));}catch(_){s.errors.push('probe failed: result is not JSON serializable');}s.done=true;},error=>{s.errors.push('probe failed: '+String(error&&error.message||error).slice(0,2000));s.done=true;});})();";
            view.evaluateJavascript(js,null);main.postDelayed(this::poll,25);
        }
        void poll(){
            if(result.isDone()||view==null)return;
            view.evaluateJavascript("(()=>{const s=window["+JSONObject.quote(key)+"];return s?JSON.stringify({done:s.done,errors:s.errors,value:s.value}):null;})()",raw->{
                if(result.isDone())return;
                try{
                    Object decoded=new org.json.JSONTokener(raw).nextValue();
                    if(!(decoded instanceof String)){fail("Demo instrumentation was unavailable");return;}
                    String encoded=(String)decoded;if(encoded.length()>4*1024*1024){fail("Probe result exceeds renderer size budget");return;}
                    JSONObject state=new JSONObject(encoded);if(!state.optBoolean("done")){main.postDelayed(this::poll,25);return;}
                    JSONArray errors=state.optJSONArray("errors");if(errors!=null)for(int i=0;i<Math.min(errors.length(),MAX_ERRORS);i++)add(pageErrors,errors.optString(i));
                    JSONObject value=new JSONObject().put("consoleErrors",snapshot(consoleErrors)).put("pageErrors",snapshot(pageErrors)).put("failedRequests",snapshot(failedRequests));
                    if(probe!=null&&!probe.trim().isEmpty()&&state.has("value"))value.put("probeResult",state.opt("value"));
                    value.put("ok",consoleErrors.isEmpty()&&pageErrors.isEmpty()&&failedRequests.isEmpty());result.complete(value);
                }catch(Exception e){fail("Could not collect the demo result");}
            });
        }
        JSONArray snapshot(List<String> values){synchronized(values){return new JSONArray(new ArrayList<>(values));}}
        void capture(){
            if(result.isDone()||view==null)return;
            Bitmap bitmap=null;
            try{bitmap=Bitmap.createBitmap(width,height,Bitmap.Config.ARGB_8888);bitmap.eraseColor(Color.WHITE);view.draw(new Canvas(bitmap));result.complete(new JSONObject().put("pngBase64",png(bitmap)));}
            catch(Throwable e){fail("Could not capture the SVG image");}finally{if(bitmap!=null)bitmap.recycle();}
        }
        void cleanup(){
            if(Looper.myLooper()!=Looper.getMainLooper()){main.post(this::cleanup);return;}
            if(cleaned)return;cleaned=true;
            if(view!=null){try{view.stopLoading();view.setWebChromeClient(null);view.setWebViewClient(new WebViewClient());view.destroy();}catch(Throwable ignored){}view=null;}
        }
    }
}
