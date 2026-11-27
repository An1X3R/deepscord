// @ts-check
'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {randomUUID}=require('node:crypto');
/** @type {typeof import('../public/js/chat-unread.js')} */
const {parseChatUnread,CHAT_UNREAD_LIMITS}=require('./app-server/public/js/chat-unread.js');
/** @typedef {import('../public/js/network-protocol.js').JsonValue} JsonValue */
/** @typedef {import('../public/js/chat-unread.js').UnreadDocument} UnreadDocument */
const MAX_INPUT_BYTES=8*1024*1024;

/** @param {string} userData */
function createChatUnreadStore(userData){
  if(!path.isAbsolute(userData))throw new TypeError('Unread storage requires an absolute user data directory');
  const filename=path.join(userData,'chat-unread.json');
  /** @type {UnreadDocument|null} */let current=null;
  /** @type {UnreadDocument|null} */let durable=null;
  /** @type {string|null} */let pending=null;
  /** @type {NodeJS.Timeout|null} */let timer=null;
  /** @type {Promise<void>|null} */let completion=null;
  /** @type {(()=>void)|null} */let complete=null;
  /** @type {((error:Error)=>void)|null} */let fail=null;
  /** @type {Error|null} */let failure=null;
  let writing=false,closing=false;
  /** @returns {UnreadDocument} */
  function read(){
    if(current)return structuredClone(current);
    if(!fs.existsSync(filename)){current={version:1,entries:[]};durable=current;return structuredClone(current);}
    const stat=fs.lstatSync(filename);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.size>CHAT_UNREAD_LIMITS.bytes)throw new RangeError(`Unread storage must be a regular file of at most ${CHAT_UNREAD_LIMITS.bytes} bytes: ${filename}`);
    current=parseChatUnread(/** @type {JsonValue} */(JSON.parse(fs.readFileSync(filename,'utf8'))));
    durable=current;
    return structuredClone(current);
  }
  /** @param {string} serialized @returns {Promise<void>} */
  async function write(serialized){
    await fs.promises.mkdir(userData,{recursive:true});
    const temporary=filename+'.pending-'+randomUUID();
    const file=await fs.promises.open(temporary,'wx',0o600);
    try{
      try{await file.writeFile(serialized,'utf8');await file.sync();}finally{await file.close();}
      await fs.promises.rename(temporary,filename);
      if(process.platform!=='win32'){
        const directory=await fs.promises.open(userData,'r');
        try{await directory.sync();}finally{await directory.close();}
      }
    }catch(error){
      try{await fs.promises.unlink(temporary);}catch(cleanupError){
        if(!(cleanupError instanceof Error && 'code' in cleanupError && cleanupError.code==='ENOENT'))console.error('unread_temporary_cleanup_failed',{filename:temporary,message:String(cleanupError)});
      }
      throw error;
    }
  }
  /** @returns {Promise<void>} */
  async function drain(){
    if(writing)return;
    writing=true;
    try{
      while(pending!==null){
        const serialized=pending,snapshot=current;
        pending=null;
        await write(serialized);
        durable=snapshot;
      }
      failure=null;
      complete?.();
    }catch(error){
      failure=error instanceof Error?error:new Error('Unread persistence failed with a non-error',{cause:error});
      pending=null;current=durable;
      console.error('unread_persistence_failed',{filename,message:failure.message});
      fail?.(failure);
    }finally{writing=false;completion=null;complete=null;fail=null;}
  }
  /** @param {JsonValue} input @returns {Promise<void>} */
  function save(input){
    if(closing)throw new Error('Unread storage is closing');
    if(Buffer.byteLength(JSON.stringify(input),'utf8')>MAX_INPUT_BYTES)throw new RangeError('Unread input exceeds its 8 MiB transfer budget');
    const parsed=parseChatUnread(input),serialized=JSON.stringify(parsed);
    if(Buffer.byteLength(serialized,'utf8')>CHAT_UNREAD_LIMITS.bytes)throw new RangeError('Unread storage exceeds its serialized file budget');
    if(current===null)read();
    if(serialized===JSON.stringify(current))return completion??Promise.resolve();
    current=parsed;pending=serialized;
    if(!completion){
      completion=new Promise((resolve,reject)=>{complete=resolve;fail=reject;});
      timer=setTimeout(()=>{timer=null;void drain();},150);
    }
    return completion;
  }
  /** @returns {Promise<void>} */
  function flush(){
    const result=completion;
    if(timer){clearTimeout(timer);timer=null;void drain();}
    return result??(failure?Promise.reject(failure):Promise.resolve());
  }
  /** @returns {Promise<void>} */
  function close(){closing=true;return flush().catch(error=>{closing=false;throw error;});}
  return {read,save,flush,close};
}
module.exports={createChatUnreadStore};
