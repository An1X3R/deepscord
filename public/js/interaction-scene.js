// @ts-check
/** @param {import('./network-protocol.js').JsonValue|undefined} value @param {string} label @returns {{[key:string]:import('./network-protocol.js').JsonValue}} */
function mediaObject(value,label) {
  if(!value || typeof value !== 'object' || Array.isArray(value))throw new TypeError(`${label} must be an object`);
  return value;
}

/** @typedef {'sender'|'target'} SceneAnchor */
/** @typedef {'fist'|'dollar'|'wallet'|'bomb'|'poop'|'thumbnail'} SceneModel */
/** @typedef {{at:number,anchor:SceneAnchor,x:number,y:number,z:number,scale:number,rotateX:number,rotateY:number,rotateZ:number,opacity:number}} SceneKeyframe */
/** @typedef {{model:SceneModel,keyframes:SceneKeyframe[]}} SceneActor */
/** @typedef {{version:1,actors:SceneActor[]}} InteractionScene */
/** @typedef {{x:number,y:number}} ScenePoint */
/** @typedef {{x:number,y:number,z:number,scale:number,rotateX:number,rotateY:number,rotateZ:number,opacity:number}} ScenePose */

/** @param {import('./network-protocol.js').JsonValue|undefined} value @param {number} minimum @param {number} maximum @param {string} label @returns {number} */
function number(value, minimum, maximum, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) throw new RangeError(`${label} must be finite and between ${minimum} and ${maximum}`);
  return value;
}
/** @param {import('./network-protocol.js').JsonValue|undefined} value @returns {SceneKeyframe} */
function keyframe(value) {
  const row = mediaObject(value, 'Scene keyframe');
  if (row.anchor !== 'sender' && row.anchor !== 'target') throw new TypeError('Scene keyframe anchor must be sender or target');
  return {at:number(row.at,0,1,'Scene time'),anchor:row.anchor,x:number(row.x,-480,480,'Scene x'),y:number(row.y,-480,480,'Scene y'),z:number(row.z,-240,240,'Scene z'),scale:number(row.scale,0,4,'Scene scale'),rotateX:number(row.rotateX,-1080,1080,'Scene rotation X'),rotateY:number(row.rotateY,-1080,1080,'Scene rotation Y'),rotateZ:number(row.rotateZ,-1080,1080,'Scene rotation Z'),opacity:number(row.opacity,0,1,'Scene opacity')};
}
/** @param {import('./network-protocol.js').JsonValue|undefined} value @returns {InteractionScene} */
export function parseInteractionScene(value) {
  const row = mediaObject(value, 'Interaction scene');
  if (row.version !== 1) throw new TypeError('Interaction scene version must be 1');
  if (!Array.isArray(row.actors) || row.actors.length < 1 || row.actors.length > 8) throw new RangeError('Scene requires 1 to 8 actors');
  return {version:1,actors:row.actors.map(value => {
    const actor = mediaObject(value, 'Scene actor');
    if (actor.model !== 'fist' && actor.model !== 'dollar' && actor.model !== 'wallet' && actor.model !== 'bomb' && actor.model !== 'poop' && actor.model !== 'thumbnail') throw new TypeError('Unsupported scene actor model');
    if (!Array.isArray(actor.keyframes) || actor.keyframes.length < 2 || actor.keyframes.length > 12) throw new RangeError('Scene actor requires 2 to 12 keyframes');
    const frames = actor.keyframes.map(keyframe);
    if (frames[0].at !== 0 || frames[frames.length - 1].at !== 1 || frames.some((frame,index) => index > 0 && frame.at <= frames[index - 1].at)) throw new RangeError('Scene keyframes must strictly increase from 0 to 1');
    return {model:actor.model,keyframes:frames};
  })};
}
/** @param {SceneActor} actor @param {number} progress @param {ScenePoint} sender @param {ScenePoint} target @returns {ScenePose} */
export function scenePose(actor, progress, sender, target) {
  const right = actor.keyframes.findIndex(frame => frame.at >= progress);
  const upper = right < 1 ? (right === -1 ? actor.keyframes.length - 1 : 1) : right;
  const a = actor.keyframes[upper - 1], b = actor.keyframes[upper];
  const t = Math.max(0, Math.min(1, (progress - a.at) / (b.at - a.at)));
  const start = a.anchor === 'sender' ? sender : target, end = b.anchor === 'sender' ? sender : target;
  /** @param {number} from @param {number} to @returns {number} */
  const lerp = (from,to) => from + (to - from) * t;
  return {x:lerp(start.x+a.x,end.x+b.x),y:lerp(start.y+a.y,end.y+b.y),z:lerp(a.z,b.z),scale:lerp(a.scale,b.scale),rotateX:lerp(a.rotateX,b.rotateX),rotateY:lerp(a.rotateY,b.rotateY),rotateZ:lerp(a.rotateZ,b.rotateZ),opacity:lerp(a.opacity,b.opacity)};
}
