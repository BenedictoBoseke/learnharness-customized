const fs = require('node:fs');
const {randomUUID} = require('node:crypto');
// Windows scanners/readers can briefly deny replacement. Keep the previous
// grant registry intact and retry only transient sharing violations.
function atomicFile(file, text) {
 const temporary=file+'.tmp-'+randomUUID();
 try {
  const descriptor=fs.openSync(temporary,'wx',0o600);
  try { fs.writeFileSync(descriptor,text); fs.fsyncSync(descriptor); }
  finally { fs.closeSync(descriptor); }
  for(let attempt=0;;attempt++) {
   try { fs.renameSync(temporary,file); break; }
   catch(error) {
    if(process.platform!=='win32'||attempt>=6||!['EPERM','EACCES','EBUSY'].includes(error.code))throw error;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10*2**attempt);
   }
  }
 } finally { try {fs.unlinkSync(temporary);}catch(error){if(error.code!=='ENOENT')throw error;} }
}
module.exports={atomicFile};
