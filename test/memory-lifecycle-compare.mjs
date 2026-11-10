// @ts-check
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
/** @typedef {import('../public/js/network-protocol.js').JsonValue} JsonValue */
/** @typedef {{stage:string,values:Record<string,number>}} Stage */
/** @typedef {{round:number,activeMedianMiB:number,idleMedianMiB:number,dropMiB:number,popupPid:number,popupActivePrivateMiB:number,popupIdlePrivateMiB:number|null,popupAbsentAtIdle:boolean}} PopupLifecycle */
/** @typedef {{sha256:string,mime:string,width:number,height:number,bytes:number}} Scene */
/** @typedef {{file:string,rounds:number,stages:Stage[],switchLatencyMedianMs:number,popupLifecycle:PopupLifecycle[],scenes:Scene[]}} Report */
const fields=['privateCommittedMiBMedian','processCountMedian','popupWindowCountMedian','jsHeapUsedMiBMedian','jsHeapTotalMiBMedian','documentsMedian','nodesMedian','listenersMedian','eventLoopRoundTripMedianMs'];
/** @param {JsonValue|undefined} value @returns {{[key:string]:JsonValue}} */
function object(value){assert(value&&typeof value==='object'&&!Array.isArray(value));return value;}
/** @param {JsonValue|undefined} value @returns {number} */
function number(value){assert.equal(typeof value,'number');assert(Number.isFinite(value));return Number(value);}
/** @param {JsonValue|undefined} value @returns {string} */
function string(value){assert.equal(typeof value,'string');return String(value);}
/** @param {JsonValue|undefined} value @returns {{[key:string]:JsonValue}[]} */
function rows(value){assert(Array.isArray(value));return value.map(object);}
/** @param {number[]} values @returns {number} */
function median(values){assert(values.length>0);const sorted=[...values].sort((left,right)=>left-right),index=Math.floor(sorted.length/2);return sorted.length%2===0?(sorted[index-1]+sorted[index])/2:sorted[index];}
/** @param {{[key:string]:JsonValue}} run @returns {PopupLifecycle} */
function popupLifecycle(run){
 const snapshots=rows(run.snapshots),before=snapshots.filter(row=>row.stage==='images-and-20-private-switches'),active=snapshots.filter(row=>row.stage==='active-popup'),idle=snapshots.filter(row=>row.stage==='popup-idle-35s');assert(before.length>0&&active.length>0&&idle.length>0);
 const previousPids=new Set(rows(before[before.length-1].processes).map(row=>number(row.pid)));
 const newcomers=rows(active[0].processes).filter(row=>!previousPids.has(number(row.pid)));assert.equal(newcomers.length,1,'Popup attribution requires exactly one new PID after the image-only stage');
 const popupPid=number(newcomers[0].pid),activeMedianMiB=median(active.map(row=>number(row.privateCommittedBytes)))/1048576,idleMedianMiB=median(idle.map(row=>number(row.privateCommittedBytes)))/1048576;
 const activePopupRows=active.flatMap(snapshot=>rows(snapshot.processes).filter(row=>number(row.pid)===popupPid)),idlePopupRows=idle.flatMap(snapshot=>rows(snapshot.processes).filter(row=>number(row.pid)===popupPid));assert.equal(activePopupRows.length,active.length);assert(idlePopupRows.length===0||idlePopupRows.length===idle.length);
 return {round:number(run.round),activeMedianMiB,idleMedianMiB,dropMiB:activeMedianMiB-idleMedianMiB,popupPid,popupActivePrivateMiB:median(activePopupRows.map(row=>number(row.privateCommittedBytes)))/1048576,popupIdlePrivateMiB:idlePopupRows.length===0?null:median(idlePopupRows.map(row=>number(row.privateCommittedBytes)))/1048576,popupAbsentAtIdle:idlePopupRows.length===0};
}
/** @param {{[key:string]:JsonValue}} run @returns {Scene} */
function scene(run){const evidence=rows(run.sceneEvidence);assert.equal(evidence.length,1);const value=object(evidence[0].rendered);return {sha256:string(value.sha256),mime:string(value.mime),width:number(value.width),height:number(value.height),bytes:number(value.bytes)};}
/** @param {string} file @returns {Report} */
function read(file){
 /** @type {JsonValue} */const raw=JSON.parse(fs.readFileSync(file,'utf8'));const report=object(raw);assert(Array.isArray(report.summary));
 const stages=report.summary.map(value=>{const row=object(value);return {stage:string(row.stage),values:Object.fromEntries(fields.map(field=>[field,number(row[field])]))};});
 assert.equal(new Set(stages.map(stage=>stage.stage)).size,stages.length);
 return {file:path.resolve(file),rounds:number(report.rounds),stages,switchLatencyMedianMs:number(report.switchLatencyMedianMs),popupLifecycle:rows(report.results).map(popupLifecycle),scenes:rows(report.results).map(scene)};
}
const args=process.argv.slice(2);assert(args.length>=3&&(args.length-1)%2===0,'Usage: node test/memory-lifecycle-compare.mjs OUTPUT.json BASELINE1/report.json OPTIMIZED1/report.json [BASELINE2/report.json OPTIMIZED2/report.json ...]');
const output=path.resolve(args[0]);
const baseline=args.slice(1).filter((_file,index)=>index%2===0).map(read),optimized=args.slice(1).filter((_file,index)=>index%2===1).map(read);
assert.equal(baseline.length,optimized.length);
const stages=baseline[0].stages.map(stage=>stage.stage);
for(const report of [...baseline,...optimized])assert.deepEqual(report.stages.map(stage=>stage.stage),stages,'Reports must measure identical stage order');
for(const report of [...baseline,...optimized])for(const measured of report.scenes)assert.deepEqual(measured,baseline[0].scenes[0],'Every compared run must upload and display the identical animation hash, MIME, dimensions and bytes');
/** @param {number[]} before @param {number[]} after @returns {{baselineMedian:number,optimizedMedian:number,delta:number,changePercent:number|null,baselineRange:number[],optimizedRange:number[]}} */
function comparison(before,after){const baselineMedian=median(before),optimizedMedian=median(after),delta=optimizedMedian-baselineMedian;return {baselineMedian,optimizedMedian,delta,changePercent:baselineMedian===0?null:100*delta/baselineMedian,baselineRange:[Math.min(...before),Math.max(...before)],optimizedRange:[Math.min(...after),Math.max(...after)]};}
const result={verifiedScene:baseline[0].scenes[0],sceneVerifiedRuns:[...baseline,...optimized].reduce((total,report)=>total+report.scenes.length,0),definition:'Median of per-run stage medians. Ranges are per-run medians. Private committed memory is not RSS. Supply chronological baseline/optimized pairs to record alternating runs.',baselineFiles:baseline.map(report=>report.file),optimizedFiles:optimized.map(report=>report.file),baselineRounds:baseline.reduce((total,report)=>total+report.rounds,0),optimizedRounds:optimized.reduce((total,report)=>total+report.rounds,0),stages:stages.map((stage,index)=>({stage,metrics:Object.fromEntries(fields.map(field=>[field,comparison(baseline.map(report=>report.stages[index].values[field]),optimized.map(report=>report.stages[index].values[field]))]))})),privateSwitchLatencyMedianMs:comparison(baseline.map(report=>report.switchLatencyMedianMs),optimized.map(report=>report.switchLatencyMedianMs)),popupAttribution:'Exactly one new descendant PID between the last image-only sample and first active-popup sample; presence checked in every active and idle snapshot.',popupLifecycle:{baseline:baseline.map(report=>({file:report.file,runs:report.popupLifecycle})),optimized:optimized.map(report=>({file:report.file,runs:report.popupLifecycle}))}};
fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,JSON.stringify(result,null,2));
console.log(JSON.stringify(result,null,2));
