import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { transcodeToOggOpus } from "../src/lib/audio-transcode";

function makeSampleWebmOpus(): Buffer {
  // A tiny synthetic tone, encoded the same way a browser's MediaRecorder
  // would (Opus audio in a WebM container) — stands in for a real recorded
  // voice note without needing to ship a binary fixture.
  return execFileSync("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:duration=1",
    "-c:a",
    "libopus",
    "-f",
    "webm",
    "pipe:1",
  ]);
}

describe("transcodeToOggOpus", () => {
  it("converts a WebM/Opus recording (what browsers actually produce) into genuine OGG/Opus — the only encoding WhatsApp renders as a native voice-note bubble", async () => {
    const webm = makeSampleWebmOpus();
    const ogg = await transcodeToOggOpus(webm);

    // "OggS" is the Ogg container's own magic bytes — proves this is real
    // Ogg output, not the WebM input echoed back unchanged (which is
    // exactly the bug: sending raw recorder bytes under an "audio/ogg"
    // label without ever actually re-encoding them).
    expect(ogg.subarray(0, 4).toString("ascii")).toBe("OggS");
    expect(ogg.length).toBeGreaterThan(0);
  });

  it("sai como a nota de voz do próprio WhatsApp: mono, 16 kHz, cerca de 24 kbps, começando no zero", async () => {
    // A 2:24 stereo recording at 48 kHz, as a browser may hand it over (the note an iPhone could not download).
    const webm = execFileSync("ffmpeg", [
      "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=144",
      "-ac", "2", "-ar", "48000", "-c:a", "libopus", "-b:a", "96k", "-f", "webm", "pipe:1",
    ], { maxBuffer: 20_000_000 });
    const ogg = await transcodeToOggOpus(webm);
    const file = join(mkdtempSync(join(tmpdir(), "voz-")), "nota.ogg");
    writeFileSync(file, ogg);
    const probe = JSON.parse(execFileSync("ffprobe", ["-hide_banner", "-loglevel", "error", "-show_streams", "-show_format", "-of", "json", file]).toString());
    const stream = probe.streams[0];
    expect(stream).toMatchObject({ codec_name: "opus", channels: 1 });
    expect(Number(probe.format.start_time)).toBeGreaterThanOrEqual(0);
    expect(Number(probe.format.duration)).toBeCloseTo(144, 0);
    // About 24 kbps: well under the 1.2 MB the encoder's defaults gave.
    expect(ogg.length).toBeLessThan(600_000);
    // The rate the note was recorded at, kept in the Opus header (decoders play it at 48 kHz).
    expect(ogg.readUInt32LE(ogg.indexOf("OpusHead") + 12)).toBe(16000);
  });

  it("rejects input that isn't audio at all, instead of silently passing it through", async () => {
    await expect(transcodeToOggOpus(Buffer.from("not an audio file"))).rejects.toThrow();
  });

  it("the converted voice note gets WhatsApp's waveform bars — Baileys draws them only with audio-decode installed", async () => {
    // 1 s loud, then 1 s almost silent: the bars must follow the volume, not come out flat.
    const webm = execFileSync("ffmpeg", [
      "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
      "-af", "volume='if(lt(t,1),1,0.05)':eval=frame",
      "-c:a", "libopus", "-f", "webm", "pipe:1",
    ]);
    const ogg = await transcodeToOggOpus(webm);

    // The same call Baileys makes for a ptt message; without audio-decode it returns undefined and the
    // customer sees a straight line instead of the bars.
    const { getAudioWaveform } = await import("@whiskeysockets/baileys");
    const waveform = await getAudioWaveform(ogg);

    expect(waveform).toBeInstanceOf(Uint8Array);
    expect(waveform!.length).toBe(64);
    const loud = Math.min(...waveform!.slice(4, 28));
    const quiet = Math.max(...waveform!.slice(36, 60));
    expect(loud).toBeGreaterThan(quiet * 5);
  });
});
