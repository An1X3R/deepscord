// @ts-check
/** @typedef {import('./interaction-scene.js').SceneKeyframe} SceneKeyframe */
/** @param {number} at @param {import('./interaction-scene.js').SceneAnchor} anchor @param {number} x @param {number} y @param {number} z @param {number} scale @param {number} rotateX @param {number} rotateY @param {number} rotateZ @param {number} opacity @returns {SceneKeyframe} */
function frame(at,anchor,x,y,z,scale,rotateX,rotateY,rotateZ,opacity){return {at,anchor,x,y,z,scale,rotateX,rotateY,rotateZ,opacity};}
/** @type {import('./customization-protocol.js').CustomInteraction[]} */
export const SCENE_EXAMPLES = [
  {id:'playful-fist',name:'轻轻捶你',thumbnail:null,model:'poop',trajectory:'linear',sound:'none',durationMs:1400,scene:{version:1,actors:[
    {model:'fist',keyframes:[frame(0,'target',24,-5,0,0.8,0,0,-20,1),frame(0.18,'target',0,0,30,1.15,0,0,0,1),frame(0.34,'target',24,-5,0,0.8,0,0,-20,1),frame(0.50,'target',0,0,30,1.15,0,0,0,1),frame(0.66,'target',24,-5,0,0.8,0,0,-20,1),frame(0.82,'target',0,0,30,1.15,0,0,0,1),frame(1,'target',0,0,0,1,0,0,0,1)]}
  ]}},
  {id:'dollar-wallet',name:'收点小费',thumbnail:null,model:'poop',trajectory:'linear',sound:'none',durationMs:1900,scene:{version:1,actors:[
    {model:'dollar',keyframes:[frame(0,'target',0,-6,0,1,-12,0,-12,1),frame(0.2,'target',0,-48,35,1.15,-12,90,-15,1),frame(0.72,'sender',0,-48,25,0.9,-12,360,8,1),frame(0.92,'sender',0,3,-15,0.55,0,360,0,1),frame(1,'sender',0,12,-30,0,0,360,0,0)]},
    {model:'wallet',keyframes:[frame(0,'sender',0,14,0,1,-18,-18,0,1),frame(0.8,'sender',0,14,0,1,-18,-18,0,1),frame(0.93,'sender',0,14,0,1.14,-18,-18,0,1),frame(1,'sender',0,14,0,1,-18,-18,0,1)]}
  ]}}
];
