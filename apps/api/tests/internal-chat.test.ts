import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { createApp } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { syncGeneralMembers } from "../src/modules/internal-chat/internal-chat.service";
import * as usersService from "../src/modules/users/users.service";
import { resetDatabase, createTestUser, TEST_PASSWORD } from "./helpers";

const app = createApp();

async function loginAs(email: string) {
  const res = await request(app).post("/api/auth/login").send({ email, password: TEST_PASSWORD });
  return res.body.accessToken as string;
}

describe("Chat interno", () => {
  const token: Record<string, string> = {};
  const id: Record<string, string> = {};
  const as = (who: string) => ({ Authorization: `Bearer ${token[who]}` });

  beforeAll(async () => {
    await resetDatabase();
    await prisma.chatRoom.deleteMany();
    for (const [who, role] of [["ana", "AGENT"], ["bia", "AGENT"], ["caio", "AGENT"], ["duda", "AGENT"], ["gestor", "MANAGER"], ["admin", "ADMIN"]] as const) {
      id[who] = (await createTestUser({ email: `${who}-chat@test.dev`, role, displayName: who })).id;
      token[who] = await loginAs(`${who}-chat@test.dev`);
    }
  });

  afterAll(async () => {
    await prisma.chatRoom.deleteMany();
    await prisma.$disconnect();
  });

  it("todo mundo está no #Geral, e a conversa direta fica com ✓✓ quando o outro lê", async () => {
    const rooms = (await request(app).get("/api/internal-chat/rooms").set(as("ana"))).body;
    expect(rooms[0]).toMatchObject({ kind: "GENERAL", name: "#Geral", canLeave: false });

    const dm = (await request(app).post("/api/internal-chat/direct").set(as("ana")).send({ userId: id.bia })).body;
    expect(dm).toMatchObject({ kind: "DIRECT", name: "bia" });
    const again = (await request(app).post("/api/internal-chat/direct").set(as("bia")).send({ userId: id.ana })).body;
    expect(again.id).toBe(dm.id);

    const sent = (await request(app).post(`/api/internal-chat/rooms/${dm.id}/messages`).set(as("ana")).send({ body: "Oi, Bia" })).body;
    expect(sent.readByAll).toBe(false);
    const biaRooms = (await request(app).get("/api/internal-chat/rooms").set(as("bia"))).body;
    expect(biaRooms.find((r: { id: string }) => r.id === dm.id).unreadCount).toBe(1);
    await request(app).post(`/api/internal-chat/rooms/${dm.id}/read`).set(as("bia")).expect(204);
    const messages = (await request(app).get(`/api/internal-chat/rooms/${dm.id}/messages`).set(as("ana"))).body;
    expect(messages.at(-1).readByAll).toBe(true);
  });

  it("grupo: só dono e administradores adicionam; só o dono escolhe administradores; histórico é opcional", async () => {
    const group = (await request(app).post("/api/internal-chat/groups").set(as("ana")).send({ name: "Cobrança", memberIds: [id.bia] })).body;
    expect(group).toMatchObject({ canManageMembers: true, canManageAdmins: true });
    await request(app).post(`/api/internal-chat/rooms/${group.id}/messages`).set(as("ana")).send({ body: "mensagem antiga" }).expect(201);

    expect((await request(app).post(`/api/internal-chat/rooms/${group.id}/members`).set(as("bia")).send({ userIds: [id.caio], canSeeHistory: true })).status).toBe(403);
    expect((await request(app).put(`/api/internal-chat/rooms/${group.id}/members/${id.bia}/admin`).set(as("bia")).send({ admin: true })).status).toBe(403);
    await request(app).put(`/api/internal-chat/rooms/${group.id}/members/${id.bia}/admin`).set(as("ana")).send({ admin: true }).expect(200);

    await request(app).post(`/api/internal-chat/rooms/${group.id}/members`).set(as("bia")).send({ userIds: [id.caio], canSeeHistory: false }).expect(200);
    await request(app).post(`/api/internal-chat/rooms/${group.id}/members`).set(as("bia")).send({ userIds: [id.duda], canSeeHistory: true }).expect(200);
    const caioSees = (await request(app).get(`/api/internal-chat/rooms/${group.id}/messages`).set(as("caio"))).body.map((m: { body: string }) => m.body);
    const dudaSees = (await request(app).get(`/api/internal-chat/rooms/${group.id}/messages`).set(as("duda"))).body.map((m: { body: string }) => m.body);
    expect(caioSees).not.toContain("mensagem antiga");
    expect(dudaSees).toContain("mensagem antiga");
  });

  it("quem sai deixa de ver o grupo; o dono que sai passa o grupo ao administrador mais antigo", async () => {
    const group = (await request(app).get("/api/internal-chat/rooms").set(as("ana"))).body.find((r: { name: string }) => r.name === "Cobrança");
    await request(app).post(`/api/internal-chat/rooms/${group.id}/leave`).set(as("ana")).expect(204);
    expect((await request(app).get("/api/internal-chat/rooms").set(as("ana"))).body.some((r: { id: string }) => r.id === group.id)).toBe(false);
    const forBia = (await request(app).get("/api/internal-chat/rooms").set(as("bia"))).body.find((r: { id: string }) => r.id === group.id);
    expect(forBia.canManageAdmins).toBe(true);
    const lines = (await request(app).get(`/api/internal-chat/rooms/${group.id}/messages`).set(as("bia"))).body.map((m: { body: string }) => m.body);
    expect(lines).toContain("ana saiu do grupo");
    expect((await request(app).get(`/api/internal-chat/rooms/${group.id}/messages`).set(as("ana"))).status).toBe(404);
  });

  it("só o administrador acompanha: lê tudo sem marcar como lido, e cada leitura vai para a auditoria", async () => {
    expect((await request(app).get("/api/internal-chat/oversight/rooms").set(as("ana"))).status).toBe(403);
    expect((await request(app).get("/api/internal-chat/oversight/rooms").set(as("gestor"))).status).toBe(403);
    const rooms = (await request(app).get("/api/internal-chat/oversight/rooms").set(as("admin"))).body;
    const dm = rooms.find((r: { kind: string; name: string }) => r.kind === "DIRECT" && r.name.includes("ana") && r.name.includes("bia"));
    expect(dm.name).toContain("↔");
    const before = await prisma.chatMember.findMany({ where: { roomId: dm.id } });
    await request(app).get(`/api/internal-chat/oversight/rooms/${dm.id}/messages`).set(as("admin")).expect(200);
    expect(await prisma.chatMember.findMany({ where: { roomId: dm.id } })).toEqual(before);
    expect(await prisma.auditLog.count({ where: { action: "INTERNAL_CHAT_OVERSIGHT_READ", entityId: dm.id } })).toBe(1);
  });

  const send = (who: string, roomId: string, body: object) => request(app).post(`/api/internal-chat/rooms/${roomId}/messages`).set(as(who)).send(body);
  const messagesOf = async (who: string, roomId: string) => (await request(app).get(`/api/internal-chat/rooms/${roomId}/messages`).set(as(who))).body;
  const oversightOf = async (roomId: string) => (await request(app).get(`/api/internal-chat/oversight/rooms/${roomId}/messages`).set(as("admin"))).body;

  it("✓ enviada, ✓✓ entregue e ✓✓ lida, com o horário de cada um em Dados da mensagem", async () => {
    const dm = (await request(app).post("/api/internal-chat/direct").set(as("caio")).send({ userId: id.duda })).body;
    const sent = (await send("caio", dm.id, { body: "chegou?" })).body;
    expect(sent.status).toBe("SENT");
    await request(app).get("/api/internal-chat/rooms").set(as("duda")).expect(200);
    expect((await messagesOf("caio", dm.id)).at(-1).status).toBe("DELIVERED");
    const delivered = (await request(app).get(`/api/internal-chat/messages/${sent.id}/info`).set(as("caio"))).body;
    expect(delivered.deliveredTo.map((p: { name: string }) => p.name)).toEqual(["duda"]);
    await request(app).post(`/api/internal-chat/rooms/${dm.id}/read`).set(as("duda")).expect(204);
    expect((await messagesOf("caio", dm.id)).at(-1).status).toBe("READ");
    const info = (await request(app).get(`/api/internal-chat/messages/${sent.id}/info`).set(as("caio"))).body;
    expect(info.readBy).toHaveLength(1);
    expect(info.readBy[0].at).toBeTruthy();
    expect((await request(app).get(`/api/internal-chat/messages/${sent.id}/info`).set(as("duda"))).status).toBe(403);
  });

  it("responder, @menção, reação, edição em até 15 min (com versões para o administrador) e apagar", async () => {
    const group = (await request(app).post("/api/internal-chat/groups").set(as("caio")).send({ name: "Plantão", memberIds: [id.duda, id.bia] })).body;
    const first = (await send("caio", group.id, { body: "quem pega sábado?" })).body;
    const reply = (await send("duda", group.id, { body: "eu pego @caio", replyToId: first.id, mentions: [id.caio, "ALL", "não-existe"] })).body;
    expect(reply.replyTo).toMatchObject({ id: first.id, preview: "quem pega sábado?" });
    expect(reply.mentions).toEqual([id.caio, "ALL"]);
    const caioRooms = (await request(app).get("/api/internal-chat/rooms").set(as("caio"))).body;
    expect(caioRooms.find((r: { id: string }) => r.id === group.id).unreadMentions).toBe(1);

    const reacted = (await request(app).put(`/api/internal-chat/messages/${reply.id}/reaction`).set(as("caio")).send({ emoji: "👍" })).body;
    expect(reacted.reactions).toEqual([{ emoji: "👍", count: 1, names: ["caio"], mine: true }]);
    await request(app).put(`/api/internal-chat/messages/${reply.id}/reaction`).set(as("caio")).send({ emoji: "❤️" }).expect(200);
    expect((await messagesOf("bia", group.id)).find((m: { id: string }) => m.id === reply.id).reactions.map((r: { emoji: string }) => r.emoji)).toEqual(["❤️"]);

    expect((await request(app).patch(`/api/internal-chat/messages/${reply.id}`).set(as("caio")).send({ body: "x" })).status).toBe(403);
    const edited = (await request(app).patch(`/api/internal-chat/messages/${reply.id}`).set(as("duda")).send({ body: "eu pego, @caio" })).body;
    expect(edited.editedAt).toBeTruthy();
    expect(edited.body).toBe("eu pego, @caio");
    const old = await send("duda", group.id, { body: "antiga" });
    await prisma.chatMessage.update({ where: { id: old.body.id }, data: { createdAt: new Date(Date.now() - 16 * 60_000) } });
    expect((await request(app).patch(`/api/internal-chat/messages/${old.body.id}`).set(as("duda")).send({ body: "nova" })).status).toBe(400);

    await request(app).delete(`/api/internal-chat/messages/${first.id}`).set(as("caio")).expect(204);
    const forBia = (await messagesOf("bia", group.id)).find((m: { id: string }) => m.id === first.id);
    expect(forBia).toMatchObject({ body: null, deletedAt: expect.any(String) });

    const admin = await oversightOf(group.id);
    expect(admin.find((m: { id: string }) => m.id === first.id).body).toBe("quem pega sábado?");
    expect(admin.find((m: { id: string }) => m.id === reply.id).oversight.edits).toEqual([{ body: "eu pego @caio", editedAt: expect.any(String) }]);
  });

  it("enquete: uma resposta por pessoa (ou várias), com o nome de quem votou", async () => {
    const group = (await request(app).get("/api/internal-chat/rooms").set(as("caio"))).body.find((r: { name: string }) => r.name === "Plantão");
    const poll = (await request(app).post(`/api/internal-chat/rooms/${group.id}/polls`).set(as("caio")).send({ question: "Turno?", options: ["Manhã", "Tarde"], multiple: false })).body;
    const [manha, tarde] = poll.poll.options;
    expect((await request(app).put(`/api/internal-chat/polls/${poll.poll.id}/votes`).set(as("duda")).send({ optionIds: [manha.id, tarde.id] })).status).toBe(400);
    await request(app).put(`/api/internal-chat/polls/${poll.poll.id}/votes`).set(as("duda")).send({ optionIds: [manha.id] }).expect(200);
    const voted = (await request(app).put(`/api/internal-chat/polls/${poll.poll.id}/votes`).set(as("bia")).send({ optionIds: [tarde.id] })).body;
    expect(voted.poll.voters).toBe(2);
    expect(voted.poll.options.map((o: { voterNames: string[] }) => o.voterNames)).toEqual([["duda"], ["bia"]]);
  });

  it("fixar mensagem: até 3, e só criador/admin no grupo", async () => {
    const group = (await request(app).get("/api/internal-chat/rooms").set(as("caio"))).body.find((r: { name: string }) => r.name === "Plantão");
    const ids = [];
    for (const body of ["a", "b", "c", "d"]) ids.push((await send("caio", group.id, { body })).body.id);
    expect((await request(app).post(`/api/internal-chat/rooms/${group.id}/pins`).set(as("duda")).send({ messageId: ids[0], days: 7 })).status).toBe(403);
    for (const messageId of ids.slice(0, 3)) await request(app).post(`/api/internal-chat/rooms/${group.id}/pins`).set(as("caio")).send({ messageId, days: null }).expect(200);
    expect((await request(app).post(`/api/internal-chat/rooms/${group.id}/pins`).set(as("caio")).send({ messageId: ids[3], days: 1 })).status).toBe(400);
    const room = (await request(app).delete(`/api/internal-chat/rooms/${group.id}/pins/${ids[0]}`).set(as("caio"))).body;
    expect(room.pins).toHaveLength(2);
  });

  it("temporária some para quem conversa e fica para o administrador; autoexplosiva conta a partir da leitura", async () => {
    const dm = (await request(app).post("/api/internal-chat/direct").set(as("caio")).send({ userId: id.duda })).body;
    const temp = (await send("caio", dm.id, { body: "senha 1234", ttlSeconds: 60 })).body;
    expect(temp.expiresAt).toBeTruthy();
    await prisma.chatMessage.update({ where: { id: temp.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await messagesOf("duda", dm.id)).some((m: { id: string }) => m.id === temp.id)).toBe(false);
    expect((await oversightOf(dm.id)).find((m: { id: string }) => m.id === temp.id).oversight.expired).toBe(true);

    const on = (await request(app).put(`/api/internal-chat/rooms/${dm.id}/auto-delete`).set(as("duda")).send({ seconds: 30 })).body;
    expect(on.autoDeleteSeconds).toBe(30);
    const auto = (await send("caio", dm.id, { body: "some depois de lida" })).body;
    expect(auto).toMatchObject({ ttlSeconds: 30, ttlFromRead: true, expiresAt: null });
    await request(app).post(`/api/internal-chat/rooms/${dm.id}/read`).set(as("caio")).expect(204);
    expect((await messagesOf("caio", dm.id)).find((m: { id: string }) => m.id === auto.id).expiresAt).toBeNull();
    await request(app).post(`/api/internal-chat/rooms/${dm.id}/read`).set(as("duda")).expect(204);
    const started = (await messagesOf("caio", dm.id)).find((m: { id: string }) => m.id === auto.id);
    expect(new Date(started.expiresAt).getTime()).toBeGreaterThan(Date.now() + 25_000);
    expect((await messagesOf("caio", dm.id)).some((m: { body: string }) => m.body?.includes("ativou as mensagens autoexplosivas: somem 30 segundos"))).toBe(true);
    await request(app).put(`/api/internal-chat/rooms/${dm.id}/auto-delete`).set(as("caio")).send({ seconds: null }).expect(200);
    expect((await send("caio", dm.id, { body: "normal" })).body.ttlSeconds).toBeNull();
  });

  it("arquivo de visualização única abre uma vez para quem recebe", async () => {
    const dm = (await request(app).post("/api/internal-chat/direct").set(as("caio")).send({ userId: id.duda })).body;
    const sent = (
      await request(app).post(`/api/internal-chat/rooms/${dm.id}/files`).set(as("caio")).field("viewOnce", "true").attach("file", Buffer.from("png"), { filename: "print.png", contentType: "image/png" })
    ).body;
    expect(sent.viewOnce).toBe(true);
    await request(app).get(`/api/internal-chat/attachments/${sent.id}`).set(as("duda")).expect(200);
    expect((await request(app).get(`/api/internal-chat/attachments/${sent.id}`).set(as("duda"))).status).toBe(404);
    const forDuda = (await messagesOf("duda", dm.id)).find((m: { id: string }) => m.id === sent.id);
    expect(forDuda).toMatchObject({ viewedByMe: true, attachment: null });
    await request(app).get(`/api/internal-chat/attachments/${sent.id}`).set(as("caio")).expect(200);
    expect((await oversightOf(dm.id)).find((m: { id: string }) => m.id === sent.id).oversight.viewedBy[0].name).toBe("duda");
  });

  it("áudio gravado guarda duração e ondas", async () => {
    const dm = (await request(app).post("/api/internal-chat/direct").set(as("caio")).send({ userId: id.duda })).body;
    const audio = (
      await request(app)
        .post(`/api/internal-chat/rooms/${dm.id}/files`)
        .set(as("caio"))
        .field("audioDurationMs", "4200")
        .field("audioWaveform", JSON.stringify([10, 50, 90]))
        .attach("file", Buffer.from("ogg"), { filename: "audio.webm", contentType: "audio/webm" })
    ).body;
    expect(audio).toMatchObject({ kind: "AUDIO", audio: { durationMs: 4200, waveform: [10, 50, 90] } });
  });

  it("chamar a atenção: na conversa individual, de novo só depois de 30 s; no grupo só criador/admin", async () => {
    const dm = (await request(app).post("/api/internal-chat/direct").set(as("caio")).send({ userId: id.duda })).body;
    const nudge = (await request(app).post(`/api/internal-chat/rooms/${dm.id}/nudge`).set(as("caio")).send({})).body;
    expect(nudge).toMatchObject({ kind: "NUDGE", nudgeTargetId: id.duda });
    expect((await request(app).post(`/api/internal-chat/rooms/${dm.id}/nudge`).set(as("caio")).send({})).status).toBe(400);
    const group = (await request(app).get("/api/internal-chat/rooms").set(as("caio"))).body.find((r: { name: string }) => r.name === "Plantão");
    expect((await request(app).post(`/api/internal-chat/rooms/${group.id}/nudge`).set(as("duda")).send({ userId: id.bia })).status).toBe(403);
    await request(app).post(`/api/internal-chat/rooms/${group.id}/nudge`).set(as("caio")).send({ userId: id.bia }).expect(201);
  });

  it("remover integrante e excluir o grupo: todos saem e o administrador vê como finalizado", async () => {
    const group = (await request(app).get("/api/internal-chat/rooms").set(as("caio"))).body.find((r: { name: string }) => r.name === "Plantão");
    await request(app).put(`/api/internal-chat/rooms/${group.id}/members/${id.duda}/admin`).set(as("caio")).send({ admin: true }).expect(200);
    expect((await request(app).delete(`/api/internal-chat/rooms/${group.id}/members/${id.caio}`).set(as("duda"))).status).toBe(403);
    await request(app).delete(`/api/internal-chat/rooms/${group.id}/members/${id.bia}`).set(as("duda")).expect(200);
    expect((await request(app).get("/api/internal-chat/rooms").set(as("bia"))).body.some((r: { id: string }) => r.id === group.id)).toBe(false);

    expect((await request(app).delete(`/api/internal-chat/rooms/${group.id}`).set(as("duda"))).status).toBe(403);
    await request(app).delete(`/api/internal-chat/rooms/${group.id}`).set(as("caio")).expect(204);
    for (const who of ["caio", "duda"]) {
      expect((await request(app).get("/api/internal-chat/rooms").set(as(who))).body.some((r: { id: string }) => r.id === group.id)).toBe(false);
    }
    expect((await send("duda", group.id, { body: "oi?" })).status).toBe(404);

    const finished = (await request(app).get("/api/internal-chat/oversight/rooms").set(as("admin"))).body.find((r: { id: string }) => r.id === group.id);
    expect(finished).toMatchObject({ deletedAt: expect.any(String), deletedByName: "caio" });
    expect(finished.members.map((m: { name: string }) => m.name).sort()).toEqual(["caio", "duda"]);
    expect(finished.formerMembers).toEqual([expect.objectContaining({ name: "bia", removedByName: "duda" })]);
    expect((await oversightOf(group.id)).map((m: { body: string }) => m.body)).toContain("caio excluiu o grupo");
  });

  const roomsOf = async (who: string) => ((await request(app).get("/api/internal-chat/rooms").set(as(who))).body as { id: string }[]).map((r) => r.id);
  const close = (who: string, roomId: string, forBoth: boolean) => request(app).post(`/api/internal-chat/rooms/${roomId}/close`).set(as(who)).send({ forBoth });
  const oversightRoom = async (roomId: string) =>
    ((await request(app).get("/api/internal-chat/oversight/rooms").set(as("admin"))).body as { id: string }[]).find((r) => r.id === roomId) as Record<string, unknown> & { members: { name: string }[] };

  it("encerrar só para mim: some para quem encerrou e volta, só com as novas, quando o outro escreve", async () => {
    const dm = (await request(app).post("/api/internal-chat/direct").set(as("ana")).send({ userId: id.caio })).body;
    await send("ana", dm.id, { body: "antes" }).expect(201);
    await close("caio", dm.id, false).expect(204);
    expect(await roomsOf("caio")).not.toContain(dm.id);
    expect(await roomsOf("ana")).toContain(dm.id);
    expect((await oversightRoom(dm.id)).deletedAt).toBeNull();

    await send("ana", dm.id, { body: "depois" }).expect(201);
    expect(await roomsOf("caio")).toContain(dm.id);
    expect((await messagesOf("caio", dm.id)).map((m: { body: string }) => m.body)).toEqual(["depois"]);
    expect((await messagesOf("ana", dm.id)).map((m: { body: string }) => m.body)).toEqual(["antes", "depois"]);

    // Quem encerrou abre de novo pela lista de pessoas: a mesma conversa, sem o que já tinha sido apagado para ele.
    await close("caio", dm.id, false).expect(204);
    const reopened = (await request(app).post("/api/internal-chat/direct").set(as("caio")).send({ userId: id.ana })).body;
    expect(reopened).toMatchObject({ id: dm.id, name: "ana" });
    expect((await messagesOf("caio", dm.id)).map((m: { body: string }) => m.body)).toEqual([]);

    // Os dois encerraram só para si: ninguém mais tem a conversa, e ela vai para o Histórico do administrador.
    await close("caio", dm.id, false).expect(204);
    await close("ana", dm.id, false).expect(204);
    expect(await oversightRoom(dm.id)).toMatchObject({ deletedAt: expect.any(String), deletedByName: "ana" });
    expect((await oversightRoom(dm.id)).members.map((m) => m.name).sort()).toEqual(["ana", "caio"]);
  });

  it("encerrar para os dois: some dos dois lados, a próxima começa do zero e o administrador guarda no Histórico", async () => {
    const dm = (await request(app).post("/api/internal-chat/direct").set(as("ana")).send({ userId: id.duda })).body;
    await send("ana", dm.id, { body: "assunto" }).expect(201);
    expect((await close("bia", dm.id, true)).status).toBe(404);
    await close("duda", dm.id, true).expect(204);
    expect(await roomsOf("ana")).not.toContain(dm.id);
    expect(await roomsOf("duda")).not.toContain(dm.id);
    expect((await send("ana", dm.id, { body: "oi?" })).status).toBe(404);

    const fresh = (await request(app).post("/api/internal-chat/direct").set(as("ana")).send({ userId: id.duda })).body;
    expect(fresh.id).not.toBe(dm.id);
    expect(await messagesOf("ana", fresh.id)).toEqual([]);

    const closed = await oversightRoom(dm.id);
    expect(closed).toMatchObject({ kind: "DIRECT", deletedAt: expect.any(String), deletedByName: "duda" });
    expect(closed.members.map((m) => m.name).sort()).toEqual(["ana", "duda"]);
    expect((await oversightOf(dm.id)).map((m: { body: string }) => m.body)).toEqual(["assunto", "duda encerrou a conversa"]);
  });

  it("grupo e #Geral não se encerram por aqui", async () => {
    const general = (await request(app).get("/api/internal-chat/rooms").set(as("ana"))).body[0];
    expect((await close("ana", general.id, true)).status).toBe(400);
  });

  const erase = (who: string, messageId: string) => request(app).delete(`/api/internal-chat/oversight/messages/${messageId}`).set(as(who));

  it("quem enviou apaga a qualquer momento: fica Mensagem apagada, a resposta continua citando e o administrador vê", async () => {
    const dm = (await request(app).post("/api/internal-chat/direct").set(as("bia")).send({ userId: id.caio })).body;
    const old = (await send("bia", dm.id, { body: "texto antigo" })).body;
    await prisma.chatMessage.update({ where: { id: old.id }, data: { createdAt: new Date(Date.now() - 30 * 86_400_000) } });
    const reply = (await send("caio", dm.id, { body: "resposta", replyToId: old.id })).body;
    expect((await request(app).delete(`/api/internal-chat/messages/${old.id}`).set(as("caio"))).status).toBe(403);
    await request(app).delete(`/api/internal-chat/messages/${old.id}`).set(as("bia")).expect(204);

    const seen = await messagesOf("caio", dm.id);
    expect(seen.find((m: { id: string }) => m.id === old.id)).toMatchObject({ body: null, deletedAt: expect.any(String) });
    expect(seen.find((m: { id: string }) => m.id === reply.id).replyTo.preview).toBe("texto antigo");
    expect((await oversightOf(dm.id)).find((m: { id: string }) => m.id === old.id).body).toBe("texto antigo");
  });

  it("administrador exclui de vez: a mensagem vira Mensagem apagada; a já apagada some; só o administrador pode", async () => {
    const dm = (await request(app).post("/api/internal-chat/direct").set(as("bia")).send({ userId: id.duda })).body;
    const shown = (await send("bia", dm.id, { body: "segredo" })).body;
    const gone = (await send("bia", dm.id, { body: "já apagada" })).body;
    await request(app).delete(`/api/internal-chat/messages/${gone.id}`).set(as("bia")).expect(204);

    expect((await erase("gestor", shown.id)).status).toBe(403);
    await erase("admin", shown.id).expect(204);
    await erase("admin", gone.id).expect(204);

    const seen = await messagesOf("duda", dm.id);
    expect(seen.map((m: { id: string }) => m.id)).toEqual([shown.id]);
    expect(seen[0]).toMatchObject({ body: null, deletedAt: expect.any(String) });
    expect((await oversightOf(dm.id)).find((m: { id: string }) => m.id === shown.id).body).toBeNull();
    expect(await prisma.auditLog.count({ where: { action: "INTERNAL_CHAT_MESSAGE_ERASED", entityId: shown.id } })).toBe(1);
  });

  it("administrador exclui o chat inteiro, também do Histórico; o #Geral não pode, mas as mensagens dele sim", async () => {
    const group = (await request(app).post("/api/internal-chat/groups").set(as("bia")).send({ name: "Apagar", memberIds: [id.caio] })).body;
    expect((await request(app).delete(`/api/internal-chat/oversight/rooms/${group.id}`).set(as("gestor"))).status).toBe(403);
    await request(app).delete(`/api/internal-chat/oversight/rooms/${group.id}`).set(as("admin")).expect(204);
    expect(await roomsOf("caio")).not.toContain(group.id);
    expect(await oversightRoom(group.id)).toBeUndefined();

    const general = (await request(app).get("/api/internal-chat/rooms").set(as("ana"))).body[0];
    expect((await request(app).delete(`/api/internal-chat/oversight/rooms/${general.id}`).set(as("admin"))).status).toBe(400);
    const line = (await send("ana", general.id, { body: "no geral" })).body;
    await erase("admin", line.id).expect(204);
  });

  it("#Geral acompanha os usuários: novo entra na hora, inativado sai, reativado volta", async () => {
    const general = (await request(app).get("/api/internal-chat/rooms").set(as("ana"))).body[0];
    const isIn = async (userId: string) => {
      const member = await prisma.chatMember.findUnique({ where: { roomId_userId: { roomId: general.id, userId } } });
      return Boolean(member && !member.leftAt);
    };
    const created = await usersService.createUser({ fullName: "Novo Usuário", displayName: "Novo", email: "novo-chat@test.dev", password: TEST_PASSWORD, role: "ADMIN" });
    expect(await isIn(created.id)).toBe(true);
    await usersService.setUserStatus(created.id, "INACTIVE", id.admin);
    expect(await isIn(created.id)).toBe(false);
    await usersService.setUserStatus(created.id, "ACTIVE", id.admin);
    expect(await isIn(created.id)).toBe(true);

    await prisma.user.update({ where: { id: created.id }, data: { status: "INACTIVE" } });
    await syncGeneralMembers();
    expect(await isIn(created.id)).toBe(false);
  });
});
