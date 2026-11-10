// @ts-check
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { X509Certificate, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { startRoomClient, prepareRoomClient } from '../desktop/room-client.cjs';
import { launch, stop } from './server-ws-helpers.mjs';

/** @param {http.Server} server @returns {Promise<string>} */
async function listen(server) {
  await new Promise((resolve,reject) => { server.once('error',reject); server.listen(0,'127.0.0.1',() => resolve(undefined)); });
  const address = server.address();
  assert(address && typeof address !== 'string');
  return `${server instanceof https.Server ? 'https' : 'http'}://127.0.0.1:${address.port}`;
}

/** @param {string} directory @returns {Promise<void>} */
function certificate(directory) {
  const script = `
$ErrorActionPreference = 'Stop'
$rsa = [System.Security.Cryptography.RSA]::Create(2048)
try {
  $request = [System.Security.Cryptography.X509Certificates.CertificateRequest]::new('CN=localhost', $rsa, [System.Security.Cryptography.HashAlgorithmName]::SHA256, [System.Security.Cryptography.RSASignaturePadding]::Pkcs1)
  $cert = $request.CreateSelfSigned([DateTimeOffset]::UtcNow.AddMinutes(-5), [DateTimeOffset]::UtcNow.AddDays(1))
  try {
    [IO.File]::WriteAllBytes([IO.Path]::Combine($env:DEEPSCORD_ROOM_FIXTURE, 'room.pfx'), $cert.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Pfx, 'fixture-password'))
    [IO.File]::WriteAllBytes([IO.Path]::Combine($env:DEEPSCORD_ROOM_FIXTURE, 'room.cer'), $cert.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Cert))
  } finally { $cert.Dispose() }
} finally { $rsa.Dispose() }
`;
  return new Promise((resolve,reject) => {
    const child = spawn('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{ windowsHide:true,env:{ ...process.env,DEEPSCORD_ROOM_FIXTURE:directory },stdio:['ignore','pipe','pipe'] });
    let diagnostic = '';
    child.stdout.on('data',data => { diagnostic += String(data); });
    child.stderr.on('data',data => { diagnostic += String(data); });
    child.once('error',reject);
    child.once('exit',code => code === 0 ? resolve() : reject(new Error(`Local certificate generation failed (${code}): ${diagnostic}`)));
  });
}

/** @param {string} origin @param {string} target @returns {Promise<string>} */
function websocket(origin,target) {
  return new Promise((resolve,reject) => {
    const request = http.request(origin + target,{ headers:{ origin,connection:'Upgrade',upgrade:'websocket','sec-websocket-version':'13','sec-websocket-key':Buffer.alloc(16,7).toString('base64') },timeout:5000 });
    request.once('error',reject);
    request.once('timeout',() => request.destroy(new Error('Local WebSocket handshake timed out')));
    request.once('response',response => { response.destroy(); reject(new Error(`WebSocket upgrade returned ${response.statusCode}`)); });
    request.once('upgrade',(response,socket,head) => {
      assert.equal(response.statusCode,101);
      /** @type {Buffer[]} */ const chunks = [head];
      socket.setTimeout(5000,() => socket.destroy(new Error('Local WebSocket frame timed out')));
      socket.once('error',reject);
      const payload = Buffer.from('client-ready');
      const mask = Buffer.from([11,22,33,44]);
      const masked = Buffer.from(payload.map((byte,index) => byte ^ mask[index % 4]));
      socket.write(Buffer.concat([Buffer.from([0x81,0x80 | payload.length]),mask,masked]));
      /** @returns {void} */
      function read() {
        const frame = Buffer.concat(chunks);
        if (frame.length < 2 || frame.length < frame[1] + 2) return;
        assert.equal(frame[0],0x81);
        const result = frame.subarray(2,2 + frame[1]).toString('utf8');
        socket.destroy(); resolve(result);
      }
      socket.on('data',(/** @type {Buffer} */ chunk) => { chunks.push(chunk); read(); });
      read();
    });
    request.end();
  });
}

for (const protocol of ['http','https']) {
  test(`bundled local interface forwards normal ${protocol} config and WebSocket traffic`,{ timeout:20000 },async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(),'deepscord-room-client-'));
    /** @type {http.Server|null} */ let upstream = null;
    /** @type {Awaited<ReturnType<typeof startRoomClient>>|null} */ let client = null;
    /** @type {Set<import('node:net').Socket>} */ const sockets = new Set();
    try {
      fs.mkdirSync(path.join(directory,'public'));
      fs.writeFileSync(path.join(directory,'public','index.html'),'<!doctype html><title>Bundled trusted room</title>');
      fs.writeFileSync(path.join(directory,'public','app.js'),'export const trusted = true;');
      if (protocol === 'https') await certificate(directory);
      /** @type {http.RequestListener} */
      const handler = (request,response) => {
        assert.equal(request.headers.host,new URL(upstreamOrigin).host);
        assert.equal(request.headers.origin,upstreamOrigin);
        response.writeHead(200,{ 'Content-Type':'application/json' });
        response.end(JSON.stringify({ requirePassword:true,endpoint:request.url }));
      };
      upstream = protocol === 'http' ? http.createServer(handler) : https.createServer({ pfx:fs.readFileSync(path.join(directory,'room.pfx')),passphrase:'fixture-password' },handler);
      upstream.on('connection',socket => { sockets.add(socket); socket.once('close',() => sockets.delete(socket)); });
      upstream.on('upgrade',(request,socket) => {
        assert.equal(request.headers.host,new URL(upstreamOrigin).host);
        assert.equal(request.headers.origin,upstreamOrigin);
        const accept = createHash('sha1').update(String(request.headers['sec-websocket-key']) + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
        socket.write(`HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
        /** @type {Buffer[]} */ const received = [];
        socket.on('data',(/** @type {Buffer} */ chunk) => {
          received.push(chunk);
          const frame = Buffer.concat(received);
          if (frame.length < 6 || frame.length < 6 + (frame[1] & 0x7f)) return;
          assert.equal(frame[0],0x81);
          assert.equal(frame[1] & 0x80,0x80);
          const mask = frame.subarray(2,6);
          const message = Buffer.from(frame.subarray(6).map((byte,index) => byte ^ mask[index % 4])).toString('utf8');
          assert.equal(message,'client-ready');
          const payload = Buffer.from(request.url === '/ws' ? 'room-connected' : 'screen-connected');
          socket.write(Buffer.concat([Buffer.from([0x81,payload.length]),payload]));
        });
      });
      const upstreamOrigin = await listen(upstream);
      const fingerprint = protocol === 'https' ? new X509Certificate(fs.readFileSync(path.join(directory,'room.cer'))).fingerprint256.replaceAll(':','').toLowerCase() : null;
      client = await startRoomClient({ serverDirectory:directory,connection:{ origin:upstreamOrigin,fingerprint } });
      assert.equal(client.url,client.origin + '/');
      assert.match(await (await fetch(client.url)).text(),/Bundled trusted room/);
      assert.equal(await (await fetch(client.origin + '/app.js')).text(),'export const trusted = true;');
      assert.deepEqual(await (await fetch(client.origin + '/api/config')).json(),{ requirePassword:true,endpoint:'/api/config' });
      const screen = '/screen-sfu/rtc/validate?access_token=local-fixture';
      assert.deepEqual(await (await fetch(client.origin + screen)).json(),{ requirePassword:true,endpoint:screen });
      assert.equal(await websocket(client.origin,'/ws'),'room-connected');
      assert.equal(await websocket(client.origin,'/screen-sfu/rtc?access_token=local-fixture'),'screen-connected');
      await client.stop(); await client.stop(); client = null;
    } finally {
      if (client) await client.stop();
      if (upstream) {
        const closing = new Promise((resolve,reject) => upstream?.close(error => error ? reject(error) : resolve(undefined)));
        for (const socket of sockets) socket.destroy();
        await closing;
      }
      fs.rmSync(directory,{ recursive:true,force:true });
    }
  });
}

test('candidate readiness uses the actual protected room protocol and preserves a live client on failure',{ timeout:25000 },async () => {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'deepscord-room-readiness-'));
  const backend=await launch(path.join(directory,'backend'),{ ECHO_PASSWORD:'readiness-test-secret' });
  /** @type {Awaited<ReturnType<typeof prepareRoomClient>>|null} */ let client=null;
  try {
    const serverDirectory=path.resolve(import.meta.dirname,'..');
    client=await prepareRoomClient({serverDirectory,connection:{origin:backend.origin,fingerprint:null}});
    const config=await (await fetch(client.origin+'/api/config')).json();
    assert.equal(config.requirePassword,true);
    assert.equal(config.networkMode,'server');
    const before=await (await fetch(backend.origin+'/api/health')).json();
    assert.equal(before.users,0,'A WebSocket probe must not join the room');
    const unused=http.createServer();const deadOrigin=await listen(unused);
    await new Promise((resolve,reject)=>unused.close(error=>error?reject(error):resolve(undefined)));
    await assert.rejects(prepareRoomClient({serverDirectory,connection:{origin:deadOrigin,fingerprint:null}}),/Room preparation config failed/);
    assert.equal((await fetch(client.origin+'/api/config')).status,200,'Existing client must survive a rejected candidate');
  } finally {
    if(client)await client.stop();
    await stop(backend);
    const resolved=path.resolve(directory);
    assert.equal(path.dirname(resolved),path.resolve(os.tmpdir()));
    assert(path.basename(resolved).startsWith('deepscord-room-readiness-'));
    fs.rmSync(resolved,{recursive:true,force:true});
  }
});
