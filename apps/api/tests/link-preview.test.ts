import { describe, it, expect, beforeEach, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import request from "supertest";
import { createApp } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { getLinkPreview, isPrivateAddress, parsePreviewHtml } from "../src/modules/link-preview/link-preview.service";
import { resetDatabase, createTestUser, TEST_PASSWORD } from "./helpers";

const app = createApp();

describe("prévia de links", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("lê título, descrição e imagem do HTML (Open Graph, ou o <title> como alternativa)", () => {
    const og = parsePreviewHtml(
      `<html><head><title>Ignorado</title><meta property="og:title" content="Loja &amp; Cia"><meta content="Tudo para você" property="og:description"><meta property="og:image" content="/foto.jpg"></head></html>`
    );
    expect(og).toEqual({ title: "Loja & Cia", description: "Tudo para você", image: "/foto.jpg" });
    expect(parsePreviewHtml("<title>Só o título</title>")).toEqual({ title: "Só o título", description: null, image: null });
  });

  it("reconhece endereços internos, inclusive IPv4 dentro de IPv6", () => {
    for (const a of ["127.0.0.1", "10.1.2.3", "192.168.0.5", "172.16.0.1", "169.254.169.254", "::1", "fd00::1", "::ffff:127.0.0.1", "0.0.0.0"]) {
      expect(isPrivateAddress(a), a).toBe(true);
    }
    for (const a of ["8.8.8.8", "172.32.0.1", "2606:4700:4700::1111"]) expect(isPrivateAddress(a), a).toBe(false);
  });

  it("nunca busca um endereço interno, mesmo que o servidor exista e responda", async () => {
    let hits = 0;
    const server = http.createServer((_req, res) => {
      hits++;
      res.setHeader("content-type", "text/html");
      res.end("<title>Segredo interno</title>");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    try {
      expect(await getLinkPreview(`http://127.0.0.1:${port}/`)).toBeNull();
      expect(await getLinkPreview(`http://localhost:${port}/`)).toBeNull();
      expect(hits).toBe(0);
    } finally {
      server.close();
    }
  });

  it("a rota exige login e valida a URL", async () => {
    expect((await request(app).get("/api/link-preview").query({ url: "https://exemplo.com" })).status).toBe(401);
    await createTestUser({ email: "agente@test.dev", role: "AGENT" });
    const login = await request(app).post("/api/auth/login").send({ email: "agente@test.dev", password: TEST_PASSWORD });
    const token = login.body.accessToken as string;
    expect((await request(app).get("/api/link-preview").query({ url: "nao-e-url" }).set("Authorization", `Bearer ${token}`)).status).toBe(400);
    const blocked = await request(app).get("/api/link-preview").query({ url: "http://127.0.0.1:1/" }).set("Authorization", `Bearer ${token}`);
    expect(blocked.status).toBe(200);
    expect(blocked.body).toBeNull();
  });
});
