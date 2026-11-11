import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { PERMISSION, PERMISSION_DEFINITIONS } from "@whatsatendende/types";
import { createApp } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { resetDatabase, createTestUser, TEST_PASSWORD } from "./helpers";

// See PROMPT: "As permissões de administrador não aparecem para o gestor na guia de permissões, também não deve
// aparecer as permissões que são exclusivas para o administrador" — the Gestor edits only the Atendente's.

const app = createApp();
const login = async (email: string) => (await request(app).post("/api/auth/login").send({ email, password: TEST_PASSWORD })).body.accessToken as string;

describe("Configurações › Permissões para o Gestor", () => {
  let admin: string;
  let manager: string;
  let agent: string;
  const get = (token: string) => request(app).get("/api/permissions").set("Authorization", `Bearer ${token}`);
  const put = (token: string, entries: unknown[]) => request(app).put("/api/permissions").set("Authorization", `Bearer ${token}`).send({ entries });

  beforeAll(async () => {
    await resetDatabase();
    await createTestUser({ email: "admin-perm@test.dev", role: "ADMIN" });
    await createTestUser({ email: "gestor-perm@test.dev", role: "MANAGER" });
    await createTestUser({ email: "agente-perm@test.dev", role: "AGENT" });
    admin = await login("admin-perm@test.dev");
    manager = await login("gestor-perm@test.dev");
    agent = await login("agente-perm@test.dev");
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("o Administrador continua vendo tudo: os três perfis e todas as permissões", async () => {
    const res = await get(admin);
    expect(res.status).toBe(200);
    expect(Object.keys(res.body.matrix).sort()).toEqual(["ADMIN", "AGENT", "MANAGER"]);
    expect(res.body.definitions).toHaveLength(PERMISSION_DEFINITIONS.length);
  });

  it("o Gestor vê só a coluna do Atendente, só com permissões oferecidas ao Atendente que o próprio Gestor tem", async () => {
    const full = (await get(admin)).body.matrix as Record<string, Record<string, boolean>>;
    const res = await get(manager);
    expect(res.status).toBe(200);
    expect(Object.keys(res.body.matrix)).toEqual(["AGENT"]); // no Gestor column, no Administrador column

    const keys: string[] = res.body.definitions.map((d: { key: string }) => d.key);
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      const def = PERMISSION_DEFINITIONS.find((d) => d.key === key)!;
      expect(def.editableRoles).toContain("AGENT");
      expect(full.MANAGER[key]).toBe(true);
    }
    // Nothing exclusive to the Administrador or to the Gestor, and nothing the Gestor doesn't have.
    const exclusive = PERMISSION_DEFINITIONS.filter((d) => !d.editableRoles.includes("AGENT")).map((d) => d.key as string);
    expect(exclusive.length).toBeGreaterThan(0);
    expect(keys.filter((k) => exclusive.includes(k))).toEqual([]);
    expect(keys).not.toContain(PERMISSION.CONFIGURACOES_PERMISSOES_ATENDENTE_EDITAR);
    const managerLacks = PERMISSION_DEFINITIONS.filter((d) => d.editableRoles.includes("AGENT") && !full.MANAGER[d.key]).map((d) => d.key as string);
    expect(managerLacks.length).toBeGreaterThan(0);
    expect(keys.filter((k) => managerLacks.includes(k))).toEqual([]);
    expect(Object.keys(res.body.matrix.AGENT).sort()).toEqual([...keys].sort());
  });

  it("o Gestor altera uma permissão do Atendente e ela passa a valer", async () => {
    const before = (await get(manager)).body;
    const key = before.definitions.map((d: { key: string }) => d.key).find((k: string) => before.matrix.AGENT[k] === true && k !== PERMISSION.ATENDIMENTO_ACESSAR) as string;
    const res = await put(manager, [{ role: "AGENT", permission: key, allowed: false }]);
    expect(res.status).toBe(200);
    expect(Object.keys(res.body.matrix)).toEqual(["AGENT"]);
    expect(res.body.matrix.AGENT[key]).toBe(false);
    expect((await request(app).get("/api/permissions/me").set("Authorization", `Bearer ${agent}`)).body[key]).toBe(false);
    expect(await prisma.auditLog.count({ where: { action: "PERMISSIONS_UPDATED" } })).toBe(1);
    await put(admin, [{ role: "AGENT", permission: key, allowed: true }]).expect(200);
  });

  it("o Gestor não altera o próprio perfil, nem dá ao Atendente o que ele mesmo não tem ou o que é exclusivo", async () => {
    const full = (await get(admin)).body.matrix as Record<string, Record<string, boolean>>;
    const own = await put(manager, [{ role: "MANAGER", permission: PERMISSION.CONFIGURACOES_GERENCIAR, allowed: true }]);
    expect(own.status).toBe(403);

    const lacking = PERMISSION_DEFINITIONS.find((d) => d.editableRoles.includes("AGENT") && !full.MANAGER[d.key])!.key;
    expect((await put(manager, [{ role: "AGENT", permission: lacking, allowed: true }])).status).toBe(403);

    const exclusive = PERMISSION_DEFINITIONS.find((d) => !d.editableRoles.includes("AGENT"))!.key;
    expect((await put(manager, [{ role: "AGENT", permission: exclusive, allowed: true }])).status).toBe(403);

    // One entry outside what the Gestor may edit refuses the whole save — the allowed one is not applied either.
    const allowedKey = (await get(manager)).body.definitions[0].key as string;
    const current = full.AGENT[allowedKey];
    expect((await put(manager, [{ role: "AGENT", permission: allowedKey, allowed: !current }, { role: "MANAGER", permission: lacking, allowed: true }])).status).toBe(403);
    const after = (await get(admin)).body.matrix;
    expect(after.AGENT[allowedKey]).toBe(current);
    expect(after.MANAGER[lacking]).toBe(false);
    expect(after.AGENT[lacking]).toBe(full.AGENT[lacking]);
  });

  it("sem a permissão, o Gestor não abre a aba; o Atendente nunca abre", async () => {
    expect((await get(agent)).status).toBe(403);
    expect((await put(agent, [])).status).toBe(403);
    await put(admin, [{ role: "MANAGER", permission: PERMISSION.CONFIGURACOES_PERMISSOES_ATENDENTE_EDITAR, allowed: false }]).expect(200);
    expect((await get(manager)).status).toBe(403);
    expect((await put(manager, [{ role: "AGENT", permission: PERMISSION.ATENDIMENTO_ACESSAR, allowed: false }])).status).toBe(403);
  });
});
