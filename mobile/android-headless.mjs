/** Android adapter for LearnHarness's HeadlessApi. AGPL-3.0-only.
 * The native renderer executes/renders; this module validates, transports, and
 * returns the original API shapes. It never claims a renderer exists from a stub.
 */
import fs from 'node:fs/promises';
import { constants as FS } from 'node:fs';
import path from 'node:path';

const MAX_INPUT_BYTES = 8 * 1024 * 1024;
const MAX_PDF_BYTES = 24 * 1024 * 1024;
const MAX_REPLY_BYTES = 64 * 1024 * 1024;
const MAX_PNG_BYTES = 16 * 1024 * 1024;
const MAX_PIXELS = 16_000_000;
const MAX_SIDE = 8192;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = message => { throw new Error(`Android renderer: ${message}`); };

function configuration(env) {
  let url;
  try { url = new URL(env.LH_ANDROID_RENDER_URL); } catch { return { error: 'native renderer URL is not configured' }; }
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname) || !url.port ||
      url.username || url.password || url.search || url.hash) return { error: 'renderer URL must be an explicit literal-loopback HTTP endpoint' };
  const token = env.LH_ANDROID_RENDER_TOKEN;
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43,256}$/.test(token)) return { error: 'a per-start renderer secret of at least 32 random bytes is required' };
  if (env.LH_ANDROID_RENDER_READY !== '1') return { error: 'native renderer has not announced readiness' };
  return { url: url.href, token };
}

function boundedText(value, label) {
  if (typeof value !== 'string' || !value.length || Buffer.byteLength(value, 'utf8') > MAX_INPUT_BYTES) fail(`${label} must be nonempty UTF-8 text no larger than 8 MiB`);
  return value;
}
function finiteOption(value, fallback, label, min, max) {
  const n = value === undefined ? fallback : value;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < min || n > max) fail(`${label} must be between ${min} and ${max}`);
  return n;
}
function diagnosticList(value, name) {
  if (!Array.isArray(value) || value.length > 256 || value.some(s => typeof s !== 'string' || s.length > 16384)) fail(`malformed ${name} in demo result`);
  return [...value];
}

function crc32(buf) {
  let crc = ~0;
  for (const byte of buf) { crc ^= byte; for (let i=0; i<8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); }
  return (~crc) >>> 0;
}
function pngChunk(type, data) {
  const chunk=Buffer.alloc(12+data.length); chunk.writeUInt32BE(data.length); chunk.write(type,4,'ascii');data.copy(chunk,8);chunk.writeUInt32BE(crc32(chunk.subarray(4,8+data.length)),8+data.length);return chunk;
}
/** Preserve the desktop's provider-safe single-IDAT encoding. No pixel re-encode. */
function pngFromBase64(value) {
  if (typeof value !== 'string' || value.length > Math.ceil(MAX_PNG_BYTES/3)*4 || value.length%4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) fail('PNG payload is invalid or exceeds 16 MiB');
  const png=Buffer.from(value,'base64');
  if (png.length>MAX_PNG_BYTES || png.length<45 || png.subarray(0,8).toString('hex')!=='89504e470d0a1a0a')fail('renderer did not return a PNG');
  const chunks=[];let pos=8,ended=false;
  while(pos+12<=png.length){const n=png.readUInt32BE(pos);if(n>png.length-pos-12)fail('truncated PNG');const type=png.subarray(pos+4,pos+8).toString('ascii'),data=png.subarray(pos+8,pos+8+n);if(crc32(png.subarray(pos+4,pos+8+n))!==png.readUInt32BE(pos+8+n))fail('invalid PNG checksum');chunks.push({type,data});pos+=n+12;if(type==='IEND'){ended=true;break;}}
  if(!ended || pos!==png.length || chunks[0]?.type!=='IHDR' || chunks[0].data.length!==13 || !chunks.some(c=>c.type==='IDAT'))fail('incomplete PNG structure');
  const width=chunks[0].data.readUInt32BE(0),height=chunks[0].data.readUInt32BE(4);
  if(!width||!height||width>MAX_SIDE||height>MAX_SIDE||width*height>MAX_PIXELS)fail('PNG dimensions exceed renderer canvas limits');
  const idats=chunks.filter(c=>c.type==='IDAT');if(idats.length<2)return png;
  const merged=Buffer.concat(idats.map(c=>c.data));let emitted=false;
  return Buffer.concat([png.subarray(0,8),...chunks.flatMap(c=>{if(c.type!=='IDAT')return [pngChunk(c.type,c.data)];if(emitted)return [];emitted=true;return [pngChunk('IDAT',merged)];})]);
}

async function privatePdf(pdfPath, root) {
  if(typeof root!=='string'||!path.isAbsolute(root)||path.parse(root).root===path.resolve(root))fail('an explicit app-private root is required for PDF rendering');
  if(typeof pdfPath!=='string'||!path.isAbsolute(pdfPath)||pdfPath.includes('\0'))fail('PDF path must be absolute');
  const realRoot=await fs.realpath(root),realFile=await fs.realpath(pdfPath);
  const rel=path.relative(realRoot,realFile);
  if(!rel||rel==='..'||rel.startsWith('..'+path.sep)||path.isAbsolute(rel))fail('PDF must be inside the app-private root');
  const file=await fs.open(realFile,FS.O_RDONLY|(FS.O_NOFOLLOW||0));
  try {
    const stat=await file.stat();if(!stat.isFile()||stat.size<5||stat.size>MAX_PDF_BYTES)fail('PDF file must be a regular file no larger than 24 MiB');
    // Sending bytes avoids a second process opening an arbitrary caller path.
    // A bounded read, rather than readFile(), also bounds a concurrently growing file.
    const chunks=[];let total=0;
    while(true){const buf=Buffer.alloc(Math.min(65536,MAX_PDF_BYTES+1-total));const {bytesRead}=await file.read(buf,0,buf.length,null);if(!bytesRead)break;total+=bytesRead;if(total>MAX_PDF_BYTES)fail('PDF exceeded 24 MiB during read');chunks.push(buf.subarray(0,bytesRead));}
    const bytes=Buffer.concat(chunks);if(!bytes.subarray(0,1024).includes(Buffer.from('%PDF-')))fail('file does not have a PDF header');return bytes;
  } finally { await file.close(); }
}

export function createAndroidHeadless({ env=process.env, fetchImpl=globalThis.fetch }={}) {
  async function request(operation,input,options,timeoutMs){
    const config=configuration(env);if(config.error)fail(config.error);
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);
    try {
      const response=await fetchImpl(config.url,{method:'POST',redirect:'error',signal:controller.signal,headers:{'Content-Type':'application/json','Authorization':`Bearer ${config.token}`},body:JSON.stringify({version:1,operation,input,options})});
      if(!response.ok)fail(`native operation ${operation} returned HTTP ${response.status}`);
      const declared=Number(response.headers.get('content-length'));if(Number.isFinite(declared)&&declared>MAX_REPLY_BYTES)fail('response exceeds 64 MiB');
      if(!response.body)fail('native renderer returned no response body');
      const reader=response.body.getReader(),chunks=[];let size=0;
      try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>MAX_REPLY_BYTES){controller.abort();fail('response exceeds 64 MiB');}chunks.push(value);}}finally{reader.releaseLock();}
      let packet;try{packet=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{fail('native renderer returned malformed JSON');}
      if(!object(packet)||packet.version!==1||packet.operation!==operation||!object(packet.result))fail('native renderer response does not match operation/schema');
      return packet.result;
    } catch(error){if(controller.signal.aborted)fail(`operation ${operation} timed out or exceeded its response budget`);throw error;}
    finally{clearTimeout(timer);}
  }
  return {
    available(){return !configuration(env).error;},
    unavailableReason(){return configuration(env).error??null;},
    async runDemo(html,opts={}){
      const options={settleMs:finiteOption(opts.settleMs,2000,'settleMs',0,15000)};
      if(opts.probe!==undefined){if(typeof opts.probe!=='string'||opts.probe.length>64000)fail('probe must be a JavaScript expression shorter than 64 KiB');options.probe=opts.probe;}
      const r=await request('runDemo',{html:boundedText(html,'demo HTML')},options,60000);
      const consoleErrors=diagnosticList(r.consoleErrors,'consoleErrors'),pageErrors=diagnosticList(r.pageErrors,'pageErrors'),failedRequests=diagnosticList(r.failedRequests,'failedRequests');
      const ok=!consoleErrors.length&&!pageErrors.length&&!failedRequests.length;if(typeof r.ok!=='boolean'||r.ok!==ok)fail('inconsistent demo success status');
      return {consoleErrors,pageErrors,failedRequests,...(Object.hasOwn(r,'probeResult')?{probeResult:r.probeResult}:{}),ok};
    },
    async renderSvg(svg,opts={}){
      const options={maxPixels:MAX_PIXELS,maxSide:MAX_SIDE};
      if(opts.width!==undefined)options.width=finiteOption(opts.width,900,'SVG width',1,MAX_SIDE);
      if(opts.height!==undefined)options.height=finiteOption(opts.height,700,'SVG height',1,MAX_SIDE);
      return pngFromBase64((await request('renderSvg',{svg:boundedText(svg,'SVG')},options,60000)).pngBase64);
    },
    async renderPdfPages(pdfPath,pages,opts={}){
      if(!Array.isArray(pages)||pages.length>8||pages.some(n=>!Number.isSafeInteger(n)||n<1||n>1000000))fail('PDF pages must contain at most eight positive page numbers');
      if(!pages.length)return [];
      const bytes=await privatePdf(pdfPath,env.LH_ANDROID_PRIVATE_ROOT);
      const options={dpi:finiteOption(opts.dpi,150,'PDF DPI',1,1200),maxPixels:MAX_PIXELS,maxSide:MAX_SIDE};
      const r=await request('renderPdfPages',{pdfBase64:bytes.toString('base64'),pages},options,90000);
      if(!Array.isArray(r.pages)||r.pages.length>pages.length)fail('malformed PDF page result');
      const wanted=new Set(pages);let index=0;
      return r.pages.map(p=>{if(!object(p)||!Number.isSafeInteger(p.page)||!wanted.has(p.page))fail('renderer returned an unrequested PDF page');const nextIndex=pages.indexOf(p.page,index);if(nextIndex<index)fail('renderer returned PDF pages out of order');index=nextIndex+1;return {page:p.page,png:pngFromBase64(p.pngBase64)};});
    }
  };
}

export const androidHeadless=createAndroidHeadless();
export default androidHeadless;
