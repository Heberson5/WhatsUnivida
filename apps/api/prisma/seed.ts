import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { removeDemoData, seedDemoData } from "./demo-data";

const prisma = new PrismaClient();

async function upsertUser(input: {
  email: string;
  fullName: string;
  displayName: string;
  role: "ADMIN" | "MANAGER" | "AGENT";
  password: string;
  whatsappConnectionId?: string;
}) {
  const passwordHash = await bcrypt.hash(input.password, 12);
  return prisma.user.upsert({
    where: { email: input.email },
    update: { whatsappConnectionId: input.whatsappConnectionId },
    create: {
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

  await upsertUser({
    email: "admin@whatsunivida.dev",
    fullName: "Administrador do Sistema",
    displayName: "Admin",
    role: "ADMIN",
    password: process.env.SEED_DEMO_PASSWORD ?? "***REMOVIDO***",
  });

  await upsertUser({
    email: "gestor@whatsunivida.dev",
    fullName: "Gestora de Atendimento",
    displayName: "Gestora",
    role: "MANAGER",
    password: process.env.SEED_DEMO_PASSWORD ?? "***REMOVIDO***",
  });

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
    await prisma.user.upsert({
      where: { email },
      update: forceReset ? { passwordHash, role: "ADMIN", status: "ACTIVE" } : {},
      create: { email, fullName: name, displayName: name, role: "ADMIN", passwordHash, status: "ACTIVE" },
    });
    console.log(`Admin provisionado a partir de variaveis de ambiente: ${email}${forceReset ? " (senha redefinida)" : ""}`);
  }

  // Dados de demonstracao (conexoes simuladas, atendentes, contatos, conversas...).
  // Desligue com SEED_DEMO_DATA=false; recrie com SEED_DEMO_FORCE=true.
  if (process.env.SEED_DEMO_REMOVE === "true") {
    await removeDemoData(prisma);
  } else if (process.env.SEED_DEMO_DATA !== "false") {
    await seedDemoData(prisma);
  }

  console.log("Seed completed.");
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
