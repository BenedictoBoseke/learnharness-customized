/** Android entry point for the unmodified LearnHarness production server. */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {androidHeadless} from './android-headless.mjs';
import {migrateLegacy} from './migrate-legacy.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const port=Number(process.env.PORT),token=process.env.LH_ANDROID_SESSION_TOKEN;
if(!Number.isInteger(port)||port<1024||!token||token.length<40)throw new Error('Missing Android runtime configuration');
const privateRoot=path.resolve(process.env.LH_ANDROID_PRIVATE_ROOT);
fs.mkdirSync(path.dirname(process.env.LH_AUTH_FILE),{recursive:true,mode:0o700});
fs.mkdirSync(process.env.LH_DATA_DIR,{recursive:true,mode:0o700});
process.env.HOSTNAME='127.0.0.1';
process.env.NODE_ENV='production';
delete process.env.LH_DESKTOP_SERVER;delete process.env.LH_DESKTOP_API_SECRET;
globalThis.__lhAndroidHeadless=androidHeadless;
const origin=`http://127.0.0.1:${port}`;
const safeEqual=(a,b)=>typeof a==='string'&&a.length===b.length&&crypto.timingSafeEqual(Buffer.from(a),Buffer.from(b));
function authorized(req){const header=req.headers['x-learnharness-android'];if(safeEqual(header,token))return true;return (req.headers.cookie||'').split(';').some(c=>safeEqual(c.trim(),`lh_android_session=${token}`));}
const injection='<script src="/__android/host-bridge.js"></script><link rel="stylesheet" href="/__android/mobile.css">';
function injectHtml(req,res){
 req.headers['accept-encoding']='identity';
 const write=res.write.bind(res),end=res.end.bind(res);let handled=false,buffer=[];let bytes=0;
 function transform(chunk,done){
  if(handled)return chunk;
  if(!String(res.getHeader('content-type')||'').includes('text/html')){handled=true;return chunk;}
  if(res.getHeader('content-encoding'))throw new Error('Unexpected compressed HTML before Android host injection');
  if(!res.headersSent)res.removeHeader('content-length');
  if(chunk!=null){const b=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);buffer.push(b);bytes+=b.length;}
  const s=Buffer.concat(buffer).toString('utf8'),at=s.indexOf('<head>');
  if(at>=0||done||bytes>65536){handled=true;buffer=[];return Buffer.from(at>=0?s.slice(0,at+6)+injection+s.slice(at+6):injection+s);}
  return null;
 }
 res.write=function(chunk,encoding,callback){if(typeof encoding==='function'){callback=encoding;encoding=undefined;}const out=transform(Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk,encoding),false);if(out===null){callback?.();return true;}return write(out,callback);};
 res.end=function(chunk,encoding,callback){if(typeof chunk==='function'){callback=chunk;chunk=undefined;}if(typeof encoding==='function'){callback=encoding;encoding=undefined;}const out=transform(chunk==null?null:Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk,encoding),true);return end(out,callback);};
}
function json(res,status,value){res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(value));}
const originalCreate=http.createServer;
http.createServer=function(...args){
 const server=originalCreate.apply(this,args),emit=server.emit;
 server.emit=function(event,...values){
  if(event!=='request')return emit.call(this,event,...values);
  const [req,res]=values;if(req.socket.localPort!==port)return emit.call(this,event,...values);
  if(req.headers.host!==`127.0.0.1:${port}`){json(res,403,{error:'Local application host required'});return true;}
  if(!authorized(req)){json(res,403,{error:'Android application session required'});return true;}
  const pathname=new URL(req.url,origin).pathname;
  if(pathname==='/__android/health'){json(res,200,{ready:true,node:process.version,mobile:process.versions.mobile,upstream:'0.4.1-custom.1',renderer:androidHeadless.available()});return true;}
  if(pathname==='/__android/host-bridge.js'||pathname==='/__android/mobile.css'){
   res.writeHead(200,{'Content-Type':pathname.endsWith('.js')?'text/javascript':'text/css','Cache-Control':'no-store'});res.end(fs.readFileSync(path.join(root,'mobile',pathname.split('/').at(-1))));return true;
  }
  if(pathname==='/__android/stop'&&req.method==='POST'){json(res,200,{stopped:true});setTimeout(()=>process.exit(0),100);return true;}
  injectHtml(req,res);return emit.call(this,event,...values);
 };
 return server;
};
// Useful for the host and deterministic local QA; never contains provider credentials.
fs.writeFileSync(path.join(privateRoot,'android-node-pid.json'),JSON.stringify({pid:process.pid,port}),{mode:0o600});
await migrateLegacy(privateRoot);
await import('../server.js');
