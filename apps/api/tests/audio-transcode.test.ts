import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
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
