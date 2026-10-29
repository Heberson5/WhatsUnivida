import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { prisma } from "../src/lib/prisma";
import { resetDatabase } from "./helpers";
import { SMS_SENDERS, normalizeSmsPhone } from "../src/modules/sms/sms-providers";
import * as sms from "../src/modules/sms/sms.service";

describe("SMS dos alertas", () => {
  const fetchMock = vi.fn();

  beforeEach(async () => {
    await resetDatabase();
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(new Response('{"ok":true}', { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    await prisma.$disconnect();
  });

  it("número brasileiro sem DDI ganha o 55", () => {
    expect(normalizeSmsPhone("(65) 99928-6623")).toBe("5565999286623");
    expect(normalizeSmsPhone("+55 65 99928-6623")).toBe("5565999286623");
  });

  it("HTTP genérico: troca {{numero}} e {{mensagem}} e manda os cabeçalhos", async () => {
    await SMS_SENDERS.GENERIC_HTTP(
      { url: "https://sms.exemplo.com/send", method: "POST", headers: "Authorization: Bearer abc", body: '{"to":"{{numero}}","text":"{{mensagem}}"}', contentType: "application/json" },
      "5565999286623",
      'Falha "agendada"'
    );
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://sms.exemplo.com/send");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer abc");
    expect(JSON.parse(init.body as string)).toEqual({ to: "5565999286623", text: 'Falha "agendada"' });
  });

  it("o provedor recusando vira um erro legível", async () => {
    fetchMock.mockResolvedValue(new Response("token inválido", { status: 401 }));
    await expect(SMS_SENDERS.ZENVIA({ token: "x", from: "conta" }, "5565999286623", "oi")).rejects.toThrow(/Zenvia recusou o envio \(HTTP 401\)/);
  });

  it("a opção de SMS só fica disponível depois de um teste que deu certo, e as chaves não voltam para a tela", async () => {
    await sms.saveSettings({ enabled: true, provider: "TWILIO", config: { accountSid: "AC1", authToken: "segredo", from: "+15550001111" } });
    expect((await sms.availability()).available).toBe(false);
    const masked = await sms.getMaskedSettings();
    expect(masked.config.authToken).toBe("");
    expect(masked.secretsSet.authToken).toBe(true);

    await sms.sendTest("65999286623");
    expect((await sms.availability()).available).toBe(true);
    const body = new URLSearchParams(fetchMock.mock.calls[0][1].body as string);
    expect(body.get("To")).toBe("+5565999286623");

    // Changing the credentials asks for a new test.
    await sms.saveSettings({ enabled: true, provider: "TWILIO", config: { accountSid: "AC2", authToken: "", from: "+15550001111" } });
    expect((await sms.availability()).available).toBe(false);
  });
});
