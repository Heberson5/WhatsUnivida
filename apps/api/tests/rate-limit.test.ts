import { afterEach, beforeEach, describe, expect, it } from "vitest";
import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { env } from "../src/config/env";
import { apiLimiter, loginLimiters, userActionLimiter } from "../src/lib/rate-limit";
import { signAccessToken } from "../src/modules/auth/jwt";

// A whole office shares one public IP: the limits must be per signed-in person, or a dozen open screens are enough
// to have everybody refused. Every request below comes from the same address (supertest), as in that office.

const tokenFor = (userId: string) => signAccessToken({ sub: userId, role: "AGENT", displayName: userId, sid: `sid-${userId}` });

function appWith(...handlers: express.RequestHandler[]) {
  const app = express();
  app.use(express.json());
  app.use(...handlers);
  app.all("*", (req, res) => res.status(req.body?.fail ? 401 : 200).json({ ok: true }));
  return app;
}

async function hit(app: express.Express, path: string, token?: string, times = 1) {
  const statuses: number[] = [];
  for (let i = 0; i < times; i++) {
    const req = request(app).get(path);
    statuses.push((await (token ? req.set("Authorization", `Bearer ${token}`) : req)).status);
  }
  return statuses;
}

describe("limite de requisições", () => {
  const saved = { user: env.RATE_LIMIT_MAX, anon: env.RATE_LIMIT_ANON_MAX };
  beforeEach(() => {
    env.RATE_LIMIT_MAX = 3;
    env.RATE_LIMIT_ANON_MAX = 5;
  });
  afterEach(() => {
    env.RATE_LIMIT_MAX = saved.user;
    env.RATE_LIMIT_ANON_MAX = saved.anon;
  });

  it("conta por usuário: um atendente no limite não bloqueia o colega do mesmo IP", async () => {
    const app = appWith(apiLimiter());
    expect(await hit(app, "/api/conversations/queue", tokenFor("ana"), 4)).toEqual([200, 200, 200, 429]);
    expect(await hit(app, "/api/conversations/queue", tokenFor("carlos"), 3)).toEqual([200, 200, 200]);
  });

  it("responde 429 em JSON, com uma mensagem que a tela mostra", async () => {
    const app = appWith(apiLimiter());
    const token = tokenFor("ana");
    await hit(app, "/api/x", token, 3);
    const res = await request(app).get("/api/x").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(429);
    expect(res.body).toEqual({ error: "TOO_MANY_REQUESTS", message: expect.stringContaining("Muitas requisições") });
  });

  it("sem sessão, conta por IP com o limite próprio", async () => {
    const app = appWith(apiLimiter());
    expect(await hit(app, "/api/settings/branding", undefined, 6)).toEqual([200, 200, 200, 200, 200, 429]);
    // Quem está logado nesse mesmo IP continua com a sua própria cota.
    expect(await hit(app, "/api/conversations/mine", tokenFor("ana"), 1)).toEqual([200]);
  });

  it("token expirado ainda conta para o próprio usuário, não para o IP", async () => {
    const app = appWith(apiLimiter());
    const expired = jwt.sign({ sub: "ana", role: "AGENT", displayName: "Ana", sid: "s" }, env.JWT_ACCESS_SECRET, { algorithm: "HS256", expiresIn: -60 });
    expect(await hit(app, "/api/x", expired, 4)).toEqual([200, 200, 200, 429]);
    expect(await hit(app, "/api/x", undefined, 5)).toEqual([200, 200, 200, 200, 200]);
  });

  it("token forjado não ganha cota de usuário: conta por IP", async () => {
    const app = appWith(apiLimiter());
    const forged = jwt.sign({ sub: "ana" }, "outro-segredo-qualquer-com-mais-de-32-caracteres", { algorithm: "HS256" });
    await hit(app, "/api/x", forged, 3);
    // Já gastou 3 das 5 do IP: sobram 2 para quem não tem sessão.
    expect(await hit(app, "/api/x", undefined, 3)).toEqual([200, 200, 429]);
  });

  it("token na query (download de anexo) também identifica o usuário", async () => {
    const app = appWith(apiLimiter());
    const path = `/api/messages/attachments/1/download?token=${encodeURIComponent(tokenFor("ana"))}`;
    expect(await hit(app, path, undefined, 4)).toEqual([200, 200, 200, 429]);
    expect(await hit(app, "/api/x", undefined, 5)).toEqual([200, 200, 200, 200, 200]);
  });

  it("fotos, logos e a verificação de saúde ficam fora da contagem", async () => {
    const app = appWith(apiLimiter());
    expect((await hit(app, "/uploads/profile/a.png", undefined, 20)).every((s) => s === 200)).toBe(true);
    expect((await hit(app, "/api/health", undefined, 20)).every((s) => s === 200)).toBe(true);
    expect(await hit(app, "/api/x", undefined, 5)).toEqual([200, 200, 200, 200, 200]);
  });

  it("limite de uma ação (ex.: e-mail de teste) também é por usuário", async () => {
    const app = appWith(userActionLimiter({ windowMs: 60_000, limit: 2 }));
    expect(await hit(app, "/api/settings/email/test", tokenFor("ana"), 3)).toEqual([200, 200, 429]);
    expect(await hit(app, "/api/settings/email/test", tokenFor("carlos"), 2)).toEqual([200, 200]);
  });
});

describe("limite de tentativas de login", () => {
  const login = (app: express.Express, email: string, fail: boolean) => request(app).post("/api/auth/login").send({ email, password: "x", fail });

  it("logins certos nunca contam: 50 pessoas do mesmo escritório entram de manhã", async () => {
    const app = appWith(...loginLimiters());
    for (let i = 0; i < 50; i++) expect((await login(app, `pessoa${i}@exemplo.com`, false)).status).toBe(200);
    for (let i = 0; i < 15; i++) expect((await login(app, "ana@exemplo.com", false)).status).toBe(200);
  });

  it("10 senhas erradas para o mesmo e-mail bloqueiam esse e-mail, e só ele", async () => {
    const app = appWith(...loginLimiters());
    for (let i = 0; i < 10; i++) expect((await login(app, "Ana@Exemplo.com", true)).status).toBe(401);
    const blocked = await login(app, "ana@exemplo.com", false);
    expect(blocked.status).toBe(429);
    expect(blocked.body.message).toContain("Muitas tentativas de login");
    expect((await login(app, "carlos@exemplo.com", false)).status).toBe(200);
  });

  it("100 senhas erradas do mesmo IP bloqueiam o IP, mesmo trocando de e-mail", async () => {
    const app = appWith(...loginLimiters());
    for (let i = 0; i < 100; i++) expect((await login(app, `alvo${i}@exemplo.com`, true)).status).toBe(401);
    expect((await login(app, "outro@exemplo.com", false)).status).toBe(429);
  });
});
