// @ts-check
'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {randomUUID}=require('node:crypto');
const {writeAtomicFile}=require('./app-server/lib/atomic-file.cjs');
/** @typedef {'join'|'leave'} SoundKind */
/** @typedef {{name:string,data:string}} SoundRecord */
const MAX_BYTES=2*1024*1024;
/** @param {string} input @returns {SoundKind} */
function soundKind(input){if(input!=='join'&&input!=='leave')throw new TypeError('提示音类型必须为加入或离开');return input;}
/** @param {SoundRecord} input @returns {SoundRecord} */
function soundRecord(input){
  if(!input||typeof input!=='object'||typeof input.name!=='string'||input.name.length<1||input.name.length>255||/[\u0000-\u001f]/.test(input.name)||typeof input.data!=='string'||!input.data.length||input.data.length>Math.ceil(MAX_BYTES/3)*4||(input.data.length%4!==0||/[^A-Za-z0-9+/=]/.test(input.data)))throw new TypeError('本机提示音记录损坏，请重新选择音频或恢复默认');
  if(Buffer.from(input.data,'base64').toString('base64')!==input.data)throw new TypeError('本机提示音编码损坏，请重新选择');
  if(Buffer.from(input.data,'base64').length>MAX_BYTES)throw new RangeError('提示音文件不能超过 2 MiB');
  return {name:input.name,data:input.data};
}
/** @param {string} directory */
function createNotificationSoundStore(directory){
  /** @param {SoundKind} kind */
  const filename=kind=>path.join(directory,'notification-sound-'+soundKind(kind)+'.json');
  /** @param {SoundKind} kind @returns {SoundRecord|null} */
  function read(kind){const file=filename(kind);if(!fs.existsSync(file))return null;const stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>3*1024*1024)throw new RangeError('本机提示音文件损坏：'+file);try{return soundRecord(JSON.parse(fs.readFileSync(file,'utf8')));}catch(error){if(error instanceof SyntaxError)throw new SyntaxError('本机提示音记录损坏，请重新选择音频或恢复默认：'+file,{cause:error});throw error;}}
  /** @param {SoundKind} kind @param {SoundRecord} record */
  function save(kind,record){const parsed=soundRecord(record);fs.mkdirSync(directory,{recursive:true});writeAtomicFile(filename(kind),JSON.stringify(parsed));}
  /** @param {SoundKind} kind */
  function reset(kind){const file=filename(kind);if(fs.existsSync(file))fs.unlinkSync(file);}
  return {read,save,reset};
}
/** @param {{ipcMain:import('electron').IpcMain,dialog:import('electron').Dialog,directory:string,assertSender:(event:import('electron').IpcMainInvokeEvent)=>string}} options */
function registerNotificationSoundIpc({ipcMain,dialog,directory,assertSender}){
  const store=createNotificationSoundStore(directory);
  /** @type {Map<number,{token:string,kind:SoundKind,record:SoundRecord}>} */const pending=new Map();
  /** @type {Set<number>} */const choosing=new Set();
  /** @type {WeakSet<import('electron').WebContents>} */const observed=new WeakSet();
  ipcMain.handle('notification-sound:read',(event,kind)=>{assertSender(event);return store.read(soundKind(kind));});
  ipcMain.handle('notification-sound:reset',(event,kind)=>{assertSender(event);pending.delete(event.sender.id);store.reset(soundKind(kind));});
  ipcMain.handle('notification-sound:choose',async(event,input)=>{
    assertSender(event);const kind=soundKind(input),sender=event.sender,id=sender.id;
    if(choosing.has(id))throw new Error('提示音文件选择窗口已经打开');
    choosing.add(id);pending.delete(id);
    try{
      const selected=await dialog.showOpenDialog({title:'选择本机提示音（不超过 2 MiB / 10 秒）',properties:['openFile'],filters:[{name:'音频',extensions:['mp3','wav','ogg','m4a','flac']}]});
      if(selected.canceled)return null;
      assertSender(event);
      const file=selected.filePaths[0];if(!file)throw new Error('文件选择窗口未返回音频文件');
      const stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size<1||stat.size>MAX_BYTES)throw new RangeError('请选择不超过 2 MiB 的普通音频文件');
      const descriptor=fs.openSync(file,'r');let bytes;
      try{bytes=Buffer.alloc(MAX_BYTES+1);const length=fs.readSync(descriptor,bytes,0,bytes.length,0);if(length>MAX_BYTES)throw new RangeError('提示音文件不能超过 2 MiB');bytes=bytes.subarray(0,length);}finally{fs.closeSync(descriptor);}
      const record=soundRecord({name:path.basename(file),data:bytes.toString('base64')}),token=randomUUID();
      if(!observed.has(sender)){observed.add(sender);sender.once('destroyed',()=>pending.delete(id));}
      pending.set(id,{token,kind,record});return {token,record};
    }finally{choosing.delete(id);}
  });
  ipcMain.handle('notification-sound:save',(event,input)=>{
    assertSender(event);if(!input||typeof input!=='object'||typeof input.token!=='string')throw new TypeError('提示音保存请求缺少文件选择凭据');
    const selected=pending.get(event.sender.id);if(!selected||selected.token!==input.token)throw new Error('提示音文件选择已过期，请重新选择');
    store.save(selected.kind,selected.record);pending.delete(event.sender.id);
  });
}
module.exports={createNotificationSoundStore,registerNotificationSoundIpc};
