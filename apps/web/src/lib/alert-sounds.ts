import { useAuthStore } from "../store/auth-store";

export type AlertSound = "newMessage" | "newQueue" | "internalChat" | "nudge";

// Two short synthesized tones (no audio files to ship): a single soft "blip"
// for a customer message, a rising two-note chime for a new queue conversation.
const TONES: Record<AlertSound, { frequency: number; start: number; duration: number }[]> = {
  newMessage: [{ frequency: 880, start: 0, duration: 0.12 }],
  newQueue: [
    { frequency: 660, start: 0, duration: 0.14 },
    { frequency: 990, start: 0.16, duration: 0.2 },
  ],
  // Chat interno: two quick, lower notes — unlike a customer's, so the attendant knows where it came from without looking.
  internalChat: [
    { frequency: 523, start: 0, duration: 0.09 },
    { frequency: 784, start: 0.1, duration: 0.12 },
  ],
  // "Chamar a atenção": a short buzz, like MSN's.
  nudge: [
    { frequency: 220, start: 0, duration: 0.12 },
    { frequency: 196, start: 0.14, duration: 0.12 },
    { frequency: 220, start: 0.28, duration: 0.16 },
  ],
};

let context: AudioContext | null = null;

export function playAlertSound(sound: AlertSound, volume: number): void {
  if (volume <= 0 || typeof AudioContext === "undefined") return;
  context ??= new AudioContext();
  const now = context.currentTime;
  for (const tone of TONES[sound]) {
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = "sine";
    oscillator.frequency.value = tone.frequency;
    gain.gain.setValueAtTime(0, now + tone.start);
    gain.gain.linearRampToValueAtTime((volume / 100) * 0.4, now + tone.start + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + tone.start + tone.duration);
    oscillator.connect(gain).connect(context.destination);
    oscillator.start(now + tone.start);
    oscillator.stop(now + tone.start + tone.duration + 0.02);
  }
}

/** Plays `sound` only if the logged-in user left it on in Meu perfil › Sons. */
export function playUserAlertSound(sound: AlertSound): void {
  const user = useAuthStore.getState().user;
  if (!user) return;
  // The nudge always sounds (it exists to be noticed); the chat's own tone follows the "new message" switch.
  const enabled = sound === "nudge" ? true : sound === "newQueue" ? user.soundNewQueue : user.soundNewMessage;
  if (enabled) playAlertSound(sound, user.soundVolume);
}
