import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import http from 'node:http';
import puppeteer from 'puppeteer-core';
const root=path.resolve(process.env.LH_QA_ROOT||'../../desktop-document-qa');
fs.mkdirSync(root,{recursive:true});
const profile=path.join(root,'profile'),note=path.join(root,'existing.md');
fs.mkdirSync(profile,{recursive:true});
const initial='---\r\ntitle: Existing note\r\n---\r\n\r\nA paragraph written by a person.\r\n';
fs.writeFileSync(note,initial);
const electron=path.resolve('dist/win-unpacked/LearnHarness.exe');
const app=spawn(electron,['--inspect=127.0.0.1:19331','--remote-debugging-port=19332'],{windowsHide:true,env:{...process.env,LH_PROFILE_DIR:profile,LH_HEADLESS:'1'}});
const log=fs.createWriteStream(path.join(root,'app.log'));app.stdout.pipe(log);app.stderr.pipe(log);
let inspector,browser,mock,sequence=0;
const pending=new Map();
async function waitJSON(url){for(let i=0;i<120;i++){try{const r=await fetch(url);if(r.ok)return r.json();}catch{}await new Promise(r=>setTimeout(r,500));}throw Error('App debugging endpoint did not start');}
async function inspect(expression){const id=++sequence;return new Promise((resolve,reject)=>{pending.set(id,{resolve,reject});inspector.send(JSON.stringify({id,method:'Runtime.evaluate',params:{expression,returnByValue:true,awaitPromise:true}}));});}
try{
 const targets=await waitJSON('http://127.0.0.1:19331/json/list');
 inspector=new WebSocket(targets[0].webSocketDebuggerUrl);await new Promise((r,j)=>{inspector.onopen=r;inspector.onerror=j;});
 inspector.onmessage=e=>{const m=JSON.parse(e.data);const p=pending.get(m.id);if(!p)return;pending.delete(m.id);m.error||m.result?.exceptionDetails?p.reject(Error(JSON.stringify(m))):p.resolve(m.result.result.value);};
 await inspect(`(async()=>{global.__qaElectron=process.getBuiltinModule('module').createRequire(process.resourcesPath+'/app.asar/package.json')('electron');global.__qaOriginalPicker=global.__qaElectron.dialog.showOpenDialog;global.__qaElectron.dialog.showOpenDialog=async()=>({canceled:false,filePaths:[${JSON.stringify(note)}]});return true;})()`);
 await waitJSON('http://127.0.0.1:19332/json/version');
 browser=await puppeteer.connect({browserURL:'http://127.0.0.1:19332'});
 let page;for(let i=0;i<100;i++){page=(await browser.pages()).find(p=>/^http:\/\/127.0.0.1:/.test(p.url()));if(page)break;await new Promise(r=>setTimeout(r,300));}
 assert.ok(page,'Packaged app page');await page.waitForSelector('body');
 await page.waitForFunction(()=>window.lh?.documents?.pick);
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 async function api(route,body,method){return page.evaluate(async(route,body,method)=>{const r=await fetch(route,{method:method||(body?'POST':'GET'),...(body?{headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{})});const b=await r.json();if(!r.ok)throw Error(b.error||r.status);return b;},route,body,method);}
 const chat=await api('/api/chats',{title:'Document integration QA'});
 await page.goto(new URL('/chat/'+chat.id,page.url()).href,{waitUntil:'networkidle2'});
 await page.waitForSelector('[data-testid="linked-documents-open"]');
 await page.click('[data-testid="linked-documents-open"]');
 // This crosses the real preload/IPC capability guard. Only the OS dialog is stubbed.
 await page.evaluate(()=>document.querySelector('[data-testid="link-markdown"]').click());
 await page.waitForFunction(async(chatId)=>{const b=await (await fetch('/api/documents')).json();return b.documents?.some(d=>d.chatIds.includes(chatId));},{},chat.id);
 const docs=await api('/api/documents');const id=docs.documents.find(d=>d.chatIds.includes(chat.id)).id;
 const chatFile=path.join(profile,'data/chats',chat.id+'.json');const record=JSON.parse(fs.readFileSync(chatFile));
 record.messages=[{role:'user',id:'qa_user',content:'Explain independent errors.',timestamp:1},{role:'assistant',id:'qa_teacher',content:[{type:'text',text:'Independent errors have zero covariance.'}],api:'openai-completions',provider:'qa',model:'qa',stopReason:'stop',timestamp:2,usage:{input:0,output:0,totalTokens:0,cost:{input:0,output:0,total:0}}}];
 fs.writeFileSync(chatFile,JSON.stringify(record));
 await api('/api/documents',{op:'backfill',chatId:chat.id});
 const logged=fs.readFileSync(note,'utf8');assert.ok(logged.startsWith(initial));assert.match(logged,/Independent errors have zero covariance/);
 await api('/api/documents',{op:'backfill',chatId:chat.id});assert.equal(fs.readFileSync(note,'utf8'),logged);
 const current=await api('/api/documents?id='+id);
 const proposal=await api('/api/documents',{op:'propose',documentId:id,chatId:chat.id,baseRevision:current.document.revision,before:'A paragraph written by a person.',after:'A clearer paragraph approved by the learner.',reason:'Integration edit'});
 assert.equal(fs.readFileSync(note,'utf8'),logged,'Proposal is read-only until Apply');
 await api('/api/documents',{op:'review',documentId:id,proposalId:proposal.id,action:'apply'});
 assert.match(fs.readFileSync(note,'utf8'),/A clearer paragraph approved/);
 await api('/api/documents',{op:'review',documentId:id,proposalId:proposal.id,action:'undo'});assert.equal(fs.readFileSync(note,'utf8'),logged);
 fs.appendFileSync(note,'\r\nAn annotation from another editor.\r\n');
 await api('/api/documents',{op:'backfill',chatId:chat.id});assert.match(fs.readFileSync(note,'utf8'),/An annotation from another editor/);
 let modelCalls=0;
 mock=http.createServer(async(req,res)=>{try{
  if(req.url==='/v1/models'){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({data:[{id:'note-fixture',context_window:8192,max_tokens:1024}]}));return;}
  assert.equal(req.url,'/v1/chat/completions');let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw);modelCalls++;
  assert.ok(body.tools.some(t=>t.function.name==='read_linked_document'));assert.ok(body.tools.some(t=>t.function.name==='propose_document_edit'));
  let delta,finish='tool_calls';
  if(modelCalls===1)delta={role:'assistant',tool_calls:[{index:0,id:'qa_read_note',type:'function',function:{name:'read_linked_document',arguments:'{}'}}]};
  else if(modelCalls===2){const tool=body.messages.find(m=>m.role==='tool'&&m.tool_call_id==='qa_read_note');assert.ok(tool,'Agent read tool result');const read=JSON.parse(typeof tool.content==='string'?tool.content:tool.content.map(p=>p.text||'').join(''));assert.equal(read.documentId,id);assert.match(read.text,/A paragraph written by a person/);delta={role:'assistant',tool_calls:[{index:0,id:'qa_propose_note',type:'function',function:{name:'propose_document_edit',arguments:JSON.stringify({documentId:read.documentId,baseRevision:read.revision,before:'A paragraph written by a person.',after:'A paragraph revised by the learning agent.',reason:'Learner requested a clearer introduction.'})}}]};}
  else {delta={role:'assistant',content:'A proposed edit is ready for your review.'};finish='stop';}
  res.writeHead(200,{'content-type':'text/event-stream'});for(const [part,reason] of [[delta,null],[{},finish]])res.write('data: '+JSON.stringify({id:'fixture',object:'chat.completion.chunk',created:1,model:'note-fixture',choices:[{index:0,delta:part,finish_reason:reason}]})+'\n\n');res.end('data: [DONE]\n\n');
 }catch(e){res.writeHead(500);res.end('Fixture assertion: '+e.message);}});
 await new Promise((resolve,reject)=>{mock.once('error',reject);mock.listen(3398,'127.0.0.1',resolve);});
 await page.evaluate(async()=>{const old=await fetch('/api/custom-provider');const r=await fetch('/api/custom-provider',{method:'POST',headers:{'content-type':'application/json','if-match':old.headers.get('etag')},body:JSON.stringify({baseUrl:'http://127.0.0.1:3398/v1',authMode:'keyless'})});if(!r.ok)throw Error('Local fixture provider setup failed');});
 const slot={model:{provider:'custom',id:'note-fixture'}};
 await api('/api/settings/models',{strong:slot,cheap:slot,vision:slot},'PUT');
 await api('/api/settings/graph',{enabled:false},'PUT');
 await api('/api/chats/'+chat.id+'/settings',{model:{provider:'custom',id:'note-fixture'}},'PUT');
 const turn=await page.evaluate(async(chatId)=>{const r=await fetch('/api/chat',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({chatId,input:{type:'text',text:'Please clarify the original introduction in my linked note.'}})});return {status:r.status,text:await r.text()};},chat.id);
 assert.equal(turn.status,200,turn.text.slice(0,500));assert.equal(modelCalls,3);
 let pending;for(let i=0;i<60;i++){const view=await api('/api/documents?id='+id);pending=view.document.proposals.find(p=>p.status==='pending'&&p.reason.includes('Learner requested'));if(pending&&view.text.includes('A proposed edit is ready'))break;await new Promise(r=>setTimeout(r,100));}
 assert.ok(pending,'Real agent created a reviewable edit');assert.match(fs.readFileSync(note,'utf8'),/A paragraph written by a person/);
 await api('/api/documents',{op:'review',documentId:id,proposalId:pending.id,action:'apply'});assert.match(fs.readFileSync(note,'utf8'),/A paragraph revised by the learning agent/);
 await api('/api/documents',{op:'review',documentId:id,proposalId:pending.id,action:'undo'});assert.match(fs.readFileSync(note,'utf8'),/A paragraph written by a person/);
 // A hidden BrowserWindow does not paint on all Windows GPU drivers.
 assert.deepEqual(errors,[]);
 fs.writeFileSync(path.join(root,'result.json'),JSON.stringify({passed:['packaged Electron startup','trusted native picker IPC','existing original note preserved','visible lesson logging','idempotent backfill','proposal/apply/undo on original file','external annotation survives','real teacher agent reads linked note and proposes scoped edit','live logging preserves agent proposal Apply and Undo','no renderer errors'],paidModelCalls:0},null,2));
 console.log('PASS packaged desktop original-note integration');
}finally{
 try{if(inspector?.readyState===WebSocket.OPEN){await inspect(`global.__qaElectron.dialog.showOpenDialog=global.__qaOriginalPicker;setTimeout(()=>global.__qaElectron.app.quit(),100)`);inspector.close();}}catch{}
 browser?.disconnect();
 mock?.close();
 setTimeout(()=>{if(app.exitCode===null)app.kill();},3000).unref();
}
