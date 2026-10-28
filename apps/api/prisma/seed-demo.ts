import { PrismaClient, type ConversationStatus, type MessageDirection } from "@prisma/client";
import bcrypt from "bcryptjs";

// Dados de exemplo para apresentar o sistema (WhatsUnivida). Tudo fica numa
// conexão própria, "Central Univida (Demonstração)", que nunca é pareada com
// um celular — a conexão verdadeira é criada à parte em Configurações, então
// nenhum número fictício daqui recebe mensagem de verdade. Roda uma vez só:
// se a conexão de demonstração já existe, não faz nada.

const DEMO_CONNECTION = "Central Univida (Demonstração)";
const DEMO_SALES_CONNECTION = "Comercial Univida (Demonstração)";
const DEMO_PASSWORD = "***REMOVIDO***";

const MIN = 60_000;
const ago = (minutes: number) => new Date(Date.now() - minutes * MIN);

type Line = [MessageDirection, string, number]; // direção, texto, minutos atrás

interface ConvSpec {
  name: string;
  phone: string;
  status: ConversationStatus;
  agent?: string; // chave em `agents`
  sales?: boolean;
  tags?: string[];
  pinnedNote?: string;
  contract?: string;
  note?: string;
  unread?: boolean;
  lines: Line[];
}

export async function seedDemo(prisma: PrismaClient) {
  if (await prisma.whatsAppConnection.findUnique({ where: { name: DEMO_CONNECTION } })) {
    console.log("Dados de demonstração já existem — nada a fazer.");
    return;
  }
  console.log("Criando dados de demonstração...");

  const central = await prisma.whatsAppConnection.create({
    data: { name: DEMO_CONNECTION, color: "#0097B4", groupsEnabled: true, groupsEnabledAt: ago(60 * 24 * 30) },
  });
  const comercial = await prisma.whatsAppConnection.create({ data: { name: DEMO_SALES_CONNECTION, color: "#E67E22" } });

  const passwordHash = await bcrypt.hash(DEMO_PASSWORD, 12);
  const mkUser = async (email: string, fullName: string, displayName: string, role: "ADMIN" | "MANAGER" | "AGENT", connectionId?: string) =>
    (await prisma.user.findFirst({ where: { email, status: "ACTIVE" } })) ??
    prisma.user.create({
      data: { email, fullName, displayName, role, passwordHash, status: "ACTIVE", whatsappConnectionId: connectionId, workState: "MT", workCity: "Cuiabá", lastAccessAt: ago(30) },
    });

  const agents = {
    gestora: await mkUser("usuario@exemplo.com", "Patrícia Moraes", "Patrícia", "MANAGER"),
    ana: await mkUser("usuario@exemplo.com", "Ana Souza", "Ana", "AGENT", central.id),
    carlos: await mkUser("usuario@exemplo.com", "Carlos Lima", "Carlos", "AGENT", central.id),
    juliana: await mkUser("usuario@exemplo.com", "Juliana Rocha", "Juliana", "AGENT", central.id),
    pedro: await mkUser("usuario@exemplo.com", "Pedro Alves", "Pedro", "AGENT", comercial.id),
  };
  type AgentKey = keyof typeof agents;

  // --- Etiquetas e respostas rápidas -------------------------------------
  const tagSpecs: [string, string][] = [
    ["Associado ativo", "#2E7D32"],
    ["Inadimplente", "#C62828"],
    ["Novo plano", "#E67E22"],
    ["Assistência funeral", "#6A1B9A"],
    ["Cliente VIP", "#F9A825"],
    ["Retornar ligação", "#1565C0"],
  ];
  const tags = new Map<string, string>();
  for (const [name, color] of tagSpecs) {
    const tag = await prisma.tag.upsert({ where: { name }, update: {}, create: { name, color } });
    tags.set(name, tag.id);
  }

  const replies: [string, string, string][] = [
    ["Boas-vindas", "boasvindas", "Olá, {{primeiro_nome}}! Aqui é da Univida 💙 Como posso te ajudar hoje?"],
    ["2ª via de boleto", "boleto", "Segue a 2ª via do seu boleto. O pagamento pode ser feito em qualquer banco ou lotérica até o vencimento."],
    ["Carteirinha digital", "carteirinha", "Sua carteirinha digital está disponível no aplicativo Univida, no menu \"Meu plano\"."],
    ["Horário de atendimento", "horario", "Nosso atendimento funciona de segunda a sexta, das 8h às 18h, e aos sábados das 8h às 12h. A central de assistência funeral atende 24 horas."],
    ["Documentos para inclusão", "documentos", "Para incluir um dependente precisamos de: RG ou certidão de nascimento, CPF e comprovante de parentesco."],
    ["Encerramento", "obrigado", "Agradecemos o contato! Qualquer dúvida, estamos à disposição. Tenha um ótimo dia 😊"],
  ];
  for (const [name, shortcut, text] of replies) {
    await prisma.quickReply.create({ data: { name, shortcut, text, allConnections: true } });
  }

  // --- Conversas individuais ---------------------------------------------
  const convs: ConvSpec[] = [
    // Na fila, aguardando atendimento
    { name: "Maria Aparecida Santos", phone: "5565999110101", status: "WAITING", tags: ["Associado ativo"], contract: "UV-102344", lines: [
      ["INBOUND", "Bom dia! Preciso da segunda via do boleto deste mês", 6],
      ["INBOUND", "Meu contrato é o 102344", 5],
    ] },
    { name: "José Ribeiro", phone: "5565999110102", status: "WAITING", lines: [
      ["INBOUND", "Boa tarde, gostaria de saber os valores do plano familiar", 12],
    ] },
    { name: "Fernanda Lopes", phone: "5565999110103", status: "WAITING", tags: ["Inadimplente"], contract: "UV-098771", lines: [
      ["INBOUND", "Oi, recebi uma mensagem dizendo que meu plano está suspenso. Como faço pra regularizar?", 3],
    ] },
    { name: "Antônio Carlos Pereira", phone: "5565999110104", status: "NEW", lines: [
      ["INBOUND", "Olá", 1],
    ] },
    { name: "Rosângela Martins", phone: "5565999110105", status: "WAITING", sales: true, tags: ["Novo plano"], lines: [
      ["INBOUND", "Vi o anúncio de vocês no Instagram. O plano cobre cremação?", 9],
    ] },

    // Em atendimento
    { name: "Luciana Ferreira", phone: "5565999110201", status: "IN_PROGRESS", agent: "ana", tags: ["Associado ativo", "Cliente VIP"], contract: "UV-087120",
      pinnedNote: "Titular desde 2012. Prefere contato pelo WhatsApp, não ligar no horário de almoço.", unread: true, lines: [
      ["INBOUND", "Bom dia! Quero incluir minha neta no plano", 42],
      ["OUTBOUND", "Bom dia, Luciana! Aqui é a Ana da Univida 💙 Claro, vou te ajudar com a inclusão.", 40],
      ["OUTBOUND", "Para incluir um dependente precisamos de: RG ou certidão de nascimento, CPF e comprovante de parentesco.", 39],
      ["INBOUND", "Ela tem 3 anos, serve a certidão de nascimento?", 30],
      ["OUTBOUND", "Serve sim! Pode enviar uma foto por aqui mesmo.", 29],
      ["INBOUND", "Vou tirar a foto e já mando", 4],
    ] },
    { name: "Roberto Nascimento", phone: "5565999110202", status: "IN_PROGRESS", agent: "ana", tags: ["Inadimplente"], contract: "UV-110455",
      note: "Cliente pediu negociação das 3 parcelas em atraso. Verificar com o financeiro se pode parcelar em 2x.", lines: [
      ["INBOUND", "Estou com 3 mensalidades atrasadas, tem como negociar?", 75],
      ["OUTBOUND", "Olá, Roberto! Tem sim. Vou verificar as condições com o setor financeiro e já te retorno.", 70],
      ["INBOUND", "Ok, fico no aguardo", 68],
    ] },
    { name: "Cláudia Mendes", phone: "5565999110203", status: "IN_PROGRESS", agent: "carlos", tags: ["Assistência funeral"], contract: "UV-075532",
      pinnedNote: "Óbito do pai (titular) em 26/10. Assistência funeral já prestada — acompanhar pós-atendimento.", lines: [
      ["INBOUND", "Bom dia. Meu pai faleceu essa semana e ele era o titular do plano. O que acontece com o contrato agora?", 55],
      ["OUTBOUND", "Bom dia, Cláudia. Sentimos muito pela sua perda. Estamos à disposição para tudo o que precisar.", 52],
      ["OUTBOUND", "O contrato pode ser transferido para um dos dependentes, sem carência. Você gostaria de assumir a titularidade?", 51],
      ["INBOUND", "Sim, gostaria. Minha mãe também está no plano", 35],
      ["OUTBOUND", "Perfeito. Vou te enviar a lista de documentos para a transferência de titularidade.", 33],
    ] },
    { name: "Marcos Vinícius", phone: "5565999110204", status: "IN_PROGRESS", agent: "carlos", tags: ["Associado ativo"], unread: true, lines: [
      ["INBOUND", "Como faço pra baixar a carteirinha digital?", 20],
      ["OUTBOUND", "Olá, Marcos! Sua carteirinha digital está disponível no aplicativo Univida, no menu \"Meu plano\".", 18],
      ["INBOUND", "Não estou conseguindo entrar no app, diz que a senha está errada", 2],
    ] },
    { name: "Sandra Oliveira", phone: "5565999110205", status: "IN_PROGRESS", agent: "juliana", tags: ["Associado ativo"], contract: "UV-093310", lines: [
      ["INBOUND", "Mudei de endereço, preciso atualizar o cadastro", 95],
      ["OUTBOUND", "Oi, Sandra! Me informe por favor o novo endereço completo com CEP.", 93],
      ["INBOUND", "Rua das Palmeiras, 450, Bairro Jardim Itália, CEP 78060-000", 80],
      ["OUTBOUND", "Cadastro atualizado com sucesso ✅ Posso ajudar em algo mais?", 78],
    ] },
    { name: "Paulo Henrique Costa", phone: "5565999110206", status: "IN_PROGRESS", agent: "juliana", tags: ["Retornar ligação"], unread: true, lines: [
      ["INBOUND", "Vocês têm convênio com farmácia?", 15],
      ["OUTBOUND", "Temos sim, Paulo! Os associados têm desconto nas farmácias parceiras. Quer que eu envie a lista?", 13],
      ["INBOUND", "Quero sim, e também queria saber se tem desconto em consulta médica", 1],
    ] },
    { name: "Eduardo Barros", phone: "5565999110207", status: "IN_PROGRESS", agent: "pedro", sales: true, tags: ["Novo plano"], lines: [
      ["INBOUND", "Quero fazer um plano para mim, minha esposa e meus dois filhos", 50],
      ["OUTBOUND", "Que ótimo, Eduardo! O Plano Família Univida cobre titular + até 6 dependentes. Posso te passar os valores?", 48],
      ["INBOUND", "Pode sim", 47],
      ["OUTBOUND", "O plano familiar fica a partir de R$ 59,90 por mês, com assistência funeral completa e clube de descontos.", 45],
      ["INBOUND", "Gostei. Como faço a adesão?", 10],
    ] },
    { name: "Tereza Cristina Alves", phone: "5565999110208", status: "TRANSFERRED", agent: "juliana", tags: ["Associado ativo"], lines: [
      ["INBOUND", "Quero mudar a data de vencimento do meu boleto para o dia 20", 30],
      ["OUTBOUND", "Olá, Tereza! Vou transferir você para a Juliana, do financeiro, que cuida disso.", 26],
    ] },

    // Encerradas (histórico e relatórios)
    { name: "Gabriel Souza", phone: "5565999110301", status: "CLOSED", agent: "ana", tags: ["Associado ativo"], lines: [
      ["INBOUND", "Qual o horário de atendimento de vocês?", 60 * 26],
      ["OUTBOUND", "Nosso atendimento funciona de segunda a sexta, das 8h às 18h, e aos sábados das 8h às 12h. A central de assistência funeral atende 24 horas.", 60 * 26 - 2],
      ["INBOUND", "Obrigado!", 60 * 26 - 5],
      ["OUTBOUND", "Agradecemos o contato! Qualquer dúvida, estamos à disposição. Tenha um ótimo dia 😊", 60 * 26 - 6],
    ] },
    { name: "Helena Duarte", phone: "5565999110302", status: "CLOSED", agent: "carlos", lines: [
      ["INBOUND", "Paguei o boleto ontem, já consta no sistema?", 60 * 30],
      ["OUTBOUND", "Olá, Helena! Já consta sim, pagamento confirmado ✅", 60 * 30 - 4],
      ["INBOUND", "Ótimo, obrigada", 60 * 30 - 6],
    ] },
    { name: "Ricardo Gomes", phone: "5565999110303", status: "CLOSED", agent: "juliana", tags: ["Inadimplente"], lines: [
      ["INBOUND", "Quero cancelar meu plano", 60 * 48],
      ["OUTBOUND", "Olá, Ricardo. Posso saber o motivo? Temos condições especiais para manter seu plano ativo.", 60 * 48 - 3],
      ["INBOUND", "Está pesando no orçamento", 60 * 48 - 10],
      ["OUTBOUND", "Entendo. Consigo te oferecer 3 meses com 30% de desconto. O que acha?", 60 * 48 - 12],
      ["INBOUND", "Aí fica bom, vou continuar", 60 * 48 - 20],
    ] },
    { name: "Vanessa Teixeira", phone: "5565999110304", status: "CLOSED", agent: "pedro", sales: true, tags: ["Novo plano"], lines: [
      ["INBOUND", "Quero contratar o plano individual", 60 * 72],
      ["OUTBOUND", "Que bom, Vanessa! Vou te enviar o link para a adesão digital.", 60 * 72 - 5],
      ["INBOUND", "Pronto, preenchi tudo", 60 * 72 - 40],
      ["OUTBOUND", "Recebemos! Seja muito bem-vinda à Univida 💙", 60 * 72 - 42],
    ] },
    { name: "Francisco das Chagas", phone: "5565999110305", status: "CLOSED", agent: "ana", tags: ["Assistência funeral"], lines: [
      ["INBOUND", "Preciso acionar a assistência funeral, minha sogra faleceu agora há pouco", 60 * 96],
      ["OUTBOUND", "Sentimos muito, Francisco. Nossa equipe de plantão já foi acionada e entrará em contato em instantes pelo telefone.", 60 * 96 - 1],
      ["INBOUND", "Obrigado pelo apoio", 60 * 96 - 30],
    ] },
    { name: "Juliana Prado", phone: "5565999110306", status: "CLOSED", agent: "carlos", lines: [
      ["INBOUND", "Vocês emitem declaração de quitação para o imposto de renda?", 60 * 120],
      ["OUTBOUND", "Emitimos sim! Vou gerar e te enviar em PDF.", 60 * 120 - 3],
      ["INBOUND", "Recebi, muito obrigada", 60 * 120 - 15],
    ] },
  ];

  let msgSeq = 0;
  const agentOf = (key?: string) => (key ? agents[key as AgentKey] : undefined);

  for (const spec of convs) {
    const connectionId = spec.sales ? comercial.id : central.id;
    const first = Math.max(...spec.lines.map((l) => l[2]));
    const last = Math.min(...spec.lines.map((l) => l[2]));
    const contact = await prisma.contact.create({
      data: {
        whatsappConnectionId: connectionId,
        phone: spec.phone,
        providerChatId: `${spec.phone}@s.whatsapp.net`,
        name: spec.name,
        firstName: spec.name.split(" ")[0],
        contractNumber: spec.contract,
        pinnedNote: spec.pinnedNote,
        pinnedNoteUpdatedAt: spec.pinnedNote ? ago(first) : undefined,
        pinnedNoteUpdatedBy: spec.pinnedNote ? (agentOf(spec.agent)?.displayName ?? "Patrícia") : undefined,
        firstConversationAt: ago(first),
        lastInteractionAt: ago(last),
      },
    });
    const agent = agentOf(spec.agent);
    for (const t of spec.tags ?? []) {
      await prisma.contactTag.create({ data: { contactId: contact.id, tagId: tags.get(t)!, addedById: agent?.id } });
    }

    const lastLine = spec.lines[spec.lines.length - 1];
    const firstOutbound = spec.lines.find((l) => l[0] === "OUTBOUND");
    const closed = spec.status === "CLOSED";
    const conversation = await prisma.conversation.create({
      data: {
        whatsappConnectionId: connectionId,
        contactId: contact.id,
        status: spec.status,
        assignedAgentId: agent?.id,
        enteredQueueAt: ago(first),
        acceptedAt: agent ? ago(first - 1) : undefined,
        firstResponseAt: firstOutbound ? ago(firstOutbound[2]) : undefined,
        closedAt: closed ? ago(last - 1) : undefined,
        closedByUserId: closed ? agent?.id : undefined,
        assignedAgentReadAt: agent && !spec.unread ? ago(last) : undefined,
        lastMessageAt: ago(last),
        lastMessageDirection: lastLine[0],
        awaitingReplySince: !closed && lastLine[0] === "INBOUND" ? ago(lastLine[2]) : undefined,
        createdAt: ago(first),
      },
    });

    for (const [direction, body, minutes] of spec.lines) {
      await prisma.message.create({
        data: {
          conversationId: conversation.id,
          direction,
          type: "TEXT",
          status: direction === "OUTBOUND" ? "READ" : "DELIVERED",
          body,
          providerMessageId: `DEMO-${++msgSeq}`,
          senderAgentId: direction === "OUTBOUND" ? agent?.id : undefined,
          createdAt: ago(minutes),
          deliveredAt: ago(minutes),
          readAt: direction === "OUTBOUND" ? ago(minutes - 1) : undefined,
        },
      });
    }

    await prisma.conversationEvent.create({ data: { conversationId: conversation.id, type: "CREATED", createdAt: ago(first) } });
    if (agent) {
      await prisma.conversationAssignment.create({ data: { conversationId: conversation.id, toAgentId: agent.id, reason: "ACCEPT", createdAt: ago(first - 1) } });
      await prisma.conversationEvent.create({ data: { conversationId: conversation.id, type: "ACCEPTED", createdAt: ago(first - 1) } });
    }
    if (spec.status === "TRANSFERRED" && agent) {
      await prisma.conversationTransfer.create({
        data: { conversationId: conversation.id, fromAgentId: agents.ana.id, toAgentId: agent.id, initiatedById: agents.ana.id, note: "Alteração de vencimento — financeiro", createdAt: ago(26) },
      });
    }
    if (closed) await prisma.conversationEvent.create({ data: { conversationId: conversation.id, type: "CLOSED", createdAt: ago(last - 1) } });
    if (spec.note) await prisma.conversationNote.create({ data: { conversationId: conversation.id, authorId: agent?.id, body: spec.note, createdAt: ago(last - 1) } });
  }

  // --- Grupos do WhatsApp -------------------------------------------------
  const groups: { name: string; id: string; participants: number; lines: [string, string, string, number][] }[] = [
    { name: "Equipe Univida - Plantão", id: "120363000000000001", participants: 12, lines: [
      ["Rafael (Plantão)", "5565999220001", "Bom dia equipe! Plantão de hoje: Rafael e Simone na funerária central", 180],
      ["Simone", "5565999220002", "Confirmado 👍", 175],
      ["Rafael (Plantão)", "5565999220001", "Atendimento em andamento na capela 2, previsão de término 14h", 60],
      ["Coordenação", "5565999220003", "Obrigado pelo retorno, Rafael", 58],
    ] },
    { name: "Parceiros - Clube de Descontos", id: "120363000000000002", participants: 34, lines: [
      ["Farmácia Vida", "5565999220011", "Bom dia! Nova campanha: 20% de desconto em genéricos para associados Univida até o fim do mês", 300],
      ["Clínica Bem Estar", "5565999220012", "Ótimo! Nós estamos com consulta a R$ 79 para associados", 240],
      ["Ótica Visão", "5565999220013", "Exame de vista gratuito na compra de óculos 👓", 90],
    ] },
    { name: "Comercial - Vendedores Externos", id: "120363000000000003", participants: 8, lines: [
      ["Marcelo Vendas", "5565999220021", "Fechei 4 contratos hoje no bairro CPA 💪", 400],
      ["Larissa", "5565999220022", "Parabéns! Eu fechei 2 no Coxipó", 380],
      ["Marcelo Vendas", "5565999220021", "Alguém tem material impresso do plano familiar sobrando?", 20],
    ] },
  ];
  for (const g of groups) {
    const first = Math.max(...g.lines.map((l) => l[3]));
    const last = Math.min(...g.lines.map((l) => l[3]));
    const contact = await prisma.contact.create({
      data: { whatsappConnectionId: central.id, phone: g.id, providerChatId: `${g.id}@g.us`, name: g.name, isGroup: true, groupParticipantsCount: g.participants, firstConversationAt: ago(first), lastInteractionAt: ago(last) },
    });
    const conversation = await prisma.conversation.create({
      data: { whatsappConnectionId: central.id, contactId: contact.id, status: "GROUP", enteredQueueAt: ago(first), lastMessageAt: ago(last), lastMessageDirection: "INBOUND", createdAt: ago(first) },
    });
    for (const [who, phone, body, minutes] of g.lines) {
      await prisma.message.create({
        data: {
          conversationId: conversation.id, direction: "INBOUND", type: "TEXT", status: "DELIVERED", body, providerMessageId: `DEMO-${++msgSeq}`,
          senderParticipantJid: `${phone}@s.whatsapp.net`, senderParticipantName: who, senderParticipantPhone: phone, createdAt: ago(minutes),
        },
      });
    }
  }

  // --- Chat interno -------------------------------------------------------
  const everyone = await prisma.user.findMany({ where: { status: "ACTIVE" }, select: { id: true } });
  const general = (await prisma.chatRoom.findFirst({ where: { kind: "GENERAL" } })) ?? (await prisma.chatRoom.create({ data: { kind: "GENERAL", name: "#Geral" } }));
  for (const u of everyone) {
    await prisma.chatMember.upsert({ where: { roomId_userId: { roomId: general.id, userId: u.id } }, create: { roomId: general.id, userId: u.id, joinedAt: ago(60 * 24 * 7) }, update: {} });
  }
  const say = (roomId: string, authorId: string, body: string, minutes: number, extra: object = {}) =>
    prisma.chatMessage.create({ data: { roomId, authorId, body, createdAt: ago(minutes), ...extra } });

  const welcome = await say(general.id, agents.gestora.id, "Bom dia, pessoal! ☀️ Lembrando que hoje a meta é zerar a fila até as 17h.", 240);
  await say(general.id, agents.ana.id, "Bom dia! Bora 💪", 238);
  await say(general.id, agents.carlos.id, "Bom dia! Já estou com 2 atendimentos em andamento", 236);
  await say(general.id, agents.gestora.id, "@todos reunião rápida às 14h na sala de treinamento sobre o novo plano familiar", 120, { mentions: ["ALL"] });
  await say(general.id, agents.juliana.id, "Combinado!", 118);
  await prisma.chatReaction.createMany({ data: [
    { messageId: welcome.id, userId: agents.ana.id, emoji: "👍" },
    { messageId: welcome.id, userId: agents.carlos.id, emoji: "💪" },
    { messageId: welcome.id, userId: agents.juliana.id, emoji: "❤️" },
  ] });
  await prisma.chatPin.create({ data: { roomId: general.id, messageId: welcome.id, pinnedById: agents.gestora.id, pinnedAt: ago(239) } });

  const pollMsg = await prisma.chatMessage.create({
    data: { roomId: general.id, authorId: agents.gestora.id, kind: "POLL", body: "Qual o melhor dia para o treinamento do sistema?", createdAt: ago(90) },
  });
  const poll = await prisma.chatPoll.create({ data: { messageId: pollMsg.id, question: "Qual o melhor dia para o treinamento do sistema?" } });
  const opts = [];
  for (const [i, text] of ["Terça-feira", "Quarta-feira", "Quinta-feira"].entries()) {
    opts.push(await prisma.chatPollOption.create({ data: { pollId: poll.id, text, position: i } }));
  }
  await prisma.chatPollVote.createMany({ data: [
    { pollId: poll.id, optionId: opts[1].id, userId: agents.ana.id },
    { pollId: poll.id, optionId: opts[1].id, userId: agents.carlos.id },
    { pollId: poll.id, optionId: opts[2].id, userId: agents.juliana.id },
  ] });

  const group = await prisma.chatRoom.create({
    data: { kind: "GROUP", name: "Financeiro & Cobrança", description: "Negociações, boletos e inadimplência", icon: "💰", ownerId: agents.gestora.id, createdAt: ago(60 * 24 * 5) },
  });
  for (const u of [agents.gestora, agents.ana, agents.juliana]) {
    await prisma.chatMember.create({ data: { roomId: group.id, userId: u.id, isAdmin: u.id === agents.gestora.id, joinedAt: ago(60 * 24 * 5) } });
  }
  await say(group.id, agents.ana.id, "Patrícia, o Roberto Nascimento quer negociar 3 parcelas em atraso. Posso oferecer em 2x?", 66);
  await say(group.id, agents.gestora.id, "Pode sim, Ana. Sem juros se ele pagar a primeira ainda essa semana.", 60);
  await say(group.id, agents.juliana.id, "Anotado, vou usar a mesma regra nas minhas negociações", 58);

  const direct = await prisma.chatRoom.create({ data: { kind: "DIRECT", createdAt: ago(60 * 24 * 2) } });
  for (const u of [agents.ana, agents.carlos]) await prisma.chatMember.create({ data: { roomId: direct.id, userId: u.id, joinedAt: ago(60 * 24 * 2) } });
  await say(direct.id, agents.carlos.id, "Ana, você sabe como resetar a senha do app de um associado?", 15);
  await say(direct.id, agents.ana.id, "Sei sim! É no portal administrativo, menu Associados > Redefinir acesso", 12);
  await say(direct.id, agents.carlos.id, "Valeu! 🙏", 11);

  console.log(`Dados de demonstração criados. Usuários de exemplo: gestora/ana/carlos/juliana/usuario@exemplo.com — senha ${DEMO_PASSWORD}`);
}
