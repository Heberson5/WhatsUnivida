export * from "./types";
export { MockWhatsAppProvider } from "./MockWhatsAppProvider";
export { BaileysWhatsAppProvider } from "./BaileysWhatsAppProvider";
export type { BaileysProviderOptions } from "./BaileysWhatsAppProvider";
export { deliveryEventFromBaileysUpdate } from "./delivery-status";
export type { BaileysMessageUpdate } from "./delivery-status";
export { reactionEventFromBaileys } from "./reaction-event";
export { decryptPollVoteOptions, pollInfoOf, pollOptionHash, pollCreationOf } from "./poll-vote";
export type { PollInfo, EncryptedPollVote } from "./poll-vote";
export { groupSenderFromBaileys, isGroupChat } from "./group-message";
export type { BaileysGroupMessageKey } from "./group-message";
export type { BaileysReactionEntry } from "./reaction-event";
export { CloudApiWhatsAppProvider } from "./CloudApiWhatsAppProvider";
export type { CloudApiProviderOptions, CloudApiWebhookValue, TemplateSendInput } from "./CloudApiWhatsAppProvider";

import type { WhatsAppProvider } from "./types";
import { MockWhatsAppProvider } from "./MockWhatsAppProvider";
import { BaileysWhatsAppProvider } from "./BaileysWhatsAppProvider";
import { CloudApiWhatsAppProvider } from "./CloudApiWhatsAppProvider";

export type CreateProviderOptions =
  | { provider: "mock" | "baileys"; authStateDir?: string }
  // WhatsApp Oficial (Cloud API) — per-connection credentials rather than a
  // single global provider kind, since every connection has its own
  // phoneNumberId/accessToken (see WhatsAppConnection.connectionMode).
  | { provider: "cloud-api"; phoneNumberId: string; accessToken: string; graphApiBaseUrl?: string };

/** Factory: the only place in the app that knows concrete provider classes exist. */
export function createWhatsAppProvider(options: CreateProviderOptions): WhatsAppProvider {
  if (options.provider === "baileys") {
    return new BaileysWhatsAppProvider({ authStateDir: options.authStateDir ?? "./whatsapp-sessions" });
  }
  if (options.provider === "cloud-api") {
    return new CloudApiWhatsAppProvider({ phoneNumberId: options.phoneNumberId, accessToken: options.accessToken, graphApiBaseUrl: options.graphApiBaseUrl });
  }
  return new MockWhatsAppProvider();
}
