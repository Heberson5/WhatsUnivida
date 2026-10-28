import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { prisma } from "../src/lib/prisma";
import * as conversationsService from "../src/modules/conversations/conversations.service";
import { resetDatabase, createTestConnection } from "./helpers";

describe("findOrCreateContact self-heals a contact whose phone was originally a WhatsApp @lid privacy id", () => {
  let connectionId: string;

  beforeEach(async () => {
    await resetDatabase();
    connectionId = (await createTestConnection("Suporte")).id;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("corrects the stored phone in place (same contact/history) once the real number becomes resolvable, instead of creating a duplicate", async () => {
    // First contact ever seen on this chat: WhatsApp only exposed the
    // opaque @lid digits at the time, so that's what got stored as "phone".
    const lidDigits = "188764014026962";
    const first = await conversationsService.findOrCreateContact(connectionId, lidDigits, "Karen", `${lidDigits}@lid`);
    expect(first.phone).toBe(lidDigits);

    const contactCountAfterFirst = await prisma.contact.count({ where: { whatsappConnectionId: connectionId } });
    expect(contactCountAfterFirst).toBe(1);

    // A later message on the SAME chat (same providerChatId) resolves the
    // real phone number (e.g. via senderPn) — must correct the existing
    // row, not spawn a second contact for the same person.
    const realPhone = "5511988887777";
    const healed = await conversationsService.findOrCreateContact(connectionId, realPhone, "Karen", `${lidDigits}@lid`);
    expect(healed.id).toBe(first.id);
    expect(healed.phone).toBe(realPhone);

    const contactCountAfterHeal = await prisma.contact.count({ where: { whatsappConnectionId: connectionId } });
    expect(contactCountAfterHeal).toBe(1);

    const byOldPhone = await prisma.contact.findUnique({
      where: { phone_whatsappConnectionId: { phone: lidDigits, whatsappConnectionId: connectionId } },
    });
    expect(byOldPhone).toBeNull();
  });

  it("still creates a normal new contact when there's nothing to heal (no providerChatId, or a genuinely new chat)", async () => {
    const contact = await conversationsService.findOrCreateContact(connectionId, "5511999998888", "Novo Cliente");
    expect(contact.phone).toBe("5511999998888");
    const count = await prisma.contact.count({ where: { whatsappConnectionId: connectionId } });
    expect(count).toBe(1);
  });

  it("reuses the same contact when a LATER event on the same chat comes back unresolved (@lid again, no phone attached) — instead of spawning a duplicate", async () => {
    // Regression: a customer message resolved the real phone (senderPn
    // given) and created the contact with providerChatId recorded. A
    // message echoed from the linked phone itself on that same chat then
    // reports remoteJid as @lid with NO senderPn/participantPn at all
    // (those are only ever populated for group chats) — phoneFromJid falls
    // back to the raw @lid digits for `phone`, identical to the chat id's
    // own digits, so the old "priorPhone !== phone" heal check never fired
    // and a second, disconnected contact/conversation got created every
    // time — showing up as a duplicate card in the Fila for someone
    // already in "Meus Atendimentos".
    const lidDigits = "199887766554433";
    const chatId = `${lidDigits}@lid`;
    const realPhone = "5511977776655";

    const first = await conversationsService.findOrCreateContact(connectionId, realPhone, "Karen", chatId);
    expect(first.phone).toBe(realPhone);
    expect(first.providerChatId).toBe(chatId);

    // The device-sent echo: same chat id, but this event could only resolve
    // the raw @lid digits as "phone" (matches the current bug's exact shape).
    const second = await conversationsService.findOrCreateContact(connectionId, lidDigits, null, chatId);
    expect(second.id).toBe(first.id);
    expect(second.phone).toBe(realPhone); // never downgraded back to the @lid digits

    const count = await prisma.contact.count({ where: { whatsappConnectionId: connectionId } });
    expect(count).toBe(1);
  });

  it("learns the chat id onto an existing phone-matched contact that didn't have one yet", async () => {
    const contact = await conversationsService.findOrCreateContact(connectionId, "5511966665544", "Bruno");
    expect(contact.providerChatId).toBeNull();

    const chatId = "5511966665544@s.whatsapp.net";
    const updated = await conversationsService.findOrCreateContact(connectionId, "5511966665544", null, chatId);
    expect(updated.id).toBe(contact.id);
    expect(updated.providerChatId).toBe(chatId);
  });

  it("folds a duplicate into an already-existing contact instead of crashing on the unique-phone constraint, once the duplicate's chat id resolves to that contact's real phone", async () => {
    // Regression: a contact that already existed (e.g. from a prior, now
    // CLOSED conversation) has no providerChatId at all if it predates that
    // column. A brand-new message sent directly from the phone on that same
    // chat — reported as @lid with no resolvable phone, since a chat with
    // no prior record here has nothing to match on yet — spawns a genuine
    // duplicate contact. When WhatsApp later reveals that @lid's real phone
    // (via chats.update's pnJid — see ChatIdentityResolvedEvent) and it
    // turns out to be this exact pre-existing contact, updating the
    // duplicate's phone in place used to collide with the unique
    // [phone, whatsappConnectionId] constraint and throw — silently
    // swallowed by the caller, permanently stranding the duplicate.
    const realPhone = "5511955554433";
    const original = await prisma.contact.create({
      data: { phone: realPhone, name: "Cliente Antigo", whatsappConnectionId: connectionId },
    });
    const closedConversation = await prisma.conversation.create({
      data: { contactId: original.id, whatsappConnectionId: connectionId, status: "CLOSED", enteredQueueAt: new Date(), lastMessageAt: new Date() },
    });

    const lidDigits = "166554433221100";
    const chatId = `${lidDigits}@lid`;
    const duplicate = await conversationsService.findOrCreateContact(connectionId, lidDigits, null, chatId);
    const newConversation = await prisma.conversation.create({
      data: { contactId: duplicate.id, whatsappConnectionId: connectionId, status: "NEW", enteredQueueAt: new Date(), lastMessageAt: new Date() },
    });

    const healed = await conversationsService.findOrCreateContact(connectionId, realPhone, null, chatId);
    expect(healed.id).toBe(original.id);
    expect(healed.phone).toBe(realPhone);

    const count = await prisma.contact.count({ where: { whatsappConnectionId: connectionId } });
    expect(count).toBe(1);

    const closedAfter = await prisma.conversation.findUniqueOrThrow({ where: { id: closedConversation.id } });
    expect(closedAfter.contactId).toBe(original.id); // untouched
    const newAfter = await prisma.conversation.findUniqueOrThrow({ where: { id: newConversation.id } });
    expect(newAfter.contactId).toBe(original.id); // re-pointed from the deleted duplicate
  });
});
