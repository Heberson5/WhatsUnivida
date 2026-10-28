import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { setTimeout as realDelay } from "node:timers/promises";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { BufferJSON, initAuthCreds } from "@whiskeysockets/baileys";
import { BaileysWhatsAppProvider, type WhatsAppStatusSnapshot } from "@whatsatendende/whatsapp";

/**
 * "Conectar com número". A fake socket plays WhatsApp's servers the way they really behave:
 * - the handshake registers a new device, or logs in when the credentials carry a number (creds.me) — and a
 *   login of a device that never finished linking is refused (401);
 * - a code is only valid when asked for after the handshake (WhatsApp then sends the QR refs, "pair-device");
 * - once the phone accepts the code, the session is registered and WhatsApp restarts the socket (515).
 * The code used to be asked for during the handshake: WhatsApp refused it, it vanished in a few seconds, and the
 * phone said it couldn't link.
 */

const RESTART_REQUIRED = 515;
const QR_REFS_ENDED = 408;
const LOGGED_OUT = 401;

interface Creds {
  me?: { id: string };
  /** What WhatsApp signs on pair-success, for a QR Code link and a code link alike. */
  account?: object;
  pairingCode?: string;
  registered?: boolean;
}

interface FakeSocket {
  ev: EventEmitter;
  user: undefined;
  ready: boolean;
  requestPairingCode: (phone: string) => Promise<string>;
  end: () => void;
  logout: () => Promise<void>;
}

/**
 * `deadAfterFirst`: every socket after the first dies before WhatsApp is ready (it never gets that far again).
 * `savedCreds`: a session already on disk, as the API finds it when it starts again (after an update).
 */
function setup(codes: string[], { deadAfterFirst = false, savedCreds }: { deadAfterFirst?: boolean; savedCreds?: Creds } = {}) {
  const sockets: FakeSocket[] = [];
  const requests: string[] = [];
  const refused: string[] = [];
  let creds: Creds | undefined;
  const closeSocket = (socket: FakeSocket, statusCode: number) =>
    socket.ev.emit("connection.update", { connection: "close", lastDisconnect: { error: { output: { statusCode } } } });

  const socketFactory = ((config: { auth: { creds: Creds } }) => {
    creds = config.auth.creds;
    const socket: FakeSocket = {
      ev: new EventEmitter(),
      user: undefined,
      ready: false,
      requestPairingCode: async (phone: string) => {
        if (!socket.ready) {
          refused.push("code asked during the handshake");
          setImmediate(() => closeSocket(socket, LOGGED_OUT));
        }
        requests.push(phone);
        // Like Baileys: the number and the code go into the saved credentials.
        const code = codes.shift() ?? "ZZZZ9999";
        config.auth.creds.me = { id: `${phone}@s.whatsapp.net` };
        config.auth.creds.pairingCode = code;
        socket.ev.emit("creds.update", { me: config.auth.creds.me, pairingCode: code });
        return code;
      },
      end: () => undefined,
      logout: async () => undefined,
    };
    sockets.push(socket);
    // The handshake, once the provider has wired its listeners.
    setImmediate(() => {
      const c = config.auth.creds;
      if (deadAfterFirst && sockets.length > 1) {
        closeSocket(socket, QR_REFS_ENDED);
      } else if (c.me && (c.account || c.registered)) {
        socket.ev.emit("connection.update", { connection: "open" });
      } else if (c.me) {
        refused.push("login of a device that is not linked");
        closeSocket(socket, LOGGED_OUT);
      } else {
        socket.ready = true;
        socket.ev.emit("connection.update", { qr: "ref,noise,identity,adv" });
      }
    });
    return socket;
  }) as never;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pairing-"));
  if (savedCreds) {
    fs.mkdirSync(path.join(dir, "auth"));
    fs.writeFileSync(path.join(dir, "auth", "creds.json"), JSON.stringify({ ...initAuthCreds(), ...savedCreds }, BufferJSON.replacer));
  }
  const provider = new BaileysWhatsAppProvider({ authStateDir: path.join(dir, "auth"), socketFactory });
  const history: WhatsAppStatusSnapshot[] = [];
  provider.onConnectionUpdate((s) => history.push(s));
  const close = (statusCode: number) => closeSocket(sockets.at(-1)!, statusCode);
  /** The phone typed the code: WhatsApp links the device and restarts the socket. */
  const phoneAccepts = () => {
    creds!.registered = true;
    creds!.account = { details: "signed" };
    sockets.at(-1)!.ev.emit("creds.update", { registered: true, account: creds!.account });
    close(RESTART_REQUIRED);
  };
  return { provider, sockets, requests, refused, history, close, phoneAccepts, credsOnDisk: () => JSON.parse(fs.readFileSync(path.join(dir, "auth", "creds.json"), "utf8")) as Creds };
}

// Real file I/O (the session credentials) runs between fake timers — give it room to finish. A burst of
// setImmediate alone can end before the disk answers on a busy machine, so real milliseconds pass too
// (node:timers/promises is not faked).
async function settle() {
  for (let i = 0; i < 20; i++) {
    await realDelay(2);
    for (let j = 0; j < 20; j++) await new Promise((resolve) => setImmediate(resolve));
  }
}

describe("código de conexão pelo número", () => {
  beforeEach(() => {
    process.env.WHATSAPP_PAIRING_LOG_LEVEL = "silent";
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("pede o código só depois que o WhatsApp está pronto, e ele fica na tela os 60 segundos", async () => {
    const { provider, requests, refused, history } = setup(["ABCD1234"]);
    await provider.connect({ phoneNumber: "+55 65 98888-7777" });
    await settle();

    expect(refused).toEqual([]);
    expect(requests).toEqual(["5565988887777"]);
    expect(provider.getStatus()).toMatchObject({ state: "CODE_PENDING", pairingCode: "ABCD-1234", pairingPhoneNumber: "5565988887777" });
    const shownAt = history.length;

    await vi.advanceTimersByTimeAsync(59_000);
    await settle();
    expect(provider.getStatus()).toMatchObject({ state: "CODE_PENDING", pairingCode: "ABCD-1234" });
    expect(history.slice(shownAt).every((s) => s.pairingCode === "ABCD-1234")).toBe(true);
  });

  it("aos 60 segundos o próximo código entra direto no lugar, sem tela vazia", async () => {
    const { provider, history, requests } = setup(["ABCD1234", "EFGH5678"]);
    await provider.connect({ phoneNumber: "5565988887777" });
    await settle();
    const shownAt = history.length;

    await vi.advanceTimersByTimeAsync(60_500);
    await settle();

    expect(provider.getStatus()).toMatchObject({ state: "CODE_PENDING", pairingCode: "EFGH-5678" });
    expect(history.slice(shownAt).map((s) => s.pairingCode)).not.toContain(null);
    expect(requests).toHaveLength(2);
  });

  it("o celular aceita o código: o WhatsApp reinicia a conexão e ela entra vinculada", async () => {
    const { provider, phoneAccepts, requests, refused } = setup(["ABCD1234"]);
    await provider.connect({ phoneNumber: "5565988887777" });
    await settle();

    phoneAccepts();
    await vi.advanceTimersByTimeAsync(3000);
    await settle();

    expect(provider.getStatus().state).toBe("CONNECTED");
    expect(refused).toEqual([]);
    expect(requests).toHaveLength(1);
  });

  it("uma queda no meio da tentativa: a nova conexão é aceita e traz um código novo, sem tela vazia", async () => {
    const { provider, close, requests, refused, history } = setup(["ABCD1234", "EFGH5678"]);
    await provider.connect({ phoneNumber: "5565988887777" });
    await settle();
    const shownAt = history.length;

    close(QR_REFS_ENDED);
    await vi.advanceTimersByTimeAsync(3000);
    await settle();

    // The number the first code wrote into the credentials must not turn the new handshake into a refused login.
    expect(refused).toEqual([]);
    expect(requests).toHaveLength(2);
    expect(provider.getStatus()).toMatchObject({ state: "CODE_PENDING", pairingCode: "EFGH-5678" });
    expect(history.slice(shownAt).map((s) => s.pairingCode)).not.toContain(null);
  });

  it("depois de 5 minutos sem vincular, para de gerar códigos e espera o Gerar novo código", async () => {
    const { provider, requests } = setup(["C0000001", "C0000002", "C0000003", "C0000004", "C0000005", "C0000006", "C0000007"]);
    await provider.connect({ phoneNumber: "5565988887777" });
    await settle();
    for (let minute = 0; minute < 6; minute++) {
      await vi.advanceTimersByTimeAsync(60_500);
      await settle();
    }
    expect(provider.getStatus()).toMatchObject({ state: "DISCONNECTED", pairingCode: null });
    expect(requests.length).toBeLessThanOrEqual(6);
  });

  it("Gerar novo código sempre traz outro, e não o anterior", async () => {
    const { provider, requests, refused } = setup(["ABCD1234", "EFGH5678"]);
    await provider.connect({ phoneNumber: "5565988887777" });
    await settle();
    await provider.connect({ phoneNumber: "5565988887777" });
    await settle();
    expect(provider.getStatus().pairingCode).toBe("EFGH-5678");
    expect(requests).toHaveLength(2);
    expect(refused).toEqual([]);
  });

  it("conexão vinculada pelo QR Code continua conectada quando o sistema reinicia (atualização)", async () => {
    // Baileys never sets `registered` for a QR Code link — only `me` and `account`.
    const linkedByQr = { me: { id: "5565988887777:12@s.whatsapp.net" }, account: { details: "signed" }, registered: false };
    const { provider, refused, credsOnDisk } = setup([], { savedCreds: linkedByQr });
    await provider.connect();
    await settle();

    expect(provider.getStatus().state).toBe("CONNECTED");
    expect(refused).toEqual([]);
    expect(credsOnDisk().me).toEqual(linkedByQr.me);
  });

  it("se o WhatsApp encerra de vez (tentativas esgotadas), aí sim o código sai", async () => {
    const { provider, close } = setup(["ABCD1234"], { deadAfterFirst: true });
    await provider.connect({ phoneNumber: "5565988887777" });
    await settle();
    expect(provider.getStatus().pairingCode).toBe("ABCD-1234");
    // The connection drops and every reconnect dies before WhatsApp is ready (3 s, 6 s, 12 s between retries).
    close(QR_REFS_ENDED);
    for (const wait of [3000, 6000, 12_000]) {
      await vi.advanceTimersByTimeAsync(wait);
      await settle();
    }
    expect(provider.getStatus()).toMatchObject({ state: "DISCONNECTED", pairingCode: null });
  });
});
