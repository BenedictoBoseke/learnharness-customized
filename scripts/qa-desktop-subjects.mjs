// Packaged Electron, isolated profile and synthetic originals. The native
// directory picker result is stubbed; trusted IPC and grant validation are real.
import assert from 'node:assert/strict';
import fs from 'node:fs';import path from 'node:path';
import {spawn,execFileSync} from 'node:child_process';
import puppeteer from 'puppeteer-core';
const root=fs.mkdtempSync(path.resolve('../../subject-desktop-qa-'));
fs.writeFileSync(path.resolve('../../subject-desktop-qa-latest.txt'),root);
const profile=path.join(root,'profile'),folder=path.join(root,'Chinese');fs.mkdirSync(folder);
for(const name of ['HSK 1.md','HSK 1 - Checkpoint.md','HSK 1 - Lesson Log.md'])fs.writeFileSync(path.join(folder,name),'---\r\ntags: [中文]\r\n---\r\n# Transport\r\nPractise transport questions.\r\n');
const exe=path.resolve('dist/win-unpacked/LearnHarness.exe');let app,browser,inspector,page,sequence=0;
const pending=new Map();
async function json(url){for(let i=0;i<100;i++){try{const r=await fetch(url);if(r.ok)return r.json();}catch{}await new Promise(r=>setTimeout(r,300));}throw Error('Packaged app did not start');}
async function inspect(expression){const id=++sequence;return new Promise((resolve,reject)=>{pending.set(id,{resolve,reject});inspector.send(JSON.stringify({id,method:'Runtime.evaluate',params:{expression,returnByValue:true,awaitPromise:true}}));});}
async function launch(){
 app=spawn(exe,['--inspect=127.0.0.1:19341','--remote-debugging-port=19342'],{windowsHide:true,env:{...process.env,LH_PROFILE_DIR:profile,LH_HEADLESS:'1'}});const log=fs.createWriteStream(path.join(root,'electron-'+Date.now()+'.log'));app.stdout.pipe(log);app.stderr.pipe(log);
 const targets=await json('http://127.0.0.1:19341/json/list');inspector=new WebSocket(targets[0].webSocketDebuggerUrl);await new Promise((r,j)=>{inspector.onopen=r;inspector.onerror=j;});inspector.onmessage=e=>{const m=JSON.parse(e.data),p=pending.get(m.id);if(p){pending.delete(m.id);m.error||m.result?.exceptionDetails?p.reject(Error('Inspector fixture failed')):p.resolve(m.result.result.value);}};
 await inspect(`(async()=>{global.__qaElectron=process.getBuiltinModule('module').createRequire(process.resourcesPath+'/app.asar/package.json')('electron');global.__qaElectron.dialog.showOpenDialog=async()=>({canceled:false,filePaths:[${JSON.stringify(folder)}]});return true;})()`);
 await json('http://127.0.0.1:19342/json/version');browser=await puppeteer.connect({browserURL:'http://127.0.0.1:19342'});
 for(let i=0;i<100;i++){page=(await browser.pages()).find(p=>p.url().startsWith('http://127.0.0.1:'));if(page)break;await new Promise(r=>setTimeout(r,200));}assert.ok(page);await page.waitForFunction(()=>Boolean(window.lh?.documents?.pick));
}
async function stop(){browser?.disconnect();inspector?.close();if(app&&!app.killed){try{execFileSync('taskkill',['/PID',String(app.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});}catch{}app=null;}await new Promise(r=>setTimeout(r,500));}
const api=(route,body)=>page.evaluate(async({route,body})=>{const r=await fetch(route,body?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}:undefined);const b=await r.json();if(!r.ok)throw Error(b.error);return b;},{route,body});
try{
 await launch();
 const picked=await page.evaluate(()=>window.lh.documents.pick('folder'));assert.equal(picked.kind,'desktop');assert.ok(picked.handle.startsWith('grant_'));assert.ok(!JSON.stringify(picked).includes(folder),'Renderer receives opaque grant, not absolute path');
 assert.equal((await page.evaluate(()=>window.lh.documents.pick('folder'))).handle,picked.handle,'Repeated selection reuses grant');
 const preview=await api('/api/subjects',{op:'preview',folder:picked});assert.equal(preview.paths.length,3);
 const w=await api('/api/subjects',{op:'link',previewId:preview.previewId,name:'Chinese desktop QA',mode:'external',included:preview.paths});let detail;
 for(let i=0;i<200;i++){detail=await api('/api/subjects?id='+w.id);if(detail.subject.scan.phase!=='scanning')break;await new Promise(r=>setTimeout(r,100));}assert.equal(detail.subject.notes.length,3);
 const note=detail.subject.notes.find(n=>n.path==='HSK 1.md');const first=await api('/api/subjects?id='+w.id+'&noteId='+note.id);assert.match(first.text,/Practise transport/);assert.ok(!first.error);
 await stop();await launch();const resumed=await api('/api/subjects?id='+w.id+'&noteId='+note.id);assert.equal(resumed.text,first.text);assert.ok(!resumed.error,'Grant persists across packaged app restart');
 assert.equal((await api('/api/subjects?id='+w.id)).subject.notes.find(n=>n.path===note.path).id,note.id);
 fs.appendFileSync(path.join(folder,note.path),'Human annotation after restart.\r\n');assert.match((await api('/api/subjects?id='+w.id+'&noteId='+note.id)).text,/Human annotation/);
 // Hidden Electron windows do not paint on every Windows GPU driver. Layout
 // screenshots are captured by the separate production-browser UI harness.
 fs.writeFileSync(path.join(root,'result.json'),JSON.stringify({passed:true,nativePicker:'result stubbed; actual trusted IPC and grant store',restart:true,notes:3,modelCalls:0},null,2));
 console.log('PASS packaged Windows folder IPC, opaque/reused grant, persisted originals and stable note IDs across restart; no model calls');
}finally{await stop();}
