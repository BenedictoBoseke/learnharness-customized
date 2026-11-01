// Uses real hosted REST/Storage/RPC with two isolated local replicas. This is
// distinct from (and does not substitute for) the actual Android-device test.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {SupabaseConnection} from '../src/server/sync/supabase.ts';
import {SyncEngine} from '../src/server/sync/engine.ts';
import {LibraryReplica} from '../src/store/library-replica.ts';
import {atomicWrite} from '../src/store/atomic-json.ts';
assert.ok(process.env.LH_QA_AUTH,'Set LH_QA_AUTH to an already signed-in isolated test connection');
const auth=new SupabaseConnection(path.resolve(process.env.LH_QA_AUTH));
const remote=await auth.transport();
const root=path.resolve(process.env.LH_QA_ROOT||'../../hosted-replica-qa');
fs.mkdirSync(root,{recursive:true});
const libraryId=await remote.createLibrary('QA hosted replicas '+new Date().toISOString());
const checks=[];const pass=x=>{checks.push(x);console.log('PASS',x);};
function device(name){const dataDir=path.join(root,name,'data');const replica=new LibraryReplica({dataDir,localDir:path.join(root,name,'state'),attachmentsDir:path.join(root,name,'attachments'),deviceId:name});const options={replica,deviceId:name,deviceName:name,isBusy:()=>false};const engine=new SyncEngine(options);engine.join(libraryId);return {dataDir,replica,engine,options};}
const pc=device('pc'),other=device('second-replica');
const chatFile=d=>path.join(d.dataDir,'chats/chat_hosted_fixture.json');
const read=d=>JSON.parse(fs.readFileSync(chatFile(d),'utf8'));
const original={version:1,id:'chat_hosted_fixture',title:'Hosted session fixture',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),messages:[{role:'user',id:'user_hosted_original',timestamp:1,content:'Explain independent measurement errors.'}],tree:{nodes:[]}};
atomicWrite(chatFile(pc),JSON.stringify(original));
const attachment=path.join(root,'reference.md');fs.writeFileSync(attachment,'Invented portable learning reference.\n');pc.replica.register(attachment);
original.messages[0].content+=' Read `'+attachment+'`.';atomicWrite(chatFile(pc),JSON.stringify(original));
assert.equal((await pc.engine.sync(remote)).phase,'synced');assert.equal((await other.engine.sync(remote)).phase,'synced');
assert.equal(read(other).messages[0].id,'user_hosted_original');assert.deepEqual(read(other).tree,original.tree);
const binding=other.replica.references().find(f=>f.name==='reference.md');assert.ok(binding?.bound);pass('Real private Storage blobs and database revision publish/import preserve native identity and attachment binding');
let c=read(other);c.title='Offline second-replica change';atomicWrite(chatFile(other),JSON.stringify(c));
const offline={...remote,head:async()=>{throw Error('QA disconnected transport');}};
assert.equal((await other.engine.sync(offline)).phase,'error');assert.equal(read(other).title,c.title);
assert.equal((await other.engine.sync(remote)).phase,'synced');await pc.engine.sync(remote);assert.equal(read(pc).title,c.title);pass('Failed network transfer preserves local state and reconnect publishes the offline edit');
for(const [d,title]of [[pc,'PC concurrent candidate'],[other,'Second concurrent candidate']]){c=read(d);c.title=title;atomicWrite(chatFile(d),JSON.stringify(c));}
await pc.engine.sync(remote);assert.equal((await other.engine.sync(remote)).phase,'conflict');assert.ok(other.engine.recoveries().length>=2);await other.engine.sync(remote,{resolution:'remote'});assert.equal(read(other).title,'PC concurrent candidate');pass('Real hosted revision comparison surfaces concurrent-session conflict and preserves both candidates');
c=read(pc);c.title='Lost-response fixture';atomicWrite(chatFile(pc),JSON.stringify(c));let lose=true;
const lossy={...remote,commit:async(...args)=>{const receipt=await remote.commit(...args);if(lose){lose=false;throw Error('QA response interrupted after hosted commit');}return receipt;}};
assert.equal((await pc.engine.sync(lossy)).phase,'error');const operationId=pc.engine.state().pending.operationId;
const restarted=new SyncEngine(pc.options);assert.equal((await restarted.sync(remote)).phase,'synced');assert.equal(restarted.state().pending,undefined);await other.engine.sync(remote);assert.equal(read(other).title,'Lost-response fixture');pass('A lost hosted commit response survives process-state restart and retries the same operation identity');
fs.unlinkSync(chatFile(pc));await restarted.sync(remote);await other.engine.sync(remote);assert.equal(fs.existsSync(chatFile(other)),false);pass('Deletion propagates without resurrecting the stale conversation');
fs.writeFileSync(path.join(root,'result.json'),JSON.stringify({time:new Date().toISOString(),libraryId,operationId,checks,environment:'Two isolated local replicas, actual hosted Supabase account and private storage; not an Android sign-in test',paidModelCalls:0},null,2));
