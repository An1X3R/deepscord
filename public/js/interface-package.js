// @ts-check
/** @typedef {import('./network-protocol.js').JsonValue} JsonValue */
/** @typedef {{html:string,css:string,script:string}} Presentation */
/** @typedef {{serverName:string,channelName:string,connected:boolean,memberCount:number}} ThemeState */
/** @typedef {'settings'|'toggleMic'|'toggleDeafen'|'serverMenu'|'toggleMembers'} ThemeCommand */
const slots={rail:'#serverRail',sidebar:'.sidebar',topbar:'.topbar',radio:'#radioStrip',content:'.main > .content',members:'#members',self:'#selfPanel'};
const baseVariables=['--bg','--bg-side','--bg-rail','--bg-elev','--bg-elev2','--bg-input','--accent','--accent-2','--accent-ink','--accent-soft','--accent-glow','--radius'];
/** @type {{presentation:Presentation,dispose:()=>void,sync:()=>void,publish:(state:ThemeState)=>void}|null} */let active=null;
/** @type {ThemeState} */let snapshot={serverName:'',channelName:'',connected:false,memberCount:0};
/** @type {(command:ThemeCommand)=>void} */let runCommand=()=>{throw new Error('Theme command handler is not initialized');};
/** @param {(command:ThemeCommand)=>void} handler @returns {void} */
export function configureInterfaceCommands(handler){runCommand=handler;}
/** @param {ThemeState} state @returns {void} */
export function publishInterfaceState(state){if(state.serverName===snapshot.serverName&&state.channelName===snapshot.channelName&&state.connected===snapshot.connected&&state.memberCount===snapshot.memberCount)return;snapshot={...state};active?.publish(snapshot);}
/** @param {Presentation|null} presentation @returns {boolean} */
export function interfacePackageMatches(presentation){return !!active&&!!presentation&&active.presentation.html===presentation.html&&active.presentation.css===presentation.css&&active.presentation.script===presentation.script;}
/** @returns {void} */
export function clearInterfacePackage(){active?.dispose();active=null;}
/** @param {string} value @returns {void} */
function validateCss(value){
  const canonical=value.replace(/\/\*[\s\S]*?\*\//g,'').replace(/\\([0-9a-f]{1,6})\s?|\\([^\r\n])/gi,(_match,hex,letter)=>hex?String.fromCodePoint(parseInt(hex,16)):letter);
  if(/@import\b|expression\s*\(|image-set\s*\(|src\s*\(|-moz-binding|behavior\s*:/i.test(canonical))throw new TypeError('Theme styles cannot import external code or stylesheets');
  for(const match of canonical.matchAll(/url\s*\(\s*([\s\S]*?)\s*\)/gi)){
    const url=match[1].replace(/^['"]|['"]$/g,'');if(!/^data:(?:image\/(?:png|jpeg|webp|avif|svg\+xml)|font\/(?:woff2?|ttf));/i.test(url))throw new TypeError('Theme assets must be embedded image or font data URLs');
  }
}
/** @param {string} html @returns {HTMLElement} */
function parseLayout(html){
  const template=document.createElement('template');template.innerHTML=html;
  const forbidden=new Set(['SCRIPT','STYLE','LINK','META','BASE','IFRAME','FRAME','OBJECT','EMBED','FORM']);
  const identifiers=new Set();
  for(const node of template.content.querySelectorAll('*')){
    if(forbidden.has(node.tagName.toUpperCase()))throw new TypeError('Theme HTML contains an unsupported executable or navigable element: '+node.tagName);
    for(const attribute of node.attributes){
      const name=attribute.name.toLowerCase(),value=attribute.value;
      if(name.startsWith('on')||name==='srcdoc'||name==='formaction'||name==='action'||name==='srcset'||name==='is'||name==='background'||name==='poster'||name==='ping')throw new TypeError('Theme HTML contains a forbidden attribute: '+name);
      if(name==='src'&&!/^data:image\/(?:png|jpeg|webp|avif|svg\+xml);/i.test(value))throw new TypeError('Theme image sources must be embedded data URLs');
      if((name==='href'||name==='xlink:href')&&!value.startsWith('#'))throw new TypeError('Theme links must stay within the current document');
      if(name==='style')validateCss(value);
    }
    if(node.id){if(!/^theme-[a-zA-Z0-9_-]{1,80}$/.test(node.id)||identifiers.has(node.id)||document.getElementById(node.id))throw new TypeError('Theme element IDs must be unique and start with theme-: '+node.id);identifiers.add(node.id);}
  }
  for(const name of Object.keys(slots))if(template.content.querySelectorAll('[data-deepscord-slot="'+name+'"]').length!==1)throw new TypeError('Theme layout requires exactly one '+name+' slot');
  const placeholders=[...template.content.querySelectorAll('[data-deepscord-slot]')];
  if(placeholders.length!==Object.keys(slots).length||placeholders.some(node=>node.parentElement?.closest('[data-deepscord-slot]')))throw new TypeError('Theme slots cannot be unknown or nested');
  const host=document.createElement('div');host.id='deepscordThemeHost';host.style.cssText='position:fixed;inset:0;z-index:0;overflow:hidden';host.append(template.content);return host;
}
const bootstrap=`
(()=>{
  let port=null,gesture='';const errors=[],pending=[];const listeners={action:[],state:[]};
  function send(message){if(!port){if(pending.length>=64)throw new RangeError('Theme startup queue is full');pending.push(message);return;}port.postMessage(message);}
  globalThis.deepscordTheme=Object.freeze({
    on:(event,handler)=>{if(!(event in listeners)||typeof handler!=='function')throw new TypeError('Invalid theme subscription');listeners[event].push(handler);},
    setText:(id,text)=>send({type:'text',id,text}),
    setAttribute:(id,name,value)=>send({type:'attribute',id,name,value}),
    setVariable:(name,value)=>send({type:'variable',name,value}),
    animate:(id,keyframes,options)=>send({type:'animate',id,keyframes,options}),
    command:name=>send({type:'command',name,gesture})
  });
  addEventListener('error',event=>{if(port)port.postMessage({type:'error',message:event.message});else errors.push(event.message);});
  addEventListener('unhandledrejection',event=>{if(port)port.postMessage({type:'error',message:String(event.reason)});else errors.push(String(event.reason));});
  addEventListener('message',event=>{if(port||event.source!==parent||event.data!=='deepscord-theme-connect'||event.ports.length!==1)return;port=event.ports[0];port.onmessage=event=>{const message=event.data;gesture=message.gesture||'';try{for(const handler of listeners[message.event]||[])handler(message.value);}catch(error){send({type:'error',message:String(error)});}finally{gesture='';}};port.start();port.postMessage({type:'ready'});for(const message of errors)port.postMessage({type:'error',message});for(const message of pending)port.postMessage(message);pending.length=0;});
})();`;
/** @param {Presentation|null} presentation @returns {void} */
export function applyInterfacePackage(presentation){
  if(active&&interfacePackageMatches(presentation)){active.sync();return;}
  clearInterfacePackage();if(!presentation)return;
  validateCss(presentation.css);const host=parseLayout(presentation.html);
  /** @type {{node:HTMLElement,parent:HTMLElement,marker:Comment}[]} */const originals=[];
  for(const selector of Object.values(slots)){const node=document.querySelector(selector);if(!(node instanceof HTMLElement)||!node.parentElement)throw new Error('Theme host slot is unavailable: '+selector);originals.push({node,parent:node.parentElement,marker:document.createComment('theme-slot')});}
  const app=document.getElementById('app');if(!app)throw new Error('Theme app shell is unavailable');
  if(typeof host.moveBefore!=='function')throw new Error('This client needs state-preserving DOM moveBefore support for full themes');
  const appNode=app;
  const owned=new Set(host.querySelectorAll('*')),display=appNode.style.display;
  const style=document.createElement('style');style.id='deepscordThemeStyle';style.textContent=presentation.css;
  const frame=document.createElement('iframe');frame.id='deepscordThemeScript';frame.hidden=true;frame.setAttribute('sandbox','allow-scripts');frame.setAttribute('aria-hidden','true');frame.referrerPolicy='no-referrer';
  const nonce=crypto.randomUUID().replaceAll('-','');
  const policy="default-src 'none'; script-src 'nonce-"+nonce+"'; connect-src 'none'; form-action 'none'; base-uri 'none'";
  frame.srcdoc='<!doctype html><meta http-equiv="Content-Security-Policy" content="'+policy+'"><script nonce="'+nonce+'">'+bootstrap+'</script><script nonce="'+nonce+'">'+presentation.script.replace(/<\/script/gi,'<\\/script')+'</script>';
  const channel=new MessageChannel(),events=new AbortController();
  /** @type {Map<string,string>} */const variables=new Map();
  /** @type {Map<string,{value:string,priority:string}>} */const previousVariables=new Map();
  /** @type {Set<Animation>} */const animations=new Set();
  let disposed=false,ready=false,gesture='',gestureUntil=0,rateStart=performance.now(),rateCount=0;
  const reduced=matchMedia('(prefers-reduced-motion: reduce)');
  /** @param {Error} error @returns {void} */
  function report(error){console.error('interface_package_failed',{message:error.message});window.dispatchEvent(new CustomEvent('deepscord-theme-error',{detail:error}));}
  /** @param {JsonValue|undefined} value @param {string} field @param {number} limit @returns {string} */
  function text(value,field,limit){if(typeof value!=='string'||value.length>limit)throw new TypeError('Invalid theme '+field);return value;}
  /** @param {JsonValue|undefined} id @returns {HTMLElement} */
  function element(id){const value=text(id,'element ID',86),node=document.getElementById(value);if(!(node instanceof HTMLElement)||!owned.has(node))throw new TypeError('Theme scripts can only modify their own layout elements: '+value);return node;}
  /** @param {JsonValue|undefined} input @returns {{[key:string]:JsonValue}} */
  function object(input){if(!input||typeof input!=='object'||Array.isArray(input))throw new TypeError('Theme bridge requires a structured message');return input;}
  /** @param {ThemeState} state @returns {void} */
  function publish(state){if(ready&&!disposed)channel.port1.postMessage({event:'state',value:state});}
  /** @returns {void} */
  function sync(){for(const key of baseVariables)document.documentElement.style.removeProperty(key);for(const [key,value] of variables)document.documentElement.style.setProperty(key,value);}
  /** @returns {void} */
  function dispose(){
    if(disposed)return;disposed=true;events.abort();channel.port1.close();channel.port2.close();frame.remove();for(const animation of animations)animation.cancel();animations.clear();
    for(const item of originals){item.parent.moveBefore(item.node,item.marker);item.marker.remove();}
    for(const [key,previous] of previousVariables){if(previous.value)document.documentElement.style.setProperty(key,previous.value,previous.priority);else document.documentElement.style.removeProperty(key);}
    host.remove();style.remove();appNode.style.display=display;delete document.documentElement.dataset.interfacePackage;
  }
  channel.port1.onmessage=/** @param {MessageEvent<JsonValue>} event */event=>{
    if(disposed)return;
    try{
      if(performance.now()-rateStart>1000){rateStart=performance.now();rateCount=0;}if(++rateCount>240)throw new RangeError('Theme script exceeds 240 bridge operations per second');
      const message=object(event.data);
      if(message.type==='ready'){ready=true;publish(snapshot);return;}
      if(message.type==='error')throw new Error(text(message.message,'script error',2000));
      if(message.type==='text'){const target=element(message.id);if(target.hasAttribute('data-deepscord-slot')||target.querySelector('[data-deepscord-slot]'))throw new TypeError('Theme text updates cannot replace application slots');target.textContent=text(message.text,'text',8000);return;}
      if(message.type==='attribute'){const target=element(message.id),name=text(message.name,'attribute',80);if(!/^(?:data-[a-z0-9-]+|aria-[a-z0-9-]+|class|hidden)$/.test(name)||name==='data-deepscord-slot')throw new TypeError('Unsupported theme attribute: '+name);if(message.value===null)target.removeAttribute(name);else target.setAttribute(name,text(message.value,'attribute value',1000));return;}
      if(message.type==='variable'){const name=text(message.name,'variable',80),value=text(message.value,'variable value',2000);if(!/^--[a-zA-Z0-9_-]+$/.test(name))throw new TypeError('Theme variable must be a CSS custom property');validateCss(value);if(!previousVariables.has(name))previousVariables.set(name,{value:document.documentElement.style.getPropertyValue(name),priority:document.documentElement.style.getPropertyPriority(name)});variables.set(name,value);document.documentElement.style.setProperty(name,value);return;}
      if(message.type==='command'){
        if(!gesture||message.gesture!==gesture||performance.now()>gestureUntil)throw new Error('Theme commands require a current user interaction');gesture='';
        const name=message.name;if(name!=='settings'&&name!=='toggleMic'&&name!=='toggleDeafen'&&name!=='serverMenu'&&name!=='toggleMembers')throw new TypeError('Unsupported theme command');runCommand(name);return;
      }
      if(message.type==='animate'){
        const target=element(message.id),options=object(message.options);if(!Array.isArray(message.keyframes)||message.keyframes.length<2||message.keyframes.length>60)throw new RangeError('Theme animations require 2–60 keyframes');
        const frames=message.keyframes.map(value=>{const frame=object(value);
        /** @type {Record<string,string|number>} */
        const result={};for(const [key,item] of Object.entries(frame)){if(!/^(?:opacity|transform|translate|rotate|scale|filter|backgroundColor|color|clipPath|offset)$/.test(key)||typeof item!=='string'&&typeof item!=='number')throw new TypeError('Unsupported theme animation property: '+key);validateCss(String(item));result[key]=item;}return result;});
        const duration=options.duration,iterations=options.iterations,easing=options.easing;
        if(typeof duration!=='number'||!Number.isFinite(duration)||duration<0||duration>10000||typeof iterations!=='number'||!Number.isInteger(iterations)||iterations<1||iterations>20||typeof easing!=='string'||easing.length>100)throw new RangeError('Theme animation options exceed the supported budget');
        if(reduced.matches)return;if(animations.size>=32)throw new RangeError('Too many simultaneous theme animations');const animation=target.animate(frames,{duration,iterations,easing});animations.add(animation);animation.onfinish=()=>animations.delete(animation);animation.oncancel=()=>animations.delete(animation);return;
      }
      throw new TypeError('Unsupported theme bridge message');
    }catch(error){ready=false;channel.port1.close();frame.remove();for(const animation of animations)animation.cancel();report(error instanceof Error?error:new Error(String(error)));}
  };
  frame.addEventListener('load',()=>frame.contentWindow?.postMessage('deepscord-theme-connect','*',[channel.port2]),{once:true,signal:events.signal});
  host.addEventListener('click',event=>{if(!ready||!event.isTrusted||!(event.target instanceof Element))return;const target=event.target.closest('[data-theme-action]');if(!target||!owned.has(target))return;gesture=crypto.randomUUID();gestureUntil=performance.now()+1500;channel.port1.postMessage({event:'action',value:{action:target.getAttribute('data-theme-action')},gesture});},{signal:events.signal});
  reduced.addEventListener('change',()=>{if(reduced.matches)for(const animation of animations)animation.cancel();},{signal:events.signal});
  try{
    document.body.append(host);document.head.append(style);for(const [index,name] of Object.keys(slots).entries()){const item=originals[index];item.parent.insertBefore(item.marker,item.node);const slot=host.querySelector('[data-deepscord-slot="'+name+'"]');if(!(slot instanceof HTMLElement))throw new Error('Missing theme slot: '+name);slot.moveBefore(item.node,null);}
    appNode.style.display='none';document.documentElement.dataset.interfacePackage='true';sync();document.body.append(frame);active={presentation,dispose,sync,publish};
  }catch(error){dispose();throw error;}
}
