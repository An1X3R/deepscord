// @ts-check
'use strict';
/** @typedef {{origin:string,source:'bundled'|'remote'}} RoomPermissionContext */
/** @typedef {{contents:Electron.WebContents,origin:string,controller:AbortController,microphone:boolean,pending:Promise<boolean>|null}} PageGrant */
/** @param {{getWindow:()=>Electron.BrowserWindow|null,getRoom:()=>RoomPermissionContext|null,confirm:(details:import('./desktop-consent.cjs').ConsentDetails,signal:AbortSignal)=>Promise<boolean>}} options */
function createRoomPermissions(options){
  /** @type {Map<number,PageGrant>} */const grants=new Map();
  /** @param {Electron.WebContents|null} contents @param {string} address @param {boolean} mainFrame @returns {RoomPermissionContext|null} */
  function context(contents,address,mainFrame){
    const parent=options.getWindow(),room=options.getRoom();
    if(!parent || parent.isDestroyed() || !contents || contents.isDestroyed() || parent.webContents!==contents || !mainFrame || !room)return null;
    let request,loaded;try{request=new URL(address);loaded=new URL(contents.getURL());}catch(error){if(error instanceof TypeError)return null;throw error;}
    if(!['http:','https:'].includes(request.protocol) || request.origin!==room.origin || loaded.origin!==room.origin)return null;
    return room;
  }
  /** @param {Electron.WebContents} contents @param {RoomPermissionContext} room @returns {PageGrant} */
  function page(contents,room){
    const saved=grants.get(contents.id);if(saved && saved.origin===room.origin)return saved;
    saved?.controller.abort();
    const entry={contents,origin:room.origin,controller:new AbortController(),microphone:false,pending:/** @type {Promise<boolean>|null} */(null)};
    grants.set(contents.id,entry);
    /** @returns {void} */function remove(){entry.controller.signal.removeEventListener('abort',remove);entry.controller.abort();if(grants.get(contents.id)===entry)grants.delete(contents.id);contents.removeListener('did-start-navigation',navigate);contents.removeListener('destroyed',remove);}
    /** @param {Electron.Event} event @param {string} address @param {boolean} inPlace @param {boolean} mainFrame @returns {void} */function navigate(event,address,inPlace,mainFrame){if(mainFrame&&!inPlace)remove();}
    contents.on('did-start-navigation',navigate);contents.once('destroyed',remove);entry.controller.signal.addEventListener('abort',remove,{once:true});return entry;
  }
  /** @param {Electron.Session} target @returns {void} */
  function configure(target){
    target.setPermissionCheckHandler((contents,permission,requestingOrigin,details)=>{
      const room=context(contents,details.requestingUrl ?? requestingOrigin,details.isMainFrame);if(!room || !contents)return false;
      if(permission==='media')return details.mediaType==='audio' && (room.source==='bundled' || grants.get(contents.id)?.microphone===true);
      return permission==='fullscreen' || permission==='display-capture' || permission==='speaker-selection';
    });
    target.setPermissionRequestHandler((contents,permission,callback,details)=>{
      const room=context(contents,details.requestingUrl,details.isMainFrame);if(!room){callback(false);return;}
      if(permission!=='media'){callback(permission==='fullscreen' || permission==='display-capture' || permission==='speaker-selection');return;}
      if(!('mediaTypes' in details) || !details.mediaTypes?.length || details.mediaTypes.some(type=>type!=='audio')){callback(false);return;}
      if(room.source==='bundled'){callback(true);return;}
      const entry=page(contents,room);
      if(entry.microphone){callback(true);return;}
      if(!entry.pending)entry.pending=options.confirm({title:'允许这个房间使用麦克风？',message:'确认后，该房间页面可在本次会话中使用麦克风。离开或刷新页面后授权失效。',details:[{label:'房间地址',value:room.origin}],acceptLabel:'允许本次会话'},entry.controller.signal).then(accepted=>{if(entry.controller.signal.aborted || !context(contents,details.requestingUrl,true))return false;entry.microphone=accepted;return accepted;}).finally(()=>{entry.pending=null;});
      entry.pending.then(accepted=>callback(accepted),error=>{console.warn('microphone_permission_rejected',{origin:room.origin,message:error instanceof Error?error.message:'Desktop permission request failed'});callback(false);});
    });
  }
  /** @returns {void} */function reset(){for(const entry of grants.values())entry.controller.abort();grants.clear();}
  return{configure,reset};
}
module.exports={createRoomPermissions};
