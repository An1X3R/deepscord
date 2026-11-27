// @ts-check
'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {createHash}=require('node:crypto');
const {app,BrowserWindow,ipcMain}=require('electron');
const protection=require('../desktop/windows-protection.cjs');
const {openContentVault}=require('../desktop/content-vault.cjs');
const {openRoomCredentials}=require('../desktop/room-credentials.cjs');
const {createContentService}=require('../desktop/content-service.cjs');
const {createWorkspaceStore}=require('../desktop/workspace-store.cjs');
const {createGovernance}=require('../lib/server-governance.cjs');
const {createMediaValidator}=require('../lib/media-validator.cjs');
const {contentDigest,verifySealedMessage}=require('../lib/content-crypto.cjs');
const {createContentClient}=require('../public/js/content-client.js');
const {parseChatMessage,parseMediaMetadata,UNICODE_EMOJIS}=require('../public/js/chat-protocol.js');
const {reactionActor}=require('../lib/message-reactions.cjs');
/** @typedef {import('../public/js/chat-protocol.js').ChatMessage} ChatMessage */
/** @typedef {import('../public/js/network-protocol.js').JsonValue} JsonValue */
/** @param {string} text @returns {string} */
function migrationRequest(text){return 'migration-'+createHash('sha256').update(text).digest('hex');}
/** @param {string} text @param {string} requestId @param {Awaited<ReturnType<ReturnType<typeof createContentService>['sealChat']>>} sealed @returns {ChatMessage} */
function envelope(text,requestId,sealed){return parseChatMessage({id:text,userId:'original-user',name:'Original member',color:'#123456',text:'',ts:123,system:false,bot:false,clientRequestId:requestId,authorId:reactionActor(sealed.memberKey),sealed});}
/** @returns {Promise<void>} */
async function main(){
  const directory=process.env.CONTENT_SERVICE_NATIVE_DIRECTORY;
  if(!directory||!path.isAbsolute(directory))throw new TypeError('Native content service requires an isolated absolute directory');
  app.setPath('userData',path.join(directory,'electron-profile'));
  app.commandLine.appendSwitch('disable-background-networking');
  await app.whenReady();
  assert.equal(process.platform,'win32');assert.equal(await protection.isAsyncEncryptionAvailable(),true);
  const credentialDirectory=path.join(directory,'credentials'),roomOrigin='http://127.0.0.1:38489',secureOrigin='https://127.0.0.1:3443',accessPassword='Native persisted room access password';
  const credentials=await openRoomCredentials({directory:credentialDirectory,protection});
  assert.equal(credentials.read(roomOrigin),null);
  await Promise.all([credentials.save(roomOrigin,accessPassword),credentials.save(secureOrigin,'Second normal room password')]);
  assert.equal(credentials.read(roomOrigin),accessPassword);
  const restoredCredentials=await openRoomCredentials({directory:credentialDirectory,protection});
  assert.equal(restoredCredentials.read(roomOrigin),accessPassword);assert.equal(restoredCredentials.read(secureOrigin),'Second normal room password');
  assert.equal((await fs.readFile(path.join(credentialDirectory,'room-credentials.dpapi'))).includes(Buffer.from(accessPassword)),false);
  assert.deepEqual(await fs.readdir(credentialDirectory),['room-credentials.dpapi']);
  const aDirectory=path.join(directory,'a'),bDirectory=path.join(directory,'b');
  const aWorkspace=createWorkspaceStore(path.join(aDirectory,'workspace')),bWorkspace=createWorkspaceStore(path.join(bDirectory,'workspace'));
  const seed=aWorkspace.seed(null),descriptor={version:/** @type {const} */(1),roomId:seed.roomId,creatorKey:seed.creatorKey},journal=createGovernance(descriptor);
  const secondIdentity=bWorkspace.seed(null).creatorKey;assert.notEqual(secondIdentity,descriptor.creatorKey);
  const connection={mode:/** @type {const} */('server'),role:/** @type {const} */('guest'),address:'http://127.0.0.1:38489/',invite:'',hostAddress:'',hostPort:0,appId:0,stunUrls:[]};
  const aEntry=aWorkspace.saveConnection(connection,null),bEntry=bWorkspace.saveConnection(connection,null);
  const aVault=await openContentVault({directory:path.join(aDirectory,'vault'),protection}),bVault=await openContentVault({directory:path.join(bDirectory,'vault'),protection});
  const a=createContentService({workspace:aWorkspace,getVault:async()=>aVault}),b=createContentService({workspace:bWorkspace,getVault:async()=>bVault});
  const validator=createMediaValidator({maxPending:4});
  /** @type {Electron.BrowserWindow|null} */let window=null;
  try{
    assert.equal(await a.activate(aEntry,{descriptor,journal,policy:null}),null);
    assert.equal(await b.activate(bEntry,{descriptor,journal,policy:null}),null);
    const prepared=await a.prepare(aEntry);assert.equal(prepared.roomId,descriptor.roomId);assert.equal('key' in prepared,false);
    const original=await fs.readFile(path.join(__dirname,'avif-codec-fixtures','transparent-animation.avif'));
    const decoded=await validator.validate(original,'personal',AbortSignal.timeout(30000));
    const asset=parseMediaMetadata({sha256:contentDigest(original),bytes:original.length,...decoded});
    const cipher=await a.sealMedia(aEntry,{kind:'personal',asset,data:original.toString('base64')});
    assert.equal(cipher.asset.encrypted,true);assert.notEqual(cipher.asset.sha256,asset.sha256);
    const policy=await a.signPolicy(aEntry,{assets:[{source:asset.sha256,asset:cipher.asset}]});
    assert.equal(policy.ownerKey,descriptor.creatorKey);assert.equal(policy.governanceRevision,journal.events.length);
    const activated=await a.activate(aEntry,{descriptor,journal,policy});assert(activated);assert(activated.key instanceof Uint8Array);assert.equal(activated.key.length,32);
    const invitation=aVault.exportSecret(descriptor);assert.equal(typeof invitation,'string');if(typeof invitation!=='string')throw new TypeError('Native owner must export the activated room invitation');
    await bVault.importSecret(invitation);
    const imported=await b.activate(bEntry,{descriptor,journal,policy});assert(imported);assert.deepEqual(imported.key,activated.key);
    const requestId=migrationRequest('original-history');
    const body={text:'Original history readable by new authorized members',replyToId:'historical-parent',attachment:{...cipher.asset,kind:/** @type {const} */('sticker'),name:'Original sticker'},reactions:[{kind:/** @type {const} */('unicode'),key:'u:👍',emoji:'👍',userIds:[reactionActor(descriptor.creatorKey)]}],reactionRevision:1};
    const sealed=await a.sealChat(aEntry,{channelId:'ch-text',requestId,body});
    verifySealedMessage({roomId:descriptor.roomId,channelId:'ch-text',requestId},sealed);
    const originalMessage=parseChatMessage({...envelope('original-history',requestId,sealed),attachment:{...cipher.asset,kind:'sticker',name:'encrypted.avif'}});
    const openedA=await a.openChat(aEntry,{channelId:'ch-text',message:originalMessage}),openedB=await b.openChat(bEntry,{channelId:'ch-text',message:originalMessage});
    assert.deepEqual(openedA,openedB);assert.equal(openedB.text,body.text);assert.equal(openedB.replyToId,body.replyToId);assert.equal(originalMessage.replyToId,undefined);
    assert.throws(()=>parseChatMessage({...originalMessage,replyToId:body.replyToId}),/no plaintext/);
    await assert.rejects(a.sealChat(aEntry,{channelId:'ch-text',requestId:'invalid-reference',body:{text:'Invalid reference',replyToId:'../bad'}}),/Reply message ID/);
    const client=createContentClient({activateContentRoom:input=>a.activate(aEntry,input),prepareContentRoom:()=>a.prepare(aEntry),signContentPolicy:input=>a.signPolicy(aEntry,input),sealContentReaction:input=>a.sealReaction(aEntry,input),sealContentMessage:input=>a.sealChat(aEntry,input),openContentMessage:input=>a.openChat(aEntry,input),sealContentMedia:input=>a.sealMedia(aEntry,input),openContentMedia:input=>a.openMedia(aEntry,input)});
    const clientKey=await client.initialize({descriptor,journal,policy});assert(clientKey);clientKey.key.fill(0);
    const clientWire=await client.sealMessage('ch-text','client-reply-request',{text:'Renderer reply',replyToId:originalMessage.id});
    assert.equal(clientWire.replyToId,undefined);assert.equal(clientWire.text,'');assert(clientWire.sealed);
    const clientOpened=await client.openMessage('ch-text',envelope('client-reply','client-reply-request',clientWire.sealed));
    assert.equal(clientOpened.replyToId,originalMessage.id);assert.equal(clientOpened.text,'Renderer reply');assert.equal(openedB.attachment?.name,'Original sticker');assert.deepEqual(openedB.reactions,body.reactions);
    const reactionRequest='second-member-reaction',reactionSealed=await b.sealReaction(bEntry,{channelId:'ch-text',requestId:reactionRequest,messageId:originalMessage.id,body:{selection:{kind:'unicode',emoji:'👍'},active:true}});
    const reacted=parseChatMessage({...originalMessage,sealedReactions:[{requestId:reactionRequest,sealed:reactionSealed}]});
    const reactedA=await a.openChat(aEntry,{channelId:'ch-text',message:reacted}),reactedB=await b.openChat(bEntry,{channelId:'ch-text',message:reacted});
    assert.deepEqual(reactedA,reactedB);assert.deepEqual(reactedA.reactions?.[0].userIds,[reactionActor(descriptor.creatorKey),reactionActor(secondIdentity)]);assert.equal(reactedA.reactionRevision,2);
    const removalId='remove-original-reaction',removal=await a.sealReaction(aEntry,{channelId:'ch-text',requestId:removalId,messageId:originalMessage.id,body:{selection:{kind:'unicode',emoji:'👍'},active:false}});
    const removed=await b.openChat(bEntry,{channelId:'ch-text',message:{...reacted,sealedReactions:[...(reacted.sealedReactions ?? []),{requestId:removalId,sealed:removal}]}});
    assert.deepEqual(removed.reactions?.[0].userIds,[reactionActor(secondIdentity)]);assert.equal(removed.reactionRevision,3);
    const emojiCipher=await a.sealMedia(aEntry,{kind:'server',asset,data:original.toString('base64')}),emoji={id:'native-emoji',domainId:'srv-main',name:'Native encrypted emoji',asset:emojiCipher.asset,addedBy:descriptor.creatorKey,ts:Date.now()},customId='native-custom-reaction';
    const custom=await b.sealReaction(bEntry,{channelId:'ch-text',requestId:customId,messageId:originalMessage.id,body:{selection:{kind:'server',emojiId:emoji.id},active:true,emoji}});
    const customOpened=await a.openChat(aEntry,{channelId:'ch-text',message:{...originalMessage,sealedReactions:[{requestId:customId,sealed:custom}]}});assert.equal(customOpened.reactions?.[1].kind,'server');assert.equal(customOpened.reactions?.[1].userIds[0],reactionActor(secondIdentity));
    const customRemovalId='native-remove-deleted-custom',customRemoval=await b.sealReaction(bEntry,{channelId:'ch-text',requestId:customRemovalId,messageId:originalMessage.id,body:{selection:{kind:'server',emojiId:emoji.id},active:false}});
    const customRemoved=await a.openChat(aEntry,{channelId:'ch-text',message:{...originalMessage,sealedReactions:[{requestId:customId,sealed:custom},{requestId:customRemovalId,sealed:customRemoval}]}});assert.equal(customRemoved.reactions?.length,1);assert.equal(customRemoved.reactions?.[0].kind,'unicode');
    const crowdRequest='concurrent-reactions-base',crowdSealed=await a.sealChat(aEntry,{channelId:'ch-text',requestId:crowdRequest,body:{text:'Concurrent reaction history'}}),crowdMessage=envelope('concurrent-history',crowdRequest,crowdSealed);
    /** @type {NonNullable<ChatMessage['sealedReactions']>} */const crowdEvents=[];
    for(const [index,emoji] of UNICODE_EMOJIS.slice(0,17).entries()){const requestId='concurrent-reaction-'+index,sealed=await b.sealReaction(bEntry,{channelId:'ch-text',requestId,messageId:crowdMessage.id,body:{selection:{kind:'unicode',emoji},active:true}});crowdEvents.push({requestId,sealed});}
    const crowdOpened=await a.openChat(aEntry,{channelId:'ch-text',message:{...crowdMessage,sealedReactions:crowdEvents}});assert.equal(crowdOpened.reactions?.length,17);assert.equal(crowdOpened.reactionRevision,17);assert.equal(crowdOpened.text,'Concurrent reaction history');assert.equal(crowdOpened.replyToId,undefined);
    const mediaB=await b.openMedia(bEntry,{asset:cipher.asset,data:cipher.data});assert.deepEqual(Buffer.from(mediaB.data,'base64'),original);assert.deepEqual(mediaB.asset,asset);
    const memberRequest='second-member-message',memberSealed=await b.sealChat(bEntry,{channelId:'ch-text',requestId:memberRequest,body:{text:'Second member signed reply',replyToId:originalMessage.id}});
    assert.equal(memberSealed.memberKey,secondIdentity);assert.notEqual(memberSealed.memberKey,sealed.memberKey);
    const memberMessage=envelope('reply',memberRequest,memberSealed),reply=await a.openChat(aEntry,{channelId:'ch-text',message:memberMessage});assert.equal(reply.text,'Second member signed reply');assert.equal(reply.replyToId,originalMessage.id);assert.equal(memberMessage.replyToId,undefined);
    const returnMedia=await b.sealMedia(bEntry,{kind:'personal',asset,data:original.toString('base64')});
    const mediaA=await a.openMedia(aEntry,{asset:returnMedia.asset,data:returnMedia.data});assert.deepEqual(Buffer.from(mediaA.data,'base64'),original);assert.notEqual(returnMedia.asset.sha256,cipher.asset.sha256);
    ipcMain.handle('content-native:activate',async(_event,actor,/** @type {JsonValue} */input)=>{
      if(actor==='a')return a.activate(aEntry,input);
      if(actor==='b')return b.activate(bEntry,input);
      throw new TypeError('Native bridge requires one of its two isolated identities');
    });
    window=new BrowserWindow({show:false,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true,preload:path.join(__dirname,'content-service-native-preload.cjs')}});
    await window.loadURL('data:text/html;charset=utf-8,<!doctype html><title>Native content contract</title>');
    const activationInput=JSON.stringify({descriptor,journal,policy});
    const bridge=await window.webContents.executeJavaScript(`(async()=>{const a=await window.contentNative.activate('a',${activationInput}),b=await window.contentNative.activate('b',${activationInput});return {aType:a.key.constructor.name,bType:b.key.constructor.name,aBytes:a.key.length,bBytes:b.key.length,keyId:a.keyId,matching:a.key.every((value,index)=>value===b.key[index])};})()`);
    assert.deepEqual(bridge,{aType:'Uint8Array',bType:'Uint8Array',aBytes:32,bBytes:32,keyId:prepared.keyId,matching:true});
    for(const actorDirectory of [aDirectory,bDirectory]){
      const protectedBytes=await fs.readFile(path.join(actorDirectory,'vault','content-keys.dpapi'));
      assert.equal(protectedBytes.includes(Buffer.from(activated.key)),false);
      assert.equal(protectedBytes.includes(Buffer.from(Buffer.from(activated.key).toString('base64url'))),false);
    }
    const restoredWorkspace=createWorkspaceStore(path.join(bDirectory,'workspace')),restoredVault=await openContentVault({directory:path.join(bDirectory,'vault'),protection});
    const restored=createContentService({workspace:restoredWorkspace,getVault:async()=>restoredVault});
    try{await restored.activate(bEntry,{descriptor,journal,policy});assert.deepEqual(await restored.openChat(bEntry,{channelId:'ch-text',message:originalMessage}),openedB);}finally{restored.close();}
    activated.key.fill(0);imported.key.fill(0);
    await fs.writeFile(path.join(directory,'report.json'),JSON.stringify({electron:process.versions.electron,asyncProtection:true,credentials:true,identities:2,vaults:2,fullHistory:true,encryptedReactions:true,bidirectionalChat:true,bidirectionalMedia:true,codecValidated:true,bridgeTypedArray:true,restored:true}));
  }finally{if(window&&!window.isDestroyed())window.destroy();ipcMain.removeHandler('content-native:activate');a.close();b.close();validator.close();}
}
main().then(()=>app.quit(),error=>{console.error(error);app.exit(1);});
