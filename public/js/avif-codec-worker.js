// @ts-check
import {createCodec} from '../vendor/avif/codec.mjs';
import {MEDIA_LIMITS,MAX_MEDIA_FRAMES,MAX_MEDIA_DURATION_MS,MAX_MEDIA_DECODED_PIXELS,parseMediaMetadata,checkMediaKind} from './chat-protocol.js';
/** @typedef {import('./avif-codec.js').CodecTask} CodecTask */
/** @typedef {import('./avif-codec.js').CodecReply} CodecReply */
/** @typedef {import('./chat-protocol.js').MediaKind} MediaKind */
/** @typedef {import('./chat-protocol.js').MediaMetadata} MediaMetadata */
/** @typedef {import('../vendor/avif/codec.mjs').AvifCodec} AvifCodec */
/** @typedef {import('../vendor/avif/codec.mjs').AvifMetadata} AvifMetadata */
/** @typedef {import('../vendor/avif/codec.mjs').CodecLimits} CodecLimits */
/** @typedef {{animated:boolean,frameCount:number,repetitionCount:number}} ImageTrack */
/** @typedef {{tracks:{ready:Promise<void>,selectedTrack:ImageTrack|null},completed:Promise<void>,decode:(options:{frameIndex:number,completeFramesOnly:boolean})=>Promise<{image:VideoFrame,complete:boolean}>,close:()=>void}} SourceDecoder */
/** @typedef {{new(options:{data:Uint8Array,type:string,preferAnimation:boolean}):SourceDecoder,isTypeSupported:(type:string)=>Promise<boolean>}} ImageDecoderConstructor */
/** @typedef {{width:number,height:number}} Dimensions */

const decoderConstructor=/** @type {typeof globalThis & {ImageDecoder?:ImageDecoderConstructor}} */(globalThis).ImageDecoder;
/** @type {Promise<AvifCodec>|null} */ let codecPromise=null;

/** @returns {Promise<AvifCodec>} */
async function codec() {
  if(!codecPromise)codecPromise=(async()=>{
    const url=new URL('../vendor/avif/module.wasm',import.meta.url);
    for(let attempt=1;attempt<=3;attempt++) {
      try {
        const response=await fetch(url);
        if(!response.ok)throw new Error('AVIF codec download failed with HTTP '+response.status+' '+await response.text());
        return await createCodec(new Uint8Array(await response.arrayBuffer()));
      } catch(error) {
        console.warn(JSON.stringify({event:'avif-codec-load-retry',url:url.href,attempt,error:String(error)}));
        if(attempt===3)throw error;
      }
    }
    throw new Error('AVIF codec could not be loaded');
  })();
  return codecPromise;
}

/** @param {MediaKind} kind @returns {CodecLimits} */
function limits(kind) {return {maxBytes:MEDIA_LIMITS[kind].bytes,maxDimension:MEDIA_LIMITS[kind].dimension,maxFrames:MAX_MEDIA_FRAMES,maxDecodedPixels:MAX_MEDIA_DECODED_PIXELS,maxDurationMs:MAX_MEDIA_DURATION_MS,timeoutMs:60000};}

/** @param {Uint8Array} data @param {number} offset @param {string} value @returns {boolean} */
function matches(data,offset,value) {return [...value].every((character,index)=>data[offset+index]===character.charCodeAt(0));}

/** @param {Uint8Array} bytes @returns {string} */
function sourceType(bytes) {
  if(bytes.length>=12&&matches(bytes,4,'ftyp'))return 'image/avif';
  if(bytes.length>=24&&bytes[0]===137&&matches(bytes,1,'PNG\r\n\u001a\n'))return 'image/png';
  if(bytes.length>=10&&(matches(bytes,0,'GIF87a')||matches(bytes,0,'GIF89a')))return 'image/gif';
  if(bytes.length>=12&&matches(bytes,0,'RIFF')&&matches(bytes,8,'WEBP'))return 'image/webp';
  if(bytes.length>=4&&bytes[0]===255&&bytes[1]===216)return 'image/jpeg';
  if(bytes.length>=26&&matches(bytes,0,'BM'))return 'image/bmp';
  throw new TypeError('Supported image sources are AVIF, PNG/APNG, JPEG, WebP, GIF and BMP');
}

/** @param {number} width @param {number} height @returns {Dimensions} */
function sourceDimensions(width,height) {
  if(!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||width<1||height<1||width*height>40000000)throw new RangeError('Image source frame must contain at most 40 million pixels');
  return {width,height};
}

/** @param {Uint8Array} bytes @param {string} type @param {AvifCodec|null} library @returns {Dimensions} */
function dimensions(bytes,type,library) {
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  if(type==='image/avif') {if(!library)throw new Error('AVIF source probe is unavailable');const probe=library.probe(bytes);return sourceDimensions(probe.width,probe.height);}
  if(type==='image/png')return sourceDimensions(view.getUint32(16),view.getUint32(20));
  if(type==='image/gif')return sourceDimensions(view.getUint16(6,true),view.getUint16(8,true));
  if(type==='image/bmp') {
    if(view.getUint32(14,true)===12)return sourceDimensions(view.getUint16(18,true),view.getUint16(20,true));
    return sourceDimensions(view.getInt32(18,true),Math.abs(view.getInt32(22,true)));
  }
  if(type==='image/webp') {
    if(bytes.length>=30&&matches(bytes,12,'VP8X'))return sourceDimensions(1+bytes[24]+bytes[25]*256+bytes[26]*65536,1+bytes[27]+bytes[28]*256+bytes[29]*65536);
    if(bytes.length>=25&&matches(bytes,12,'VP8L')&&bytes[20]===47) {const value=view.getUint32(21,true);return sourceDimensions((value&16383)+1,((value>>>14)&16383)+1);}
    if(bytes.length>=30&&matches(bytes,12,'VP8 ')&&bytes[23]===157&&bytes[24]===1&&bytes[25]===42)return sourceDimensions(view.getUint16(26,true)&16383,view.getUint16(28,true)&16383);
    throw new TypeError('WebP source lacks a supported bounded frame header');
  }
  if(type==='image/jpeg') {
    let offset=2;
    while(offset+3<bytes.length) {
      if(bytes[offset++]!==255)throw new TypeError('JPEG source contains an invalid marker');
      while(bytes[offset]===255)offset++;
      const marker=bytes[offset++];if(marker===217||marker===218)break;
      if(marker===1||marker>=208&&marker<=215)continue;
      if(offset+2>bytes.length)break;
      const length=view.getUint16(offset);if(length<2||offset+length>bytes.length)throw new TypeError('JPEG segment exceeds source bytes');
      if([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker)) {
        if(length<8)throw new TypeError('JPEG dimensions are truncated');
        return sourceDimensions(view.getUint16(offset+5),view.getUint16(offset+3));
      }
      offset+=length;
    }
    throw new TypeError('JPEG source has no bounded frame dimensions');
  }
  throw new TypeError('Unsupported source dimensions');
}

/** @param {number} width @param {number} height @param {number} target @returns {Dimensions} */
function fit(width,height,target) {const scale=Math.min(1,target/width,target/height);return {width:Math.max(1,Math.round(width*scale)),height:Math.max(1,Math.round(height*scale))};}

/** @param {Uint8Array} bytes @param {AvifMetadata} metadata @param {MediaKind} kind @returns {Promise<MediaMetadata>} */
async function mediaMetadata(bytes,metadata,kind) {
  const digest=await crypto.subtle.digest('SHA-256',Uint8Array.from(bytes));
  const sha256=Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,'0')).join('');
  return checkMediaKind(parseMediaMetadata({sha256,bytes:bytes.length,width:metadata.width,height:metadata.height,animated:metadata.animated,frames:metadata.frames,durationMs:metadata.durationMs}),kind);
}

/** @param {Uint8Array} bytes @param {string} type @returns {Promise<SourceDecoder>} */
async function openDecoder(bytes,type) {
  if(!decoderConstructor||!await decoderConstructor.isTypeSupported(type))throw new TypeError('This browser cannot decode '+type+' without losing animation');
  const decoder=new decoderConstructor({data:bytes,type,preferAnimation:true});
  try {await decoder.tracks.ready;await decoder.completed;return decoder;}
  catch(error) {decoder.close();throw error;}
}

/** @param {OffscreenCanvas} canvas @param {CanvasImageSource} frame @returns {Uint8Array} */
function framePixels(canvas,frame) {
  const context=canvas.getContext('2d',{willReadFrequently:true});
  if(!context)throw new Error('Image conversion requires a 2D canvas');
  context.clearRect(0,0,canvas.width,canvas.height);context.drawImage(frame,0,0,canvas.width,canvas.height);
  return new Uint8Array(context.getImageData(0,0,canvas.width,canvas.height).data.buffer);
}

/** @param {Uint8Array} bytes @param {string} type @param {Dimensions} source @param {MediaKind} kind @param {number} quality @param {AvifCodec} library @returns {Promise<Uint8Array>} */
async function transcode(bytes,type,source,kind,quality,library) {
  const size=fit(source.width,source.height,MEDIA_LIMITS[kind].target),canvas=new OffscreenCanvas(size.width,size.height);
  if(type==='image/avif') {
    const probe=library.probe(bytes);
    if(size.width*size.height*probe.frames>MAX_MEDIA_DECODED_PIXELS)throw new RangeError('Image output exceeds 24 million cumulative decoded pixels');
    const encoder=library.createEncoder({...size,timescale:probe.timescale,repetitionCount:probe.repetitionCount,quality,speed:8,frameCount:probe.frames},limits(kind));
    const sourceCanvas=new OffscreenCanvas(source.width,source.height),context=sourceCanvas.getContext('2d');
    try {
      if(!context)throw new Error('AVIF source conversion requires a 2D canvas');
      library.inspectSource(bytes,frame=>{
        context.putImageData(new ImageData(Uint8ClampedArray.from(frame.rgba),source.width,source.height),0,0);
        encoder.addFrame(framePixels(canvas,sourceCanvas),frame.durationTicks);
      });
      return encoder.finish();
    } catch(error) {
      if(error instanceof Error&&/memory|OOM|allocation/i.test(error.message))throw new RangeError('Source AVIF exceeds the codec worker\'s 256 MiB memory budget; resize the original image first');
      throw error;
    } finally {encoder.destroy();sourceCanvas.width=1;sourceCanvas.height=1;canvas.width=1;canvas.height=1;}
  }
  if(type==='image/bmp') {
    const bitmap=await createImageBitmap(new Blob([Uint8Array.from(bytes)],{type}));
    const encoder=library.createEncoder({...size,timescale:1000000,repetitionCount:0,quality,speed:8,frameCount:1},limits(kind));
    try {sourceDimensions(bitmap.width,bitmap.height);encoder.addFrame(framePixels(canvas,bitmap),1000000);return encoder.finish();}
    finally {bitmap.close();encoder.destroy();}
  }
  const decoder=await openDecoder(bytes,type);
  try {
    const track=decoder.tracks.selectedTrack;
    if(!track||!Number.isSafeInteger(track.frameCount)||track.frameCount<1||track.frameCount>MAX_MEDIA_FRAMES)throw new RangeError('Image source must contain 1 through 180 complete frames');
    if(source.width*source.height*track.frameCount>256*1024*1024)throw new RangeError('Image source exceeds 256 million cumulative decoded pixels');
    const first=await decoder.decode({frameIndex:0,completeFramesOnly:true});
    let target;
    try {sourceDimensions(first.image.displayWidth,first.image.displayHeight);target=fit(first.image.displayWidth,first.image.displayHeight,MEDIA_LIMITS[kind].target);}
    finally {first.image.close();}
    canvas.width=target.width;canvas.height=target.height;
    if(target.width*target.height*track.frameCount>MAX_MEDIA_DECODED_PIXELS)throw new RangeError('Image output exceeds 24 million cumulative decoded pixels');
    const repetitions=track.repetitionCount===Infinity?-1:track.repetitionCount;
    if(!Number.isInteger(repetitions)||repetitions< -1||repetitions>2147483647)throw new RangeError('Image source contains an invalid loop count');
    const encoder=library.createEncoder({...target,timescale:1000000,repetitionCount:repetitions,quality,speed:8,frameCount:track.frameCount},limits(kind));
    let elapsed=0,totalPixels=0;
    try {
      for(let index=0;index<track.frameCount;index++) {
        const result=await decoder.decode({frameIndex:index,completeFramesOnly:true});
        try {
          if(!result.complete)throw new TypeError('Image source contains an incomplete frame');
          const frame=result.image;sourceDimensions(frame.displayWidth,frame.displayHeight);
          totalPixels+=frame.displayWidth*frame.displayHeight;
          if(totalPixels>256*1024*1024)throw new RangeError('Image source exceeds 256 million cumulative decoded pixels');
          const duration=track.frameCount===1?1000000:frame.duration;
          if(duration===null||!Number.isSafeInteger(duration)||duration<1)throw new TypeError('Animated source contains an invalid frame duration');
          elapsed+=duration;if(elapsed>MAX_MEDIA_DURATION_MS*1000)throw new RangeError('Image animation exceeds 10 seconds');
          encoder.addFrame(framePixels(canvas,frame),duration);
        } finally {result.image.close();}
      }
      return encoder.finish();
    } finally {encoder.destroy();}
  } finally {decoder.close();canvas.width=1;canvas.height=1;}
}

/** @param {Blob} file @param {MediaKind} kind @returns {Promise<{blob:Blob,metadata:MediaMetadata}>} */
async function prepare(file,kind) {
  const bytes=new Uint8Array(await file.arrayBuffer()),type=sourceType(bytes),library=await codec();
  const avifProbe=type==='image/avif'?library.probe(bytes):null;
  const source=avifProbe?sourceDimensions(avifProbe.width,avifProbe.height):dimensions(bytes,type,null);
  if(avifProbe&&file.size<=MEDIA_LIMITS.image.bytes&&source.width<=MEDIA_LIMITS.image.dimension&&source.height<=MEDIA_LIMITS.image.dimension&&source.width*source.height*avifProbe.frames<=MAX_MEDIA_DECODED_PIXELS) {
    const checked=library.inspect(bytes,limits('image'),null);
    if(file.size<=MEDIA_LIMITS[kind].bytes&&source.width<=MEDIA_LIMITS[kind].dimension&&source.height<=MEDIA_LIMITS[kind].dimension) {
      const metadata=await mediaMetadata(bytes,checked,kind);
      return {blob:new Blob([Uint8Array.from(bytes)],{type:'image/avif'}),metadata};
    }
  }
  // Byte budgeting retries the complete sequence at most three times. No frames are dropped.
  for(const quality of [70,50,30]) {
    try {
      const encoded=await transcode(bytes,type,source,kind,quality,library);
      const metadata=await mediaMetadata(encoded,library.inspect(encoded,limits(kind),null),kind);
      return {blob:new Blob([Uint8Array.from(encoded)],{type:'image/avif'}),metadata};
    } catch(error) {
      if(!(error instanceof Error)||!error.message.includes('Encoded AVIF exceeds its output byte limit')||quality===30)throw error;
      console.warn(JSON.stringify({event:'avif-byte-budget-retry',quality,nextQuality:quality===70?50:30,kind}));
    }
  }
  throw new RangeError('Image cannot fit its AVIF byte budget without exceeding permitted quality retries');
}

/** @param {Blob} file @returns {Promise<Blob>} */
async function poster(file) {
  const bytes=new Uint8Array(await file.arrayBuffer()),type=sourceType(bytes),library=type==='image/avif'?await codec():null;
  const source=dimensions(bytes,type,library),size=fit(source.width,source.height,320),canvas=new OffscreenCanvas(size.width,size.height);
  if(type==='image/bmp'||type==='image/avif') {
    const bitmap=await createImageBitmap(file);
    try {framePixels(canvas,bitmap);return await canvas.convertToBlob({type:'image/png'});}
    finally {bitmap.close();canvas.width=1;canvas.height=1;}
  }
  const decoder=await openDecoder(bytes,type);
  try {
    const result=await decoder.decode({frameIndex:0,completeFramesOnly:true});
    try {sourceDimensions(result.image.displayWidth,result.image.displayHeight);const target=fit(result.image.displayWidth,result.image.displayHeight,320);canvas.width=target.width;canvas.height=target.height;framePixels(canvas,result.image);return await canvas.convertToBlob({type:'image/png'});}
    finally {result.image.close();}
  } finally {decoder.close();canvas.width=1;canvas.height=1;}
}

/** @param {CodecTask} task @returns {Promise<CodecReply>} */
async function execute(task) {
  if(!task||!(task.file instanceof Blob)||!task.file.size||task.file.size>32*1024*1024)throw new RangeError('Image source must contain at most 32 MiB');
  if(task.operation==='poster')return {ok:true,poster:await poster(task.file)};
  if(task.operation==='prepare')return {ok:true,...await prepare(task.file,task.kind)};
  if(task.operation==='inspect') {
    const bytes=new Uint8Array(await task.file.arrayBuffer()),library=await codec();
    return {ok:true,metadata:await mediaMetadata(bytes,library.inspect(bytes,limits(task.kind),null),task.kind)};
  }
  throw new TypeError('Unsupported image worker operation');
}

globalThis.onmessage=/** @param {MessageEvent<CodecTask>} event */ event=>{
  execute(event.data).then(reply=>globalThis.postMessage(reply),error=>{
    const failure=error instanceof Error?error:new Error(String(error));
    const context=event.data.operation==='prepare'?'prepare '+event.data.name:event.data.operation;
    /** @type {CodecReply} */ const reply={ok:false,name:failure.name,message:context+': '+failure.message};globalThis.postMessage(reply);
  });
};
