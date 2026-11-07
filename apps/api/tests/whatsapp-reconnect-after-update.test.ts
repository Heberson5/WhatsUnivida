import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import { MockWhatsAppProvider } from "@whatsatendende/whatsapp";
import { prisma } from "../src/lib/prisma";
import { env } from "../src/config/env";
import { initWhatsAppConnections } from "../src/modules/whatsapp/whatsapp.service";
import { resetDatabase, createTestConnection } from "./helpers";

/**
 * An update restarts the API. A connection still linked to the phone has to come back on its own, even when the
 * update landed while WhatsApp was reconnecting and the database read CONNECTING or DISCONNECTED; it used to stay
 * off until someone pressed Conectar again.
 */

const sessionDirs: string[] = [];

function saveSession(connectionId: string, creds: object) {
  const dir = path.join(env.WHATSAPP_AUTH_DIR, connectionId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "creds.json"), JSON.stringify(creds));
  sessionDirs.push(dir);
}

describe("a conexão volta sozinha depois de uma atualização", () => {
  let connectSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    await resetDatabase();
    connectSpy = vi.spyOn(MockWhatsAppProvider.prototype, "connect").mockResolvedValue(undefined);
  });

  afterEach(() => {
    connectSpy.mockRestore();
    for (const dir of sessionDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("uma conexão com a sessão ligada ao celular reconecta, mesmo gravada como reconectando ou desconectada", async () => {
    const reconnecting = await createTestConnection("Suporte");
    const settled = await createTestConnection("Vendas");
    await prisma.whatsAppConnection.update({ where: { id: reconnecting.id }, data: { status: "CONNECTING" } });
    await prisma.whatsAppConnection.update({ where: { id: settled.id }, data: { status: "DISCONNECTED" } });
    // QR Code link (account) and code link (registered) — both are a session linked to the phone.
    saveSession(reconnecting.id, { account: { details: "x" } });
    saveSession(settled.id, { registered: true });

    await initWhatsAppConnections();

    expect(connectSpy).toHaveBeenCalledTimes(2);
  });

  it("não liga sozinha a conexão sem sessão, nem a que ficou no meio de um pareamento", async () => {
    const neverLinked = await createTestConnection("Financeiro");
    const halfPaired = await createTestConnection("Cobrança");
    await prisma.whatsAppConnection.update({ where: { id: neverLinked.id }, data: { status: "DISCONNECTED" } });
    await prisma.whatsAppConnection.update({ where: { id: halfPaired.id }, data: { status: "DISCONNECTED" } });
    saveSession(halfPaired.id, { pairingCode: "ABCD1234", registered: false });

    await initWhatsAppConnections();

    expect(connectSpy).not.toHaveBeenCalled();
  });

  it("a conexão gravada como conectada continua reconectando como antes", async () => {
    const live = await createTestConnection("Atendimento");
    await prisma.whatsAppConnection.update({ where: { id: live.id }, data: { status: "CONNECTED" } });

    await initWhatsAppConnections();

    expect(connectSpy).toHaveBeenCalledTimes(1);
  });
});
