import { Errors } from "./http-error";

/**
 * What a password has to be, wherever one is chosen (a new user, Meu Perfil, the reset link, an administrator setting
 * one): at least 8 characters, with a letter and a number, not one of the passwords every attack tries first, and not
 * the person's own name or e-mail. The message says what is wrong, in the words the form shows.
 */

// The passwords tried first in any attack (most used in Brazil and worldwide), compared with no accents, spaces or
// case — and with the usual endings ("123", "@2026", "!") taken off, so "Senha@123" is the same as "senha".
const COMMON = new Set([
  "password", "passw0rd", "senha", "senhas", "minhasenha", "mudar", "trocar", "admin", "administrador", "administrator", "root", "user", "usuario",
  "teste", "test", "testando", "qwerty", "qwertyuiop", "asdfgh", "asdfghjkl", "zxcvbnm", "qazwsx", "abc", "abcd", "abcdef", "abcdefgh", "iloveyou",
  "teamo", "amor", "brasil", "brazil", "flamengo", "corinthians", "palmeiras", "saopaulo", "vasco", "gremio", "santos", "cruzeiro", "futebol", "deus",
  "jesus", "jesuscristo", "familia", "felicidade", "sucesso", "welcome", "bemvindo", "letmein", "login", "master", "dragon", "monkey", "football",
  "princesa", "gabriel", "rafael", "lucas", "maria", "joao", "pedro", "ana", "whatsapp", "atendimento", "atendente", "sistema", "empresa", "clinica",
  "suporte", "gestor", "mudar123", "changeme", "default", "segredo", "secret",
]);

const fold = (text: string) =>
  text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();

/** The word left once digits, symbols and spaces are taken off: "Senha@2026!" → "senha". */
const core = (password: string) => fold(password).replace(/[^a-z]/g, "");

function isSequenceOrRepeat(password: string): boolean {
  const p = fold(password);
  if (/^(.)\1+$/.test(p)) return true; // "aaaaaaaa", "11111111"
  if (/^(.{1,4})\1+$/.test(p)) return true; // "abcabcabc", "12121212"
  const digits = p.replace(/\D/g, "");
  // Only a run of digits going up or down ("12345678", "87654321"), with or without a couple of other characters around.
  if (digits.length >= 6 && digits.length >= p.length - 2 && ("01234567890123456789".includes(digits) || "98765432109876543210".includes(digits))) return true;
  return false;
}

export interface PasswordOwner {
  email?: string | null;
  fullName?: string | null;
  displayName?: string | null;
}

/** Why this password can't be used, or null when it can. */
export function passwordProblem(password: string, owner: PasswordOwner = {}): string | null {
  if (password.length < 8) return "A senha precisa ter pelo menos 8 caracteres";
  if (password.length > 128) return "A senha pode ter no máximo 128 caracteres";
  if (!/\p{L}/u.test(password) || !/\d/.test(password)) return "A senha precisa ter pelo menos uma letra e um número";
  if (isSequenceOrRepeat(password)) return "Escolha uma senha menos óbvia: evite sequências e repetições";
  const word = core(password);
  if (word.length === 0 || COMMON.has(word) || COMMON.has(fold(password).replace(/\s/g, ""))) {
    return "Esta senha é muito comum e fácil de adivinhar. Escolha outra";
  }
  const personal = [owner.email?.split("@")[0], ...(owner.fullName ?? "").split(/\s+/), ...(owner.displayName ?? "").split(/\s+/)]
    .map((part) => core(part ?? ""))
    .filter((part) => part.length >= 4);
  if (personal.some((part) => word === part)) return "A senha não pode ser o seu nome ou o seu e-mail";
  return null;
}

export function assertPasswordAllowed(password: string, owner: PasswordOwner = {}): void {
  const problem = passwordProblem(password, owner);
  if (problem) throw Errors.badRequest(problem);
}
