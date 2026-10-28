import type { DeliveryEvent } from "./types";

// Baileys WAMessageStatus enum: 0 ERROR,1 PENDING,2 SERVER_ACK,3 DELIVERY_ACK,4 READ,5 PLAYED
export function mapBaileysReceiptToStatus(receipt: number): DeliveryEvent["status"] | null {
  switch (receipt) {
    case 3:
      return "DELIVERED";
    case 4:
    case 5:
      return "READ";
    case 0:
      return "FAILED";
    default:
      return null;
  }
}

/** The part of a Baileys `messages.update` entry that matters here (structurally compatible with its WAMessageUpdate). */
export interface BaileysMessageUpdate {
  key: { id?: string | null; remoteJid?: string | null };
  update: { status?: number | null; messageStubParameters?: readonly string[] | null };
}

/**
 * What a Baileys `messages.update` entry means for a message this app sent, or
 * null when it says nothing about delivery (an edit, a pin, SERVER_ACK...).
 *
 * Status 0 (ERROR) is a real status and has to get through: it is how Baileys
 * reports the ack in which WhatsApp's server REJECTED a message it had just
 * received (the error code rides in messageStubParameters). A truthiness check
 * on the status used to drop it together with "no status in this update", so a
 * message WhatsApp refused stayed on a single ✓ in Atendimento forever, as if
 * it had been sent, while the customer never got it.
 */
export function deliveryEventFromBaileysUpdate(entry: BaileysMessageUpdate, now: Date = new Date()): DeliveryEvent | null {
  const receipt = entry.update?.status;
  if (receipt === undefined || receipt === null) return null;
  const status = mapBaileysReceiptToStatus(receipt);
  if (!status) return null;
  const errorCode = status === "FAILED" ? entry.update.messageStubParameters?.[0] : undefined;
  return {
    providerMessageId: entry.key.id ?? "",
    chatId: entry.key.remoteJid ?? "",
    status,
    ...(errorCode ? { errorCode: String(errorCode) } : {}),
    timestamp: now,
  };
}
