import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { DEFAULT_PHONE_SETTINGS, brazilianPhoneVariants, normalizeTypedPhone, type PhoneSettingsDTO } from "@whatsatendende/types";

// What WhatsApp "knows": the lookup answers with the number itself when it is in `known`.
const whatsapp = vi.hoisted(() => ({ known: new Set<string>(), asked: [] as string[], down: false }));
vi.mock("../src/modules/whatsapp/whatsapp.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/modules/whatsapp/whatsapp.service")>();
  return {
    ...actual,
    lookupNumber: vi.fn(async (_connectionId: string, phone: string) => {
      whatsapp.asked.push(phone);
      if (whatsapp.down) throw new Error("conexão fora do ar");
      return whatsapp.known.has(phone) ? { phone } : null;
    }),
  };
});

import { createApp } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { importContactsCsv, normalizeImportPhone } from "../src/modules/contacts/contacts.service";
import { updatePhoneSettings } from "../src/modules/phone-numbers/phone-settings.service";
import { resetDatabase, createTestConnection, createTestUser, TEST_PASSWORD } from "./helpers";

const app = createApp();
const ON = DEFAULT_PHONE_SETTINGS;
const OFF: PhoneSettingsDTO = { defaultCountryCodeEnabled: false, defaultCountryCode: "55", fixExtraNineEnabled: false };

async function loginAs(email: string) {
  const res = await request(app).post("/api/auth/login").send({ email, password: TEST_PASSWORD });
  return res.body.accessToken as string;
}

describe("número digitado à mão: DDI padrão e 9 a mais", () => {
  describe("regras", () => {
    it.each([
      // typed, number to use, other forms to try if WhatsApp doesn't know it
      ["65999286623", "556599286623", ["5565999286623"]], // DDD + 9 + 8 digits, no DDI: the 9 goes, 55 comes
      ["(65) 99928-6623", "556599286623", ["5565999286623"]], // punctuation is ignored
      ["6599286623", "556599286623", []], // already without the 9: only the 55
      ["5565999286623", "556599286623", ["5565999286623"]], // has the DDI and the 9: only the 9 goes
      ["+55 65 99928-6623", "556599286623", ["5565999286623"]],
      ["556599286623", "556599286623", []], // already right
      ["00 65 99928-6623", "556599286623", ["5565999286623"]], // international/long-distance zeros
      ["55999286623", "555599286623", ["5555999286623"]], // DDD 55 (Rio Grande do Sul) is a DDD, not the DDI
      ["6532221234", "556532221234", []], // landline: no 9 involved
      ["351912345678", "351912345678", []], // 12–15 digits without 55: another country's DDI, left alone
      ["12125551234", "12125551234", []], // 11 digits without a mobile 9 in the DDD slot: not Brazilian, left alone
      ["", "", []],
    ])("%s → %s", (typed, phone, alternates) => {
      expect(normalizeTypedPhone(typed, ON)).toEqual({ phone, alternates });
    });

    it("keeps the 9 where WhatsApp keeps it (DDD 11–19, 21, 22, 24, 27, 28), with the other form as the fallback", () => {
      expect(normalizeTypedPhone("11987654321", ON)).toEqual({ phone: "5511987654321", alternates: ["551187654321"] });
      expect(normalizeTypedPhone("(21) 98765-4321", ON)).toEqual({ phone: "5521987654321", alternates: ["552187654321"] });
      // 31 is the first DDD where it goes
      expect(normalizeTypedPhone("31987654321", ON)).toEqual({ phone: "553187654321", alternates: ["5531987654321"] });
    });

    it("does nothing when both options are off, and each option works on its own", () => {
      expect(normalizeTypedPhone("65999286623", OFF)).toEqual({ phone: "65999286623", alternates: [] });
      expect(normalizeTypedPhone("065999286623", OFF)).toEqual({ phone: "065999286623", alternates: [] });
      expect(normalizeTypedPhone("65999286623", { ...OFF, defaultCountryCodeEnabled: true })).toEqual({ phone: "5565999286623", alternates: [] });
      expect(normalizeTypedPhone("5565999286623", { ...OFF, fixExtraNineEnabled: true })).toEqual({ phone: "556599286623", alternates: ["5565999286623"] });
    });

    it("uses another default country code when it is changed", () => {
      const portugal = { ...ON, defaultCountryCode: "351" };
      expect(normalizeTypedPhone("912345678", portugal).phone).toBe("351912345678");
      expect(normalizeTypedPhone("351912345678", portugal).phone).toBe("351912345678");
      // the 9 fix is about Brazilian numbers, whatever the default code is
      expect(normalizeTypedPhone("5565999286623", portugal).phone).toBe("556599286623");
    });

    it("gives both forms of a Brazilian mobile, and only itself for anything else", () => {
      expect(brazilianPhoneVariants("5565999286623")).toEqual(["5565999286623", "556599286623"]);
      expect(brazilianPhoneVariants("556599286623")).toEqual(["556599286623", "5565999286623"]);
      expect(brazilianPhoneVariants("556532221234")).toEqual(["556532221234"]);
      expect(brazilianPhoneVariants("351912345678")).toEqual(["351912345678"]);
    });
  });

  describe("com o sistema", () => {
    let connectionId: string;
    let agentToken: string;
    let adminId: string;
    let adminToken: string;

    beforeEach(async () => {
      await resetDatabase();
      whatsapp.known.clear();
      whatsapp.asked.length = 0;
      whatsapp.down = false;
      connectionId = (await createTestConnection("Suporte")).id;
      adminId = (await createTestUser({ email: "admin@test.dev", role: "ADMIN" })).id;
      await createTestUser({ email: "joao@test.dev", role: "AGENT", displayName: "Joao", whatsappConnectionId: connectionId });
      adminToken = await loginAs("admin@test.dev");
      agentToken = await loginAs("joao@test.dev");
    });

    afterAll(async () => {
      await prisma.$disconnect();
    });

    const lookup = (typed: string) =>
      request(app).get(`/api/whatsapp/connections/${connectionId}/lookup-number`).query({ phone: typed }).set("Authorization", `Bearer ${agentToken}`);
    const start = (typed: string) => request(app).post("/api/conversations/start").set("Authorization", `Bearer ${agentToken}`).send({ phone: typed });

    describe("configurações", () => {
      it("começam ligadas, e qualquer usuário logado pode ler", async () => {
        const res = await request(app).get("/api/settings/phone").set("Authorization", `Bearer ${agentToken}`);
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ defaultCountryCodeEnabled: true, defaultCountryCode: "55", fixExtraNineEnabled: true });
      });

      it("o administrador altera e fica salvo e registrado; o atendente não pode", async () => {
        const body = { defaultCountryCodeEnabled: true, defaultCountryCode: "351", fixExtraNineEnabled: false };
        expect((await request(app).patch("/api/settings/phone").set("Authorization", `Bearer ${agentToken}`).send(body)).status).toBe(403);

        const saved = await request(app).patch("/api/settings/phone").set("Authorization", `Bearer ${adminToken}`).send(body);
        expect(saved.status).toBe(200);
        expect((await request(app).get("/api/settings/phone").set("Authorization", `Bearer ${agentToken}`)).body).toEqual(body);
        expect(await prisma.auditLog.count({ where: { action: "SETTINGS_PHONE_UPDATED", userId: adminId } })).toBe(1);
      });

      it("recusa um DDI que não são 1 a 3 números", async () => {
        for (const defaultCountryCode of ["", "5555", "+55", "ab"]) {
          const res = await request(app)
            .patch("/api/settings/phone")
            .set("Authorization", `Bearer ${adminToken}`)
            .send({ defaultCountryCodeEnabled: true, defaultCountryCode, fixExtraNineEnabled: true });
          expect(res.status).toBe(400);
        }
      });

      it("a aba tem as suas próprias permissões, que o gestor recebe por padrão e o atendente não", async () => {
        const res = await request(app).get("/api/permissions").set("Authorization", `Bearer ${adminToken}`);
        expect(res.status).toBe(200);
        const keys = JSON.stringify(res.body);
        expect(keys).toContain("configuracoes.telefone.visualizar");
        expect(keys).toContain("configuracoes.telefone.editar");
      });
    });

    describe("conferência no WhatsApp ao digitar", () => {
      it("sem o 9, quando é a forma que o WhatsApp tem", async () => {
        whatsapp.known.add("556599286623");
        const res = await lookup("65999286623");
        expect(res.body).toEqual({ exists: true, phone: "556599286623", normalizedPhone: "556599286623", unverifiable: false, checkedByConnectionName: null });
        expect(whatsapp.asked).toEqual(["556599286623"]); // the first form was enough
      });

      it("com o 9, quando o WhatsApp só conhece essa forma", async () => {
        whatsapp.known.add("5565999286623");
        const res = await lookup("65999286623");
        expect(res.body).toEqual({ exists: true, phone: "5565999286623", normalizedPhone: "556599286623", unverifiable: false, checkedByConnectionName: null });
        expect(whatsapp.asked).toEqual(["556599286623", "5565999286623"]);
      });

      it("em DDD que mantém o 9, pergunta primeiro pela forma digitada", async () => {
        whatsapp.known.add("5511987654321");
        const res = await lookup("11987654321");
        expect(res.body).toEqual({ exists: true, phone: "5511987654321", normalizedPhone: "5511987654321", unverifiable: false, checkedByConnectionName: null });
        expect(whatsapp.asked).toEqual(["5511987654321"]);
      });

      it("diz que não existe quando nenhuma forma existe, e mostra o número que foi conferido", async () => {
        const res = await lookup("65999286623");
        expect(res.body).toEqual({ exists: false, phone: null, normalizedPhone: "556599286623", unverifiable: false, checkedByConnectionName: null });
        expect(whatsapp.asked).toEqual(["556599286623", "5565999286623"]);
      });

      it("responde sem resposta (null) quando o WhatsApp não pôde ser consultado", async () => {
        whatsapp.down = true;
        const res = await lookup("65999286623");
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ exists: null, phone: null, normalizedPhone: "556599286623", unverifiable: false, checkedByConnectionName: null });
      });

      it("com a correção desligada, confere o número exatamente como foi digitado", async () => {
        await updatePhoneSettings(OFF);
        whatsapp.known.add("65999286623");
        const res = await lookup("65999286623");
        expect(res.body).toEqual({ exists: true, phone: "65999286623", normalizedPhone: "65999286623", unverifiable: false, checkedByConnectionName: null });
      });
    });

    describe("iniciar a conversa", () => {
      const contactPhones = async () => (await prisma.contact.findMany({ select: { phone: true } })).map((c) => c.phone);

      it("salva o contato com a forma que o WhatsApp confirmou", async () => {
        whatsapp.known.add("556599286623");
        const res = await start("65999286623");
        expect(res.status).toBe(201);
        expect(await contactPhones()).toEqual(["556599286623"]);
        const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: "CONVERSATION_STARTED" } });
        expect(audit.metadata).toMatchObject({ phone: "556599286623", typedPhone: "65999286623" });
      });

      it("usa a forma com o 9 quando é a única que o WhatsApp tem", async () => {
        whatsapp.known.add("5565999286623");
        expect((await start("65999286623")).status).toBe(201);
        expect(await contactPhones()).toEqual(["5565999286623"]);
      });

      it("recusa quando o WhatsApp não conhece nenhuma forma do número", async () => {
        const res = await start("65999286623");
        expect(res.status).toBe(400);
        expect(res.body.message ?? res.body.error).toMatch(/não tem WhatsApp/);
        expect(await contactPhones()).toEqual([]);
      });

      it("recusa quando o WhatsApp não pôde ser consultado agora", async () => {
        whatsapp.down = true;
        const res = await start("6599286623");
        expect(res.status).toBe(400);
        expect(JSON.stringify(res.body)).toMatch(/Não foi possível confirmar/);
      });

      it("também confere o número sem dúvida de 9 antes de iniciar", async () => {
        whatsapp.known.add("556599286623");
        expect((await start("6599286623")).status).toBe(201);
        expect(whatsapp.asked).toEqual(["556599286623"]);
        expect(await contactPhones()).toEqual(["556599286623"]);
      });

      it("reaproveita o contato salvo com o 9 e corrige o número dele quando o WhatsApp confirma a outra forma", async () => {
        const stale = await prisma.contact.create({ data: { phone: "5565999286623", name: "Joana", whatsappConnectionId: connectionId } });
        whatsapp.known.add("556599286623");
        const res = await start("65999286623");
        expect(res.status).toBe(201);
        const contacts = await prisma.contact.findMany();
        expect(contacts).toHaveLength(1);
        expect(contacts[0]).toMatchObject({ id: stale.id, phone: "556599286623", name: "Joana" });
        expect(res.body.contact.id).toBe(stale.id);
      });

      it("prefere o contato que já tem exatamente o número, em vez de mexer em outro", async () => {
        const exact = await prisma.contact.create({ data: { phone: "556599286623", whatsappConnectionId: connectionId } });
        await prisma.contact.create({ data: { phone: "5565999286623", whatsappConnectionId: connectionId } });
        whatsapp.known.add("556599286623");
        const res = await start("65999286623");
        expect(res.body.contact.id).toBe(exact.id);
        expect(await prisma.contact.count()).toBe(2);
      });

      it("com as opções desligadas, usa só os números digitados", async () => {
        await updatePhoneSettings(OFF);
        whatsapp.known.add("65999286623");
        expect((await start("65999286623")).status).toBe(201);
        expect(await contactPhones()).toEqual(["65999286623"]);
        expect(whatsapp.asked).toEqual(["65999286623"]);
      });
    });

    describe("API Oficial: conferência por uma conexão de QR Code", () => {
      async function officialConnection() {
        return prisma.whatsAppConnection.create({ data: { name: "Vendas Oficial", status: "CONNECTED", connectionMode: "OFFICIAL_API" } });
      }

      it("pergunta pela conexão de QR Code conectada e diz qual conferiu", async () => {
        const official = await officialConnection();
        whatsapp.known.add("556599286623");
        const res = await request(app).get(`/api/whatsapp/connections/${official.id}/lookup-number`).set("Authorization", `Bearer ${adminToken}`).query({ phone: "65999286623" });
        expect(res.body).toMatchObject({ exists: true, phone: "556599286623", unverifiable: false, checkedByConnectionName: "Suporte" });
        const started = await request(app).post("/api/conversations/start").set("Authorization", `Bearer ${adminToken}`).send({ connectionId: official.id, phone: "65999286623" });
        expect(started.status).toBe(201);
        expect(started.body.whatsappConnectionId).toBe(official.id);
      });

      it("recusa o número que a conexão de QR Code diz não ter WhatsApp", async () => {
        const official = await officialConnection();
        const started = await request(app).post("/api/conversations/start").set("Authorization", `Bearer ${adminToken}`).send({ connectionId: official.id, phone: "65999286623" });
        expect(started.status).toBe(400);
      });

      it("sem conexão de QR Code conectada, segue sem verificação", async () => {
        const official = await officialConnection();
        await prisma.whatsAppConnection.update({ where: { id: connectionId }, data: { status: "DISCONNECTED" } });
        const res = await request(app).get(`/api/whatsapp/connections/${official.id}/lookup-number`).set("Authorization", `Bearer ${adminToken}`).query({ phone: "65999286623" });
        expect(res.body).toMatchObject({ exists: null, unverifiable: true });
        const started = await request(app).post("/api/conversations/start").set("Authorization", `Bearer ${adminToken}`).send({ connectionId: official.id, phone: "65999286623" });
        expect(started.status).toBe(201);
        expect(whatsapp.asked).toEqual([]);
      });
    });

    describe("importação de contatos (CSV)", () => {
      it("completa o DDI e tira o 9 a mais onde o WhatsApp costuma não ter, sem mexer em SP/RJ/ES", async () => {
        const csv = ["Nome;Telefone", "Ana;65 99928-6623", "Bia;11 98765-4321", "Carla;(31) 3222-1234", "Dora;123"].join("\n");
        const result = await importContactsCsv(csv, connectionId, adminId);
        expect(result).toMatchObject({ created: 3, existing: 0 });
        expect(result.errors).toEqual([expect.objectContaining({ line: 5 })]);
        const phones = (await prisma.contact.findMany({ select: { phone: true } })).map((c) => c.phone).sort();
        expect(phones).toEqual(["5511987654321", "553132221234", "556599286623"]);
      });

      it("não duplica o contato salvo na outra forma do número", async () => {
        const saved = await prisma.contact.create({ data: { phone: "5565999286623", whatsappConnectionId: connectionId } });
        const result = await importContactsCsv("Nome;Telefone\nJoana;65 99928-6623", connectionId, adminId);
        expect(result).toMatchObject({ created: 0, existing: 1 });
        expect(await prisma.contact.count()).toBe(1);
        expect((await prisma.contact.findUniqueOrThrow({ where: { id: saved.id } })).name).toBe("Joana");
      });

      it("segue as configurações, ligadas ou desligadas", async () => {
        expect(normalizeImportPhone("65 99928-6623")).toBe("556599286623");
        expect(normalizeImportPhone("65 99928-6623", OFF)).toBeNull(); // no DDI added: too short to be a full number
        expect(normalizeImportPhone("5565999286623", OFF)).toBe("5565999286623");
      });
    });
  });
});
