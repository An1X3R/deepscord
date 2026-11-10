// @ts-check
'use strict';
/** @typedef {{read:()=>Promise<import('./desktop-consent.cjs').ConsentDetails>,respond:(decision:'accept'|'deny')=>Promise<void>}} ConsentApi */
const consentGlobals=/** @type {Window & {desktopConsent?:ConsentApi}} */(window);
/** @returns {ConsentApi} */function requireConsentApi(){if(!consentGlobals.desktopConsent)throw new Error('Missing desktop confirmation bridge');return consentGlobals.desktopConsent;}
const consentApi=requireConsentApi();
/** @param {string} id @returns {HTMLElement} */function element(id){const value=document.getElementById(id);if(!value)throw new Error('Missing consent element: '+id);return value;}
const accept=/** @type {HTMLButtonElement} */(element('consentAccept')),deny=/** @type {HTMLButtonElement} */(element('consentDeny'));
/** @param {Error} error @returns {void} */function report(error){element('consentError').hidden=false;element('consentError').textContent=error.message;accept.disabled=true;}
/** @param {'accept'|'deny'} decision @returns {Promise<void>} */async function respond(decision){accept.disabled=true;deny.disabled=true;try{await consentApi.respond(decision);}catch(error){deny.disabled=false;report(error instanceof Error?error:new Error('本机确认失败'));}}
accept.addEventListener('click',()=>void respond('accept'));deny.addEventListener('click',()=>void respond('deny'));
document.addEventListener('keydown',event=>{if(event.key==='Escape')void respond('deny');});
consentApi.read().then(details=>{element('consentTitle').textContent=details.title;element('consentMessage').textContent=details.message;for(const row of details.details){const label=document.createElement('dt'),value=document.createElement('dd');label.textContent=row.label;value.textContent=row.value;element('consentDetails').append(label,value);}accept.textContent=details.acceptLabel;accept.disabled=false;deny.focus();}).catch(error=>report(error instanceof Error?error:new Error('无法读取本机确认请求')));
