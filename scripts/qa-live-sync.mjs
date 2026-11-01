// Optional hosted integration test. Uses an isolated PC profile and a disposable emulator.
// Never print credentials or copy refresh sessions between devices.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {spawn,execFileSync} from 'node:child_process';
import puppeteer from 'puppeteer-core';
const root=path.resolve(process.env.LH_QA_ROOT||'../../live-sync-qa');
fs.mkdirSync(root,{recursive:true});
const profile=path.join(root,'desktop'),stateFile=path.join(root,'state.json');
const adbPath=process.env.ADB_PATH||'C:/Users/Ben/AppData/Local/Android/Sdk/platform-tools/adb.exe';
const adb=(...args)=>execFileSync(adbPath,['-s','emulator-5554',...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const op=process.argv[2]||'status';
if(op==='launch'){
 fs.mkdirSync(profile,{recursive:true});
 const log=fs.createWriteStream(path.join(root,'desktop.log'));
 const app=spawn(path.resolve('dist/win-unpacked/LearnHarness.exe'),['--remote-debugging-port=19335'],{windowsHide:true,env:{...process.env,LH_PROFILE_DIR:profile,LH_HEADLESS:'1'}});
 app.stdout.pipe(log);app.stderr.pipe(log);app.once('exit',code=>{process.exitCode=code||0;});
}else{
 let browser,forward,phoneBrowser,cdpForward;
 try{
  browser=await puppeteer.connect({browserURL:'http://127.0.0.1:19335'});
  const pc=(await browser.pages()).find(p=>p.url().startsWith('http://127.0.0.1:'));assert.ok(pc,'Isolated desktop page started');
  const desktop=(route,body,method)=>pc.evaluate(async(route,body,method)=>{const r=await fetch(route,{method:method||(body?'POST':'GET'),...(body?{headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{})});const b=await r.json();if(!r.ok)throw Error(b.error||'Desktop API failed');return b;},route,body,method);
  assert.match(adb('shell','getprop','ro.hardware'),/ranchu|goldfish/,'Only a disposable emulator');
  adb('shell','am','start','-n','ai.learnharness.mobile/.MainActivity');
  let info={port:0},forwardedPort=0;
  const phone=(route,body,method)=>new Promise((resolve,reject)=>{
   const r=http.request('http://127.0.0.1:'+forward+route,{agent:false,method:method||(body?'POST':'GET'),headers:{host:'127.0.0.1:'+info.port,origin:'http://127.0.0.1:'+info.port,'x-learnharness-android':info.token,...(body?{'content-type':'application/json'}:{})},timeout:60000},res=>{const chunks=[];res.on('data',b=>chunks.push(b));res.on('end',()=>{try{const b=JSON.parse(Buffer.concat(chunks));res.statusCode<400?resolve(b):reject(Error(b.error||'Android API failed'));}catch(e){reject(e);}});});r.on('error',reject);r.on('timeout',()=>r.destroy(Error('Android API timed out')));r.end(body?JSON.stringify(body):undefined);
  });
  let ready=false;
  for(let i=0;i<100;i++){try{info=JSON.parse(adb('shell','run-as','ai.learnharness.mobile','cat','no_backup/runtime-info.json'));if(info.port>=1024){if(forwardedPort!==info.port){if(forward)adb('forward','--remove','tcp:'+forward);forward=adb('forward','tcp:0','tcp:'+info.port);forwardedPort=info.port;}if((await phone('/__android/health')).ready){ready=true;break;}}}catch{}await delay(200);}
  assert.ok(ready,'Actual Android backend healthy after instrumentation shutdown');
  const sync=async(api,fields={})=>{let s;for(let i=0;i<12;i++){s=await api('/api/sync',{op:'sync',...fields});if(s.phase!=='waiting'||s.initialChoiceRequired)return s;await delay(150);}return s;};
  if(op==='status'){
   for(const [name,api]of [['desktop',desktop],['android',phone]]){const s=await api('/api/sync');console.log(name,JSON.stringify({configured:s.configured,signedIn:s.signedIn,phase:s.phase,message:s.message}));}
  }else if(op==='request-code'||op==='verify-code'){
   const api=process.argv[3]==='android'?phone:desktop;
   if(op==='request-code'){
    assert.ok(process.env.LH_QA_PROJECT_URL&&process.env.LH_QA_PUBLISHABLE_KEY&&process.env.LH_QA_EMAIL,'Connection environment required');
    await api('/api/sync',{op:'configure',projectUrl:process.env.LH_QA_PROJECT_URL,publishableKey:process.env.LH_QA_PUBLISHABLE_KEY});
    await api('/api/sync',{op:'request-code',email:process.env.LH_QA_EMAIL});console.log('Email code requested.');
   }else{
    assert.ok(process.env.LH_QA_EMAIL&&process.env.LH_QA_CODE,'Email/code environment required');
    const s=await api('/api/sync',{op:'verify-code',email:process.env.LH_QA_EMAIL,code:process.env.LH_QA_CODE});assert.equal(s.signedIn,true);console.log('Separate device sync sign-in verified.');
   }
  }else if(op==='exercise'){
   assert.equal((await desktop('/api/sync')).signedIn,true);assert.equal((await phone('/api/sync')).signedIn,true);
   const checks=[];const pass=x=>{checks.push(x);console.log('PASS',x);};
   const c=await desktop('/api/chats',{title:'Hosted sync integration fixture'});
   const file=path.join(profile,'data/chats',c.id+'.json'),record=JSON.parse(fs.readFileSync(file));
   record.messages=[{id:'qa_user_original',role:'user',content:'Explain covariance.',timestamp:1},{id:'qa_assistant_original',role:'assistant',timestamp:2,api:'openai-completions',provider:'qa',model:'qa',stopReason:'toolUse',usage:{input:0,output:0,totalTokens:0,cost:{input:0,output:0,total:0}},content:[{type:'text',text:'Independent errors have zero covariance.'},{type:'toolCall',id:'qa_quiz_original',name:'quiz',arguments:{type:'check',nodeId:'qa_covariance',question:'What is their covariance?',options:[{label:'Zero'},{label:'One'}],correctAnswer:'Zero',explanation:'Hidden until answered'}}]}];
   record.tree={nodes:[]};fs.writeFileSync(file,JSON.stringify(record));
   const made=await desktop('/api/sync',{op:'create-library',name:'QA disposable '+new Date().toISOString()});const libraryId=made.libraryId;fs.writeFileSync(stateFile,JSON.stringify({libraryId,chatId:c.id}));
   assert.equal((await sync(desktop)).phase,'synced');
   await phone('/api/sync',{op:'join-library',libraryId});assert.equal((await sync(phone,{initialChoice:'remote'})).phase,'synced');
   let imported=await phone('/api/chats/'+c.id);assert.deepEqual(imported.messages,record.messages);assert.deepEqual(imported.tree,record.tree);assert.equal((await phone('/api/sync?chatId='+c.id)).resumeRequired,true);pass('Real hosted PC to Android native messages, plan and pending quiz; explicit resume gate');
   const activityPid=adb('shell','pidof','ai.learnharness.mobile');
   cdpForward=adb('forward','tcp:0','localabstract:webview_devtools_remote_'+activityPid);
   phoneBrowser=await puppeteer.connect({browserURL:'http://127.0.0.1:'+cdpForward,defaultViewport:null});
   const phonePage=(await phoneBrowser.pages()).find(p=>p.url().startsWith('http://127.0.0.1:'+info.port));assert.ok(phonePage,'Actual Android app WebView');
   await phonePage.goto('http://127.0.0.1:'+info.port+'/chat/'+c.id,{waitUntil:'networkidle2',timeout:60000});
   if(await phonePage.$('[aria-label="Close sidebar"]'))await phonePage.click('[aria-label="Close sidebar"]');
   await phonePage.waitForFunction(()=>document.body.innerText.includes('What is their covariance?'));
   assert.ok(!(await phonePage.$eval('body',e=>e.innerText)).includes('Hidden until answered'));
   await phonePage.screenshot({path:path.join(root,'android-synced-session.png')});
   pass('Original Android UI renders the transferred pending quiz and keeps its explanation hidden');
   await phone('/api/sync',{op:'resume-session',chatId:c.id});
   // No sync while disconnected; the native rename remains entirely local.
   adb('shell','svc','wifi','disable');adb('shell','svc','data','disable');
   try{await phone('/api/chats/'+c.id,{title:'Edited offline on Android'},'PUT');const failed=await sync(phone);assert.equal(failed.phase,'error');assert.equal((await phone('/api/chats/'+c.id)).title,'Edited offline on Android');pass('Offline Android progress remains locally readable after failed transfer');}finally{adb('shell','svc','wifi','enable');adb('shell','svc','data','enable');}
   await delay(2000);let s;for(let i=0;i<10;i++){s=await sync(phone);if(s.phase==='synced')break;await delay(1500);}assert.equal(s.phase,'synced');await sync(desktop);assert.equal((await desktop('/api/chats/'+c.id)).title,'Edited offline on Android');pass('Offline changes reconcile through hosted storage after reconnect');
   // Mutate both before the background coalescing window, then fence using actual remote revisions.
   await Promise.all([desktop('/api/chats/'+c.id,{title:'Concurrent PC candidate'},'PUT'),phone('/api/chats/'+c.id,{title:'Concurrent Android candidate'},'PUT')]);
   const ps=await sync(desktop);s=await sync(phone);const loser=ps.phase==='conflict'?desktop:phone;const winner=ps.phase==='conflict'?phone:desktop;const conflict=await loser('/api/sync');assert.equal(conflict.phase,'conflict');assert.ok(conflict.conflict.keys.includes('chat/'+c.id));assert.ok(conflict.recoveries.length);const winningTitle=(await winner('/api/chats/'+c.id)).title;await sync(loser,{resolution:'remote'});assert.equal((await loser('/api/chats/'+c.id)).title,winningTitle);pass('Concurrent conversation edits are explicit conflicts with preserved recovery candidates');
   const messages=(await phone('/api/chats/'+c.id)).messages;assert.deepEqual(messages,record.messages,'Sync/resume without answering must not run inference');await sync(phone);await sync(desktop);assert.deepEqual((await phone('/api/chats/'+c.id)).messages,messages);pass('Repeated hosted synchronization does not duplicate native messages or quiz calls');
   fs.writeFileSync(path.join(root,'result.json'),JSON.stringify({time:new Date().toISOString(),libraryId,chatId:c.id,checks,paidModelCalls:0},null,2));
  }else throw Error('Unknown live QA command');
 }finally{browser?.disconnect();phoneBrowser?.disconnect();for(const port of [forward,cdpForward])if(port)try{adb('forward','--remove','tcp:'+port);}catch{}}
}
