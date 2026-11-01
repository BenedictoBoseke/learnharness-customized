import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import puppeteer from 'puppeteer-core';
const root=path.resolve('../../signin-recovery-qa');fs.mkdirSync(root,{recursive:true});
const listener=net.createServer();await new Promise(r=>listener.listen(0,'127.0.0.1',r));const port=listener.address().port;await new Promise(r=>listener.close(r));
const server=spawn(process.execPath,[path.resolve('.next/standalone/server.js')],{windowsHide:true,env:{...process.env,PORT:String(port),HOSTNAME:'127.0.0.1',NODE_ENV:'production',LH_DATA_DIR:path.join(root,'data'),LH_LOCAL_STATE_DIR:path.join(root,'device-state'),LH_AUTH_FILE:path.join(root,'auth.json')}});
const log=fs.createWriteStream(path.join(root,'server.log'));server.stdout.pipe(log);server.stderr.pipe(log);
let browser;let sends=0,verifications=0,signedIn=false;
const link='https://fixture.supabase.co/auth/v1/verify?token='+'a'.repeat(64)+'&type=magiclink';
const status=()=>({configured:true,signedIn,phase:signedIn?'local':'signed-out',deviceId:'fixture',deviceName:'Fixture',libraryId:null,localChanges:0,email:signedIn?'fixture@example.com':undefined,recoveries:[],fileReferences:[]});
try{
 for(let i=0;i<100;i++){try{if((await fetch('http://127.0.0.1:'+port)).ok)break;}catch{}await new Promise(r=>setTimeout(r,200));}
 browser=await puppeteer.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true,args:['--no-first-run','--disable-background-networking']});
 const p=await browser.newPage();await p.setViewport({width:1280,height:900});
 await p.setRequestInterception(true);
 p.on('request',async request=>{
  if(new URL(request.url()).pathname!=='/api/sync'){await request.continue();return;}
  const body=request.postData()?JSON.parse(request.postData()):{};let value=status(),code=200;
  if(body.op==='request-code'){sends++;code=400;value={error:'Supabase is limiting sign-in email requests. Paste an unused sign-in link already in your inbox, or wait before requesting another email.'};}
  else if(body.op==='verify-code'){assert.equal(body.email,'fixture@example.com');assert.equal(body.code,link);verifications++;signedIn=true;value=status();}
  else if(body.op==='libraries')value={libraries:[]};
  await request.respond({status:code,contentType:'application/json',body:JSON.stringify(value)});
 });
 async function open(){await p.waitForSelector('[data-testid="settings-entry"]',{visible:true});await p.click('[data-testid="settings-entry"]');await p.waitForSelector('[data-testid="settings-nav-sync"]');await p.click('[data-testid="settings-nav-sync"]');await p.waitForSelector('[aria-label="Sync email"]',{visible:true});}
 await p.goto('http://127.0.0.1:'+port,{waitUntil:'networkidle2'});await open();
 assert.ok(await p.$('[aria-label="Sync email code or sign-in link"]'),'Existing email can be used before any send');
 await p.type('[aria-label="Sync email"]','fixture@example.com');
 await p.$eval('[data-testid="section-sync"] form',form=>form.requestSubmit());
 await p.waitForFunction(()=>document.querySelector('[data-testid="section-sync"] [role="alert"]')?.textContent.includes('Supabase is limiting'));assert.equal(sends,1);
 assert.ok(await p.$('[aria-label="Sync email code or sign-in link"]'),'Throttling must not hide verification');
 await p.screenshot({path:path.join(root,'rate-limit-recovery.png')});
 await p.reload({waitUntil:'networkidle2'});await open();
 await p.type('[aria-label="Sync email"]','fixture@example.com');
 await p.type('[aria-label="Sync email code or sign-in link"]',link);
 await p.$eval('[data-testid="section-sync"] form',form=>form.requestSubmit());
 await p.waitForFunction(()=>[...document.querySelectorAll('[data-testid="section-sync"] button')].some(b=>b.textContent.trim()==='Sign out of sync'));
 assert.equal(verifications,1);assert.equal(sends,1,'Pasting a link after reload must not request another email');
 console.log('PASS existing-link sign-in before sending, after throttling, and after closing/reloading; no extra email sent');
 fs.writeFileSync(path.join(root,'result.json'),JSON.stringify({passed:['Existing-link field visible before sending','Sender failure preserves verification entry','Existing link works after reload without resend','Successful verification enters signed-in state'],actualEmailsSent:0},null,2));
}finally{await browser?.close();server.kill();}
