import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import { createApp } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { resetDatabase, createTestUser, TEST_PASSWORD } from "./helpers";
import { findApplicableHoliday } from "../src/modules/holidays/holidays.service";

const app = createApp();

describe("Feriados que repetem todo ano", () => {
  let token: string;
  beforeEach(async () => {
    await resetDatabase();
    await prisma.holiday.deleteMany();
    await createTestUser({ email: "admin-fer@test.dev", role: "ADMIN" });
    token = (await request(app).post("/api/auth/login").send({ email: "admin-fer@test.dev", password: TEST_PASSWORD })).body.accessToken;
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  const create = (body: Record<string, unknown>) => request(app).post("/api/holidays").set("Authorization", `Bearer ${token}`).send(body);

  it("anual vale no mesmo dia e mês de qualquer ano; o de um ano só, não", async () => {
    await create({ date: "2026-03-19", name: "Aniversário da cidade", scope: "MUNICIPAL", state: "MT", city: "Tangará da Serra", recurringYearly: true }).expect(201);
    await create({ date: "2026-06-05", name: "Ponto facultativo", scope: "MUNICIPAL", state: "MT", city: "Tangará da Serra" }).expect(201);

    expect(await findApplicableHoliday("2028-03-19", "MT", "Tangará da Serra")).toEqual({ name: "Aniversário da cidade" });
    expect(await findApplicableHoliday("2026-06-05", "MT", "Tangará da Serra")).toEqual({ name: "Ponto facultativo" });
    expect(await findApplicableHoliday("2027-06-05", "MT", "Tangará da Serra")).toBeNull();
    expect(await findApplicableHoliday("2028-03-19", "MT", "Cuiabá")).toBeNull();
  });

  it("aparece na lista de outro ano, na data daquele ano, marcado como anual", async () => {
    await create({ date: "2026-03-19", name: "Aniversário da cidade", scope: "NATIONAL", recurringYearly: true }).expect(201);
    const list = await request(app).get("/api/holidays").query({ year: 2030 }).set("Authorization", `Bearer ${token}`);
    expect(list.body).toEqual([expect.objectContaining({ name: "Aniversário da cidade", date: "2030-03-19", recurringYearly: true, year: 2030 })]);
  });

  it("o feriado manual pode ser editado, inclusive para passar a repetir todo ano", async () => {
    const created = await create({ date: "2026-08-10", name: "Festa", scope: "NATIONAL" }).expect(201);
    const edited = await request(app)
      .patch(`/api/holidays/${created.body.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Festa do padroeiro", date: "2026-08-11", recurringYearly: true });
    expect(edited.status).toBe(200);
    expect(edited.body).toMatchObject({ name: "Festa do padroeiro", date: "2026-08-11", recurringYearly: true });
    expect(await findApplicableHoliday("2031-08-11", null, null)).toEqual({ name: "Festa do padroeiro" });
  });
});
