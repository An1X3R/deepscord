// @ts-check

/** @typedef {{id:string,type:string,timestamp:number,mid?:string,kind?:string,mediaType?:string,selectedCandidatePairId?:string,localCandidateId?:string,remoteCandidateId?:string,candidateType?:string,currentRoundTripTime?:number,bytesSent?:number,bytesReceived?:number,jitter?:number,jitterBufferDelay?:number,jitterBufferEmittedCount?:number,packetsReceived?:number,packetsLost?:number,concealedSamples?:number,totalSamplesReceived?:number,codecId?:string,mimeType?:string,clockRate?:number}} StatsEntry */
/** @typedef {{route:'pending'|'direct'|'relay',roundTripMs:number|null,bytesSent:number|null,bytesReceived:number|null,localCandidate:string|null,remoteCandidate:string|null,inboundAudioId:string|null,jitterMs:number|null,jitterBufferMs:number|null,packetsLostDelta:number|null,packetsReceivedDelta:number|null,packetLossRatio:number|null,concealedSamplesRatio:number|null,codecMimeType:string|null,codecClockRate:number|null}} LinkStats */

/** @param {number|undefined} value @returns {number|null} */
function finite(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** @param {number|undefined} value @returns {number|null} */
function nonnegative(value) {
  const result = finite(value);
  return result !== null && result >= 0 ? result : null;
}

/** @param {number|undefined} current @param {number|undefined} previous @returns {number|null} */
function increment(current, previous) {
  const end = nonnegative(current);
  const start = nonnegative(previous);
  return end !== null && start !== null && end >= start ? end - start : null;
}

/** @param {number|null} numerator @param {number|null} denominator @returns {number|null} */
function ratio(numerator, denominator) {
  return numerator !== null && denominator !== null && denominator > 0 ? numerator / denominator : null;
}

/** @param {ReadonlyArray<Readonly<StatsEntry>>} entries @param {ReadonlyArray<Readonly<StatsEntry>>} previous @returns {LinkStats} */
export function summarizePeerStats(entries, previous) {
  const transport = entries.find((entry) => entry.type === 'transport' && typeof entry.selectedCandidatePairId === 'string');
  const pair = entries.find((entry) => entry.type === 'candidate-pair' && entry.id === transport?.selectedCandidatePairId);
  const local = pair ? entries.find((entry) => entry.type === 'local-candidate' && entry.id === pair.localCandidateId) : undefined;
  const remote = pair ? entries.find((entry) => entry.type === 'remote-candidate' && entry.id === pair.remoteCandidateId) : undefined;
  const inboundAudio = entries.filter((entry) => entry.type === 'inbound-rtp' && (entry.kind === 'audio' || entry.mediaType === 'audio'));
  const audio = inboundAudio.find((entry) => entry.mid === '0') ?? (inboundAudio.every((entry) => entry.mid === undefined) ? inboundAudio[0] : undefined);
  const before = audio ? previous.find((entry) => entry.id === audio.id && entry.type === audio.type && entry.timestamp < audio.timestamp) : undefined;
  const codec = audio ? entries.find((entry) => entry.type === 'codec' && entry.id === audio.codecId) : undefined;
  const emitted = increment(audio?.jitterBufferEmittedCount, before?.jitterBufferEmittedCount);
  const bufferDelay = increment(audio?.jitterBufferDelay, before?.jitterBufferDelay);
  const lost = increment(audio?.packetsLost, before?.packetsLost);
  const received = increment(audio?.packetsReceived, before?.packetsReceived);
  const concealed = increment(audio?.concealedSamples, before?.concealedSamples);
  const samples = increment(audio?.totalSamplesReceived, before?.totalSamplesReceived);
  const bufferSeconds = ratio(bufferDelay, emitted);
  const rtt = nonnegative(pair?.currentRoundTripTime);
  const jitter = nonnegative(audio?.jitter);
  return {
    route: !pair || !local || !remote ? 'pending' : local.candidateType === 'relay' || remote.candidateType === 'relay' ? 'relay' : 'direct',
    roundTripMs: rtt === null ? null : Math.round(rtt * 1000),
    bytesSent: nonnegative(pair?.bytesSent),
    bytesReceived: nonnegative(pair?.bytesReceived),
    localCandidate: typeof local?.candidateType === 'string' ? local.candidateType : null,
    remoteCandidate: typeof remote?.candidateType === 'string' ? remote.candidateType : null,
    inboundAudioId: audio?.id ?? null,
    jitterMs: jitter === null ? null : jitter * 1000,
    jitterBufferMs: bufferSeconds === null ? null : bufferSeconds * 1000,
    packetsLostDelta: lost,
    packetsReceivedDelta: received,
    packetLossRatio: ratio(lost, lost !== null && received !== null ? lost + received : null),
    concealedSamplesRatio: ratio(concealed, samples),
    codecMimeType: typeof codec?.mimeType === 'string' ? codec.mimeType : null,
    codecClockRate: nonnegative(codec?.clockRate),
  };
}
