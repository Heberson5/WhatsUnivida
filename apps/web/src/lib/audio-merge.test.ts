import { describe, it, expect } from "vitest";
import { concatMono, encodeWav } from "./audio-merge";

const readBytes = (blob: Blob) =>
  new Promise<DataView>((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new DataView(reader.result as ArrayBuffer));
    reader.readAsArrayBuffer(blob);
  });

describe("juntar os trechos de um áudio continuado", () => {
  it("os trechos ficam um depois do outro, na ordem", () => {
    expect(Array.from(concatMono([new Float32Array([0.1, 0.2]), new Float32Array([0.3])]))).toEqual([0.1, 0.2, 0.3].map(Math.fround));
  });

  it("gera um WAV mono de 16 bits válido, com a duração certa", async () => {
    const samples = new Float32Array(16000); // 1 s at 16 kHz
    samples[0] = 1;
    samples[1] = -1;
    const wav = encodeWav(samples, 16000);
    expect(wav.type).toBe("audio/wav");
    expect(wav.size).toBe(44 + 16000 * 2);
    const view = await readBytes(wav);
    const text = (at: number) => String.fromCharCode(...[0, 1, 2, 3].map((i) => view.getUint8(at + i)));
    expect(text(0)).toBe("RIFF");
    expect(text(8)).toBe("WAVE");
    expect(view.getUint16(22, true)).toBe(1); // mono
    expect(view.getUint32(24, true)).toBe(16000);
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.getInt16(44, true)).toBe(0x7fff);
    expect(view.getInt16(46, true)).toBe(-0x8000);
  });
});
