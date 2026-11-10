// @ts-check
import {PeerLink} from '../public/js/peer-link.js';
import {MicrophoneGraph} from '../public/js/microphone-graph.js';
import {ProcessAudioCapture,captureScreen,listScreenSources,listAudioProcesses} from '../public/js/desktop-capture.js';
import {DEFAULT_SCREEN_PREFERENCES} from '../public/js/screen-preferences.js';
/** @typedef {import('../public/js/network-protocol.js').PeerSignal} PeerSignal */
/** @typedef {{id:string,kind:string,bytes:number,packets:number,frames:number,energy:number,samples:number}} InboundSnapshot */
/** @typedef {{amplitudes:{kind:string,rms:number}[],hidden:boolean,state:string,context:string|undefined,contextTime:number|undefined,inbound:InboundSnapshot[],outbound:{kind:string,bytes:number,packets:number,frames:number}[],received:string[],tracks:{kind:string,state:string}[],errors:string[]}} MediaSnapshot */
/** @typedef {{peer:string|undefined,tracks:string[],context:string|undefined,errors:string[]}} StoppedSnapshot */
/** @type {PeerSignal[]} */const signals=[];
/** @type {string[]} */const errors=[];
/** @type {PeerLink|null} */let link=null;
/** @type {AudioContext|null} */let context=null;
/** @type {OscillatorNode|null} */let oscillator=null;
/** @type {MicrophoneGraph|null} */let graph=null;
/** @type {MediaStream|null} */let source=null;
/** @type {MediaStream|null} */let screen=null;
/** @type {MediaStreamTrack[]} */const tracks=[];
/** @type {HTMLMediaElement[]} */const elements=[];
/** @type {AudioNode[]} */const consumers=[];
/** @type {Map<string,MediaStream>} */const received=new Map();
/** @type {Map<string,AnalyserNode>} */const analysers=new Map();
/** @param {Error} error @returns {void} */function fail(error){errors.push(error.message);}
const capture=new ProcessAudioCapture(fail,()=>{});
/** @param {string} side @returns {Promise<void>} */
async function start(side){
  context=new AudioContext({sampleRate:48000});await context.resume();
  if(side==='a'){
    oscillator=context.createOscillator();oscillator.frequency.value=617;
    const gain=context.createGain();gain.gain.value=0.1;const destination=context.createMediaStreamDestination();oscillator.connect(gain).connect(destination);oscillator.start();source=destination.stream;
    graph=new MicrophoneGraph(context,source,1,0);graph.gate.gain.value=1;tracks.push(...source.getTracks(),...graph.dest.stream.getTracks());
  }
  link=new PeerLink({selfId:side,peerId:side==='a'?'b':'a',config:{networkMode:'direct',mediaPolicy:'direct',iceTransportPolicy:'all',iceServers:[],iceExpiresAt:null},track:graph?.dest.stream.getAudioTracks()[0] ?? null,stream:graph?.dest.stream ?? null,sendSignal:signal=>signals.push(signal),onState:()=>{},onControl:()=>{},onReady:()=>{},onError:fail,onTrack:(stream,kind)=>{
    received.set(kind,stream);tracks.push(...stream.getTracks());
    const element=document.createElement(kind==='screen'?'video':'audio');element.muted=true;element.autoplay=true;element.srcObject=stream;elements.push(element);document.body.append(element);void element.play().catch(fail);
    if(kind!=='screen' && context){const input=context.createMediaStreamSource(stream),silent=context.createGain(),analyser=context.createAnalyser();analyser.fftSize=2048;silent.gain.value=0;input.connect(analyser).connect(silent).connect(context.destination);consumers.push(input,analyser,silent);analysers.set(kind,analyser);}
  }});
}
/** @param {number} pid @param {string} sourceId @returns {Promise<void>} */
async function share(pid,sourceId){if(!link)throw new Error('Peer is not initialized');const audio=await capture.start(pid);screen=await captureScreen(sourceId,DEFAULT_SCREEN_PREFERENCES);tracks.push(...audio.getTracks(),...screen.getTracks());await link.setAccompanimentTrack(audio.getAudioTracks()[0]);await link.setScreenTrack(screen.getVideoTracks()[0]);}
/** @returns {Promise<MediaSnapshot>} */
async function stats(){
  if(!link)throw new Error('Peer is not initialized');
  /** @type {InboundSnapshot[]} */const inbound=[];
  /** @type {{kind:string,bytes:number,packets:number,frames:number}[]} */const outbound=[];
  const report=await link.pc.getStats();report.forEach(entry=>{if(entry.type==='inbound-rtp')inbound.push({id:entry.id,kind:entry.kind,bytes:entry.bytesReceived ?? 0,packets:entry.packetsReceived ?? 0,frames:entry.framesDecoded ?? 0,energy:entry.totalAudioEnergy ?? 0,samples:entry.totalSamplesDuration ?? 0});if(entry.type==='outbound-rtp')outbound.push({kind:entry.kind,bytes:entry.bytesSent ?? 0,packets:entry.packetsSent ?? 0,frames:entry.framesEncoded ?? 0});});
  const amplitudes=[...analysers].map(([kind,analyser])=>{const values=new Float32Array(analyser.fftSize);analyser.getFloatTimeDomainData(values);return{kind,rms:Math.sqrt(values.reduce((sum,value)=>sum+value*value,0)/values.length)};});return{amplitudes,hidden:document.hidden,state:link.pc.connectionState,context:context?.state,contextTime:context?.currentTime,inbound,outbound,received:[...received.keys()],tracks:tracks.map(track=>({kind:track.kind,state:track.readyState})),errors:[...errors]};
}
/** @returns {Promise<StoppedSnapshot>} */
async function stop(){
  link?.close();if(capture.context)await capture.stop();for(const track of tracks)track.stop();oscillator?.stop();graph?.dispose();for(const node of consumers)node.disconnect();for(const element of elements){element.pause();element.srcObject=null;element.remove();}await context?.close();return{peer:link?.pc.connectionState,tracks:tracks.map(track=>track.readyState),context:context?.state,errors:[...errors]};
}
/** @returns {number[]} */
function videoPixel(){const video=elements.find(element=>element instanceof HTMLVideoElement);if(!(video instanceof HTMLVideoElement) || video.videoWidth<1)throw new Error('No decoded remote video');const canvas=document.createElement('canvas');canvas.width=video.videoWidth;canvas.height=video.videoHeight;const painter=canvas.getContext('2d');if(!painter)throw new Error('No sample canvas');painter.drawImage(video,0,0);return [...painter.getImageData(Math.floor(canvas.width/2),Math.floor(canvas.height/2),1,1).data];}
Object.assign(window,{memoryMediaRegression:{start,share,stats,stop,videoPixel,listScreenSources,listAudioProcesses,takeSignals:()=>signals.splice(0),receive:(/** @type {PeerSignal} */ signal)=>{if(!link)throw new Error('Peer is not initialized');return link.receive(signal);}}});
