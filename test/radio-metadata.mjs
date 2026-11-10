import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {inspectRadioStation,readRadioMetadata,radioUrl} from '../desktop/radio-metadata.cjs';

test('real HTTP ICY framing, redirect, header detection, rejection, and cancellation', async () => {
  let active = 0;
  const fixture = http.createServer((request,response) => {
    assert.equal(request.headers['icy-metadata'],'1');
    assert.equal(request.headers.authorization,undefined);
    assert.equal(request.headers.cookie,undefined);
    active += 1; response.on('close',() => { active -= 1; });
    if (request.url === '/redirect') { response.writeHead(302,{Location:'/radio'}); response.end(); return; }
    if (request.url === '/html') { response.writeHead(200,{'Content-Type':'text/html'}); response.end('<html>Not a radio</html>'); return; }
    if (request.url === '/missing') { response.writeHead(404); response.end('missing'); return; }
    if (request.url === '/hls') { response.writeHead(200,{'Content-Type':'application/vnd.apple.mpegurl'}); response.end('#EXTM3U'); return; }
    if (request.url === '/wait') { response.writeHead(200,{'Content-Type':'audio/mpeg','icy-metaint':'64'}); response.flushHeaders(); return; }
    const title = Buffer.from("StreamTitle='Artist - Real HTTP title';");
    const block = Buffer.alloc(Math.ceil(title.length / 16) * 16); title.copy(block);
    response.writeHead(200,{'Content-Type':'audio/mpeg','icy-name':'Local Station','icy-metaint':'64'});
    response.write(Buffer.alloc(31));
    setTimeout(() => { if (!response.destroyed) response.end(Buffer.concat([Buffer.alloc(33),Buffer.from([block.length/16]),block])); },10);
  });
  fixture.listen(0,'127.0.0.1'); await once(fixture,'listening');
  const endpoint = fixture.address(); assert(endpoint && typeof endpoint === 'object');
  const base = `http://127.0.0.1:${endpoint.port}`;
  try {
    const metadata = await readRadioMetadata(base+'/redirect',new AbortController().signal);
    assert.deepEqual(metadata,{stationName:'Local Station',trackTitle:'Artist - Real HTTP title',format:'audio',metadataAvailable:true});
    assert.equal((await inspectRadioStation(base+'/hls',new AbortController().signal)).format,'hls');
    await assert.rejects(inspectRadioStation(base+'/html',new AbortController().signal),/not an audio stream/);
    await assert.rejects(inspectRadioStation(base+'/missing',new AbortController().signal),/status=404/);
    const controller = new AbortController();
    const pending = readRadioMetadata(base+'/wait',controller.signal);
    setTimeout(() => controller.abort(),50);
    await assert.rejects(pending,/aborted/i);
    assert.throws(() => radioUrl('file:///C:/Windows/win.ini'),/requires HTTP/);
    assert.throws(() => radioUrl('https://user:secret@example.com/'),/credentials/);
  } finally {
    fixture.closeAllConnections();
    fixture.close(); await once(fixture,'close');
  }
  assert.equal(active,0);
});
