import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChrome, connectPage, closeChrome } from './cdp.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'deepscord-thumbnail-queue-'));
const avif = await fs.readFile(path.join(root, 'test/avif-codec-fixtures/transparent-animation.avif'));
let active = 0, maximum = 0, requests = 0;
const server = http.createServer(async (request, response) => {
  if (request.url === '/interaction-thumbnail-queue.js') {
    response.writeHead(200, { 'Content-Type': 'text/javascript' });
    response.end(await fs.readFile(path.join(root, 'public/js/interaction-thumbnail-queue.js'))); return;
  }
  if (request.url?.startsWith('/thumbnail.avif')) {
    requests++; active++; maximum = Math.max(maximum, active);
    let finished = false;
    const complete = () => { if (!finished) { finished = true; active--; } };
    response.once('close', complete); response.once('finish', complete);
    setTimeout(() => { if (!response.destroyed) { response.writeHead(200, {'Content-Type':'image/avif'}); response.end(avif); } }, 45);
    return;
  }
  response.writeHead(200, {'Content-Type':'text/html'}); response.end('<!doctype html><html><body>Thumbnail queue</body></html>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const address = server.address(); assert(address && typeof address !== 'string');
const probe = net.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
const debug = probe.address(); assert(debug && typeof debug !== 'string');
await new Promise((resolve,reject) => probe.close(error => error ? reject(error) : resolve()));
const url = `http://127.0.0.1:${address.port}/`;
let browser = null;
try {
  browser = (await launchChrome({port:debug.port,userDataDir:profile,url,headless:true})).child;
  const page = await connectPage(debug.port,url);
  try {
    await page.waitFor("document.readyState==='complete' && location.protocol==='http:'", {timeout:10000,interval:100,label:'thumbnail queue fixture ready'});
    const report = await page.eval(`(async()=>{
      const {createInteractionThumbnailQueue}=await import('/interaction-thumbnail-queue.js');
      const asset={sha256:'a'.repeat(64),bytes:1,width:100,height:100,animated:true,frames:2,durationMs:100};
      let active=0,maximum=0,created=0,released=0,cancelledStarts=0;const live=new Set();
      const queue=createInteractionThumbnailQueue(async(input,signal)=>{
        active++;maximum=Math.max(maximum,active);
        try {
          const response=await fetch('/thumbnail.avif?index='+created,{signal});
          if(!response.ok)throw new Error('AVIF request failed: '+response.status);
          const blob=await response.blob();const bitmap=await createImageBitmap(blob);bitmap.close();
          const url=URL.createObjectURL(blob);created++;live.add(url);
          return {url,release:()=>{if(!live.delete(url))throw new Error('Lease released twice');released++;URL.revokeObjectURL(url);}};
        } finally { active--; }
      });
      const first=queue.load(asset,new AbortController().signal);
      const second=queue.load(asset,new AbortController().signal);
      const cancelled=Array.from({length:6},()=>{const controller=new AbortController();const result=queue.load(asset,controller.signal).then(lease=>{cancelledStarts++;lease.release();return 'resolved';},error=>error.name);controller.abort();return result;});
      const rest=Array.from({length:24},()=>queue.load(asset,new AbortController().signal));
      const leases=await Promise.all([first,second,...rest]);const cancelledResults=await Promise.all(cancelled);
      for(const lease of leases)lease.release();
      const late=new AbortController();let lateReleased=0;
      const lateQueue=createInteractionThumbnailQueue(async(input,signal)=>{
        const response=await fetch('/thumbnail.avif?late',{signal});const blob=await response.blob();const url=URL.createObjectURL(blob);late.abort();
        return {url,release:()=>{lateReleased++;URL.revokeObjectURL(url);}};
      });
      const lateResult=await lateQueue.load(asset,late.signal).then(lease=>{lease.release();return 'resolved';},error=>error.name);
      return {maximum,created,released,live:live.size,cancelledStarts,cancelledResults,lateReleased,lateResult};
    })()`);
    assert.equal(report.maximum,2);assert.equal(report.created,26);assert.equal(report.released,26);assert.equal(report.live,0);
    assert.equal(report.cancelledStarts,0);assert.deepEqual(report.cancelledResults,Array(6).fill('AbortError'));
    assert.equal(report.lateReleased,1);assert.equal(report.lateResult,'AbortError');assert.equal(requests,27);assert.equal(maximum,2);
    console.log(JSON.stringify({passed:true,requests,serverMaximum:maximum,...report}));
  } finally { page.close(); }
} finally {
  await closeChrome(debug.port);if(browser && browser.exitCode===null)browser.kill();
  server.closeAllConnections();await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
  assert.equal(path.dirname(profile),os.tmpdir());assert(path.basename(profile).startsWith('deepscord-thumbnail-queue-'));
  await fs.rm(profile,{recursive:true,force:true,maxRetries:5,retryDelay:200});
}
