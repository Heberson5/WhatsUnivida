import { randomBytes } from "node:crypto";

// Logins e senhas das contas de exemplo nunca ficam no repositório: o domínio
// dos e-mails vem de SEED_EMAIL_DOMAIN e a senha de SEED_USERS_PASSWORD. Sem
// essa variável, cada execução sorteia uma senha nova e a mostra só no console.
export const SEED_EMAIL_DOMAIN = process.env.SEED_EMAIL_DOMAIN ?? "exemplo.com";

let generated: string | undefined;
export function seedPassword() {
  return process.env.SEED_USERS_PASSWORD ?? (generated ??= `${randomBytes(9).toString("base64url")}#7a`);
}

export const seedEmail = (handle: string) => `${handle}@${SEED_EMAIL_DOMAIN}`;
