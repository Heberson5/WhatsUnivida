import { describe, it, expect, afterAll, beforeAll } from "vitest";
import request from "supertest";
import { createApp } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { resetDatabase, createTestUser, TEST_PASSWORD } from "./helpers";

const app = createApp();

async function attendantsAs(email: string) {
  const login = await request(app).post("/api/auth/login").send({ email, password: TEST_PASSWORD });
  return request(app).get("/api/agents/attendants").set("Authorization", `Bearer ${login.body.accessToken}`);
}

// See PROMPT: "Em gestão no acesso de administrador, poderá ver na lista de atendentes o próprio nome e de algum
// gestor, pois ambos podem atender algum cliente, mas o gestor não poderá ver o administrador na lista dos filtros."
describe("Gestão › filtro de atendentes", () => {
  beforeAll(async () => {
    await resetDatabase();
    await createTestUser({ email: "admin-filtro@test.dev", role: "ADMIN", displayName: "Admin" });
    await createTestUser({ email: "gestora-filtro@test.dev", role: "MANAGER", displayName: "Gestora" });
    await createTestUser({ email: "maria-filtro@test.dev", role: "AGENT", displayName: "Maria" });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("o administrador vê os atendentes, os gestores e o próprio nome", async () => {
    const res = await attendantsAs("admin-filtro@test.dev");
    expect(res.status).toBe(200);
    expect(res.body.map((u: { displayName: string; role: string; isSelf: boolean }) => [u.displayName, u.role, u.isSelf])).toEqual([
      ["Admin", "ADMIN", true],
      ["Gestora", "MANAGER", false],
      ["Maria", "AGENT", false],
    ]);
  });

  it("o gestor vê os atendentes e os gestores, nunca o administrador", async () => {
    const res = await attendantsAs("gestora-filtro@test.dev");
    expect(res.status).toBe(200);
    expect(res.body.map((u: { displayName: string; isSelf: boolean }) => [u.displayName, u.isSelf])).toEqual([
      ["Gestora", true],
      ["Maria", false],
    ]);
  });

  it("o atendente não acessa a lista", async () => {
    expect((await attendantsAs("maria-filtro@test.dev")).status).toBe(403);
  });
});
