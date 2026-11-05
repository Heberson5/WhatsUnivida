/**
 * Joins the pieces of one voice recording into a single file — a recording kept as a draft and then continued
 * (WhatsApp-style) is two or more separate MediaRecorder outputs, and those can't simply be glued byte by byte.
 * Each piece is decoded by the browser, the samples are laid end to end and written out as a mono 16-bit WAV, which
 * the server then re-encodes (ffmpeg) into the same voice-note format as any other recording.
 */
export async function mergeAudioBlobs(pieces: Blob[]): Promise<Blob> {
  if (pieces.length === 1) return pieces[0];
  const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const context = new AudioCtx();
  try {
    const decoded = await Promise.all(pieces.map(async (piece) => context.decodeAudioData(await piece.arrayBuffer())));
    const sampleRate = decoded[0]?.sampleRate ?? context.sampleRate;
    return encodeWav(concatMono(decoded.map(toMono)), sampleRate);
  } finally {
    context.close().catch(() => undefined);
  }
}

/** A decoded piece as one channel (stereo mic input is averaged). */
function toMono(buffer: AudioBuffer): Float32Array {
  if (buffer.numberOfChannels === 1) return buffer.getChannelData(0);
  const out = new Float32Array(buffer.length);
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < data.length; i++) out[i] += data[i] / buffer.numberOfChannels;
  }
  return out;
}

export function concatMono(parts: Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((sum, p) => sum + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** PCM samples (-1..1) → a mono 16-bit WAV file. */
export function encodeWav(samples: Float32Array, sampleRate: number): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const writeText = (offset: number, text: string) => [...text].forEach((ch, i) => view.setUint8(offset + i, ch.charCodeAt(0)));
  writeText(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeText(8, "WAVE");
  writeText(12, "fmt ");
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeText(36, "data");
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buffer], { type: "audio/wav" });
}
