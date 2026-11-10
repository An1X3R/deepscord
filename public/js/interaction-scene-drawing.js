// @ts-check
/** @typedef {import('./interaction-scene.js').ScenePose} ScenePose */
/** @typedef {{x:number,y:number,z:number}} Point3 */
/** @typedef {{points:Point3[],color:string}} Face */

/** @param {Point3} point @param {ScenePose} pose @returns {Point3} */
function transform(point, pose) {
  const rx=pose.rotateX*Math.PI/180, ry=pose.rotateY*Math.PI/180, rz=pose.rotateZ*Math.PI/180;
  const y=point.y*Math.cos(rx)-point.z*Math.sin(rx), z=point.y*Math.sin(rx)+point.z*Math.cos(rx);
  const x=point.x*Math.cos(ry)+z*Math.sin(ry), depth=-point.x*Math.sin(ry)+z*Math.cos(ry);
  return {x:x*Math.cos(rz)-y*Math.sin(rz),y:x*Math.sin(rz)+y*Math.cos(rz),z:depth};
}
/** @param {Point3} point @param {number} radius @returns {{x:number,y:number}} */
function project(point,radius) { const depth=5/(5-point.z); return {x:point.x*radius*depth,y:point.y*radius*depth}; }
/** @param {CanvasRenderingContext2D} context @param {Face[]} faces @param {ScenePose} pose @param {number} radius @returns {void} */
function drawFaces(context,faces,pose,radius) {
  const transformed=faces.map(face=>({points:face.points.map(point=>transform(point,pose)),color:face.color}));
  transformed.sort((a,b)=>a.points.reduce((sum,p)=>sum+p.z,0)/a.points.length-b.points.reduce((sum,p)=>sum+p.z,0)/b.points.length);
  for(const face of transformed) {
    const points=face.points.map(point=>project(point,radius));
    context.beginPath(); context.moveTo(points[0].x,points[0].y);
    for(const point of points.slice(1))context.lineTo(point.x,point.y);
    context.closePath(); context.fillStyle=face.color; context.fill(); context.strokeStyle='#163129';context.lineWidth=1;context.stroke();
  }
}
/** @param {number} width @param {number} height @param {number} depth @param {number} cy @returns {Face[]} */
function box(width,height,depth,cy) {
  const a={x:-width,y:cy-height,z:-depth},b={x:width,y:cy-height,z:-depth},c={x:width,y:cy+height,z:-depth},d={x:-width,y:cy+height,z:-depth};
  const e={x:-width,y:cy-height,z:depth},f={x:width,y:cy-height,z:depth},g={x:width,y:cy+height,z:depth},h={x:-width,y:cy+height,z:depth};
  return [{points:[a,b,c,d],color:'#473026'},{points:[a,b,f,e],color:'#37291f'},{points:[b,c,g,f],color:'#63482d'},{points:[c,d,h,g],color:'#3f2d22'},{points:[d,a,e,h],color:'#8a633c'},{points:[e,f,g,h],color:'#a16d3e'}];
}
/** @param {CanvasRenderingContext2D} context @param {import('./interaction-scene.js').SceneModel} model @param {ScenePose} pose @param {number} radius @param {HTMLImageElement|null} image @param {(context:CanvasRenderingContext2D,radius:number,angle:number)=>void} drawBomb @returns {void} */
export function drawSceneActor(context,model,pose,radius,image,drawBomb) {
  if(pose.opacity===0 || pose.scale===0)return;
  const perspective=600/(600-pose.z), size=radius*pose.scale*perspective;
  context.save();context.translate(pose.x,pose.y);context.globalAlpha=pose.opacity;
  if(model==='wallet') {
    drawFaces(context,box(1.15,0.6,0.24,0.15),pose,size);
    drawFaces(context,box(1.2,0.10,0.29,-0.48),pose,size);
  } else {
    const origin=project(transform({x:0,y:0,z:0},pose),size),x=project(transform({x:1,y:0,z:0},pose),size),y=project(transform({x:0,y:1,z:0},pose),size);
    context.transform((x.x-origin.x)/size,(x.y-origin.y)/size,(y.x-origin.x)/size,(y.y-origin.y)/size,origin.x,origin.y);
    if(model==='dollar') {
      context.fillStyle='#a9d99d';context.fillRect(-size*1.3,-size*0.6,size*2.6,size*1.2);
      context.strokeStyle='#326448';context.lineWidth=2;context.strokeRect(-size*1.16,-size*0.46,size*2.32,size*0.92);
      context.fillStyle='#245738';context.font=`bold ${size}px Georgia,serif`;context.textAlign='center';context.textBaseline='middle';context.fillText('$',0,1);
    } else if(model==='thumbnail') {if(image?.complete && image.naturalWidth>0)context.drawImage(image,-size,-size,size*2,size*2);}
    else if(model==='bomb')drawBomb(context,size,pose.rotateY*Math.PI/180);
    else {context.font=`${size*2}px "Segoe UI Emoji",sans-serif`;context.textAlign='center';context.textBaseline='middle';context.fillText(model==='fist'?'👊':'💩',0,0);}
  }
  context.restore();
}
