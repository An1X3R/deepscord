// @ts-check

import { parseScreenPreferences } from './screen-preferences.js';

/** @typedef {import('./network-protocol.js').JsonValue} JsonValue */
/** @typedef {import('./network-protocol.js').JsonObject} JsonObject */
/** @typedef {{video:HTMLVideoElement,local:boolean}} DiagnosticPreview */
/** @typedef {{readable:ReadableStream<VideoFrame>}} TrackProcessor */
/** @typedef {{reports:RTCStatsReport[],unsupported:number}} DiagnosticRtpReports */
/** @typedef {{capture:MediaStream|null,previews:DiagnosticPreview[],getReports:()=>Promise<DiagnosticRtpReports>,preferences:import('./screen-preferences.js').ScreenPreferences|null}} DiagnosticOptions */
/** @typedef {{id:string,type:string,timestamp?:number,mediaSourceId?:string,transportId?:string,remoteId?:string,selectedCandidatePairId?:string,frames?:number,width?:number,height?:number,framesSent?:number,packetsSent?:number,packetsReceived?:number,packetsLost?:number,jitter?:number,nackCount?:number,pliCount?:number,firCount?:number,roundTripTime?:number,currentRoundTripTime?:number,availableOutgoingBitrate?:number,availableIncomingBitrate?:number,targetBitrate?:number,qualityLimitationReason?:string,qualityLimitationDurations?:{none?:number,cpu?:number,bandwidth?:number,other?:number},kind?:string,mediaType?:string,codecId?:string,mimeType?:string,bytesSent?:number,bytesReceived?:number,framesEncoded?:number,framesDecoded?:number,framesDropped?:number,framesPerSecond?:number,frameWidth?:number,frameHeight?:number,totalEncodeTime?:number,totalDecodeTime?:number,encoderImplementation?:string,decoderImplementation?:string,powerEfficientEncoder?:boolean,powerEfficientDecoder?:boolean}} RtpStat */
/** @typedef {{status:'saved'|'cancelled'}} ExportResult */

/** @param {number} milliseconds @returns {Promise<void>} */
function delay(milliseconds) { return new Promise(resolve => setTimeout(resolve, milliseconds)); }
/** @param {JsonValue|undefined} value @param {string} field @returns {JsonObject} */
function object(value, field) { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid screen diagnostic object: ' + field); return value; }
/** @param {JsonValue|undefined} value @param {string} field @returns {number|null} */
function number(value, field) { if (value === null) return null; if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new TypeError('Invalid screen diagnostic number: ' + field); return value; }
/** @param {JsonValue|undefined} value @param {string} field @returns {boolean|null} */
function boolean(value, field) { if (value === null) return null; if (typeof value !== 'boolean') throw new TypeError('Invalid screen diagnostic boolean: ' + field); return value; }
/** @param {JsonValue|undefined} value @param {string[]} allowed @param {string} field @returns {string} */
function choice(value, allowed, field) { if (typeof value !== 'string' || !allowed.includes(value)) throw new TypeError('Invalid screen diagnostic value: ' + field); return value; }
/** @param {JsonValue|undefined} value @param {string} field @returns {string|null} */
function implementation(value, field) { if (value === null) return null; if (typeof value !== 'string' || !/^[A-Za-z0-9_ .()+/:-]{1,160}$/.test(value)) throw new TypeError('Invalid screen diagnostic implementation: ' + field); return value; }
/** @param {JsonValue|undefined} value @param {number} limit @param {string} field @returns {JsonValue[]} */
function array(value, limit, field) { if (!Array.isArray(value) || value.length > limit) throw new RangeError('Invalid screen diagnostic array: ' + field); return value; }

/** @param {JsonValue|undefined} value @param {string} field @returns {number|null} */
function signedInteger(value, field) { if (value === null) return null; if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new TypeError('Invalid screen diagnostic integer: ' + field); return value; }
/** @param {JsonValue|undefined} value @param {string} field @returns {number|null} */
function count(value, field) { const result = signedInteger(value, field); if (result !== null && result < 0) throw new RangeError('Invalid screen diagnostic counter: ' + field); return result; }
/** @param {JsonValue|undefined} value @param {string} field @returns {string} */
function utc(value, field) { if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw new TypeError('Invalid screen diagnostic UTC time: ' + field); return value; }
/** @param {JsonValue|undefined} value @returns {JsonObject|null} */
function limitationDurations(value) {
  if (value === null) return null;
  const input = object(value, 'quality limitation durations');
  /** @type {JsonObject} */ const output = {};
  for (const key of ['none', 'cpu', 'bandwidth', 'other']) output[key] = number(input[key], key);
  return output;
}

/** Validate and strip all fields outside the diagnostic allowlist before saving. @param {JsonValue} input @returns {JsonObject} */
export function parseScreenDiagnosticReport(input) {
  const report = object(input, 'report');
  if (report.schemaVersion !== 1 && report.schemaVersion !== 2) throw new TypeError('Unsupported screen diagnostic schema');
  const capture = object(report.capture, 'capture');
  const previews = array(report.previews, 100, 'previews').map(value => {
    const row = object(value, 'preview');
    return { role: choice(row.role, ['local', 'remote'], 'preview role'), frameCallbacks: choice(row.frameCallbacks, ['supported', 'unsupported'], 'frame callbacks') };
  });
  const samples = array(report.samples, 6, 'samples').map(value => {
    const row = object(value, 'sample'), captured = object(row.capture, 'capture sample');
    const videos = array(row.videos, 100, 'videos').map(value => {
      const video = object(value, 'video'), result = { };
      /** @type {JsonObject} */ const output = result;
      for (const key of ['frames', 'dropped', 'time', 'width', 'height', 'callbacks', 'readyState']) output[key] = number(video[key], key);
      for (const key of ['paused', 'ended', 'connected', 'hidden']) output[key] = boolean(video[key], key);
      return output;
    });
    if (videos.length !== previews.length) throw new TypeError('Screen diagnostic preview samples do not match their inventory');
    const rtp = array(row.rtp, 300, 'rtp').map(value => {
      const item = object(value, 'RTP'), output = { direction: choice(item.direction, ['send', 'receive'], 'RTP direction') };
      /** @type {JsonObject} */ const result = output;
      for (const key of ['stream', 'bytes', 'frames', 'dropped', 'width', 'height']) result[key] = count(item[key], key);
      for (const key of ['fps', 'totalCodecTimeSeconds']) result[key] = number(item[key], key);
      for (const key of ['encoderImplementation', 'decoderImplementation', 'codec']) result[key] = implementation(item[key], key);
      for (const key of ['powerEfficientEncoder', 'powerEfficientDecoder']) result[key] = boolean(item[key], key);
      if (report.schemaVersion === 2) {
        for (const key of ['timestampMs', 'sourceTimestampMs', 'remoteTimestampMs', 'candidatePairTimestampMs', 'sourceFps', 'targetBitrate', 'jitterSeconds', 'roundTripTimeSeconds', 'candidatePairRoundTripTimeSeconds', 'availableOutgoingBitrate', 'availableIncomingBitrate']) result[key] = number(item[key], key);
        for (const key of ['sourceFrames', 'sourceWidth', 'sourceHeight', 'framesSent', 'packetsSent', 'packetsReceived', 'nackCount', 'pliCount', 'firCount']) result[key] = count(item[key], key);
        result.packetsLost = signedInteger(item.packetsLost, 'packetsLost');
        result.qualityLimitationReason = item.qualityLimitationReason === null ? null : choice(item.qualityLimitationReason, ['none', 'cpu', 'bandwidth', 'other'], 'quality limitation reason');
        result.qualityLimitationDurations = limitationDurations(item.qualityLimitationDurations);
      }
      return result;
    });
    return { ...(report.schemaVersion === 2 ? { timestampUtc: utc(row.timestampUtc, 'sample timestampUtc') } : {}), elapsedMs: number(row.elapsedMs, 'elapsedMs'), capture: { frames: count(captured.frames, 'capture frames'), ended: boolean(captured.ended, 'capture ended') }, visibility: choice(row.visibility, ['visible', 'hidden'], 'visibility'), videos, rtp, unsupportedRtpReports: count(row.unsupportedRtpReports, 'unsupported RTP reports') };
  });
  if (samples.length !== 5) throw new TypeError('Screen diagnostic requires five samples over four seconds');
  /** @type {JsonObject} */ const metadata = {};
  if (report.schemaVersion === 2) {
    metadata.startedAtUtc = utc(report.startedAtUtc, 'startedAtUtc');
    metadata.preferences = report.preferences === null ? null : { ...parseScreenPreferences(object(report.preferences, 'preferences')) };
    const frameCounterMethod = choice(capture.frameCounterMethod, ['track-processor-clone', 'none'], 'capture frame counter method');
    const observerStatus = choice(capture.observerStatus, ['frames-observed', 'no-frames-observed', 'unsupported', 'not-applicable'], 'capture observer status');
    const status = choice(capture.status, ['supported', 'unsupported', 'not-applicable'], 'capture status');
    if (status === 'supported') {
      if (frameCounterMethod !== 'track-processor-clone' || (observerStatus !== 'frames-observed' && observerStatus !== 'no-frames-observed')) throw new TypeError('Screen diagnostic clone observer metadata does not match its capability');
      const observed = samples.map(sample => sample.capture.frames);
      if (observed.some(value => value === null) || (observerStatus === 'frames-observed') !== observed.some(value => typeof value === 'number' && value > 0)) throw new TypeError('Screen diagnostic clone observer status does not match its counters');
    } else if (frameCounterMethod !== 'none' || observerStatus !== status || samples.some(sample => sample.capture.frames !== null)) throw new TypeError('Screen diagnostic unavailable observer must have null counters and matching status');
    metadata.capture = { frameCounterMethod, observerStatus, contentHint: capture.contentHint === null ? null : choice(capture.contentHint, ['', 'motion', 'detail', 'text'], 'capture contentHint'), displaySurface: capture.displaySurface === null ? null : choice(capture.displaySurface, ['monitor', 'window', 'browser'], 'capture displaySurface'), aspectRatio: number(capture.aspectRatio, 'capture aspectRatio'), resizeMode: capture.resizeMode === null ? null : choice(capture.resizeMode, ['none', 'crop-and-scale'], 'capture resizeMode') };
  }
  return { schemaVersion: report.schemaVersion, ...metadata, durationMs: number(report.durationMs, 'durationMs'), capture: { ...(metadata.capture ? object(metadata.capture, 'capture metadata') : {}), status: choice(capture.status, ['supported', 'unsupported', 'not-applicable'], 'capture status'), width: number(capture.width, 'capture width'), height: number(capture.height, 'capture height'), frameRate: number(capture.frameRate, 'capture frameRate') }, previews, samples };
}

/** @param {import('./screen-relay.js').ScreenRelay|import('./screen-sfu.js').ScreenSfu} transport @returns {Promise<DiagnosticRtpReports>} */
export async function getScreenDiagnosticReports(transport) {
  if ('edges' in transport) return { reports: await Promise.all([...transport.edges.values()].map(edge => edge.link.pc.getStats())), unsupported: 0 };
  const connections = [...transport.watchers.values(), ...(transport.publisher ? [transport.publisher] : [])];
  const tracks = connections.flatMap(connection => [connection.room.localParticipant, ...connection.room.remoteParticipants.values()].flatMap(participant => [...participant.videoTrackPublications.values()].flatMap(publication => publication.track ? [publication.track] : [])));
  const values = await Promise.all(tracks.map(track => track.getRTCStatsReport()));
  return { reports: values.filter(value => value !== undefined), unsupported: values.filter(value => value === undefined).length };
}
/** @param {RTCStatsReport} report @param {string|undefined} id @returns {RtpStat|undefined} */
function statReference(report, id) { return id ? /** @type {RtpStat|undefined} */ (report.get(id)) : undefined; }
/** @param {RTCStatsReport[]} reports @param {Map<string,number>} streams @returns {JsonObject[]} */
function rtpRows(reports, streams) {
  /** @type {JsonObject[]} */ const rows = [];
  reports.forEach((report, reportIndex) => report.forEach(/** @param {RtpStat} item */ item => {
    if ((item.type !== 'outbound-rtp' && item.type !== 'inbound-rtp') || (item.kind ?? item.mediaType) !== 'video') return;
    const codec = statReference(report, item.codecId);
    const send = item.type === 'outbound-rtp';
    const source = statReference(report, item.mediaSourceId);
    const remote = statReference(report, item.remoteId);
    const transport = statReference(report, item.transportId);
    const pair = statReference(report, transport?.selectedCandidatePairId);
    const received = send ? remote : item;
    const key = reportIndex + ':' + item.id;
    if (!streams.has(key)) streams.set(key, streams.size);
    rows.push({ stream: streams.get(key) ?? null, direction: send ? 'send' : 'receive', timestampMs: item.timestamp ?? null, bytes: (send ? item.bytesSent : item.bytesReceived) ?? null, frames: (send ? item.framesEncoded : item.framesDecoded) ?? null, dropped: item.framesDropped ?? null, fps: item.framesPerSecond ?? null, width: item.frameWidth ?? null, height: item.frameHeight ?? null, totalCodecTimeSeconds: (send ? item.totalEncodeTime : item.totalDecodeTime) ?? null, encoderImplementation: item.encoderImplementation ?? null, decoderImplementation: item.decoderImplementation ?? null, powerEfficientEncoder: item.powerEfficientEncoder ?? null, powerEfficientDecoder: item.powerEfficientDecoder ?? null, codec: codec?.mimeType ?? null,
      sourceTimestampMs: source?.timestamp ?? null, sourceFps: source?.framesPerSecond ?? null, sourceFrames: source?.frames ?? null, sourceWidth: source?.width ?? null, sourceHeight: source?.height ?? null, targetBitrate: item.targetBitrate ?? null, framesSent: item.framesSent ?? null, packetsSent: item.packetsSent ?? null, packetsReceived: received?.packetsReceived ?? null, packetsLost: received?.packetsLost ?? null, jitterSeconds: received?.jitter ?? null, nackCount: item.nackCount ?? null, pliCount: item.pliCount ?? null, firCount: item.firCount ?? null, remoteTimestampMs: remote?.timestamp ?? null, roundTripTimeSeconds: remote?.roundTripTime ?? null,
      qualityLimitationReason: item.qualityLimitationReason ?? null, qualityLimitationDurations: item.qualityLimitationDurations ? { none: item.qualityLimitationDurations.none ?? null, cpu: item.qualityLimitationDurations.cpu ?? null, bandwidth: item.qualityLimitationDurations.bandwidth ?? null, other: item.qualityLimitationDurations.other ?? null } : null,
      candidatePairTimestampMs: pair?.timestamp ?? null, candidatePairRoundTripTimeSeconds: pair?.currentRoundTripTime ?? null, availableOutgoingBitrate: pair?.availableOutgoingBitrate ?? null, availableIncomingBitrate: pair?.availableIncomingBitrate ?? null });
  }));
  return rows;
}

/** Sample counters only; temporary tracks and callbacks never outlive this operation. @param {DiagnosticOptions} options @returns {Promise<JsonObject>} */
export async function collectScreenDiagnostics(options) {
  const startedAtUtc = new Date().toISOString();
  const started = performance.now(), track = options.capture?.getVideoTracks()[0];
  const Processor = /** @type {Window & {MediaStreamTrackProcessor?:new(options:{track:MediaStreamTrack})=>TrackProcessor}} */ (window).MediaStreamTrackProcessor;
  /** @type {MediaStreamTrack|null} */ let clone = null;
  /** @type {ReadableStreamDefaultReader<VideoFrame>|null} */ let reader = null;
  /** @type {Promise<void>|null} */ let reading = null;
  /** @type {Error|null} */ let readError = null;
  let frames = 0, stopping = false;
  const counters = options.previews.map(() => ({ count: 0, request: 0 }));
  /** @type {Map<string,number>} */ const streams = new Map();
  try {
    if (track && Processor) {
      if (track.readyState !== 'live') throw new DOMException('屏幕诊断无法采样：本地采集已结束', 'InvalidStateError');
      clone = track.clone(); reader = new Processor({ track: clone }).readable.getReader();
      const activeReader = reader;
      reading = (async () => { while (!stopping) { const next = await activeReader.read(); if (next.done) return; frames += 1; next.value.close(); } })().catch(error => { readError = error instanceof Error ? error : new TypeError('Screen frame reader rejected with a non-error'); });
    }
    options.previews.forEach((preview, index) => {
      if (typeof preview.video.requestVideoFrameCallback !== 'function') return;
      /** @param {number} _now @param {VideoFrameCallbackMetadata} _metadata @returns {void} */
      const presented = (_now, _metadata) => { counters[index].count += 1; if (!stopping) counters[index].request = preview.video.requestVideoFrameCallback(presented); };
      counters[index].request = preview.video.requestVideoFrameCallback(presented);
    });
    /** @type {JsonObject[]} */ const samples = [];
    for (let index = 0; index < 5; index += 1) {
      if (readError) throw readError;
      const rtp = await options.getReports();
      samples.push({ timestampUtc: new Date().toISOString(), elapsedMs: performance.now() - started, capture: { frames: track && Processor ? frames : null, ended: track ? track.readyState === 'ended' : null }, visibility: document.visibilityState, videos: options.previews.map((preview, index) => {
        const video = preview.video, quality = video.getVideoPlaybackQuality();
        return { frames: quality.totalVideoFrames, dropped: quality.droppedVideoFrames, time: video.currentTime, width: video.videoWidth, height: video.videoHeight, callbacks: typeof video.requestVideoFrameCallback === 'function' ? counters[index].count : null, readyState: video.readyState, paused: video.paused, ended: video.ended, connected: video.isConnected, hidden: video.hidden };
      }), rtp: rtpRows(rtp.reports, streams), unsupportedRtpReports: rtp.unsupported });
      if (index < 4) await delay(1000);
    }
    const settings = track?.getSettings();
    return parseScreenDiagnosticReport({ schemaVersion: 2, startedAtUtc, preferences: options.preferences ? { ...options.preferences } : null, durationMs: performance.now() - started, capture: { frameCounterMethod: track && Processor ? 'track-processor-clone' : 'none', observerStatus: track ? Processor ? frames > 0 ? 'frames-observed' : 'no-frames-observed' : 'unsupported' : 'not-applicable', status: track ? Processor ? 'supported' : 'unsupported' : 'not-applicable', width: settings?.width ?? null, height: settings?.height ?? null, frameRate: settings?.frameRate ?? null, contentHint: track?.contentHint ?? null, displaySurface: settings?.displaySurface ?? null, aspectRatio: settings?.aspectRatio ?? null, resizeMode: /** @type {MediaTrackSettings & {resizeMode?:string}|undefined} */ (settings)?.resizeMode ?? null }, previews: options.previews.map(preview => ({ role: preview.local ? 'local' : 'remote', frameCallbacks: typeof preview.video.requestVideoFrameCallback === 'function' ? 'supported' : 'unsupported' })), samples });
  } finally {
    stopping = true;
    options.previews.forEach((preview, index) => { if (counters[index].request) preview.video.cancelVideoFrameCallback(counters[index].request); });
    try { if (reader) await reader.cancel(); if (reading) await reading; }
    finally { clone?.stop(); }
    if (readError) throw readError;
  }
}

/** @param {DiagnosticOptions} options @returns {Promise<ExportResult>} */
export async function exportScreenDiagnostics(options) {
  const bridge = /** @type {Window & {deepscord?:{exportScreenDiagnostics?:(report:JsonObject)=>Promise<ExportResult>}}} */ (window).deepscord;
  if (typeof bridge?.exportScreenDiagnostics !== 'function') throw new DOMException('屏幕诊断导出需要支持此功能的 Windows 桌面客户端', 'NotSupportedError');
  return bridge.exportScreenDiagnostics(await collectScreenDiagnostics(options));
}
