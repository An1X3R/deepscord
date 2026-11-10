// @ts-check
import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import {once} from 'node:events';
import {parseTrustedProxies,clientAddress,permittedUpgrade,createMessageBudget,passwordMatches,createAuthLimiter,createSendBudget} from '../lib/connection-policy.cjs';

test('bounded traffic accounting refills and recovery does not erase an active ban',()=>{
  const limiter=createAuthLimiter(2);
  for(let index=0;index<5;index++)limiter.failure('client-a',1000);
  assert.equal(limiter.blocked('client-a',1001),true);
  limiter.failure('client-b',1000);
  assert.throws(()=>limiter.failure('client-c',1000),/capacity/);
  limiter.sweep(61000);assert.equal(limiter.size(),0);
  limiter.failure('client-c',61000);limiter.success('client-c');assert.equal(limiter.size(),0);
  assert(passwordMatches('room-secret','room-secret'));assert(!passwordMatches('room-secret','different'));
  const messages=createMessageBudget(0);
  assert(messages.accept(16*1024*1024,0));assert(!messages.accept(1,0));assert(messages.accept(1024,1000));
  for(let index=0;index<20;index++)assert(messages.action('chat',1000));
  assert(!messages.action('chat',1000));assert(messages.action('chat',1200));
  const queued=createSendBudget({maxBytes:100,maxFrames:2}),first=queued.reserve(60),second=queued.reserve(40);
  assert(first && second);assert.equal(queued.reserve(1),null);
  first();first();assert.deepEqual(queued.stats(),{bytes:40,frames:1});second();assert.deepEqual(queued.stats(),{bytes:0,frames:0});
});

test('real HTTP headers accept same-host UI and honor forwarded clients only through configured proxies',async()=>{
  const server=http.createServer((request,response)=>{
    const trusted=parseTrustedProxies('127.0.0.1,::1');
    response.end(JSON.stringify({originAccepted:permittedUpgrade(request),direct:clientAddress(request,new Set()),proxied:clientAddress(request,trusted)}));
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const bound=server.address();assert(bound && typeof bound!=='string');const origin='http://127.0.0.1:'+bound.port;
  try {
    const same=await fetch(origin+'/ws',{headers:{origin,'x-forwarded-for':'192.0.2.7, 127.0.0.1'}});
    assert.deepEqual(await same.json(),{originAccepted:true,direct:'127.0.0.1',proxied:'192.0.2.7'});
    const cross=await fetch(origin+'/ws',{headers:{origin:'https://unrelated.example'}});
    assert.equal((await cross.json()).originAccepted,false);
    const other=await fetch(origin+'/other');assert.equal((await other.json()).originAccepted,false);
  } finally { server.closeAllConnections();await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve(undefined))); }
});
