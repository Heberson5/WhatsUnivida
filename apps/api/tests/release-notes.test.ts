import { describe, it, expect, beforeEach, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import request from "supertest";
import type { ReleaseContent } from "@whatsatendende/types";
import { createApp } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { DEFAULT_RELEASES } from "../src/modules/release-notes/default-releases";
import { releaseSchema } from "../src/modules/release-notes/release-notes.routes";
import { syncDefaultReleaseNotes } from "../src/modules/release-notes/release-notes.service";
import { resetDatabase, createTestUser, TEST_PASSWORD } from "./helpers";

const app = createApp();
const PUBLIC_DIR = path.resolve(__dirname, "../../web/public");
// A 1×1 PNG.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

const release = (overrides: Partial<ReleaseContent> = {}): ReleaseContent => ({
  version: "9.0.0",
  date: "09 out 2026",
  name: "Versão de teste",
  summary: "O que mudou.",
  notes: [{ type: "novo", area: "geral", title: "Uma novidade", text: "Para todo mundo." }],
  ...overrides,
});

async function tokenFor(email: string, role: "ADMIN" | "MANAGER" | "AGENT") {
  await createTestUser({ email, role });
  return (await request(app).post("/api/auth/login").send({ email, password: TEST_PASSWORD })).body.accessToken as string;
}

describe("Notas de versão no banco (Configurações › Notas de versão)", () => {
  beforeEach(async () => {
    await resetDatabase();
    await prisma.releaseNoteVersion.deleteMany();
  });

  afterAll(async () => {
    await prisma.releaseNoteVersion.deleteMany();
    await prisma.$disconnect();
  });

  it("as notas que vêm com o sistema são válidas e todas as imagens existem", () => {
    for (const shipped of DEFAULT_RELEASES) {
      expect(() => releaseSchema.parse(shipped), shipped.version).not.toThrow();
      for (const image of shipped.notes.flatMap((n) => n.images ?? [])) {
        expect(fs.existsSync(path.join(PUBLIC_DIR, image.src)), image.src).toBe(true);
      }
    }
    expect(new Set(DEFAULT_RELEASES.map((r) => r.version)).size).toBe(DEFAULT_RELEASES.length);
  });

  it("copia as versões do sistema uma vez: o que o administrador excluiu ou editou fica como ele deixou; versão nova entra", async () => {
    expect(await syncDefaultReleaseNotes()).toBe(DEFAULT_RELEASES.length);
    expect(await syncDefaultReleaseNotes()).toBe(0);

    const [newest, second] = DEFAULT_RELEASES;
    await prisma.releaseNoteVersion.delete({ where: { version: newest.version } });
    await prisma.releaseNoteVersion.update({ where: { version: second.version }, data: { name: "Editada pelo administrador" } });
    const shippedLater = release({ version: "99.0.0" });

    expect(await syncDefaultReleaseNotes([...DEFAULT_RELEASES, shippedLater])).toBe(1);
    expect(await prisma.releaseNoteVersion.findUnique({ where: { version: newest.version } })).toBeNull();
    expect((await prisma.releaseNoteVersion.findUniqueOrThrow({ where: { version: second.version } })).name).toBe("Editada pelo administrador");
    expect(await prisma.releaseNoteVersion.findUnique({ where: { version: "99.0.0" } })).not.toBeNull();
  });

  it("cada pessoa recebe só as notas das telas que pode abrir — a da apresentação só para gestão e administrador", async () => {
    await syncDefaultReleaseNotes();
    const title = "Apresentação de PowerPoint para a diretoria";
    const notesOf = async (token: string) =>
      ((await request(app).get("/api/release-notes").set("Authorization", `Bearer ${token}`)).body as ReleaseContent[]).flatMap((r) => r.notes.map((n) => n.title));

    expect(await notesOf(await tokenFor("admin-notas@test.dev", "ADMIN"))).toContain(title);
    expect(await notesOf(await tokenFor("gestor-notas@test.dev", "MANAGER"))).toContain(title);
    const agent = await notesOf(await tokenFor("agente-notas@test.dev", "AGENT"));
    expect(agent).not.toContain(title);
    expect(agent.length).toBeGreaterThan(0);
  });

  it("o administrador cria, edita e exclui; a mais nova (pelo número) vem primeiro", async () => {
    const auth = { Authorization: `Bearer ${await tokenFor("admin-crud@test.dev", "ADMIN")}` };
    expect((await request(app).post("/api/release-notes").set(auth).send(release({ version: "9.0.0" }))).status).toBe(201);
    const created = await request(app).post("/api/release-notes").set(auth).send(release({ version: "10.0.0", name: "Dez" }));
    expect(created.status).toBe(201);

    const listed = await request(app).get("/api/release-notes/all").set(auth);
    expect(listed.body.map((r: ReleaseContent) => r.version)).toEqual(["10.0.0", "9.0.0"]);

    const edited = await request(app)
      .put(`/api/release-notes/${created.body.id}`)
      .set(auth)
      .send(release({ version: "10.0.0", name: "Dez, revisada", notes: [{ type: "correcao", area: "atendimento", title: "Corrigido", before: "Dava erro", after: "Funciona" }] }));
    expect(edited.status).toBe(200);
    expect(edited.body.notes[0]).toMatchObject({ type: "correcao", before: "Dava erro", after: "Funciona" });

    const clash = await request(app).put(`/api/release-notes/${created.body.id}`).set(auth).send(release({ version: "9.0.0" }));
    expect(clash.status).toBe(409);
    expect(clash.body.message).toContain("Já existe a versão 9.0.0");

    expect((await request(app).delete(`/api/release-notes/${created.body.id}`).set(auth)).status).toBe(204);
    expect(await prisma.auditLog.count({ where: { action: { in: ["RELEASE_NOTES_CREATED", "RELEASE_NOTES_UPDATED", "RELEASE_NOTES_DELETED"] } } })).toBe(4);
  });

  it("recusa com uma explicação: Antes sem Agora, imagem de fora do sistema, versão sem número", async () => {
    const auth = { Authorization: `Bearer ${await tokenFor("admin-valida@test.dev", "ADMIN")}` };
    const post = (body: ReleaseContent) => request(app).post("/api/release-notes").set(auth).send(body);

    const onlyBefore = await post(release({ notes: [{ type: "melhoria", area: "geral", title: "Ok" }, { type: "melhoria", area: "geral", title: "Sem agora", before: "Era assim" }] }));
    expect(onlyBefore.status).toBe(400);
    expect(onlyBefore.body.message).toBe("Nota 2: Preencha o Antes e o Agora juntos (ou nenhum dos dois)");

    const external = await post(release({ notes: [{ type: "novo", area: "geral", title: "Print", images: [{ src: "https://example.com/x.png", caption: "" }] }] }));
    expect(external.status).toBe(400);

    expect((await post(release({ version: "versão nova" }))).status).toBe(400);
    expect((await post(release({ notes: [] }))).status).toBe(400);
  });

  it("envio de imagem: PNG vira um endereço do sistema que abre; outro tipo é recusado", async () => {
    const auth = { Authorization: `Bearer ${await tokenFor("admin-imagem@test.dev", "ADMIN")}` };
    const sent = await request(app).post("/api/release-notes/images").set(auth).attach("file", PNG, { filename: "print.png", contentType: "image/png" });
    expect(sent.status).toBe(201);
    expect(sent.body.src).toMatch(/^\/uploads\/release-notes\/[\w-]+\.png$/);
    const served = await request(app).get(sent.body.src);
    expect(served.status).toBe(200);
    expect(served.headers["content-type"]).toContain("image/png");

    const text = await request(app).post("/api/release-notes/images").set(auth).attach("file", Buffer.from("oi"), { filename: "nota.txt", contentType: "text/plain" });
    expect(text.status).toBe(400);
    expect(text.body.message).toBe("Envie uma imagem PNG, JPG ou WebP");
  });

  it("só o administrador mexe no cadastro", async () => {
    const auth = { Authorization: `Bearer ${await tokenFor("gestor-bloqueado@test.dev", "MANAGER")}` };
    expect((await request(app).get("/api/release-notes/all").set(auth)).status).toBe(403);
    expect((await request(app).post("/api/release-notes").set(auth).send(release())).status).toBe(403);
    expect((await request(app).post("/api/release-notes/images").set(auth).attach("file", PNG, { filename: "p.png", contentType: "image/png" })).status).toBe(403);
    expect((await request(app).get("/api/release-notes").set(auth)).status).toBe(200);
  });
});
