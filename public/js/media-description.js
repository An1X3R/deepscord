// @ts-check

/** Preserve stereo on the independent music channel (RFC 7587). */
/** @param {RTCSessionDescriptionInit} description @returns {RTCSessionDescriptionInit} */
export function withStereoAccompaniment(description) {
  if (!description.sdp) throw new TypeError('Media negotiation returned an empty description');
  const sections = description.sdp.split(/(?=^m=)/m);
  let audioIndex = 0;
  const configured = sections.map((section) => {
    if (!section.startsWith('m=audio ')) return section;
    audioIndex += 1;
    if (audioIndex !== 2) return section;
    const payload = /^a=rtpmap:(\d+) opus\/48000\/2\r?$/mi.exec(section)?.[1];
    if (!payload) throw new TypeError('The accompaniment channel requires stereo Opus');
    const pattern = new RegExp(`^a=fmtp:${payload} ([^\\r\\n]*)`, 'm');
    const current = pattern.exec(section);
    const retained = (current?.[1] ?? '').split(';').map((value) => value.trim()).filter((value) => value && !/^(stereo|sprop-stereo|maxaveragebitrate)=/.test(value));
    const line = `a=fmtp:${payload} ${[...retained, 'stereo=1', 'sprop-stereo=1', 'maxaveragebitrate=128000'].join(';')}`;
    return current ? section.replace(pattern, line) : section + line + '\r\n';
  });
  if (audioIndex !== 2) throw new TypeError('Media negotiation requires separate microphone and accompaniment channels');
  return { type: description.type, sdp: configured.join('') };
}
