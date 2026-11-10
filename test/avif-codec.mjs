// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {encode,decode,validate,limitsForKind} from '../lib/avif-codec.cjs';
import {createCodec} from '../public/vendor/avif/codec.mjs';

/** @param {number} width @param {number} height @param {number} seed @returns {Uint8Array} */
function rgba(width,height,seed) {
  let state=seed;
  return Uint8Array.from({length:width*height*4},(_,index)=>{
    state=(Math.imul(state,1664525)+1013904223)>>>0;
    return index%4===3?[0,128,255][Math.floor(index/4)%3]:state>>>24;
  });
}

const imageLimits={...limitsForKind('image'),timeoutMs:60000};
const options={quality:100,speed:10};

test('real transparent AVIF retains exact RGBA and passes complete validation',async()=>{
  const pixels=rgba(8,8,1337);
  const bytes=await encode({width:8,height:8,timescale:1000,repetitionCount:0,frames:[{rgba:pixels,durationTicks:1000}]},options,imageLimits,new AbortController().signal);
  const metadata=await validate(bytes,'server',new AbortController().signal);
  const decoded=await decode(bytes,imageLimits,new AbortController().signal);
  assert.equal(metadata.width,8);assert.equal(metadata.height,8);
  assert.equal(metadata.hasAlpha,true);assert.equal(metadata.frames,1);assert.equal(metadata.animated,false);
  assert.equal(metadata.codecVersion,'1.4.2');assert.deepEqual(decoded.frames[0]?.rgba,pixels);
});

test('real animated AVIF preserves changing alpha, exact durations and finite loops',async()=>{
  const first=rgba(12,12,4),second=rgba(12,12,5);
  for(let offset=3;offset<first.length;offset+=4) first[offset]=255;
  const bytes=await encode({width:12,height:12,timescale:1000,repetitionCount:2,frames:[{rgba:first,durationTicks:67},{rgba:second,durationTicks:149}]},options,imageLimits,new AbortController().signal);
  const result=await decode(bytes,imageLimits,new AbortController().signal);
  assert.equal(result.metadata.animated,true);assert.equal(result.metadata.frames,2);
  assert.equal(result.metadata.durationMs,216);assert.equal(result.metadata.repetitionCount,2);
  assert.deepEqual(result.metadata.frameDurationsTicks,[67,149]);assert.equal(result.metadata.hasAlpha,true);
  assert.deepEqual(result.frames[0]?.rgba,first);assert.deepEqual(result.frames[1]?.rgba,second);
  await assert.rejects(validate(bytes.subarray(0,bytes.length-8),'server',new AbortController().signal),/AVIF|Decode|Truncated/i);
  await fs.mkdir(new URL('./avif-codec-fixtures/',import.meta.url),{recursive:true});
  await fs.writeFile(new URL('./avif-codec-fixtures/transparent-animation.avif',import.meta.url),bytes);
});

test('AVIF sequence retains infinite loop count',async()=>{
  const pixels=rgba(2,2,8);
  const bytes=await encode({width:2,height:2,timescale:1000000,repetitionCount:-1,frames:[{rgba:pixels,durationTicks:100001},{rgba:pixels,durationTicks:300007}]},options,imageLimits,new AbortController().signal);
  const result=await validate(bytes,'server',new AbortController().signal);
  assert.equal(result.repetitionCount,-1);assert.equal(result.timescale,1000000);
  assert.deepEqual(result.frameDurationsTicks,[100001,300007]);assert.equal(result.durationMs,400.008);
});

test('AVIF validation rejects signatures without a decodable image and enforces kind dimensions',async()=>{
  const fake=Buffer.from('00000010667479706176696600000000','hex');
  await assert.rejects(validate(fake,'server',new AbortController().signal),/AVIF|Truncated/i);
  const bytes=await encode({width:241,height:1,timescale:1000,repetitionCount:0,frames:[{rgba:rgba(241,1,9),durationTicks:1000}]},options,imageLimits,new AbortController().signal);
  assert.equal((await validate(bytes,'personal',new AbortController().signal)).width,241);
  await assert.rejects(validate(bytes,'server',new AbortController().signal),/AVIF|limit/i);
});

test('AVIF encoding rejects frame, time and decoded pixel budgets',async()=>{
  const input={width:8,height:8,timescale:1000,repetitionCount:0,frames:[{rgba:rgba(8,8,1),durationTicks:500},{rgba:rgba(8,8,2),durationTicks:500}]};
  await assert.rejects(encode(input,options,{...imageLimits,maxFrames:1},new AbortController().signal),{name:'RangeError'});
  await assert.rejects(encode(input,options,{...imageLimits,maxDurationMs:999},new AbortController().signal),/limit/i);
  await assert.rejects(encode(input,options,{...imageLimits,maxDecodedPixels:127},new AbortController().signal),/limit/i);
});

test('AVIF workers terminate on cancellation and hard deadline',async()=>{
  const bytes=await encode({width:2,height:2,timescale:1000,repetitionCount:0,frames:[{rgba:rgba(2,2,1),durationTicks:1000}]},options,imageLimits,new AbortController().signal);
  const controller=new AbortController();
  const pending=validate(bytes,'server',controller.signal);controller.abort();
  await assert.rejects(pending,{name:'AbortError'});
  await assert.rejects(decode(bytes,{...imageLimits,timeoutMs:1},new AbortController().signal),/exceeded 1 milliseconds/);
});

test('real upstream transform, ICC and HDR assets stay fully decodable while unsafe resizing is rejected',async()=>{
  const library=await createCodec(await fs.readFile(new URL('../public/vendor/avif/module.wasm',import.meta.url)));
  const cases=[
    {name:'abc_color_irot_alpha_irot.avif',message:/requires rotation/},
    {name:'paris_icc_exif_xmp.avif',message:/requires ICC, HDR or non-sRGB/},
    {name:'colors_hdr_srgb.avif',message:/requires ICC, HDR or non-sRGB/},
    {name:'seine_hdr_gainmap_small_srgb.avif',message:/requires ICC, HDR or non-sRGB/}
  ];
  for(const fixture of cases){
    const bytes=await fs.readFile(new URL('./avif-codec-fixtures/upstream/'+fixture.name,import.meta.url));
    const expectedHash=createHash('sha256').update(bytes).digest('hex');
    assert(library.inspect(bytes,imageLimits,null).width>0,fixture.name+' must contain completely decodable AV1 pixels');
    assert.throws(()=>library.inspectSource(bytes,()=>{assert.fail('Unsafe pixels must never reach the resize callback');}),fixture.message);
    assert.equal(createHash('sha256').update(bytes).digest('hex'),expectedHash,'Original AVIF bytes must remain intact');
  }
  const malformed=await fs.readFile(new URL('./avif-codec-fixtures/upstream/clap_irot_imir_non_essential.avif',import.meta.url));
  assert.throws(()=>library.inspectSource(malformed,()=>{assert.fail('Invalid clap must never expose pixels');}),/clap.*essential/);
});
