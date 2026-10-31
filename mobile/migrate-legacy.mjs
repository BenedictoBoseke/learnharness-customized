/** Preserve simplified Android records without inventing original-engine evidence. AGPL-3.0-only. */
import fs from 'node:fs/promises';
import { constants as FS } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const MAX_BYTES=8*1024*1024,MAX_TEXT=200000;
const obj=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const hash=v=>createHash('sha256').update(v).digest('hex');
const assert=(yes,reason)=>{if(!yes)throw new Error(reason);};
const string=(v,max=MAX_TEXT)=>typeof v==='string'&&v.length<=max;
const safeId=v=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,120}$/.test(v)&&!['__proto__','constructor','prototype'].includes(v);
const iso=v=>string(v,80)&&Number.isFinite(Date.parse(v));

function validate(input){
 assert(obj(input)&&input.version===1,'Unsupported legacy library version');
 for(const key of ['sessions','concepts','notes'])assert(Array.isArray(input[key])&&input[key].length<=10000,'Invalid '+key+' collection');
 const ids=new Set();const unique=id=>{assert(safeId(id)&&!ids.has(id),'Invalid or duplicate legacy identity');ids.add(id);};
 const sessions=new Set(),concepts=new Set(),notes=new Set();
 for(const s of input.sessions){assert(obj(s),'Invalid session');unique(s.id);sessions.add(s.id);assert(string(s.title,1000)&&['teach','practice'].includes(s.mode)&&['probe','plan','teach','practice'].includes(s.phase)&&iso(s.updatedAt),'Invalid session metadata');assert(Array.isArray(s.messages)&&s.messages.length<=10000&&Array.isArray(s.plan)&&s.plan.length<=100,'Invalid session messages or plan');if(s.question!==undefined)assert(string(s.question),'Invalid pending question');
  for(const m of s.messages)assert(obj(m)&&['user','assistant'].includes(m.role)&&string(m.content)&&(m.reasoning===undefined||string(m.reasoning))&&(m.question===undefined||string(m.question)),'Invalid transcript message');
  const planIds=new Set();for(const p of s.plan){assert(obj(p)&&safeId(p.id)&&!planIds.has(p.id)&&string(p.title,2000)&&['upcoming','current','visited'].includes(p.status),'Invalid legacy plan');planIds.add(p.id);}
 }
 for(const n of input.notes){assert(obj(n),'Invalid note');unique(n.id);notes.add(n.id);assert(string(n.title,1000)&&string(n.text)&&iso(n.createdAt),'Invalid note metadata');}
 for(const c of input.concepts){assert(obj(c),'Invalid concept');unique(c.id);concepts.add(c.id);assert(string(c.title,1000)&&string(c.statement)&&Array.isArray(c.premises)&&c.premises.length<=100&&c.premises.every(safeId),'Invalid concept metadata');const sources=c.sourceSessionIds??(c.sourceSessionId?[c.sourceSessionId]:[]);assert(Array.isArray(sources)&&sources.every(id=>sessions.has(id)),'Unknown legacy session provenance');if(c.sourceNoteId!==undefined)assert(notes.has(c.sourceNoteId),'Unknown legacy note provenance');}
 for(const c of input.concepts)assert(c.premises.every(id=>id!==c.id&&concepts.has(id)),'Dangling or self-referencing legacy premise');
 return input;
}
async function privateDirectory(root,relative){
 let current=root;
 for(const part of relative.split('/')){
  assert(part&&part!=='.'&&part!=='..'&&/^[A-Za-z0-9._-]+$/.test(part),'Unsafe migration directory');current=path.join(current,part);
  try{const info=await fs.lstat(current);assert(info.isDirectory()&&!info.isSymbolicLink(),'Migration destination is not a private directory');}
  catch(e){if(e.code!=='ENOENT')throw e;await fs.mkdir(current,{mode:0o700});}
 }
 return current;
}
async function readBounded(file){
 const info=await fs.lstat(file);assert(info.isFile()&&!info.isSymbolicLink(),'Legacy library is not a regular private file');assert(info.size<=MAX_BYTES,'Legacy library exceeds 8 MiB');
 const handle=await fs.open(file,FS.O_RDONLY|(FS.O_NOFOLLOW||0));
 try{const chunks=[];let total=0;while(true){const buf=Buffer.alloc(Math.min(65536,MAX_BYTES+1-total));const {bytesRead}=await handle.read(buf,0,buf.length,null);if(!bytesRead)break;total+=bytesRead;assert(total<=MAX_BYTES,'Legacy library grew beyond 8 MiB');chunks.push(buf.subarray(0,bytesRead));}return Buffer.concat(chunks);}finally{await handle.close();}
}
async function writeNew(file,bytes){
 let handle;
 try{handle=await fs.open(file,'wx',0o600);await handle.writeFile(bytes);await handle.sync();return true;}
 catch(e){if(e.code==='EEXIST'){const stat=await fs.lstat(file);assert(stat.isFile()&&!stat.isSymbolicLink(),'Migration destination is not a regular file');return false;}throw e;}
 finally{await handle?.close();}
}
async function atomicReport(file,report){const tmp=file+'.tmp-'+randomUUID();let handle;try{handle=await fs.open(tmp,'wx',0o600);await handle.writeFile(JSON.stringify(report,null,2)+'\n');await handle.sync();await handle.close();handle=null;await fs.rename(tmp,file);}finally{await handle?.close();await fs.unlink(tmp).catch(e=>{if(e.code!=='ENOENT')throw e;});}}
function messageText(m){return m.content+(m.reasoning?'\n\n[Legacy learner reasoning]\n'+m.reasoning:'')+(m.question?'\n\n[Legacy question]\n'+m.question:'');}
function nativeRecord(s,digest){
 const id='android_'+hash(digest+':session:'+s.id).slice(0,32),timestamp=Date.parse(s.updatedAt);
 const messages=s.messages.map((m,i)=>({id:'msg_android_'+hash(digest+':'+s.id+':'+i).slice(0,28),role:m.role,content:m.role==='assistant'?[{type:'text',text:messageText(m)}]:messageText(m),timestamp,androidLegacyImport:{version:1,sourceSessionId:s.id,sourceMessageIndex:i,timestampApproximate:true}}));
 if(s.question&&!s.messages.some(m=>m.question===s.question)){
  const lastAssistant=messages.findLast(m=>m.role==='assistant');
  if(lastAssistant)lastAssistant.content[0].text+='\n\n[Legacy pending question; no original-engine answer state]\n'+s.question;
 }
 // There is no real provider/model/usage record in the old app. Do not mint one.
 // The original readers/projector accept these native text shapes; usage remains absent.
 return {version:1,id,title:s.title,createdAt:s.updatedAt,updatedAt:s.updatedAt,...(s.mode==='practice'?{kind:'practice'}:{}),messages,androidLegacyImport:{version:1,sourceHash:digest,sourceSessionId:s.id,createdAtDerivedFromUpdatedAt:true,originalPhase:s.phase,originalPlanArchived:true}};
}

/** Called once before the original server imports any stores. Never reads preferences/credentials. */
export async function migrateLegacy(privateRoot){
 assert(typeof privateRoot==='string'&&path.isAbsolute(privateRoot),'An absolute app-private root is required');
 const root=await fs.realpath(privateRoot);assert(root!==path.parse(root).root&&(await fs.stat(root)).isDirectory(),'Refusing a filesystem root as app-private storage');
 const source=path.join(root,'learning.json');let bytes;
 try{bytes=await readBounded(source);}catch(e){
  if(e.code==='ENOENT')return {version:1,status:'absent',imported:{sessions:0,messages:0,notes:0,graphNodes:0,graphChains:0},limitations:[]};
  const rejected={version:1,status:'rejected',sourceHash:null,sourceFile:'learning.json',backupPath:null,imported:{sessions:0,messages:0,notes:0,graphNodes:0,graphChains:0},limitations:['Legacy file could not be safely read within the 8 MiB regular-file bound. It was not modified. No records or credentials were imported.']};
  const data=await privateDirectory(root,'original/data');await atomicReport(path.join(data,'android-migration.json'),rejected);return rejected;
 }
 const digest=hash(bytes),legacyDir=await privateDirectory(root,'original/legacy'),dataDir=await privateDirectory(root,'original/data');
 const marker=path.join(dataDir,'android-migration.json');
 try{const old=JSON.parse((await readBounded(marker)).toString('utf8'));if(old.version===1&&old.sourceHash===digest&&['complete','rejected'].includes(old.status))return old;}catch(e){if(e.code!=='ENOENT'&&e.name!=='SyntaxError')throw e;}
 const archiveName='android-'+digest+'.json',archive=path.join(legacyDir,archiveName);
 const createdArchive=await writeNew(archive,bytes);
 if(!createdArchive)assert(hash(await readBounded(archive))===digest,'Existing immutable legacy archive differs from source');
 const report={version:1,status:'complete',sourceHash:digest,sourceFile:'learning.json',backupPath:'original/legacy/'+archiveName,imported:{sessions:0,messages:0,notes:0,graphNodes:0,graphChains:0},preserved:{concepts:0,plans:0},skipped:{sessions:0,notes:0},sessionIds:{},limitations:[]};
 let legacy;
 try{legacy=validate(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes),(key,value)=>{if(['__proto__','prototype','constructor'].includes(key))throw new Error('Unsafe legacy object key');return value;}));}
 catch(e){report.status='rejected';report.limitations=['Legacy data failed validation. Original file and immutable backup were preserved; no sessions, notes, or graph records were imported.'];await atomicReport(marker,report);return report;}
 const chats=await privateDirectory(root,'original/data/chats'),attachments=await privateDirectory(root,'original/attachments');
 for(const s of legacy.sessions){const record=nativeRecord(s,digest);report.sessionIds[s.id]=record.id;const written=await writeNew(path.join(chats,record.id+'.json'),JSON.stringify(record,null,2)+'\n');if(written){report.imported.sessions++;report.imported.messages+=record.messages.length;}else report.skipped.sessions++;if(s.plan.length)report.preserved.plans++;}
 for(const n of legacy.notes){const name='android-note-'+hash(digest+':note:'+n.id).slice(0,28)+'.txt';const text=n.title+'\n\n'+n.text;const written=await writeNew(path.join(attachments,name),text);if(written)report.imported.notes++;else report.skipped.notes++;}
 report.preserved.concepts=legacy.concepts.length;
 if(legacy.concepts.length){const graphName='android-graph-'+digest.slice(0,24)+'.txt';const text='Imported legacy Android graph proposals — not audited by the original engine.\n\n'+legacy.concepts.map(c=>c.title+'\n'+c.statement+'\nLegacy ID: '+c.id+'\nProposed premises: '+c.premises.join(', ')+'\n').join('\n');await writeNew(path.join(attachments,graphName),text);}
 report.limitations=[
  'Imported transcripts contain only preserved user/assistant text. Legacy questions and reasoning are labeled text; no original question tools, answer grades, active problems, probe handoffs, plan trees, or usage records were invented.',
  'Legacy message timestamps were unavailable. Each imported message uses the session updatedAt timestamp and is marked approximate; session createdAt is derived from updatedAt.',
  'Legacy graph propositions and premise proposals remain in the immutable aggregate backup and a readable attachment. They were not inserted into audited graph ledgers because message-level provenance, original reasoning-chain evidence, and audit state cannot be reconstructed.',
  'Legacy plan snapshots remain archived rather than being converted into completed original-engine plan states. Imported sessions resume using the original engine’s normal initial phase.',
  'Notes are preserved as text files in original/attachments; importing/extracting their knowledge remains an explicit original-app operation.',
  'Provider keys, account tokens, and Android shared preferences were not read or migrated.'
 ];
 const reportFile=path.join(legacyDir,'android-'+digest+'-report.json');await writeNew(reportFile,JSON.stringify(report,null,2)+'\n');await atomicReport(marker,report);return report;
}

export default migrateLegacy;
