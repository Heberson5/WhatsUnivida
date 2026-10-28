import { describe, it, expect, afterAll } from "vitest";
import request from "supertest";
import { createApp } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { resetDatabase, createTestUser, TEST_PASSWORD } from "./helpers";

const app = createApp();

async function loginAs(email: string) {
  const res = await request(app).post("/api/auth/login").send({ email, password: TEST_PASSWORD });
  return res.body.accessToken as string;
}

async function waitForState(app: ReturnType<typeof createApp>, token: string, connectionId: string, ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
  const res = await request(app).get("/api/whatsapp/connections").set("Authorization", `Bearer ${token}`);
  return res.body.find((c: { id: string }) => c.id === connectionId);
}

describe("a connection can only ever be re-paired with the phone number it was first linked to", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("remembers the first-linked number, rejects a pairing with a different one, and accepts the same one again", async () => {
    await resetDatabase();
    await createTestUser({ email: "admin-samenumber@test.dev", role: "ADMIN" });
    const token = await loginAs("admin-samenumber@test.dev");
    const created = await request(app)
      .post("/api/whatsapp/connections")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "SuporteNumero" });

    // First-ever pairing — mock provider: CODE_PENDING -> CONNECTED with
    // exactly the requested phone number in ~1.9s.
    await request(app)
      .post(`/api/whatsapp/connections/${created.body.id}/connect`)
      .set("Authorization", `Bearer ${token}`)
      .send({ phoneNumber: "5511900001111" });
    let connection = await waitForState(app, token, created.body.id, 2200);
    expect(connection.state).toBe("CONNECTED");
    expect(connection.connectedNumber).toBe("5511900001111");
    expect(connection.linkedNumber).toBe("5511900001111");

    // Disconnect, then try pairing a DIFFERENT number on the same connection.
    await request(app).post(`/api/whatsapp/connections/${created.body.id}/disconnect`).set("Authorization", `Bearer ${token}`);
    await request(app)
      .post(`/api/whatsapp/connections/${created.body.id}/connect`)
      .set("Authorization", `Bearer ${token}`)
      .send({ phoneNumber: "5511900002222" });
    connection = await waitForState(app, token, created.body.id, 2200);

    // Rejected: never settles as CONNECTED with the wrong number, and the
    // originally-linked number is preserved untouched.
    expect(connection.state).not.toBe("CONNECTED");
    expect(connection.connectedNumber).not.toBe("5511900002222");
    expect(connection.linkedNumber).toBe("5511900001111");

    // Re-pairing with the ORIGINAL number still works.
    await request(app)
      .post(`/api/whatsapp/connections/${created.body.id}/connect`)
      .set("Authorization", `Bearer ${token}`)
      .send({ phoneNumber: "5511900001111" });
    connection = await waitForState(app, token, created.body.id, 2200);
    expect(connection.state).toBe("CONNECTED");
    expect(connection.connectedNumber).toBe("5511900001111");
  }, 15000);

  it("refuses to link a number that's already the linked number of a different connection, leaving that other connection untouched", async () => {
    await resetDatabase();
    await createTestUser({ email: "admin-dupnumber@test.dev", role: "ADMIN" });
    const token = await loginAs("admin-dupnumber@test.dev");

    const vendas = await request(app).post("/api/whatsapp/connections").set("Authorization", `Bearer ${token}`).send({ name: "Vendas" });
    await request(app)
      .post(`/api/whatsapp/connections/${vendas.body.id}/connect`)
      .set("Authorization", `Bearer ${token}`)
      .send({ phoneNumber: "5511900003333" });
    let vendasConnection = await waitForState(app, token, vendas.body.id, 2200);
    expect(vendasConnection.state).toBe("CONNECTED");
    expect(vendasConnection.linkedNumber).toBe("5511900003333");

    // A second, brand-new connection tries to pair with the SAME real number.
    const suporte = await request(app).post("/api/whatsapp/connections").set("Authorization", `Bearer ${token}`).send({ name: "Suporte2" });
    await request(app)
      .post(`/api/whatsapp/connections/${suporte.body.id}/connect`)
      .set("Authorization", `Bearer ${token}`)
      .send({ phoneNumber: "5511900003333" });
    const suporteConnection = await waitForState(app, token, suporte.body.id, 2200);

    expect(suporteConnection.state).not.toBe("CONNECTED");
    expect(suporteConnection.linkedNumber).toBeNull();

    // "Vendas" — already legitimately linked first — must be completely unaffected.
    vendasConnection = await waitForState(app, token, vendas.body.id, 0);
    expect(vendasConnection.state).toBe("CONNECTED");
    expect(vendasConnection.linkedNumber).toBe("5511900003333");
  }, 15000);
});
