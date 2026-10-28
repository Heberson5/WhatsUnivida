import { spawn } from "node:child_process";

/**
 * Transcodes an arbitrary audio buffer (whatever the browser's
 * MediaRecorder produced — typically WebM/Opus in Chrome/Edge, MP4/AAC in
 * Safari) into genuine OGG/Opus. WhatsApp's own clients only render the
 * native voice-note (PTT) waveform bubble for audio actually encoded this
 * way — sending the raw recorder output with an `audio/ogg` mimetype
 * slapped on it (without re-encoding) is what used to make a recorded
 * voice note show up on the customer's phone as a generic, unplayable
 * "web file" instead of a proper voice message, exactly like WhatsApp Web
 * itself avoids by doing the same conversion before sending.
 *
 * ffmpeg sniffs the real input format itself (it does not trust a file
 * extension or mimetype), so this works regardless of which container the
 * browser actually used.
 */
export function transcodeToOggOpus(input: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      "pipe:0",
      "-c:a",
      "libopus",
      "-f",
      "ogg",
      "pipe:1",
    ]);

    const chunks: Buffer[] = [];
    let stderr = "";
    ffmpeg.stdout.on("data", (chunk) => chunks.push(chunk));
    ffmpeg.stderr.on("data", (chunk) => (stderr += chunk.toString()));

    ffmpeg.on("error", (err) => {
      // ENOENT means the ffmpeg binary itself isn't installed on this host.
      reject(new Error(`failed to start ffmpeg: ${err.message}`));
    });

    ffmpeg.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`ffmpeg exited with code ${code}: ${stderr.trim()}`));
        return;
      }
      resolve(Buffer.concat(chunks));
    });

    ffmpeg.stdin.on("error", () => {
      // A malformed/empty input can make ffmpeg close stdin early — the
      // "close" handler above still fires with a non-zero code and reports
      // the real reason; swallow this one so it doesn't also crash as an
      // unhandled "write EPIPE" on the write() call below.
    });
    ffmpeg.stdin.write(input);
    ffmpeg.stdin.end();
  });
}
