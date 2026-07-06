/** Encode decoded PCM as a 16-bit WAV blob.
 *
 * Playback goes through a plain media element fed with THIS wav — built from
 * the exact same decoded buffer the waveform/spectrogram are drawn from, so
 * display and sound can never drift apart (FIXES.md #7), and we no longer
 * depend on WebKit's flaky WebAudio playback path (FIXES.md #13). */

export interface PcmSource {
  numberOfChannels: number;
  sampleRate: number;
  length: number;
  getChannelData(channel: number): Float32Array;
}

export function pcmToWavBlob(buffer: PcmSource): Blob {
  const channels = buffer.numberOfChannels;
  const blockAlign = channels * 2; // 16-bit
  const dataSize = buffer.length * blockAlign;
  const ab = new ArrayBuffer(44 + dataSize);
  const view = new DataView(ab);

  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, buffer.sampleRate, true);
  view.setUint32(28, buffer.sampleRate * blockAlign, true); // byte rate
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true); // bits per sample
  ascii(36, "data");
  view.setUint32(40, dataSize, true);

  const chans: Float32Array[] = [];
  for (let c = 0; c < channels; c++) chans.push(buffer.getChannelData(c));
  let offset = 44;
  for (let i = 0; i < buffer.length; i++) {
    for (let c = 0; c < channels; c++) {
      const v = Math.max(-1, Math.min(1, chans[c][i]));
      view.setInt16(offset, Math.round(v * 32767), true);
      offset += 2;
    }
  }
  return new Blob([ab], { type: "audio/wav" });
}
