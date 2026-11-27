// @ts-check
import http from 'node:http';
/** @param {string} upstreamOrigin */
export async function createChatDropProxy(upstreamOrigin){
  const upstream=new URL(upstreamOrigin);
  /** @type {Set<import('node:stream').Duplex>} */const sockets=new Set();
  let armed=false,dropped=0;
  /** @type {Error|null} */let failure=null;
  const server=http.createServer((request,response)=>{
    const outgoing=http.request({hostname:upstream.hostname,port:upstream.port,path:request.url,method:request.method,headers:request.headers},incoming=>{response.writeHead(incoming.statusCode??502,incoming.headers);incoming.pipe(response);});
    outgoing.on('error',error=>{failure=error;response.destroy(error);});request.pipe(outgoing);
  });
  server.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});
  server.on('upgrade',(request,client,head)=>{
    const outgoing=http.request({hostname:upstream.hostname,port:upstream.port,path:request.url,method:request.method,headers:request.headers});
    outgoing.on('error',error=>{failure=error;client.destroy(error);});
    outgoing.on('upgrade',(response,remote,remoteHead)=>{
      sockets.add(remote);remote.on('close',()=>{sockets.delete(remote);client.destroy();});client.on('close',()=>remote.destroy());
      remote.on('error',error=>{failure=error;client.destroy();});client.on('error',error=>{failure=error;remote.destroy();});
      const headers=['HTTP/1.1 101 Switching Protocols',...Object.entries(response.headers).map(([name,value])=>name+': '+String(value))];client.write(headers.join('\r\n')+'\r\n\r\n');
      if(remoteHead.length)client.write(remoteHead);if(head.length)remote.write(head);
      /** @type {Buffer<ArrayBufferLike>} */let buffered=Buffer.alloc(0);
      remote.on('data',chunk=>{
        if(typeof chunk==='string')throw new TypeError('Chat test transport requires binary socket chunks');
        buffered=Buffer.concat([buffered,chunk]);
        while(buffered.length>=2){
          const short=buffered[1]&127;let header=2,length=short;
          if(short===126){if(buffered.length<4)return;header=4;length=buffered.readUInt16BE(2);}
          if(short===127){if(buffered.length<10)return;header=10;const size=buffered.readBigUInt64BE(2);if(size>8n*1024n*1024n){failure=new RangeError('Chat test transport frame exceeds 8 MiB');client.destroy();remote.destroy();return;}length=Number(size);}
          if(buffered.length<header+length)return;
          const frame=buffered.subarray(0,header+length),payload=frame.subarray(header),opcode=frame[0]&15;buffered=buffered.subarray(header+length);
          if(armed&&opcode===1&&payload.toString('utf8').includes('"t":"chatResult"')){armed=false;dropped++;remote.destroy();client.destroy();return;}
          client.write(frame);
        }
      });client.pipe(remote);
    });outgoing.end();
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>resolve(undefined));});
  const address=server.address();if(!address||typeof address==='string')throw new Error('Chat test transport has no loopback address');
  return {origin:'http://127.0.0.1:'+address.port,dropNextChatAcknowledgement:()=>{armed=true;},dropped:()=>dropped,failure:()=>failure,close:async()=>{for(const socket of sockets)socket.destroy();await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve(undefined)));}};
}
