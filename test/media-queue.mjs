// @ts-check
import assert from 'node:assert/strict';
import test from 'node:test';
import net from 'node:net';
import {once} from 'node:events';
import queueModule from '../desktop/media-queue.cjs';
/** @returns {Promise<{server:net.Server,client:net.Socket,bytes:()=>Buffer,close:()=>Promise<void>}>} */async function connection(){
  /** @type {Buffer[]} */const chunks=[];/** @type {Set<net.Socket>} */const sockets=new Set();let size=0;
  const server=net.createServer(socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));socket.on('data',bytes=>{size+=bytes.length;assert(size<=1024*1024);chunks.push(Buffer.from(bytes));});});
  server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();assert(address && typeof address!=='string');
  const client=net.createConnection({host:'127.0.0.1',port:address.port});await once(client,'connect');
  /** @returns {Promise<void>} */async function close(){client.destroy();for(const socket of sockets)socket.destroy();await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve(undefined)));}
  return{server,client,bytes:()=>Buffer.concat(chunks),close};
}
/** @param {()=>boolean} condition @returns {Promise<void>} */async function until(condition){const deadline=Date.now()+5000;while(!condition()){if(Date.now()>=deadline)throw new Error('Real media TCP transfer timed out');await new Promise(resolve=>setTimeout(resolve,5));}}

test('real TCP media pacing bounds queued memory and allows direct signaling ahead of queued media',{timeout:10000},async()=>{
  const tcp=await connection(),queue=queueModule.createMediaQueue({send:(_peer,packet)=>{tcp.client.write(packet);},bytesPerSecond:256*1024,maxQueuedBytes:512*1024});
  try{
    const packets=Array.from({length:16},()=>Buffer.alloc(16384,0x4d)),started=performance.now(),transfer=queue.send('real-peer',packets);
    for(const packet of packets)packet.fill(0x58);packets[1]=Buffer.alloc(1);
    assert(queue.stats().queuedBytes<=512*1024);await assert.rejects(queue.send('real-peer',Array.from({length:32},()=>Buffer.alloc(16384))),/full/);
    const signal=Buffer.from('SIGNAL\n');tcp.client.write(signal);await until(()=>tcp.bytes().includes(signal));assert(performance.now()-started<500,'Signaling must bypass the queued media transfer');
    assert(tcp.bytes().indexOf(signal)<256*1024);await transfer;const elapsed=performance.now()-started;assert(elapsed>=750,'The token bucket must enforce 256 KiB/s after its bounded 32 KiB burst');
    await until(()=>tcp.bytes().length===256*1024+signal.length);const received=tcp.bytes(),index=received.indexOf(signal);assert.deepEqual(Buffer.concat([received.subarray(0,index),received.subarray(index+signal.length)]),Buffer.alloc(256*1024,0x4d));
    assert.deepEqual(queue.stats(),{queuedBytes:0,transfers:0});await assert.rejects(queue.send('real-peer',[Buffer.alloc(0)]),/bounded nonempty/);await assert.rejects(queue.send('real-peer',Array.from({length:129},()=>Buffer.alloc(1))),/bounded nonempty/);
  }finally{queue.close();await tcp.close();}
});

test('closing a real TCP media queue rejects remaining transfers and retains no pending payload',{timeout:5000},async()=>{
  const tcp=await connection(),queue=queueModule.createMediaQueue({send:(_peer,packet)=>{tcp.client.write(packet);},bytesPerSecond:256*1024,maxQueuedBytes:512*1024});
  try{
    const pending=queue.send('real-peer',Array.from({length:32},()=>Buffer.alloc(16384,0x4d))),rejected=assert.rejects(pending,/closed/);assert(queue.stats().queuedBytes>0);queue.close();await rejected;
    assert.deepEqual(queue.stats(),{queuedBytes:0,transfers:0});await assert.rejects(queue.send('real-peer',[Buffer.from('x')]),/closed/);
  }finally{queue.close();await tcp.close();}
});
