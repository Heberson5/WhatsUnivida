import { useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { Pause, Play } from "lucide-react";
import { api } from "../../lib/api";

const SPEEDS = [1, 1.5, 2] as const;

export function formatAudioTime(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** A recorded audio of the chat interno: bars, play/pause, 1×/1,5×/2×. The file needs the login token, so it's fetched as a blob. */
export function ChatAudioPlayer({ url, durationMs, waveform, mine }: { url: string; durationMs: number; waveform: number[]; mine: boolean }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [src, setSrc] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>(1);
  const bars = waveform.length ? waveform : Array.from({ length: 32 }, (_, i) => 30 + ((i * 37) % 50));

  useEffect(() => () => {
    if (src) URL.revokeObjectURL(src);
  }, [src]);

  async function toggle() {
    if (!audioRef.current) {
      const res = await api.get<Blob>(url, { responseType: "blob" });
      const objectUrl = URL.createObjectURL(res.data);
      setSrc(objectUrl);
      const audio = new Audio(objectUrl);
      audio.playbackRate = speed;
      audio.ontimeupdate = () => setProgress(audio.duration ? audio.currentTime / audio.duration : 0);
      audio.onended = () => {
        setPlaying(false);
        setProgress(0);
      };
      audioRef.current = audio;
    }
    const audio = audioRef.current;
    if (playing) {
      audio.pause();
      setPlaying(false);
    } else {
      await audio.play().catch(() => undefined);
      setPlaying(true);
    }
  }

  function cycleSpeed() {
    const next = SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length];
    setSpeed(next);
    if (audioRef.current) audioRef.current.playbackRate = next;
  }

  useEffect(() => () => audioRef.current?.pause(), []);

  return (
    <div className="flex min-w-[220px] items-center gap-2">
      <button
        type="button"
        onClick={toggle}
        className={clsx("focus-ring flex h-8 w-8 shrink-0 items-center justify-center rounded-full", mine ? "bg-white/20" : "bg-primary text-primary-fg")}
        aria-label={playing ? "Pausar áudio" : "Ouvir áudio"}
      >
        {playing ? <Pause className="h-4 w-4" /> : <Play className="ml-0.5 h-4 w-4" />}
      </button>
      <div className="flex h-7 flex-1 items-center gap-[2px]" aria-hidden>
        {bars.map((level, i) => (
          <span
            key={i}
            className={clsx("w-[3px] rounded-full bg-current", i / bars.length <= progress ? "opacity-100" : "opacity-40")}
            style={{ height: `${Math.max(12, level)}%` }}
          />
        ))}
      </div>
      <button type="button" onClick={cycleSpeed} className={clsx("focus-ring rounded-full px-1.5 py-0.5 text-[10px] font-bold", mine ? "bg-white/20" : "bg-surface-alt")} aria-label="Velocidade">
        {String(speed).replace(".", ",")}×
      </button>
      <span className="w-9 text-right text-[10px] tabular-nums opacity-80">{formatAudioTime(playing || progress ? progress * durationMs : durationMs)}</span>
    </div>
  );
}
