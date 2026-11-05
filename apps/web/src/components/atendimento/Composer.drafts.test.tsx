import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import type { UserDTO } from "@whatsatendende/types";
import { Composer } from "./Composer";
import { useAuthStore } from "../../store/auth-store";
import { useMediaDraftStore } from "../../store/media-draft-store";
import { useDraftStore } from "../../store/draft-store";

vi.mock("../../lib/api", () => ({ api: { get: vi.fn(() => Promise.resolve({ data: [] })), post: vi.fn() } }));

URL.createObjectURL = vi.fn(() => "blob:preview");
URL.revokeObjectURL = vi.fn();
// jsdom's Blob has no arrayBuffer(); the audio joiner reads the pieces with it.
if (!Blob.prototype.arrayBuffer) {
  Blob.prototype.arrayBuffer = function (this: Blob) {
    return new Promise<ArrayBuffer>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as ArrayBuffer);
      reader.readAsArrayBuffer(this);
    });
  };
}

// A browser recorder, as far as the Composer uses it: every stop() hands over one last piece of "audio".
class FakeRecorder {
  static instances: FakeRecorder[] = [];
  static isTypeSupported = () => true;
  state: "inactive" | "recording" | "paused" = "inactive";
  mimeType = "audio/webm";
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  constructor(public stream: MediaStream) {
    FakeRecorder.instances.push(this);
  }
  start() {
    this.state = "recording";
  }
  pause() {
    this.state = "paused";
  }
  resume() {
    this.state = "recording";
  }
  requestData() {
    this.ondataavailable?.({ data: new Blob(["som"], { type: "audio/webm" }) });
  }
  stop() {
    this.ondataavailable?.({ data: new Blob(["som"], { type: "audio/webm" }) });
    this.state = "inactive";
    this.onstop?.();
  }
}
class FakeAudioContext {
  sampleRate = 16000;
  createMediaStreamSource = () => ({ connect: () => undefined });
  createAnalyser = () => ({ fftSize: 0, getByteTimeDomainData: () => undefined });
  close = () => Promise.resolve();
  decodeAudioData = () => Promise.resolve({ numberOfChannels: 1, sampleRate: 16000, length: 4, getChannelData: () => new Float32Array(4) });
}
const stopTrack = vi.fn();
const getUserMedia = vi.fn(() => Promise.resolve({ getTracks: () => [{ stop: stopTrack }] }));
Object.assign(globalThis, { MediaRecorder: FakeRecorder, AudioContext: FakeAudioContext });
Object.defineProperty(navigator, "mediaDevices", { value: { getUserMedia }, configurable: true });

function composer(draftId: string, onSendAudio = vi.fn().mockResolvedValue(undefined)) {
  return (
    <Composer
      draftId={draftId}
      onSendText={vi.fn().mockResolvedValue(undefined)}
      onSendFile={vi.fn().mockResolvedValue(undefined)}
      onSendAudio={onSendAudio}
      onSendLocation={vi.fn()}
      replyTo={null}
      onCancelReply={() => undefined}
    />
  );
}

const paste = (target: HTMLElement, file: File) => fireEvent.paste(target, { clipboardData: { files: [file], getData: () => "" } });

beforeEach(() => {
  useAuthStore.setState({ user: { id: "u1" } as UserDTO });
  useMediaDraftStore.setState({ drafts: {} });
  useDraftStore.setState({ drafts: {} });
  FakeRecorder.instances = [];
  getUserMedia.mockClear();
  stopTrack.mockClear();
});

describe("Composer: rascunho ao sair da conversa, como no WhatsApp", () => {
  it("arquivo na prévia fica como rascunho da conversa e volta ao reabrir", async () => {
    const { rerender } = render(composer("c1"));
    paste(screen.getByPlaceholderText("Digite uma mensagem"), new File(["%PDF"], "contrato.pdf", { type: "application/pdf" }));
    expect(await screen.findAllByText("contrato.pdf")).not.toHaveLength(0);

    rerender(composer("c2")); // another conversation: empty box
    expect(screen.queryByText("contrato.pdf")).not.toBeInTheDocument();
    expect(useMediaDraftStore.getState().drafts["u1:c1"]?.files?.[0].file.name).toBe("contrato.pdf");

    rerender(composer("c1")); // back: the file is waiting again
    expect(await screen.findAllByText("contrato.pdf")).not.toHaveLength(0);
  });

  it("gravando e saindo (Esc ou o card), o áudio é pausado — microfone liberado — e fica como rascunho", async () => {
    const onSendAudio = vi.fn().mockResolvedValue(undefined);
    const { unmount } = render(composer("c1"));
    fireEvent.click(screen.getByRole("button", { name: "Gravar áudio" }));
    await screen.findByRole("button", { name: "Pausar gravação" });

    unmount(); // the conversation closed
    expect(stopTrack).toHaveBeenCalled();
    expect(useMediaDraftStore.getState().drafts["u1:c1"]?.audio?.pieces).toHaveLength(1);

    render(composer("c1", onSendAudio));
    expect(await screen.findByRole("button", { name: "Ouvir prévia" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retomar gravação" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Enviar áudio" }));
    await waitFor(() => expect(onSendAudio).toHaveBeenCalledTimes(1));
    expect(useMediaDraftStore.getState().drafts["u1:c1"]).toBeUndefined();
  });

  it("dá para continuar gravando um rascunho; o envio junta tudo num áudio só", async () => {
    const onSendAudio = vi.fn().mockResolvedValue(undefined);
    useMediaDraftStore.getState().put("u1:c1", { audio: { pieces: [new Blob(["antes"], { type: "audio/webm" })], mimeType: "audio/webm", seconds: 7, waveform: [0.5] } });
    render(composer("c1", onSendAudio));
    expect(await screen.findByText("00:07")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Retomar gravação" }));
    await screen.findByRole("button", { name: "Pausar gravação" });
    expect(getUserMedia).toHaveBeenCalledTimes(1);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Enviar áudio" }));
    });
    await waitFor(() => expect(onSendAudio).toHaveBeenCalledTimes(1));
    const sent = onSendAudio.mock.calls[0][0] as File;
    expect(sent.type).toBe("audio/wav"); // the draft + the new piece, joined
  });

  it("descartar o áudio também apaga o rascunho", async () => {
    useMediaDraftStore.getState().put("u1:c1", { audio: { pieces: [new Blob(["x"])], mimeType: "audio/webm", seconds: 3, waveform: [] } });
    const { unmount } = render(composer("c1"));
    fireEvent.click(await screen.findByRole("button", { name: "Descartar gravação" }));
    unmount();
    expect(useMediaDraftStore.getState().drafts["u1:c1"]).toBeUndefined();
  });
});
