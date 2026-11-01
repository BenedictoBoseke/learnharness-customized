// Disposable emulator only. No emails, paid inference or personal notes.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import http from 'node:http';
import puppeteer from 'puppeteer-core';
const adbPath=process.env.ADB_PATH||'C:/Users/Ben/AppData/Local/Android/Sdk/platform-tools/adb.exe';
const adb=(...args)=>execFileSync(adbPath,['-s','emulator-5554',...args],{windowsHide:true,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
assert.match(adb('shell','getprop','ro.hardware'),/ranchu|goldfish/);
const out=fs.mkdtempSync(path.resolve('../../subject-android-ui-'));
fs.writeFileSync(path.resolve('../../subject-android-ui-latest.txt'),out);
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const original={size:adb('shell','wm','size'),density:adb('shell','wm','density'),font:adb('shell','settings','get','system','font_scale'),rotate:adb('shell','settings','get','system','accelerometer_rotation'),rotation:adb('shell','settings','get','system','user_rotation'),ime:adb('shell','settings','get','secure','show_ime_with_hard_keyboard')};
const results=[];let browser,page;
let inference=0;
const mock=http.createServer((req,res)=>{
  if(req.url==='/v1/models'){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({data:[{id:'android-subject-layout-fixture',context_window:32768,max_tokens:4096}]}));}
  else {inference++;res.writeHead(500).end('Unexpected model call in layout QA');}
});
await new Promise(r=>mock.listen(0,'127.0.0.1',r));
async function connect(){
  browser?.disconnect();
  for(let i=0;i<120;i++){
    try{
      const pid=adb('shell','pidof','ai.learnharness.mobile').split(' ')[0];
      adb('forward','tcp:19445','localabstract:webview_devtools_remote_'+pid);
      browser=await puppeteer.connect({browserURL:'http://127.0.0.1:19445',defaultViewport:null});
      page=(await browser.pages()).find(p=>p.url().startsWith('http://127.0.0.1:'));
      if(page){page.setDefaultTimeout(20000);await page.waitForSelector('[data-testid=stats-model]');return;}
    }catch{}await delay(500);
  }throw Error('QA WebView not available');
}
async function shot(name){adb('shell','screencap','-p','/sdcard/lh-qa.png');adb('pull','/sdcard/lh-qa.png',path.join(out,name+'.png'));}
async function closeSidebar(){if(await page.$eval('aside.sidebar-motion',e=>e.getBoundingClientRect().width>0))await page.click('[aria-label="Close sidebar"]');await delay(350);}
async function measure(name){
  const result=await page.evaluate(()=>({width:innerWidth,height:innerHeight,visibleHeight:visualViewport.height,compactIme:document.documentElement.hasAttribute('data-lh-compact-ime'),scrollWidth:document.documentElement.scrollWidth,dictate:(()=>{const r=document.querySelector('[data-testid=dictation-toggle]').getBoundingClientRect();return {w:r.width,h:r.height};})()}));
  if(!result.compactIme)assert.ok(result.dictate.w>=48&&result.dictate.h>=48,JSON.stringify(result));
  assert.ok(result.scrollWidth<=result.width+1,JSON.stringify(result));
  results.push({name,...result});await shot(name);return result;
}
try{
  adb('shell','settings','put','secure','show_ime_with_hard_keyboard','1');
  adb('shell','am','start','-n','ai.learnharness.mobile/.MainActivity');await connect();
  adb('reverse','tcp:33391','tcp:'+mock.address().port);
  await page.evaluate(async()=>{
    const request=async(url,body,method='PUT',extra={})=>{const r=await fetch(url,{method,headers:{'content-type':'application/json',...extra},body:JSON.stringify(body)});if(!r.ok)throw Error('Fixture configuration failed: '+await r.text());};
    const prior=await fetch('/api/custom-provider');
    await request('/api/custom-provider',{baseUrl:'http://127.0.0.1:33391/v1',authMode:'keyless'},'POST',{'if-match':prior.headers.get('etag')});
    const slot={model:{provider:'custom',id:'android-subject-layout-fixture'}};
    await request('/api/settings/models',{strong:slot,cheap:slot,vision:slot});
    await request('/api/settings/graph',{enabled:false});
  });
  // A new empty session does not invoke the model.
  const chat=await page.evaluate(async()=>{const r=await fetch('/api/chats',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({title:'Chinese subject UI QA with a long session name'})});if(!r.ok)throw Error('QA chat failed');return r.json();});
  await page.goto(new URL('/chat/'+chat.id,page.url()).href,{waitUntil:'domcontentloaded'});await page.waitForSelector('[data-testid=stats-model]');await closeSidebar();
  for(const width of (process.env.LH_QA_SKIP_WIDTHS ? [] : [320,360,393,411])){
    adb('shell','wm','size',(width*3)+'x2400');adb('shell','wm','density','480');
    await delay(1000);await connect();await closeSidebar();
    await page.goto(new URL('/chat/'+chat.id,page.url()).href,{waitUntil:'domcontentloaded'});await page.waitForSelector('[data-testid=stats-model]');await closeSidebar();
    const m=await measure('width-'+width);assert.equal(m.width,width,'Actual Android viewport width');
    await page.click('[data-testid=stats-model]');await page.waitForSelector('[data-testid=model-menu]');await delay(300);
    const menu=await page.$eval('[data-testid=model-menu]',e=>{const r=e.getBoundingClientRect();return {x:r.x,right:r.right,top:r.top,bottom:r.bottom,v:visualViewport.height};});
    assert.ok(menu.x>=7&&menu.right<=width-7,JSON.stringify(menu));
    results.push({name:'menu-'+width,...menu});await page.evaluate(()=>window.lhDismissTop());
    console.log('PASS actual Android '+width+'px viewport, Dictate and model menu');
  }
  const sessionPath=new URL(page.url()).pathname;
  const draft='Unsent rotation and keyboard QA draft 你怎么去医院？';
  await page.click('[contenteditable=true]');await page.keyboard.sendCharacter(draft);await delay(700);
  const send=await page.$eval('[data-testid=composer] button[aria-label="Send"]',e=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height,bottom:r.bottom,viewport:visualViewport.height};});
  assert.ok(send.w>=48&&send.h>=48&&send.bottom<=send.viewport,JSON.stringify(send));
  results.push({name:'keyboard-send',...send});await shot('keyboard-portrait');
  adb('shell','input','keyevent','4');await delay(400);
  await page.click('[data-testid=stats-model]');await page.waitForSelector('[data-testid=model-menu]');
  const search=await page.$('[data-testid=model-menu] input');if(search)await search.click();await delay(500);
  adb('shell','input','keyevent','4');await delay(1000);assert.ok(await page.$('[data-testid=model-menu]'),'First Back hides keyboard');
  adb('shell','input','keyevent','4');await page.waitForFunction(()=>!document.querySelector('[data-testid=model-menu]'),{timeout:10000});assert.equal(new URL(page.url()).pathname,sessionPath);
  assert.equal(await page.$eval('[contenteditable=true]',e=>e.textContent),draft);
  console.log('PASS keyboard send target, two-step hardware Back and unsent draft');
  adb('shell','settings','put','system','accelerometer_rotation','0');adb('shell','settings','put','system','user_rotation','1');await delay(1000);await connect();await closeSidebar();
  assert.equal(await page.$eval('[contenteditable=true]',e=>e.textContent),draft,'Draft survives rotation');
  await page.click('[contenteditable=true]');await delay(700);await measure('landscape-keyboard');
  const landscape=await page.$eval('[aria-label="Send"]',e=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height,bottom:r.bottom,v:visualViewport.height,hit:e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))};});assert.ok(landscape.y>=0&&landscape.w>=48&&landscape.h>=48&&landscape.bottom<=landscape.v&&landscape.hit,JSON.stringify(landscape));results.push({name:'landscape-send',...landscape});
  adb('shell','input','keyevent','4');adb('shell','settings','put','system','user_rotation','0');adb('shell','settings','put','system','font_scale','1.3');await delay(1500);await connect();await page.goto(new URL('/chat/'+chat.id,page.url()).href,{waitUntil:'domcontentloaded'});await page.waitForSelector('[data-testid=stats-model]');await closeSidebar();await measure('font-130');
  await page.click('[data-testid=top-bar] [data-testid=subjects-open]');await page.waitForSelector('[data-testid=subjects-dialog]');
  assert.equal(await page.evaluate(()=>document.activeElement?.getAttribute('aria-label')),'Close subjects');
  await shot('subjects-font-130');
  adb('shell','uiautomator','dump','/sdcard/lh-subject-accessibility.xml');adb('pull','/sdcard/lh-subject-accessibility.xml',path.join(out,'accessibility.xml'));
  assert.match(fs.readFileSync(path.join(out,'accessibility.xml'),'utf8'),/More options/);
  const accessibility=await page.$$eval('[data-testid=subjects-dialog] button',items=>items.map(e=>({name:e.getAttribute('aria-label')||e.textContent.trim(),disabled:e.disabled})));
  assert.ok(accessibility.some(e=>e.name==='Close subjects'&&!e.disabled));
  results.push({name:'modal-focus-and-labels',controls:accessibility});
  adb('shell','input','keyevent','4');await delay(1000);if(await page.$('[data-testid=subjects-dialog]'))adb('shell','input','keyevent','4');await page.waitForFunction(()=>!document.querySelector('[data-testid=subjects-dialog]'),{timeout:10000});
  assert.equal(new URL(page.url()).pathname,sessionPath);
  console.log('PASS rotation, landscape keyboard, 130% font and modal accessibility/Back');
  assert.equal(inference,0);
  fs.writeFileSync(path.join(out,'result.json'),JSON.stringify({passed:true,results,modelCalls:inference,talkBackInstalled:Boolean(adb('shell','pm','list','packages','talkback'))},null,2));
}finally{
  browser?.disconnect();
  adb('reverse','--remove','tcp:33391');await new Promise(r=>mock.close(r));
  adb('shell','wm','size',original.size.match(/Override size: (\S+)/)?.[1]||'reset');adb('shell','wm','density',original.density.match(/Override density: (\d+)/)?.[1]||'reset');
  for(const [key,value] of [['font_scale',original.font],['accelerometer_rotation',original.rotate],['user_rotation',original.rotation]])adb('shell','settings',value==='null'?'delete':'put','system',key,...(value==='null'?[]:[value]));
  adb('shell','settings',original.ime==='null'?'delete':'put','secure','show_ime_with_hard_keyboard',...(original.ime==='null'?[]:[original.ime]));
}
