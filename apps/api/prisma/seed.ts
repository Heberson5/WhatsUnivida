import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { seedEmail, seedPassword } from "./seed-credentials";
import { seedDemo } from "./seed-demo";

const prisma = new PrismaClient();

async function upsertConnection(name: string) {
  return prisma.whatsAppConnection.upsert({
    where: { name },
    update: {},
    create: { name },
  });
}

async function upsertUser(input: {
  email: string;
  fullName: string;
  displayName: string;
  role: "ADMIN" | "MANAGER" | "AGENT";
  password: string;
  whatsappConnectionId?: string;
}) {
  const passwordHash = await bcrypt.hash(input.password, 12);
  const existing = await prisma.user.findFirst({ where: { email: input.email, status: "ACTIVE" } });
  if (existing) return prisma.user.update({ where: { id: existing.id }, data: { whatsappConnectionId: input.whatsappConnectionId } });
  return prisma.user.create({
    data: {
      email: input.email,
      fullName: input.fullName,
      displayName: input.displayName,
      role: input.role,
      passwordHash,
      status: "ACTIVE",
      whatsappConnectionId: input.whatsappConnectionId,
    },
  });
}

async function main() {
  console.log("Seeding development connections and users (DEV ONLY — change all passwords before production)...");

  // Two named connections so the multi-WhatsApp scenario is demonstrable
  // out of the box: each agent below is a home to exactly one, but can
  // still receive a transferred conversation from the other.
  const suporte = await upsertConnection("Suporte");
  const vendas = await upsertConnection("Vendas");

  // Contas de desenvolvimento só num banco vazio, para que rodar o seed de
  // novo numa instalação em uso não crie logins extras. E-mail e senha vêm
  // de seed-credentials.ts — nada fica gravado no repositório.
  if ((await prisma.user.count()) === 0) {
    const password = seedPassword();
    await upsertUser({ email: seedEmail("admin"), fullName: "Administrador do Sistema", displayName: "Admin", role: "ADMIN", password });
    await upsertUser({ email: seedEmail("gestor"), fullName: "Gestora de Atendimento", displayName: "Gestora", role: "MANAGER", password });
    await upsertUser({ email: seedEmail("joao"), fullName: "Joao Pereira", displayName: "Joao", role: "AGENT", password, whatsappConnectionId: suporte.id });
    await upsertUser({ email: seedEmail("maria"), fullName: "Maria Fernandes", displayName: "Maria", role: "AGENT", password, whatsappConnectionId: vendas.id });
    console.log(`Contas de desenvolvimento: ${["admin", "gestor", "joao", "maria"].map(seedEmail).join(", ")} — senha ${password}`);
  }

  // A real admin account, provisioned only from environment variables so
  // its credentials never end up committed to the repo or printed in
  // documentation — pass SEED_ADMIN_EMAIL/SEED_ADMIN_PASSWORD (and
  // optionally SEED_ADMIN_NAME) when running this script. By default this
  // never touches an existing row's passwordHash (same as upsertUser
  // above), so re-running the seed can't silently reset a password that
  // was already changed through the app — but if you genuinely need to
  // reset a forgotten/mismatched password (e.g. bootstrapping the very
  // first login on a fresh deploy), also pass SEED_ADMIN_FORCE_RESET=true
  // to explicitly overwrite it.
  if (process.env.SEED_ADMIN_EMAIL && process.env.SEED_ADMIN_PASSWORD) {
    const email = process.env.SEED_ADMIN_EMAIL;
    const name = process.env.SEED_ADMIN_NAME ?? "Administrador";
    const forceReset = process.env.SEED_ADMIN_FORCE_RESET === "true";
    const passwordHash = await bcrypt.hash(process.env.SEED_ADMIN_PASSWORD, 12);
    // The active admin with this e-mail (e-mails only repeat across inactive users), or the most recent one.
    const existing =
      (await prisma.user.findFirst({ where: { email, status: "ACTIVE" } })) ?? (await prisma.user.findFirst({ where: { email }, orderBy: { createdAt: "desc" } }));
    if (existing) {
      if (forceReset) await prisma.user.update({ where: { id: existing.id }, data: { passwordHash, role: "ADMIN", status: "ACTIVE", deactivatedAt: null, deactivatedById: null } });
    } else {
      await prisma.user.create({ data: { email, fullName: name, displayName: name, role: "ADMIN", passwordHash, status: "ACTIVE" } });
    }
    console.log(`Admin provisionado a partir de variaveis de ambiente: ${email}${forceReset ? " (senha redefinida)" : ""}`);
  }

  // WhatsUnivida: conversas, grupos, chat interno e contatos de exemplo para
  // apresentação. SEED_DEMO=false pula esta parte.
  if (process.env.SEED_DEMO !== "false") await seedDemo(prisma);

  console.log("Seed completed.");
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
