// @ts-check
'use strict';
/** @typedef {{peer:string,packets:Buffer[],next:number,resolve:()=>void,reject:(error:Error)=>void}} Transfer */

/** @param {{send:(peer:string,packet:Buffer)=>void,bytesPerSecond:number,maxQueuedBytes:number}} options */
function createMediaQueue(options){
  if(!Number.isSafeInteger(options.bytesPerSecond) || options.bytesPerSecond<32768 || options.bytesPerSecond>1024*1024 || !Number.isSafeInteger(options.maxQueuedBytes) || options.maxQueuedBytes<65536 || options.maxQueuedBytes>1024*1024)throw new RangeError('Invalid media queue bandwidth or memory budget');
  /** @type {Transfer[]} */const queue=[];
  let queuedBytes=0,tokens=32768,updated=performance.now(),closed=false;
  const timer=setInterval(drain,20);timer.unref();
  function drain(){
    const now=performance.now();tokens=Math.min(32768,tokens+(now-updated)*options.bytesPerSecond/1000);updated=now;
    while(queue.length){
      const entry=queue[0],packet=entry.packets[entry.next];if(packet.length>tokens)return;
      tokens-=packet.length;queuedBytes-=packet.length;entry.packets[entry.next]=Buffer.alloc(0);entry.next+=1;
      try{options.send(entry.peer,packet);}
      catch(error){queue.shift();for(const pending of entry.packets.slice(entry.next))queuedBytes-=pending.length;entry.reject(error instanceof Error ? error : new TypeError('Steam media send failed without an Error',{cause:error}));continue;}
      if(entry.next===entry.packets.length){queue.shift();entry.resolve();}
    }
  }
  /** @param {string} peer @param {Buffer[]} packets @returns {Promise<void>} */
  function send(peer,packets){
    if(closed)return Promise.reject(new Error('Steam media queue is closed'));
    if(typeof peer!=='string' || !peer || peer.length>128 || !Array.isArray(packets) || packets.length<1 || packets.length>128 || packets.some(packet=>!Buffer.isBuffer(packet) || packet.length<1 || packet.length>32768))return Promise.reject(new RangeError('Steam media transfer requires 1..128 bounded nonempty packets and a valid peer'));
    const bytes=packets.reduce((sum,packet)=>sum+packet.length,0);
    if(queue.length>=32 || queuedBytes+bytes>options.maxQueuedBytes)return Promise.reject(new RangeError('Steam media queue is full; signaling remains available'));
    const owned=packets.map(packet=>Buffer.from(packet));
    return new Promise((resolve,reject)=>{queuedBytes+=bytes;queue.push({peer,packets:owned,next:0,resolve,reject});drain();});
  }
  function close(){closed=true;clearInterval(timer);for(const entry of queue.splice(0))entry.reject(new Error('Steam media queue closed'));queuedBytes=0;}
  return{send,close,stats:()=>({queuedBytes,transfers:queue.length})};
}
module.exports={createMediaQueue};
