// @ts-check

/** @typedef {{maxBytes:number,maxDimension:number,maxFrames:number,maxDecodedPixels:number,maxDurationMs:number,timeoutMs:number}} CodecLimits */
/** @typedef {{rgba:Uint8Array,durationTicks:number}} RgbaFrame */
/** @typedef {{width:number,height:number,timescale:number,repetitionCount:number,frames:RgbaFrame[]}} EncodeInput */
/** @typedef {{quality:number,speed:number}} EncodeOptions */
/** @typedef {{width:number,height:number,timescale:number,repetitionCount:number,quality:number,speed:number,frameCount:number}} EncoderConfig */
/** @typedef {{addFrame:(rgba:Uint8Array,durationTicks:number)=>void,finish:()=>Uint8Array,destroy:()=>void}} EncoderSession */
/** @typedef {{width:number,height:number,animated:boolean,frames:number,durationMs:number,timescale:number,frameDurationsTicks:number[],repetitionCount:number,hasAlpha:boolean,bitDepth:number,decodedPixels:number,bytes:number,codecVersion:string}} AvifMetadata */
/** @typedef {{HEAPU8:Uint8Array,_dc_error:()=>number,_dc_version:()=>number,_dc_alloc:(bytes:number)=>number,_dc_free:(pointer:number)=>void,_dc_encoder_create:(width:number,height:number,timescale:number,repetitions:number,quality:number,speed:number,frameCount:number,maxFrames:number,maxPixels:number,maxTicks:number,maxBytes:number)=>number,_dc_encoder_add:(state:number,rgba:number,bytes:number,ticks:number)=>number,_dc_encoder_finish:(state:number)=>number,_dc_encoder_data:(state:number)=>number,_dc_encoder_size:(state:number)=>number,_dc_encoder_destroy:(state:number)=>void,_dc_decoder_create:(input:number,bytes:number,dimension:number,frames:number,pixels:number,duration:number)=>number,_dc_decoder_next:(state:number)=>number,_dc_decoder_rgba:(state:number)=>number,_dc_decoder_width:(state:number)=>number,_dc_decoder_height:(state:number)=>number,_dc_decoder_frames:(state:number)=>number,_dc_decoder_timescale:(state:number)=>number,_dc_decoder_duration:(state:number)=>number,_dc_decoder_frame_ticks:(state:number)=>number,_dc_decoder_repetitions:(state:number)=>number,_dc_decoder_alpha:(state:number)=>number,_dc_decoder_depth:(state:number)=>number,_dc_decoder_destroy:(state:number)=>void}} NativeCore */
/** @typedef {NativeCore & {_dc_source_decoder_create:(input:number,bytes:number)=>number,_dc_probe_create:(input:number,bytes:number)=>number,_dc_probe_frame_ticks:(state:number,index:number)=>number}} NativeModule */
/** @typedef {{width:number,height:number,frames:number,timescale:number,frameDurationsTicks:number[],repetitionCount:number}} SourceProbe */
/** @typedef {(options:{wasmBinary:Uint8Array})=>Promise<NativeModule>} ModuleFactory */
/** @typedef {{inspectSource:(bytes:Uint8Array,onFrame:(frame:RgbaFrame)=>void)=>AvifMetadata,probe:(bytes:Uint8Array)=>SourceProbe,createEncoder:(config:EncoderConfig,limits:CodecLimits)=>EncoderSession,encode:(input:EncodeInput,options:EncodeOptions,limits:CodecLimits)=>Uint8Array,inspect:(bytes:Uint8Array,limits:CodecLimits,onFrame:((frame:RgbaFrame)=>void)|null)=>AvifMetadata}} AvifCodec */

/** @param {number} value @param {string} name @param {number} minimum @param {number} maximum @returns {number} */
function integer(value,name,minimum,maximum) {
  if(!Number.isSafeInteger(value)||value<minimum||value>maximum) throw new RangeError(name+' must be an integer from '+minimum+' through '+maximum);
  return value;
}

/** @param {CodecLimits} limits @returns {CodecLimits} */
export function parseLimits(limits) {
  if(!limits||typeof limits!=='object') throw new TypeError('AVIF codec limits must be explicit');
  return {
    maxBytes:integer(limits.maxBytes,'maxBytes',1,1572864),
    maxDimension:integer(limits.maxDimension,'maxDimension',1,1920),
    maxFrames:integer(limits.maxFrames,'maxFrames',1,180),
    maxDecodedPixels:integer(limits.maxDecodedPixels,'maxDecodedPixels',1,25165824),
    maxDurationMs:integer(limits.maxDurationMs,'maxDurationMs',1,10000),
    timeoutMs:integer(limits.timeoutMs,'timeoutMs',1,60000),
  };
}

/** @param {NativeModule} module @param {number} pointer @returns {string} */
function text(module,pointer) {
  const end=module.HEAPU8.indexOf(0,pointer);
  if(pointer<1||end<0||end-pointer>1024) throw new Error('AVIF codec returned an invalid diagnostic pointer');
  return new TextDecoder().decode(module.HEAPU8.subarray(pointer,end));
}

/** @param {NativeModule} module @returns {never} */
function failure(module) { throw new TypeError('AVIF codec rejected data: '+text(module,module._dc_error())); }

/** @param {NativeModule} module @param {Uint8Array} bytes @returns {number} */
function copyInput(module,bytes) {
  const pointer=module._dc_alloc(bytes.byteLength);
  if(!pointer) throw new RangeError('AVIF input allocation failed for '+bytes.byteLength+' bytes');
  module.HEAPU8.set(bytes,pointer);
  return pointer;
}

/** @param {NativeModule} module @param {EncoderConfig} input @param {CodecLimits} rawLimits @returns {EncoderSession} */
function createEncoder(module,input,rawLimits) {
  const limits=parseLimits(rawLimits);
  if(!input||typeof input!=='object') throw new TypeError('AVIF encoder configuration must be explicit');
  const width=integer(input.width,'width',1,limits.maxDimension),height=integer(input.height,'height',1,limits.maxDimension);
  const timescale=integer(input.timescale,'timescale',1,1000000),repetitions=integer(input.repetitionCount,'repetitionCount',-1,2147483647);
  const quality=integer(input.quality,'quality',0,100),speed=integer(input.speed,'speed',0,10);
  const frameCount=integer(input.frameCount,'frameCount',1,limits.maxFrames);
  const state=module._dc_encoder_create(width,height,timescale,repetitions,quality,speed,frameCount,limits.maxFrames,limits.maxDecodedPixels,Math.floor(limits.maxDurationMs*timescale/1000),limits.maxBytes);
  if(!state) failure(module);
  let destroyed=false,finished=false;
  return {
    addFrame(rgba,durationTicks) {
      if(destroyed||finished) throw new TypeError('AVIF encoder is closed');
      if(!(rgba instanceof Uint8Array)||rgba.byteLength!==width*height*4) throw new TypeError('AVIF frame must contain exactly width × height × 4 RGBA bytes');
      integer(durationTicks,'durationTicks',1,10000000);
      const pointer=copyInput(module,rgba);
      try { if(!module._dc_encoder_add(state,pointer,rgba.byteLength,durationTicks)) failure(module); }
      finally { module._dc_free(pointer); }
    },
    finish() {
      if(destroyed||finished) throw new TypeError('AVIF encoder is closed');
      finished=true;
      if(!module._dc_encoder_finish(state)) failure(module);
      const start=module._dc_encoder_data(state),length=module._dc_encoder_size(state);
      if(length<1||length>limits.maxBytes) throw new RangeError('Encoded AVIF byte count exceeds its limit');
      return module.HEAPU8.slice(start,start+length);
    },
    destroy() { if(!destroyed) { destroyed=true;module._dc_encoder_destroy(state); } },
  };
}

/** @param {NativeModule} module @param {EncodeInput} input @param {EncodeOptions} options @param {CodecLimits} limits @returns {Uint8Array} */
function encode(module,input,options,limits) {
  if(!input||!options||!Array.isArray(input.frames)||!input.frames.length) throw new TypeError('AVIF encode requires frames and explicit options');
  const encoder=createEncoder(module,{width:input.width,height:input.height,timescale:input.timescale,repetitionCount:input.repetitionCount,quality:options.quality,speed:options.speed,frameCount:input.frames.length},limits);
  try { for(const frame of input.frames) encoder.addFrame(frame.rgba,frame.durationTicks);return encoder.finish(); }
  finally { encoder.destroy(); }
}

/** @param {NativeModule} module @param {Uint8Array} bytes @param {CodecLimits} rawLimits @param {((frame:RgbaFrame)=>void)|null} onFrame @returns {AvifMetadata} */
function inspect(module,bytes,rawLimits,onFrame) {
  const limits=parseLimits(rawLimits);
  if(!(bytes instanceof Uint8Array)||bytes.byteLength<1||bytes.byteLength>limits.maxBytes) throw new RangeError('AVIF input bytes exceed their limit');
  const pointer=copyInput(module,bytes);
  let state=0;
  try { state=module._dc_decoder_create(pointer,bytes.byteLength,limits.maxDimension,limits.maxFrames,limits.maxDecodedPixels,limits.maxDurationMs); }
  finally { module._dc_free(pointer); }
  if(!state) failure(module);
  return readFrames(module,state,bytes.byteLength,onFrame);
}

/** @param {NativeModule} module @param {number} state @param {number} byteLength @param {((frame:RgbaFrame)=>void)|null} onFrame @returns {AvifMetadata} */
function readFrames(module,state,byteLength,onFrame) {
  try {
    const width=module._dc_decoder_width(state),height=module._dc_decoder_height(state),frames=module._dc_decoder_frames(state);
    const timescale=module._dc_decoder_timescale(state),duration=module._dc_decoder_duration(state);
    /** @type {number[]} */ const frameDurationsTicks=[];
    for(let index=0;index<frames;index++) {
      if(!module._dc_decoder_next(state)) failure(module);
      const durationTicks=module._dc_decoder_frame_ticks(state);
      frameDurationsTicks.push(durationTicks);
      if(onFrame) {
        const start=module._dc_decoder_rgba(state);
        onFrame({rgba:module.HEAPU8.slice(start,start+width*height*4),durationTicks});
      }
    }
    return {width,height,animated:frames>1,frames,durationMs:duration*1000/timescale,timescale,frameDurationsTicks,repetitionCount:module._dc_decoder_repetitions(state),hasAlpha:module._dc_decoder_alpha(state)!==0,bitDepth:module._dc_decoder_depth(state),decodedPixels:width*height*frames,bytes:byteLength,codecVersion:text(module,module._dc_version())};
  } finally { module._dc_decoder_destroy(state); }
}

/** @param {NativeModule} module @param {Uint8Array} bytes @param {(frame:RgbaFrame)=>void} onFrame @returns {AvifMetadata} */
function inspectSource(module,bytes,onFrame) {
  if(!(bytes instanceof Uint8Array)||!bytes.length||bytes.length>32*1024*1024)throw new RangeError('AVIF source must contain at most 32 MiB');
  const pointer=copyInput(module,bytes);
  let state=0;
  try {state=module._dc_source_decoder_create(pointer,bytes.length);}
  finally {module._dc_free(pointer);}
  if(!state)failure(module);
  return readFrames(module,state,bytes.byteLength,onFrame);
}

/** @param {NativeModule} module @param {Uint8Array} bytes @returns {SourceProbe} */
function probe(module,bytes) {
  if(!(bytes instanceof Uint8Array)||!bytes.length||bytes.length>32*1024*1024) throw new RangeError('AVIF source must contain at most 32 MiB');
  const pointer=copyInput(module,bytes);
  let state=0;
  try {state=module._dc_probe_create(pointer,bytes.length);}
  finally {module._dc_free(pointer);}
  if(!state) failure(module);
  try {
    const frames=module._dc_decoder_frames(state);
    return {width:module._dc_decoder_width(state),height:module._dc_decoder_height(state),frames,timescale:module._dc_decoder_timescale(state),frameDurationsTicks:Array.from({length:frames},(_,index)=>module._dc_probe_frame_ticks(state,index)),repetitionCount:module._dc_decoder_repetitions(state)};
  } finally {module._dc_decoder_destroy(state);}
}

/** @param {Uint8Array} wasmBytes @returns {Promise<AvifCodec>} */
export async function createCodec(wasmBytes) {
  if(!(wasmBytes instanceof Uint8Array)||wasmBytes.length<8) throw new TypeError('AVIF WebAssembly bytes are required');
  const factory=/** @type {ModuleFactory} */ ((await import('./module.mjs')).default);
  const module=await factory({wasmBinary:wasmBytes});
  return {inspectSource:(bytes,onFrame)=>inspectSource(module,bytes,onFrame),probe:bytes=>probe(module,bytes),createEncoder:(config,limits)=>createEncoder(module,config,limits),encode:(input,options,limits)=>encode(module,input,options,limits),inspect:(bytes,limits,onFrame)=>inspect(module,bytes,limits,onFrame)};
}
