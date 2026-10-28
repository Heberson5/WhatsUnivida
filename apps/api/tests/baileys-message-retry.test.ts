import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { describe, it, expect, beforeAll } from "vitest";
import { BaileysWhatsAppProvider } from "@whatsatendende/whatsapp";

/**
 * "Aguardando mensagem": the customer's phone couldn't decrypt a message and asks for it again; it is only
 * fixed if this connection can still find what it sent. A fake socket stands in for WhatsApp's servers.
 */

type SocketConfig = {
  getMessage: (key: { id?: string | null }) => Promise<{ conversation?: string | null } | undefined>;
  msgRetryCounterCache?: { get: (k: string) => unknown; set: (k: string, v: unknown) => void; del: (k: string) => void; flushAll: () => void };
  auth: { creds: object; keys: { get: (...args: unknown[]) => unknown; set: (...args: unknown[]) => unknown } };
};

function connectedProvider(dir: string) {
  const configs: SocketConfig[] = [];
  let n = 0;
  const socketFactory = ((config: SocketConfig) => {
    configs.push(config);
    const ev = new EventEmitter();
    return {
      ev,
      user: undefined,
      end: () => undefined,
      logout: async () => undefined,
      sendMessage: async (_jid: string, content: { text: string }) => {
        n += 1;
        return { key: { id: `MSG${n}`, remoteJid: _jid, fromMe: true }, message: { extendedTextMessage: { text: content.text } } };
      },
    };
  }) as never;
  const provider = new BaileysWhatsAppProvider({ authStateDir: dir, socketFactory });
  return { provider, configs };
}

async function open(provider: BaileysWhatsAppProvider, configs: SocketConfig[]) {
  await provider.connect();
  const socket = (provider as unknown as { socket: { ev: EventEmitter } }).socket;
  socket.ev.emit("connection.update", { connection: "open" });
  return configs.at(-1)!;
}

describe("reenvio de mensagem pedido pelo celular do cliente", () => {
  beforeAll(() => {
    process.env.WHATSAPP_DELIVERY_LOG_LEVEL = "silent";
  });

  it("a mensagem enviada continua disponível para reenvio depois de reiniciar o servidor", async () => {
    const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "retry-")), "auth");
    const first = connectedProvider(dir);
    await open(first.provider, first.configs);
    const sent = await first.provider.sendText("5565988887777@s.whatsapp.net", "*Ana:*\n\nSeu boleto foi reenviado.");
    expect(sent.providerMessageId).toBe("MSG1");
    await first.provider.endForShutdown(); // a deploy

    const second = connectedProvider(dir);
    const config = await open(second.provider, second.configs);
    const again = await config.getMessage({ id: "MSG1" });
    expect(again?.conversation ?? (again as { extendedTextMessage?: { text?: string } })?.extendedTextMessage?.text).toBe("*Ana:*\n\nSeu boleto foi reenviado.");
    expect(await config.getMessage({ id: "NAO-EXISTE" })).toBeUndefined();
  });

  it("liga o controle de tentativas de reenvio e o cache das chaves de criptografia", async () => {
    const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "retry-")), "auth");
    const { provider, configs } = connectedProvider(dir);
    const config = await open(provider, configs);
    const cache = config.msgRetryCounterCache!;
    expect(cache).toBeDefined();
    cache.set("MSG1", 2);
    expect(cache.get("MSG1")).toBe(2);
    cache.del("MSG1");
    expect(cache.get("MSG1")).toBeUndefined();
    expect(typeof config.auth.keys.get).toBe("function");
    expect(typeof config.auth.keys.set).toBe("function");
  });
});
