// @ts-check
import {createAvifCodec} from '../public/js/avif-codec.js';
import {createCodec} from '../public/vendor/avif/codec.mjs';
import {MEDIA_LIMITS,MAX_MEDIA_FRAMES,MAX_MEDIA_DURATION_MS,MAX_MEDIA_DECODED_PIXELS} from '../public/js/chat-protocol.js';

/** @param {boolean} condition @param {string} message @returns {void} */
function verify(condition,message) {if(!condition)throw new Error(message);}
/** @param {string} name @returns {Promise<Blob>} */
async function fixture(name) {const response=await fetch('/test/avif-codec-fixtures/'+name);if(!response.ok)throw new Error('Fixture HTTP '+response.status);return response.blob();}

/** @returns {Promise<{formats:{name:string,bytes:number,width:number,height:number,frames:number,durationMs:number}[],queue:{active:number,queued:number,completed:number,cancelled:number,failed:number}}>} */
export async function run() {
  const codec=createAvifCodec();
  const library=await createCodec(new Uint8Array(await (await fetch('/public/vendor/avif/module.wasm')).arrayBuffer()));
  const limits={maxBytes:MEDIA_LIMITS.server.bytes,maxDimension:240,maxFrames:MAX_MEDIA_FRAMES,maxDurationMs:MAX_MEDIA_DURATION_MS,maxDecodedPixels:MAX_MEDIA_DECODED_PIXELS,timeoutMs:60000};
  const formats=[];
  try {
    for(const name of ['transparent.png','transparent-animation.png','transparent-animation.webp','transparent-animation.gif','still.jpg','still.bmp','large-transparent-animation.avif']) {
      const input=await fixture(name);
      const output=await codec.prepare(input,name,'server',new AbortController().signal).catch(error=>{throw new Error(name+' prepare: '+String(error));});
      verify(output.blob.type==='image/avif','Output must be pure AVIF: '+name);
      verify(output.metadata.width===160&&output.metadata.height===96,'Aspect ratio or target size changed: '+name);
      const animated=name.includes('animation');
      verify(output.metadata.frames===(animated?2:1),'Animation frame count changed: '+name);
      if(animated)verify(output.metadata.durationMs===(name.endsWith('.gif')?250:216),'Animation duration changed: '+name);
      const actual=library.inspect(new Uint8Array(await output.blob.arrayBuffer()),limits,null);
      if(animated) {
        const Constructor=/** @type {typeof globalThis & {ImageDecoder:import('../public/js/avif-codec-worker.js').ImageDecoderConstructor}} */(globalThis).ImageDecoder;
        let repetitions=2;
        if(!name.endsWith('.avif')) {
          const source=new Constructor({data:new Uint8Array(await input.arrayBuffer()),type:name.endsWith('.png')?'image/png':name.endsWith('.gif')?'image/gif':'image/webp',preferAnimation:true});
          try {await source.tracks.ready;repetitions=source.tracks.selectedTrack?.repetitionCount??0;}
          finally {source.close();}
        }
        verify(actual.repetitionCount===(repetitions===Infinity?-1:repetitions),'Animation loop count changed: '+name);
      }
      const metadata=await codec.inspect(output.blob,'server',new AbortController().signal);
      verify(metadata.sha256===output.metadata.sha256,'Roundtrip asset hash changed: '+name);
      const nativeImage=new Image(),nativeUrl=URL.createObjectURL(output.blob);nativeImage.src=nativeUrl;
      try {await nativeImage.decode();verify(nativeImage.naturalWidth===160,'Native AVIF image width changed');}
      catch(error) {throw new Error(name+' native image decode: '+String(error));}
      finally {URL.revokeObjectURL(nativeUrl);}
      const poster=await codec.poster(output.blob,new AbortController().signal).catch(error=>{throw new Error(name+' poster: '+String(error));});
      verify(poster.type==='image/png','Poster must remain local PNG');
      const bitmap=await createImageBitmap(poster),canvas=new OffscreenCanvas(bitmap.width,bitmap.height);
      const context=canvas.getContext('2d');if(!context)throw new Error('Test canvas is unavailable');
      context.drawImage(bitmap,0,0);bitmap.close();
      if(name.includes('transparent')&&!name.endsWith('.gif')) {
        verify(context.getImageData(0,0,1,1).data[3]===0,'Transparent pixel was lost: '+name);
        verify(context.getImageData(80,48,1,1).data[3]===128,'Semitransparent pixel was lost: '+name);
        const sourceBitmap=await createImageBitmap(input),reference=new OffscreenCanvas(sourceBitmap.width,sourceBitmap.height),referenceContext=reference.getContext('2d');
        if(!referenceContext)throw new Error('Reference color canvas is unavailable');
        try {
          referenceContext.drawImage(sourceBitmap,0,0);
          const expected=referenceContext.getImageData(Math.floor(sourceBitmap.width/2),Math.floor(sourceBitmap.height/2),1,1).data,actual=context.getImageData(80,48,1,1).data;
          for(let channel=0;channel<3;channel++)verify(Math.abs(expected[channel]-actual[channel])<=8,'sRGB color changed beyond the lossy quality tolerance: '+name+' channel '+channel);
        } finally {sourceBitmap.close();reference.width=1;reference.height=1;}
      }
      formats.push({name,bytes:output.metadata.bytes,width:metadata.width,height:metadata.height,frames:metadata.frames,durationMs:metadata.durationMs});
    }
    const original=await fixture('transparent-animation.avif');
    const passthrough=await codec.prepare(original,'original.avif','server',new AbortController().signal);
    const before=new Uint8Array(await original.arrayBuffer()),after=new Uint8Array(await passthrough.blob.arrayBuffer());
    verify(before.length===after.length&&before.every((value,index)=>after[index]===value),'AVIF passthrough changed bytes');
    for(const name of ['abc_color_irot_alpha_irot.avif','paris_icc_exif_xmp.avif','colors_hdr_srgb.avif','seine_hdr_gainmap_small_srgb.avif']) {
      const source=await fixture('upstream/'+name),preserved=await codec.prepare(source,name,'image',new AbortController().signal);
      const originalBytes=new Uint8Array(await source.arrayBuffer()),preservedBytes=new Uint8Array(await preserved.blob.arrayBuffer());
      verify(originalBytes.length===preservedBytes.length&&originalBytes.every((value,index)=>value===preservedBytes[index]),'AVIF transform/color metadata changed during passthrough: '+name);
      const image=new Image(),url=URL.createObjectURL(preserved.blob);image.src=url;
      try {await image.decode();} finally {URL.revokeObjectURL(url);}
      if(name!=='colors_hdr_srgb.avif') {
        let rejected=false;
        try {await codec.prepare(source,name,'server',new AbortController().signal);}
        catch(error) {rejected=/requires rotation|requires ICC, HDR or non-sRGB/.test(error instanceof Error?error.message:String(error));}
        verify(rejected,'Unsafe AVIF resizing must report its unsupported transform/color profile: '+name);
      }
    }
    const controllers=Array.from({length:6},()=>new AbortController());
    const requests=controllers.map(controller=>codec.inspect(original,'server',controller.signal));
    const results=Promise.allSettled(requests);controllers[0].abort();controllers[4].abort();
    const settled=await results;
    verify(settled[5].status==='rejected','Queue must reject a sixth task');
    verify(settled[0].status==='rejected'&&settled[4].status==='rejected','Cancellation must reject active and queued tasks');
    verify(codec.stats().active===0&&codec.stats().queued===0,'Codec workers must leave no idle heap');
    return {formats,queue:codec.stats()};
  } finally {codec.destroy();}
}
