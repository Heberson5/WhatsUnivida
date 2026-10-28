import { normalizeTypedPhone } from "@whatsatendende/types";
import { logger } from "../../lib/logger";
import { prisma } from "../../lib/prisma";
import { Errors } from "../../lib/http-error";
import * as whatsappService from "../whatsapp/whatsapp.service";
import { getPhoneSettings } from "./phone-settings.service";

export interface ResolvedNumber {
  /** What to use: the number WhatsApp knows, or — when it doesn't know any form, or couldn't be asked — the typed number after the settings' rules. */
  phone: string;
  /** The typed number after the settings' rules, before asking WhatsApp. */
  normalized: string;
  /** true/false when WhatsApp answered; null when it couldn't be asked right now. */
  exists: boolean | null;
  /** A WhatsApp Oficial connection with no connected QR Code connection to ask through — nothing could be checked. */
  unverifiable: boolean;
  /** The QR Code connection that answered for a WhatsApp Oficial one. */
  checkedByConnectionName: string | null;
}

/**
 * Who answers "does this number have WhatsApp": a QR Code connection asks through itself; the WhatsApp Oficial
 * (Cloud API) has no such query, so the connected QR Code connections are asked instead, one after the other.
 */
async function lookupConnections(connectionId: string): Promise<{ id: string; name: string }[]> {
  const connection = await prisma.whatsAppConnection.findUniqueOrThrow({ where: { id: connectionId }, select: { id: true, name: true, connectionMode: true } });
  if (connection.connectionMode !== "OFFICIAL_API") return [connection];
  return prisma.whatsAppConnection.findMany({ where: { connectionMode: "QRCODE", status: "CONNECTED" }, select: { id: true, name: true }, orderBy: { name: "asc" } });
}

/** Asks WhatsApp about each form of the number in turn; the first one it knows wins, and its own spelling of the number is what comes back. */
async function confirmWithWhatsApp(connectionId: string, normalized: string, alternates: string[]): Promise<ResolvedNumber> {
  const askers = await lookupConnections(connectionId);
  const official = askers.length === 0 || askers[0].id !== connectionId;
  if (askers.length === 0) return { phone: normalized, normalized, exists: null, unverifiable: true, checkedByConnectionName: null };

  for (const asker of askers) {
    let answered = false;
    for (const candidate of [normalized, ...alternates]) {
      try {
        const found = await whatsappService.lookupNumber(asker.id, candidate);
        answered = true;
        if (found) return { phone: found.phone, normalized, exists: true, unverifiable: false, checkedByConnectionName: official ? asker.name : null };
      } catch (err) {
        logger.warn({ err, connectionId: asker.id }, "could not ask WhatsApp whether a number exists");
      }
    }
    // This connection answered "no such number": that is the answer. Otherwise try the next QR Code connection.
    if (answered) return { phone: normalized, normalized, exists: false, unverifiable: false, checkedByConnectionName: official ? asker.name : null };
  }
  return { phone: normalized, normalized, exists: null, unverifiable: false, checkedByConnectionName: null };
}

/** For the number being typed in Nova conversa: applies the settings, then confirms the number (and, if the 9 was dropped, its other form) on WhatsApp. */
export async function resolveTypedNumber(connectionId: string, typed: string): Promise<ResolvedNumber> {
  const { phone, alternates } = normalizeTypedPhone(typed, await getPhoneSettings());
  return confirmWithWhatsApp(connectionId, phone, alternates);
}

/**
 * For actually starting a conversation — every way of starting one goes through here. Only a number that has
 * WhatsApp starts: one WhatsApp doesn't know is refused, and so is one it couldn't be asked about right now. The
 * only exception is a WhatsApp Oficial connection with no connected QR Code connection to ask through.
 */
export async function resolveNumberToStart(connectionId: string, typed: string): Promise<{ phone: string; confirmedOnWhatsApp: boolean }> {
  const { phone, alternates } = normalizeTypedPhone(typed, await getPhoneSettings());
  // A customer WhatsApp already reaches through their @lid (it hides their number from the phone lookup) obviously has WhatsApp.
  const reachedByLid = await prisma.contact.findFirst({
    where: { whatsappConnectionId: connectionId, phone: { in: [phone, ...alternates] }, providerChatId: { endsWith: "@lid" } },
    select: { phone: true },
  });
  if (reachedByLid?.phone) return { phone: reachedByLid.phone, confirmedOnWhatsApp: false };
  const resolved = await confirmWithWhatsApp(connectionId, phone, alternates);
  if (resolved.unverifiable) return { phone, confirmedOnWhatsApp: false };
  if (resolved.exists === false) throw Errors.badRequest("Este número não tem WhatsApp. Confira o número digitado.");
  if (resolved.exists === null) throw Errors.badRequest("Não foi possível confirmar o número no WhatsApp agora. Tente novamente.");
  return { phone: resolved.phone, confirmedOnWhatsApp: true };
}
