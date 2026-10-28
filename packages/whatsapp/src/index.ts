export * from "./types";
export { MockWhatsAppProvider } from "./MockWhatsAppProvider";
export type { MockProviderOptions } from "./MockWhatsAppProvider";
export { BaileysWhatsAppProvider } from "./BaileysWhatsAppProvider";
export type { BaileysProviderOptions } from "./BaileysWhatsAppProvider";

import type { WhatsAppProvider } from "./types";
import { MockWhatsAppProvider } from "./MockWhatsAppProvider";
import { BaileysWhatsAppProvider } from "./BaileysWhatsAppProvider";

export interface CreateProviderOptions {
  provider: "mock" | "baileys";
  authStateDir?: string;
  /** Opcoes do simulador — so usadas quando o provedor efetivo e "mock". */
  mock?: import("./MockWhatsAppProvider").MockProviderOptions;
}

/** Factory: the only place in the app that knows concrete provider classes exist. */
export function createWhatsAppProvider(options: CreateProviderOptions): WhatsAppProvider {
  if (options.provider === "baileys") {
    return new BaileysWhatsAppProvider({ authStateDir: options.authStateDir ?? "./whatsapp-sessions" });
  }
  return new MockWhatsAppProvider(options.mock);
}
