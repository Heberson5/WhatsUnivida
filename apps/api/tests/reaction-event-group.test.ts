import { describe, it, expect } from "vitest";
import { reactionEventFromBaileys } from "@whatsatendende/whatsapp";

describe("reação em grupo → evento com o participante", () => {
  const groupMessage = { id: "MSG1", remoteJid: "120363000000000000@g.us" };

  it("diz quem reagiu: o participante, com o número quando o WhatsApp mostra", () => {
    const event = reactionEventFromBaileys({
      key: groupMessage,
      reaction: { text: "👍", key: { remoteJid: groupMessage.remoteJid, fromMe: false, participant: "5565999990002@s.whatsapp.net" } },
    });
    expect(event.participant).toEqual({ jid: "5565999990002@s.whatsapp.net", phone: "5565999990002" });
    expect(event.emoji).toBe("👍");
  });

  it("participante com @lid: o número vem do participantPn; sem ele, fica sem número", () => {
    const withPn = reactionEventFromBaileys({
      key: groupMessage,
      reaction: { text: "❤️", key: { remoteJid: groupMessage.remoteJid, participant: "1234567@lid", participantPn: "5565988887777@s.whatsapp.net" } },
    });
    expect(withPn.participant).toEqual({ jid: "1234567@lid", phone: "5565988887777" });
    const hidden = reactionEventFromBaileys({ key: groupMessage, reaction: { text: "❤️", key: { remoteJid: groupMessage.remoteJid, participant: "1234567@lid" } } });
    expect(hidden.participant).toEqual({ jid: "1234567@lid", phone: null });
  });

  it("numa conversa 1:1 não há participante", () => {
    const event = reactionEventFromBaileys({ key: { id: "M2", remoteJid: "5565999990001@s.whatsapp.net" }, reaction: { text: "👍", key: { remoteJid: "5565999990001@s.whatsapp.net" } } });
    expect(event.participant).toBeNull();
  });
});
