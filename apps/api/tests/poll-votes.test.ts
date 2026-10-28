import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { aesEncryptGCM, hmacSign, proto } from "@whiskeysockets/baileys";
import type { PollVoteEvent } from "@whatsatendende/whatsapp";
import { prisma } from "../src/lib/prisma";
import { resetDatabase, createTestConnection } from "./helpers";
import { recordPollVote } from "../src/modules/messages/poll-votes.service";
import { toMessageDTO } from "../src/modules/messages/messages.mapper";
import { fillPollKey } from "../src/modules/conversations/conversations.service";

const POLL_ID = "3EB0POLL0001";
const CREATOR = "556599990000@s.whatsapp.net";
const OPTIONS = ["Segunda", "Terça", "Quarta"];

/** Encrypts a vote the way WhatsApp does (the inverse of Baileys' decryptPollVote). */
function encryptVote(secret: Buffer, voterJid: string, chosen: string[], creatorJid = CREATOR) {
  const sign = Buffer.concat([Buffer.from(POLL_ID), Buffer.from(creatorJid), Buffer.from(voterJid), Buffer.from("Poll Vote"), new Uint8Array([1])]);
  const key0 = hmacSign(secret, new Uint8Array(32), "sha256");
  const encKey = hmacSign(sign, key0, "sha256");
  const iv = randomBytes(12);
  const payload = proto.Message.PollVoteMessage.encode({ selectedOptions: chosen.map((o) => createHash("sha256").update(o).digest()) }).finish();
  const enc = aesEncryptGCM(payload, encKey, iv, Buffer.from(`${POLL_ID}\u0000${voterJid}`));
  return { encPayload: Buffer.from(enc).toString("base64"), encIv: iv.toString("base64") };
}

describe("Enquetes nos grupos: votos", () => {
  let secret: Buffer;
  let messageId: string;

  beforeEach(async () => {
    await resetDatabase();
    const connection = await createTestConnection("Suporte");
    const group = await prisma.contact.create({ data: { name: "Equipe", isGroup: true, providerChatId: "1203630000@g.us", whatsappConnectionId: connection.id } });
    const conversation = await prisma.conversation.create({ data: { contactId: group.id, whatsappConnectionId: connection.id, status: "GROUP", lastMessageAt: new Date() } });
    secret = randomBytes(32);
    const message = await prisma.message.create({
      data: { conversationId: conversation.id, direction: "INBOUND", type: "POLL", status: "DELIVERED", providerMessageId: POLL_ID },
    });
    messageId = message.id;
    await prisma.messageAttachment.create({
      data: {
        messageId,
        fileName: "poll",
        mimeType: "application/vnd.whatsapp.poll",
        sizeBytes: 0,
        storageKey: "",
        kind: "POLL",
        pollQuestion: "Qual dia da reunião?",
        pollOptions: OPTIONS,
        pollSelectableCount: 1,
        pollSecret: secret.toString("base64"),
        pollCreatorJid: CREATOR,
      },
    });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  const vote = (voterJid: string, voterName: string, chosen: string[], at = new Date()): PollVoteEvent => ({
    chatId: "1203630000@g.us",
    pollMessageId: POLL_ID,
    voterJid,
    voterName,
    voterPhone: voterJid.split("@")[0],
    fromMe: false,
    ...encryptVote(secret, voterJid, chosen),
    timestamp: at,
  });

  const results = async () => {
    const message = await prisma.message.findUniqueOrThrow({
      where: { id: messageId },
      include: { senderAgent: true, attachments: { include: { pollVotes: true } }, reactions: { include: { user: true } } },
    });
    return toMessageDTO(message).attachments[0].pollResults!;
  };

  it("decifra e conta os votos; quem muda o voto conta só uma vez; voto retirado sai da contagem", async () => {
    await recordPollVote(vote("556511110001@s.whatsapp.net", "Ana", ["Segunda"]), async () => null);
    await recordPollVote(vote("556511110002@s.whatsapp.net", "Bruno", ["Terça"]), async () => null);
    await recordPollVote(vote("556511110003@s.whatsapp.net", "Carla", ["Terça"]), async () => null);
    let r = await results();
    expect(r).toMatchObject({ readable: true, voters: 3 });
    expect(r.options.map((o) => [o.option, o.count])).toEqual([
      ["Segunda", 1],
      ["Terça", 2],
      ["Quarta", 0],
    ]);
    expect(r.options[1].voters.map((v) => v.name)).toEqual(["Bruno", "Carla"]);

    // Bruno changes his vote; Carla takes hers back.
    await recordPollVote(vote("556511110002@s.whatsapp.net", "Bruno", ["Quarta"]), async () => null);
    await recordPollVote(vote("556511110003@s.whatsapp.net", "Carla", []), async () => null);
    r = await results();
    expect(r.voters).toBe(2);
    expect(r.options.map((o) => o.count)).toEqual([1, 0, 1]);
  });

  it("grupo com LID: o voto feito com o número de telefone abre pelos outros nomes de quem criou e de quem votou", async () => {
    // The poll was saved naming its creator by LID; the voter's phone encrypted with the creator's phone number.
    await prisma.messageAttachment.updateMany({ data: { pollCreatorJid: "99887766@lid" } });
    const event: PollVoteEvent = {
      ...vote("556511110009@s.whatsapp.net", "Fábio", ["Quarta"]),
      voterJid: "11223344@lid",
      voterJidCandidates: ["11223344@lid", "556511110009@s.whatsapp.net"],
      creatorJidCandidates: ["99887766@lid", CREATOR],
    };
    expect(await recordPollVote(event, async () => null)).not.toBeNull();
    expect((await results()).options.map((o) => o.count)).toEqual([0, 0, 1]);
  });

  it("enquete salva sem a chave recebe a chave pelo histórico e passa a contar os votos", async () => {
    await prisma.messageAttachment.updateMany({ data: { pollSecret: null, pollCreatorJid: null } });
    expect(await recordPollVote(vote("556511110006@s.whatsapp.net", "Gil", ["Terça"]), async () => null)).toBeNull();
    await fillPollKey(messageId, { type: "POLL", pollSecret: secret.toString("base64"), pollCreatorJid: CREATOR });
    expect(await recordPollVote(vote("556511110006@s.whatsapp.net", "Gil", ["Terça"]), async () => null)).not.toBeNull();
    expect((await results())).toMatchObject({ readable: true, voters: 1 });
  });

  it("voto com a chave errada é ignorado; enquete antiga (sem chave) não mostra votos", async () => {
    const forged = { ...vote("556511110004@s.whatsapp.net", "Diego", ["Segunda"]), ...encryptVote(randomBytes(32), "556511110004@s.whatsapp.net", ["Segunda"]) };
    expect(await recordPollVote(forged, async () => null)).toBeNull();
    expect((await results()).voters).toBe(0);

    await prisma.messageAttachment.updateMany({ data: { pollSecret: null } });
    expect(await recordPollVote(vote("556511110005@s.whatsapp.net", "Eva", ["Segunda"]), async () => null)).toBeNull();
    expect((await results()).readable).toBe(false);
  });
});
