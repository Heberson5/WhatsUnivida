/**
 * Dados de DEMONSTRACAO do WhatsUnivida.
 *
 * Cria, de forma repetivel, um ambiente completo para apresentar o sistema
 * sem depender de WhatsApp real: 3 conexoes de demonstracao (isDemo = true,
 * rodam no simulador mesmo com WHATSAPP_PROVIDER=baileys), atendentes,
 * contatos com foto, conversas em todos os estados (fila, em atendimento,
 * transferida, encerrada, abandonada, atendida pelo celular), historico de
 * ~30 dias para Dashboard/Relatorios, anexos, reacoes, respostas citadas,
 * respostas rapidas e trilha de auditoria.
 *
 * Tudo e FICTICIO. Telefones usam o padrao 55 65 9 0000-xxxx (faixa sem uso
 * real), nomes e valores sao inventados.
 *
 * Uso:
 *   npm run seed                      (cria usuarios base + dados de demo)
 *   SEED_DEMO_FORCE=true npm run seed (apaga os dados de demo e recria, com datas de "agora")
 *   SEED_DEMO_DATA=false npm run seed (so usuarios base, sem demonstracao)
 *
 * Nunca toca em conexoes reais (isDemo = false) nem nas conversas delas.
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import type { MessageStatus, MessageType, Prisma, PrismaClient, Role } from "@prisma/client";

// ---------------------------------------------------------------------------
// Utilitarios
// ---------------------------------------------------------------------------

function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20261028);
const rint = (min: number, max: number) => Math.floor(rand() * (max - min + 1)) + min;
const pick = <T>(arr: readonly T[]): T => arr[Math.floor(rand() * arr.length)];

const MIN = 60_000;
const NOW = new Date();
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * MIN);

const UPLOAD_DIR = process.env.UPLOAD_DIR ?? "./uploads";
const ASSET_DIR = path.join(__dirname, "demo-assets");

function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
}

const AVATAR_COLORS = ["#0097B4", "#7C3AED", "#F59E0B", "#10B981", "#EF4444", "#3B82F6", "#EC4899", "#14B8A6", "#6366F1", "#84CC16"];

function initials(name: string) {
  const parts = name.replace(/[^\p{L}\s]/gu, "").trim().split(/\s+/);
  return ((parts[0]?.[0] ?? "?") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
}

/** Avatar SVG com iniciais — servido pelo proprio app (/uploads/...), sem depender de CDN externa. */
function writeAvatar(dir: string, urlPrefix: string, name: string, colorIndex: number): string {
  ensureDir(dir);
  const file = `demo-${name.toLowerCase().normalize("NFD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}.svg`;
  const color = AVATAR_COLORS[colorIndex % AVATAR_COLORS.length];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256"><rect width="256" height="256" fill="${color}"/><text x="128" y="128" font-family="Arial, Helvetica, sans-serif" font-size="104" font-weight="700" fill="#ffffff" text-anchor="middle" dominant-baseline="central">${initials(name)}</text></svg>`;
  fs.writeFileSync(path.join(dir, file), svg);
  return `${urlPrefix}/${file}`;
}

// ---------------------------------------------------------------------------
// Conexoes e usuarios
// ---------------------------------------------------------------------------

type ConnKey = "AT" | "CO" | "FI";

const CONNECTIONS: Record<ConnKey, { name: string; color: string; number: string }> = {
  AT: { name: "Atendimento Univida", color: "#0097B4", number: "5565900009001" },
  CO: { name: "Comercial - Planos", color: "#F59E0B", number: "5565900009002" },
  FI: { name: "Financeiro", color: "#7C3AED", number: "5565900009003" },
};

type AgentKey = "carla" | "joao" | "pedro" | "maria" | "luciana" | "ricardo";

const AGENTS: Record<AgentKey, { email: string; fullName: string; displayName: string; conn: ConnKey; presence: "ONLINE" | "AWAY" | "OFFLINE" }> = {
  carla: { email: "carla@whatsunivida.dev", fullName: "Carla Menezes", displayName: "Carla", conn: "AT", presence: "ONLINE" },
  joao: { email: "joao@whatsunivida.dev", fullName: "Joao Pereira", displayName: "Joao", conn: "AT", presence: "AWAY" },
  pedro: { email: "pedro@whatsunivida.dev", fullName: "Pedro Henrique Lima", displayName: "Pedro", conn: "CO", presence: "ONLINE" },
  maria: { email: "maria@whatsunivida.dev", fullName: "Maria Fernandes", displayName: "Maria", conn: "CO", presence: "ONLINE" },
  luciana: { email: "luciana@whatsunivida.dev", fullName: "Luciana Barros", displayName: "Luciana", conn: "FI", presence: "ONLINE" },
  ricardo: { email: "ricardo@whatsunivida.dev", fullName: "Ricardo Nogueira", displayName: "Ricardo", conn: "FI", presence: "OFFLINE" },
};

const AGENTS_BY_CONN: Record<ConnKey, AgentKey[]> = {
  AT: ["carla", "joao"],
  CO: ["pedro", "maria"],
  FI: ["luciana", "ricardo"],
};

// ---------------------------------------------------------------------------
// Contatos (fictícios)
// ---------------------------------------------------------------------------

const CONTACT_NAMES: Record<ConnKey, string[]> = {
  AT: [
    "Rosa Maria Alencar", "Sergio Albuquerque", "Dona Terezinha Arruda", "Anderson Pires", "Helena Cavalcante",
    "Jose Carlos Brandao", "Marlene Figueiredo", "Welington Sampaio", "Edna Maria Gouveia", "Claudio Teixeira",
    "Iracema Duarte", "Osvaldo Ribeiro", "Neuza Prado", "Gilberto Moura",
  ],
  CO: [
    "Marcelo Tavares", "Patricia Monteiro", "Fabiana Rocha", "Leandro Siqueira", "Aline Cordeiro",
    "Rodrigo Esteves", "Simone Vasconcelos", "Thiago Barreto", "Vanessa Lacerda", "Eduardo Peixoto",
    "Camila Fontes", "Renato Guimaraes", "Debora Andrade", "Cesar Augusto Meireles",
  ],
  FI: [
    "Rosana Dias", "Antonio Marcos Freitas", "Luzia Carneiro", "Wagner Oliveira", "Sueli Bastos",
    "Paulo Roberto Lemos", "Joice Martins", "Nelson Batista", "Cristiane Amorim", "Valter Quintino",
    "Elaine Pacheco", "Mauro Salles", "Adriana Coutinho", "Rubens Nascimento",
  ],
};

const CONN_PHONE_BLOCK: Record<ConnKey, number> = { AT: 100, CO: 200, FI: 300 };

function phoneFor(conn: ConnKey, index: number) {
  return `556590000${String(CONN_PHONE_BLOCK[conn] + index + 1).padStart(4, "0")}`;
}

interface ContactRef {
  conn: ConnKey;
  index: number;
  name: string;
  phone: string;
}
function contactRef(conn: ConnKey, name: string): ContactRef {
  const index = CONTACT_NAMES[conn].indexOf(name);
  if (index < 0) throw new Error(`Contato de demo desconhecido: ${name}`);
  return { conn, index, name, phone: phoneFor(conn, index) };
}

// ---------------------------------------------------------------------------
// Modelo de conversa roteirizada
// ---------------------------------------------------------------------------

type AttachSpec =
  | { file: string; name: string; mime: string; kind: "IMAGE" | "DOCUMENT" }
  | { location: { lat: number; lng: number; label: string } }
  | { vcard: { name: string; phone: string } };

interface MsgSpec {
  d: "in" | "out";
  /** minutos depois do inicio da conversa */
  at: number;
  t?: string;
  attach?: AttachSpec;
  /** indice (na mesma conversa) da mensagem citada */
  reply?: number;
  reactions?: { emoji: string; by: "agent" | "customer" }[];
  preview?: { title: string; description: string; url: string };
  /** atendente que enviou (padrao: o responsavel; util antes de uma transferencia) */
  agent?: AgentKey;
  status?: MessageStatus;
}

interface ConvSpec {
  conn: ConnKey;
  contact: string;
  status: "NEW" | "WAITING" | "IN_PROGRESS" | "TRANSFERRED" | "CLOSED" | "ABANDONED" | "HANDLED_EXTERNALLY";
  agent?: AgentKey;
  /** minutos atras em que a conversa comecou */
  startAgo: number;
  /** minutos entre entrar na fila e ser aceita */
  acceptAfter?: number;
  /** minutos apos a ultima mensagem ate o encerramento (so CLOSED) */
  closeAfter?: number;
  transfer?: { from: AgentKey; to: AgentKey; note: string; at: number };
  /** o responsavel ja abriu a conversa? (default: leu tudo ate a ultima mensagem enviada por ele) */
  readAll?: boolean;
  msgs: MsgSpec[];
}

const TGS_LOCATION = { lat: -14.6229, lng: -57.4933 };

const SCRIPTED: ConvSpec[] = [
  // ----------------------------- FILA (sem responsavel) ----------------------
  {
    conn: "FI", contact: "Rosana Dias", status: "WAITING", startAgo: 14,
    msgs: [
      { d: "in", at: 0, t: "Boa tarde! Preciso da segunda via do boleto de novembro." },
      { d: "in", at: 1, t: "Vence dia 10 e nao chegou aqui no meu e-mail." },
    ],
  },
  {
    conn: "CO", contact: "Marcelo Tavares", status: "NEW", startAgo: 4,
    msgs: [
      { d: "in", at: 0, t: "Ola, vi o anuncio de voces. Quanto custa o plano para minha familia? Somos 4 pessoas." },
    ],
  },
  {
    conn: "AT", contact: "Dona Terezinha Arruda", status: "WAITING", startAgo: 26,
    msgs: [
      { d: "in", at: 0, t: "Bom dia. Queria saber como faco para incluir meu marido no plano." },
      { d: "in", at: 3, t: "Ele tem 71 anos, isso atrapalha?" },
    ],
  },
  {
    conn: "AT", contact: "Anderson Pires", status: "NEW", startAgo: 1,
    msgs: [
      { d: "in", at: 0, t: "Ola!" },
      { d: "in", at: 0, t: "Tem alguem ai?" },
    ],
  },
  {
    conn: "CO", contact: "Patricia Monteiro", status: "WAITING", startAgo: 41,
    msgs: [
      { d: "in", at: 0, t: "Boa tarde, gostaria de uma proposta do Plano Individual." },
      { d: "in", at: 1, t: "Moro em Barra do Bugres, voces atendem la?" },
    ],
  },

  // ------------------------- EM ATENDIMENTO ----------------------------------
  {
    // Acionamento do plano — conversa sensivel, tom respeitoso
    conn: "AT", contact: "Sergio Albuquerque", status: "IN_PROGRESS", agent: "carla", startAgo: 38, acceptAfter: 1,
    msgs: [
      { d: "in", at: 0, t: "Boa tarde. Preciso de ajuda urgente. Meu pai faleceu agora ha pouco e ele e titular do plano de voces." },
      { d: "out", at: 2, t: "Boa tarde, Sergio. Sinto muito pela sua perda. Pode ficar tranquilo, vou te acompanhar em cada passo agora." },
      { d: "out", at: 2, t: "Para acionarmos o plano, preciso de duas informacoes: o nome completo do seu pai e onde ele esta neste momento (casa ou hospital)." },
      { d: "in", at: 5, t: "Ele se chamava Valdemar Albuquerque. Esta em casa, aqui em Tangara da Serra, no Jardim Europa." },
      { d: "out", at: 7, t: "Obrigada. Ja estou acionando a equipe de plantao e eles entram em contato com voce em instantes. Fique com o telefone por perto, por favor." },
      { d: "in", at: 9, t: "Ta bom. Meu irmao tambem vai acompanhar, vou passar o contato dele.", reactions: [{ emoji: "🙏", by: "agent" }] },
      { d: "in", at: 10, attach: { vcard: { name: "Luiz Albuquerque (irmao)", phone: "5565900000999" } } },
      { d: "out", at: 12, t: "Recebi o contato do Luiz. Enquanto a equipe chega, deixo aqui a localizacao da capela da unidade para a familia ter como referencia." },
      { d: "out", at: 12, attach: { location: { ...TGS_LOCATION, label: "Capela da Unidade TGS (localizacao de exemplo)" } } },
      { d: "in", at: 33, t: "A equipe acabou de chegar. Muito obrigado pelo cuidado." },
    ],
  },
  {
    conn: "FI", contact: "Antonio Marcos Freitas", status: "IN_PROGRESS", agent: "luciana", startAgo: 52, acceptAfter: 3,
    msgs: [
      { d: "in", at: 0, t: "Boa tarde, ja fiz o pagamento da mensalidade por PIX mas o sistema ainda mostra em aberto." },
      { d: "out", at: 4, t: "Boa tarde, Antonio! Pode me enviar o comprovante, por favor? Vou localizar o pagamento." },
      { d: "in", at: 6, t: "Segue", attach: { file: "comprovante-pix.png", name: "comprovante-pix.png", mime: "image/png", kind: "IMAGE" } },
      { d: "out", at: 9, t: "Recebi, obrigada! Encontrei o PIX de R$ 89,90 feito hoje cedo. Vou solicitar a baixa agora.", reactions: [{ emoji: "👍", by: "customer" }] },
      { d: "out", at: 10, t: "A baixa costuma refletir em ate 1 dia util. Qualquer coisa me chama por aqui." },
      { d: "in", at: 46, t: "Beleza, obrigado!" },
    ],
  },
  {
    conn: "CO", contact: "Fabiana Rocha", status: "IN_PROGRESS", agent: "pedro", startAgo: 95, acceptAfter: 2,
    msgs: [
      { d: "in", at: 0, t: "Oi! Quero contratar um plano para mim, meu marido e 2 filhos." },
      { d: "out", at: 3, t: "Oi, Fabiana! Tudo bem? Para uma familia com 4 pessoas, a Modalidade de Plano mais indicada e a Familiar. Vou te mandar uma proposta de exemplo." },
      { d: "out", at: 4, t: "Proposta - Plano Familiar", attach: { file: "proposta-plano-familiar.pdf", name: "proposta-plano-familiar.pdf", mime: "application/pdf", kind: "DOCUMENT" } },
      { d: "in", at: 20, t: "Entendi. E tem carencia?", reply: 1 },
      { d: "out", at: 24, t: "Boa pergunta! A carencia depende da Modalidade de Plano escolhida. Vou confirmar as condicoes da Familiar e te passo certinho.", reply: 3 },
      { d: "out", at: 25, t: "Enquanto isso, deixo aqui o link com mais detalhes:", preview: { title: "Univida Santa Cruz - Planos de assistencia funeral", description: "Conheca as Modalidades de Plano e como funciona o atendimento 24 horas.", url: "https://univida.example.com/planos" } },
      { d: "in", at: 88, t: "Pode me ligar amanha de manha para fechar?" },
    ],
  },
  {
    conn: "AT", contact: "Helena Cavalcante", status: "IN_PROGRESS", agent: "joao", startAgo: 70, acceptAfter: 5,
    msgs: [
      { d: "in", at: 0, t: "Bom dia! Mudei de endereco e preciso atualizar o cadastro." },
      { d: "out", at: 6, t: "Bom dia, Helena! Claro, eu faco isso por aqui. Qual e o endereco novo completo, com CEP?" },
      { d: "in", at: 9, t: "Rua das Palmeiras, 410, Jardim Aeroporto, Tangara da Serra. CEP 78300-000." },
      { d: "out", at: 12, t: "Perfeito, cadastro atualizado! Voce vai receber uma confirmacao por mensagem em instantes.", status: "READ" },
    ],
    readAll: true,
  },
  {
    conn: "CO", contact: "Leandro Siqueira", status: "IN_PROGRESS", agent: "maria", startAgo: 33, acceptAfter: 1,
    msgs: [
      { d: "in", at: 0, t: "Boa tarde. Ja tenho o plano e queria saber quantos dependentes posso incluir." },
      { d: "out", at: 3, t: "Boa tarde, Leandro! Depende da sua Modalidade de Plano. Pode me enviar uma foto do seu cartao de beneficiario?" },
      { d: "in", at: 6, t: "Aqui", attach: { file: "cartao-beneficiario.png", name: "cartao-beneficiario.png", mime: "image/png", kind: "IMAGE" } },
      { d: "out", at: 9, t: "Obrigada! Sua Modalidade e a Familiar, entao da para incluir dependentes do grupo familiar. Quais voce quer incluir?" },
      { d: "in", at: 28, t: "Minha mae e minha sogra." },
      { d: "in", at: 29, t: "Precisa de documento?" },
    ],
  },
  {
    // Transferida entre atendentes da mesma conexao (ainda nao lida pela nova responsavel)
    conn: "AT", contact: "Edna Maria Gouveia", status: "TRANSFERRED", agent: "carla", startAgo: 60, acceptAfter: 2,
    transfer: { from: "joao", to: "carla", note: "Cliente pergunta sobre translado para outro estado. Precisa da coordenacao operacional.", at: 24 },
    msgs: [
      { d: "in", at: 0, t: "Boa tarde. Meu tio mora em Cuiaba mas quer ser atendido em Campo Novo do Parecis pelo plano. Da para fazer?", agent: "joao" },
      { d: "out", at: 3, t: "Boa tarde, Edna! Vou verificar com a equipe responsavel e ja te respondo.", agent: "joao" },
      { d: "in", at: 18, t: "Fico no aguardo.", agent: "joao" },
      { d: "in", at: 40, t: "Conseguiram ver?" },
    ],
  },
  {
    // Transferida do Comercial para o Financeiro (ja lida)
    conn: "FI", contact: "Luzia Carneiro", status: "TRANSFERRED", agent: "luciana", startAgo: 120, acceptAfter: 4,
    transfer: { from: "pedro", to: "luciana", note: "Cliente fechou o Plano Familiar. Falta emitir o primeiro boleto.", at: 45 },
    readAll: true,
    msgs: [
      { d: "in", at: 0, t: "Quero fechar o plano familiar que voces me mandaram.", agent: "pedro" },
      { d: "out", at: 5, t: "Que otimo, Luzia! Vou passar para o financeiro emitir o seu primeiro boleto.", agent: "pedro" },
      { d: "out", at: 50, t: "Oi, Luzia! Aqui e a Luciana, do financeiro. Segue o boleto da primeira mensalidade:", agent: "luciana" },
      { d: "out", at: 50, t: "Boleto - 1a mensalidade", attach: { file: "boleto-exemplo.pdf", name: "boleto-exemplo.pdf", mime: "application/pdf", kind: "DOCUMENT" }, agent: "luciana" },
      { d: "in", at: 58, t: "Recebi! Pago ainda hoje.", reactions: [{ emoji: "👍", by: "agent" }] },
    ],
  },

  // ------------------------ ABANDONADA / ATENDIDA PELO CELULAR ---------------
  {
    conn: "AT", contact: "Osvaldo Ribeiro", status: "ABANDONED", startAgo: 60 * 30,
    msgs: [
      { d: "in", at: 0, t: "Boa noite" },
      { d: "in", at: 2, t: "Alguem pode me ajudar com uma duvida sobre o plano?" },
    ],
  },
  {
    conn: "AT", contact: "Neuza Prado", status: "HANDLED_EXTERNALLY", startAgo: 60 * 5,
    msgs: [
      { d: "in", at: 0, t: "Bom dia! A unidade de Denise abre sabado?" },
      { d: "out", at: 6, t: "Bom dia, Neuza! Abre sim, das 8h as 12h.", status: "READ" },
    ],
  },

  // ----------------------------- ENCERRADAS (roteirizadas) -------------------
  {
    conn: "FI", contact: "Wagner Oliveira", status: "CLOSED", agent: "ricardo", startAgo: 60 * 26, acceptAfter: 3, closeAfter: 6,
    msgs: [
      { d: "in", at: 0, t: "Boa tarde! Posso mudar a data de vencimento do meu boleto para o dia 20?" },
      { d: "out", at: 4, t: "Boa tarde, Wagner! Consigo sim. Vou alterar o vencimento para o dia 20 a partir do proximo ciclo." },
      { d: "in", at: 7, t: "Perfeito, obrigado!", reactions: [{ emoji: "👍", by: "agent" }] },
      { d: "out", at: 8, t: "Por nada! Alteracao registrada. Precisando, e so chamar." },
    ],
  },
  {
    conn: "CO", contact: "Simone Vasconcelos", status: "CLOSED", agent: "maria", startAgo: 60 * 50, acceptAfter: 2, closeAfter: 10,
    msgs: [
      { d: "in", at: 0, t: "Ola, tenho uma empresa com 12 funcionarios. Voces tem plano para empresas?" },
      { d: "out", at: 4, t: "Ola, Simone! Temos sim. Vou agendar uma conversa com um consultor para montar uma proposta para a sua equipe. Qual o melhor horario?" },
      { d: "in", at: 8, t: "Amanha apos as 14h." },
      { d: "out", at: 10, t: "Combinado! Amanha as 14h30 um consultor entra em contato. Obrigada pelo interesse!" },
      { d: "in", at: 11, t: "Obrigada!" },
    ],
  },
];

// ---------------------------------------------------------------------------
// Roteiros para o historico gerado (30 dias)
// ---------------------------------------------------------------------------

type Turn = [("in" | "out"), string];
const TEMPLATES: Record<ConnKey, Turn[][]> = {
  AT: [
    [
      ["in", "Boa tarde, perdi a carteirinha do plano. Como faco para pedir outra?"],
      ["out", "Boa tarde, {nome}! Posso solicitar a segunda via para voce. Pode confirmar o nome completo do titular?"],
      ["in", "Sou o titular mesmo, {nome}."],
      ["out", "Obrigada! Solicitacao registrada. A nova carteirinha fica disponivel para retirada na unidade."],
      ["in", "Perfeito, obrigado!"],
      ["out", "Por nada! Posso ajudar em mais alguma coisa?"],
      ["in", "So isso, obrigado."],
    ],
    [
      ["in", "Oi, quero incluir minha filha como dependente no plano."],
      ["out", "Oi, {nome}! Claro. Preciso do nome completo e da data de nascimento dela, por favor."],
      ["in", "Mariana Souza, nascida em 14/03/2009."],
      ["out", "Anotado. Para concluir, preciso de uma foto do documento de identificacao dela."],
      ["in", "Mando hoje a tarde."],
      ["out", "Combinado, fico no aguardo. Assim que chegar finalizo a inclusao."],
    ],
    [
      ["in", "Bom dia! Mudei de endereco, como atualizo no cadastro?"],
      ["out", "Bom dia, {nome}! Eu atualizo por aqui mesmo. Qual e o endereco novo, com CEP?"],
      ["in", "Avenida Brasil, 1200, Centro. CEP 78300-000."],
      ["out", "Cadastro atualizado com sucesso!"],
      ["in", "Muito obrigado."],
    ],
    [
      ["in", "Boa tarde, o plano cobre atendimento fora da minha cidade?"],
      ["out", "Boa tarde, {nome}! A cobertura de atendimento em outras cidades depende da area de abrangencia da sua Modalidade de Plano. Em qual cidade voce pensa?"],
      ["in", "Em Barra do Bugres, onde mora minha mae."],
      ["out", "Barra do Bugres esta na nossa rede, com unidade propria. Pode ficar tranquilo."],
      ["in", "Que alivio! Obrigado pela atencao."],
    ],
    [
      ["in", "So queria agradecer o atendimento que minha familia recebeu semana passada. Foram muito atenciosos."],
      ["out", "Muito obrigada pelas palavras, {nome}. Vou repassar a toda a equipe. Estamos sempre a disposicao."],
      ["in", "Deus abencoe voces."],
    ],
    [
      ["in", "Qual o horario de funcionamento da unidade de Campo Novo do Parecis?"],
      ["out", "Ola, {nome}! A unidade funciona de segunda a sexta, das 8h as 18h, e aos sabados das 8h as 12h. O plantao funerario atende 24 horas."],
      ["in", "Obrigada!"],
    ],
  ],
  CO: [
    [
      ["in", "Ola, quanto custa o Plano Individual?"],
      ["out", "Ola, {nome}! O Plano Individual de exemplo parte de R$ 59,90 por mes. Posso te enviar uma proposta com todos os detalhes?"],
      ["in", "Pode sim."],
      ["out", "Perfeito! Qual o seu nome completo e a cidade onde mora?"],
      ["in", "{nome}, moro em Nova Olimpia."],
      ["out", "Obrigada! Envio a proposta ainda hoje e um consultor entra em contato. Combinado?"],
      ["in", "Combinado."],
    ],
    [
      ["in", "Quantos dependentes o Plano Familiar aceita?"],
      ["out", "Ola, {nome}! O Plano Familiar aceita o titular e dependentes do grupo familiar, conforme as regras do contrato. Quantas pessoas voce quer incluir?"],
      ["in", "Eu, esposa e 3 filhos."],
      ["out", "Entao cabe certinho na Familiar. Vou preparar a proposta."],
      ["in", "Fico no aguardo, obrigado."],
    ],
    [
      ["in", "Voces fazem plano para empresas? Tenho 20 funcionarios."],
      ["out", "Fazemos sim, {nome}! Vou encaminhar para um consultor montar uma proposta personalizada. Qual o melhor horario para contato?"],
      ["in", "De manha, por volta das 9h."],
      ["out", "Anotado. Amanha as 9h um consultor entra em contato. Obrigada!"],
    ],
    [
      ["in", "Tem carencia no plano?"],
      ["out", "Ola, {nome}! Cada Modalidade de Plano tem suas condicoes de carencia, descritas em contrato. Qual modalidade voce tem interesse?"],
      ["in", "A familiar."],
      ["out", "Vou confirmar as condicoes da Familiar e te passo detalhado. Um instante."],
      ["out", "Confirmado! Te envio o resumo das condicoes por aqui mesmo em seguida."],
      ["in", "Show, obrigado."],
    ],
    [
      ["in", "Um amigo me indicou voces. Posso agendar uma visita para conhecer a unidade?"],
      ["out", "Que bom, {nome}! Temos prazer em receber voce. Qual o melhor dia e horario para a visita?"],
      ["in", "Sexta de manha."],
      ["out", "Agendado para sexta, as 9h. Te aguardamos!"],
    ],
  ],
  FI: [
    [
      ["in", "Boa tarde, preciso da segunda via do boleto deste mes."],
      ["out", "Boa tarde, {nome}! Ja envio por aqui."],
      ["out", "Segue o boleto atualizado. O vencimento e dia 10."],
      ["in", "Recebi, obrigado."],
      ["out", "Por nada! Mais alguma duvida?"],
      ["in", "Nao, so isso."],
    ],
    [
      ["in", "Ja paguei a mensalidade mas ainda aparece em aberto."],
      ["out", "Oi, {nome}! Pode me enviar o comprovante para eu localizar o pagamento?"],
      ["in", "Mando aqui."],
      ["out", "Encontrei o pagamento. Vou solicitar a baixa, que costuma refletir em ate 1 dia util."],
      ["in", "Ok, obrigada."],
    ],
    [
      ["in", "Quero mudar o vencimento para o dia 15."],
      ["out", "Claro, {nome}! Alteracao registrada para o dia 15 a partir do proximo ciclo."],
      ["in", "Show, valeu."],
    ],
    [
      ["in", "Estou com duas mensalidades em atraso, tem como negociar?"],
      ["out", "Ola, {nome}! Tem sim. Vou levantar os valores e te passo as opcoes de pagamento."],
      ["out", "Consegui uma condicao: pagamento das duas em PIX com desconto nos juros. Quer que eu gere?"],
      ["in", "Quero sim."],
      ["out", "Gerado! O codigo PIX vai na proxima mensagem."],
      ["in", "Pago, ja te mando o comprovante."],
    ],
    [
      ["in", "Fui cobrado duas vezes este mes. Como resolvo?"],
      ["out", "Oi, {nome}, peco desculpas pelo transtorno. Vou verificar agora o que aconteceu."],
      ["out", "Confirmei a duplicidade. O valor sera estornado na proxima fatura. Vou te passar o protocolo."],
      ["in", "Obrigado pela rapidez."],
    ],
  ],
};

// ---------------------------------------------------------------------------
// Respostas rapidas
// ---------------------------------------------------------------------------

const QUICK_REPLIES: Record<ConnKey, { name: string; shortcut: string; text: string }[]> = {
  AT: [
    { name: "Boas-vindas", shortcut: "boasvindas", text: "Ola! Seja bem-vindo(a) a Univida Santa Cruz. Como posso ajudar?" },
    { name: "Aguarde um instante", shortcut: "aguarde", text: "Um instante, por favor. Ja estou verificando para voce." },
    { name: "Documentos para inclusao", shortcut: "documentos", text: "Para incluir um dependente, preciso do nome completo, da data de nascimento e de uma foto do documento de identificacao." },
    { name: "Horario das unidades", shortcut: "horario", text: "Nossas unidades funcionam de segunda a sexta, das 8h as 18h, e aos sabados das 8h as 12h. O plantao funerario atende 24 horas." },
    { name: "Encerramento", shortcut: "encerrar", text: "Fico a disposicao para o que precisar. A Univida Santa Cruz agradece o contato!" },
  ],
  CO: [
    { name: "Boas-vindas", shortcut: "boasvindas", text: "Ola! Que bom ter voce por aqui. Vou te ajudar a escolher a Modalidade de Plano ideal." },
    { name: "Modalidades de Plano", shortcut: "modalidades", text: "Trabalhamos com as Modalidades Individual e Familiar. Quer que eu envie uma proposta de cada uma?" },
    { name: "Solicitar dados", shortcut: "dados", text: "Para montar a proposta, me informe por favor: nome completo, cidade e quantas pessoas serao incluidas." },
    { name: "Agendar contato", shortcut: "agendar", text: "Posso agendar o contato de um consultor. Qual o melhor dia e horario para voce?" },
  ],
  FI: [
    { name: "Boas-vindas", shortcut: "boasvindas", text: "Ola! Aqui e o financeiro da Univida Santa Cruz. Em que posso ajudar?" },
    { name: "Segunda via de boleto", shortcut: "segundavia", text: "Claro! Estou gerando a segunda via do seu boleto e ja envio por aqui." },
    { name: "Pedir comprovante", shortcut: "comprovante", text: "Pode me enviar o comprovante de pagamento, por favor? Assim localizo o pagamento mais rapido." },
    { name: "Baixa de pagamento", shortcut: "baixa", text: "Pagamento localizado! A baixa costuma refletir em ate 1 dia util." },
  ],
};

// ---------------------------------------------------------------------------
// Persistencia
// ---------------------------------------------------------------------------

interface Ctx {
  prisma: PrismaClient;
  connIds: Record<ConnKey, string>;
  agentIds: Record<AgentKey, string>;
  managerId: string;
  contactIds: Map<string, string>; // chave: `${conn}:${index}`
  firstContactAt: Map<string, Date>;
  lastContactAt: Map<string, Date>;
}

async function ensureContact(ctx: Ctx, ref: ContactRef): Promise<string> {
  const key = `${ref.conn}:${ref.index}`;
  const existing = ctx.contactIds.get(key);
  if (existing) return existing;
  const photoUrl = ref.index % 3 === 2 ? null : writeAvatar(path.join(UPLOAD_DIR, "contacts"), "/uploads/contacts", ref.name, ref.index + CONN_PHONE_BLOCK[ref.conn]);
  const contact = await ctx.prisma.contact.create({
    data: {
      whatsappConnectionId: ctx.connIds[ref.conn],
      phone: ref.phone,
      name: ref.name,
      photoUrl,
      providerChatId: `${ref.phone}@s.whatsapp.net`,
    },
  });
  ctx.contactIds.set(key, contact.id);
  return contact.id;
}

function copyAsset(file: string): { storageKey: string; sizeBytes: number } {
  ensureDir(UPLOAD_DIR);
  const src = path.join(ASSET_DIR, file);
  const storageKey = `${randomUUID()}${path.extname(file)}`;
  fs.copyFileSync(src, path.join(UPLOAD_DIR, storageKey));
  return { storageKey, sizeBytes: fs.statSync(src).size };
}

async function persistConversation(ctx: Ctx, spec: ConvSpec, ref: ContactRef): Promise<void> {
  const { prisma } = ctx;
  const contactId = await ensureContact(ctx, ref);
  const start = minutesAgo(spec.startAgo);
  const at = (m: number) => new Date(start.getTime() + m * MIN);
  const assigned = spec.agent ? ctx.agentIds[spec.agent] : null;
  const lastMsgOffset = Math.max(...spec.msgs.map((m) => m.at));
  const lastMsgAt = at(lastMsgOffset);
  const lastDirection = [...spec.msgs].sort((a, b) => a.at - b.at).pop()!.d === "in" ? "INBOUND" : "OUTBOUND";

  const acceptedAt = spec.agent || spec.transfer ? at(spec.acceptAfter ?? 2) : null;
  const firstOut = spec.msgs.filter((m) => m.d === "out").sort((a, b) => a.at - b.at)[0];
  const firstResponseAt = firstOut ? at(firstOut.at) : null;
  const closedAt = spec.status === "CLOSED" ? new Date(lastMsgAt.getTime() + (spec.closeAfter ?? 5) * MIN) : null;

  // Marca de leitura: tudo lido ate a ultima mensagem do responsavel (as recebidas depois contam como nao lidas).
  let readAt: Date | null = null;
  if (assigned) {
    if (spec.readAll || spec.status === "CLOSED") readAt = new Date(lastMsgAt.getTime() + MIN);
    else if (spec.transfer) readAt = null; // recem-transferida: a nova responsavel ainda nao abriu
    else {
      const lastOut = [...spec.msgs].filter((m) => m.d === "out").sort((a, b) => a.at - b.at).pop();
      readAt = lastOut ? at(lastOut.at + 0.5) : null;
    }
  }

  const conversation = await prisma.conversation.create({
    data: {
      whatsappConnectionId: ctx.connIds[spec.conn],
      contactId,
      status: spec.status,
      assignedAgentId: assigned,
      enteredQueueAt: start,
      acceptedAt,
      firstResponseAt,
      closedAt,
      closedByUserId: spec.status === "CLOSED" ? assigned : null,
      assignedAgentReadAt: readAt,
      lastMessageAt: lastMsgAt,
      lastMessageDirection: lastDirection,
      createdAt: start,
    },
  });

  // Eventos e atribuicoes
  await prisma.conversationEvent.create({ data: { conversationId: conversation.id, type: "CREATED", createdAt: start } });
  const firstAgentForAccept = spec.transfer ? ctx.agentIds[spec.transfer.from] : assigned;
  if (firstAgentForAccept && acceptedAt) {
    await prisma.conversationAssignment.create({ data: { conversationId: conversation.id, toAgentId: firstAgentForAccept, reason: "ACCEPT", createdAt: acceptedAt } });
    await prisma.conversationEvent.create({ data: { conversationId: conversation.id, type: "ACCEPTED", payload: { agentId: firstAgentForAccept }, createdAt: acceptedAt } });
  }
  if (spec.transfer && assigned) {
    const t = spec.transfer;
    const tAt = at(t.at);
    await prisma.conversationTransfer.create({
      data: { conversationId: conversation.id, fromAgentId: ctx.agentIds[t.from], toAgentId: ctx.agentIds[t.to], initiatedById: ctx.agentIds[t.from], note: t.note, createdAt: tAt },
    });
    await prisma.conversationAssignment.create({
      data: { conversationId: conversation.id, fromAgentId: ctx.agentIds[t.from], toAgentId: ctx.agentIds[t.to], reason: "TRANSFER", createdAt: tAt },
    });
    await prisma.conversationEvent.create({
      data: { conversationId: conversation.id, type: "TRANSFERRED", payload: { fromAgentId: ctx.agentIds[t.from], toAgentId: ctx.agentIds[t.to], note: t.note, targetWasOffline: false }, createdAt: tAt },
    });
  }
  if (spec.status === "CLOSED" && closedAt) {
    await prisma.conversationEvent.create({ data: { conversationId: conversation.id, type: "CLOSED", payload: { agentId: assigned }, createdAt: closedAt } });
  }
  if (spec.status === "HANDLED_EXTERNALLY") {
    await prisma.conversationEvent.create({ data: { conversationId: conversation.id, type: "HANDLED_EXTERNALLY", payload: { reason: "replied from device" }, createdAt: lastMsgAt } });
  }

  // Mensagens
  const createdIds: string[] = [];
  const ordered = [...spec.msgs].map((m, i) => ({ m, i })).sort((a, b) => a.m.at - b.m.at || a.i - b.i);
  const idByOriginalIndex = new Map<number, string>();
  for (const { m, i } of ordered) {
    const createdAt = new Date(at(m.at).getTime() + (i % 5) * 1000);
    const senderKey = m.agent ?? spec.agent;
    const outbound = m.d === "out";
    let type: MessageType = "TEXT";
    if (m.attach) {
      if ("file" in m.attach) type = m.attach.kind;
      else if ("location" in m.attach) type = "LOCATION";
      else type = "CONTACT";
    }
    const isLast = i === spec.msgs.length - 1;
    const status: MessageStatus = outbound ? m.status ?? (isLast && spec.status === "IN_PROGRESS" ? "DELIVERED" : "READ") : "DELIVERED";
    const message = await prisma.message.create({
      data: {
        conversationId: conversation.id,
        direction: outbound ? "OUTBOUND" : "INBOUND",
        type,
        status,
        body: m.t ?? (m.attach && "location" in m.attach ? m.attach.location.label : null),
        providerMessageId: `demo-${randomUUID()}`,
        senderAgentId: outbound && senderKey ? ctx.agentIds[senderKey] : null,
        replyToMessageId: m.reply !== undefined ? idByOriginalIndex.get(m.reply) ?? null : null,
        linkPreviewTitle: m.preview?.title ?? null,
        linkPreviewDescription: m.preview?.description ?? null,
        linkPreviewUrl: m.preview?.url ?? null,
        createdAt,
        deliveredAt: outbound && status !== "SENT" ? new Date(createdAt.getTime() + 2000) : null,
        readAt: outbound && status === "READ" ? new Date(createdAt.getTime() + 60_000) : null,
      },
    });
    idByOriginalIndex.set(i, message.id);
    createdIds.push(message.id);

    if (m.attach) {
      if ("file" in m.attach) {
        const stored = copyAsset(m.attach.file);
        await prisma.messageAttachment.create({
          data: { messageId: message.id, fileName: m.attach.name, mimeType: m.attach.mime, sizeBytes: stored.sizeBytes, storageKey: stored.storageKey, kind: m.attach.kind, createdAt },
        });
      } else if ("location" in m.attach) {
        await prisma.messageAttachment.create({
          data: { messageId: message.id, fileName: "location", mimeType: "application/geo+json", sizeBytes: 0, storageKey: "", kind: "LOCATION", latitude: m.attach.location.lat, longitude: m.attach.location.lng, createdAt },
        });
      } else {
        const v = m.attach.vcard;
        const vcard = `BEGIN:VCARD\nVERSION:3.0\nFN:${v.name}\nTEL;type=CELL;waid=${v.phone}:+${v.phone}\nEND:VCARD`;
        await prisma.messageAttachment.create({
          data: { messageId: message.id, fileName: "contact.vcf", mimeType: "text/vcard", sizeBytes: vcard.length, storageKey: "", kind: "CONTACT", vcard, createdAt },
        });
      }
    }

    for (const r of m.reactions ?? []) {
      await prisma.messageReaction.create({
        data: {
          messageId: message.id,
          emoji: r.emoji,
          fromCustomer: r.by === "customer",
          userId: r.by === "agent" ? (assigned ?? ctx.managerId) : null,
          createdAt: new Date(createdAt.getTime() + 30_000),
        },
      });
    }
  }

  // Acompanha a janela de interacao do contato
  const key = `${ref.conn}:${ref.index}`;
  const first = ctx.firstContactAt.get(key);
  if (!first || start < first) ctx.firstContactAt.set(key, start);
  const last = ctx.lastContactAt.get(key);
  if (!last || lastMsgAt > last) ctx.lastContactAt.set(key, lastMsgAt);

  // Auditoria basica das conversas atendidas
  if (assigned && acceptedAt) {
    await prisma.auditLog.create({ data: { userId: firstAgentForAccept, action: "CONVERSATION_ACCEPTED", entity: "Conversation", entityId: conversation.id, createdAt: acceptedAt } });
  }
  if (spec.transfer) {
    await prisma.auditLog.create({ data: { userId: ctx.agentIds[spec.transfer.from], action: "CONVERSATION_TRANSFERRED", entity: "Conversation", entityId: conversation.id, createdAt: at(spec.transfer.at) } });
  }
  if (closedAt && assigned) {
    await prisma.auditLog.create({ data: { userId: assigned, action: "CONVERSATION_CLOSED", entity: "Conversation", entityId: conversation.id, createdAt: closedAt } });
  }
}

/** Instante de inicio de uma conversa historica: dia util/sabado, 8h-17h no horario de Cuiaba (UTC-4). */
function historicalStart(): { startAgo: number } {
  for (let guard = 0; guard < 50; guard++) {
    const dayOffset = Math.min(29, Math.floor(Math.pow(rand(), 1.3) * 30) + 1);
    const d = new Date(NOW.getTime() - dayOffset * 24 * 60 * MIN);
    const localHour = rint(8, 17);
    d.setUTCHours(localHour + 4, rint(0, 59), rint(0, 59), 0);
    const localDay = new Date(d.getTime() - 4 * 60 * MIN).getUTCDay();
    if (localDay === 0) continue; // domingo
    const ago = (NOW.getTime() - d.getTime()) / MIN;
    if (ago < 150) continue;
    return { startAgo: ago };
  }
  return { startAgo: 60 * 24 * 7 };
}

function buildHistorical(conn: ConnKey): { spec: ConvSpec; ref: ContactRef } {
  const names = CONTACT_NAMES[conn];
  const name = pick(names);
  const ref = contactRef(conn, name);
  const template = pick(TEMPLATES[conn]);
  const agentKey = pick(AGENTS_BY_CONN[conn]);
  const first = name.split(" ")[0];

  const { startAgo } = historicalStart();
  const acceptAfter = rand() < 0.12 ? rint(18, 45) : rint(1, 12);
  const firstResponseGap = rint(1, 5);
  const msgs: MsgSpec[] = [];
  let clock = 0;
  let firstOutSeen = false;
  template.forEach(([dir, text], i) => {
    if (dir === "in") clock += i === 0 ? 0 : rint(1, 6);
    else {
      if (!firstOutSeen) {
        clock = Math.max(clock, acceptAfter + firstResponseGap);
        firstOutSeen = true;
      } else clock += rint(1, 4);
    }
    msgs.push({ d: dir, at: clock, t: text.replace(/\{nome\}/g, first), reactions: dir === "in" && i === template.length - 1 && rand() < 0.25 ? [{ emoji: pick(["👍", "🙏", "❤️"]), by: "agent" }] : undefined });
  });

  const spec: ConvSpec = {
    conn,
    contact: name,
    status: "CLOSED",
    agent: agentKey,
    startAgo,
    acceptAfter,
    closeAfter: rint(2, 25),
    msgs,
  };
  if (rand() < 0.08) {
    const other = AGENTS_BY_CONN[conn].find((a) => a !== agentKey)!;
    spec.transfer = { from: agentKey, to: other, note: "Cliente precisa de apoio de outro colega para concluir.", at: Math.max(acceptAfter + 1, Math.floor(clock / 2)) };
    spec.agent = other;
  }
  return { spec, ref };
}

// ---------------------------------------------------------------------------
// Limpeza (somente conexoes de demonstracao)
// ---------------------------------------------------------------------------

async function purgeDemoData(prisma: PrismaClient) {
  const demoConns = await prisma.whatsAppConnection.findMany({ where: { isDemo: true }, select: { id: true } });
  const ids = demoConns.map((c) => c.id);
  if (ids.length === 0) return;
  const convs = await prisma.conversation.findMany({ where: { whatsappConnectionId: { in: ids } }, select: { id: true } });
  const convIds = convs.map((c) => c.id);
  const msgs = await prisma.message.findMany({ where: { conversationId: { in: convIds } }, select: { id: true } });
  const msgIds = msgs.map((m) => m.id);

  const attachments = await prisma.messageAttachment.findMany({ where: { messageId: { in: msgIds }, storageKey: { not: "" } }, select: { storageKey: true } });
  for (const a of attachments) fs.rmSync(path.join(UPLOAD_DIR, a.storageKey), { force: true });

  await prisma.messageReaction.deleteMany({ where: { messageId: { in: msgIds } } });
  await prisma.messageAttachment.deleteMany({ where: { messageId: { in: msgIds } } });
  await prisma.message.updateMany({ where: { id: { in: msgIds } }, data: { replyToMessageId: null } });
  await prisma.message.deleteMany({ where: { id: { in: msgIds } } });
  await prisma.conversationEvent.deleteMany({ where: { conversationId: { in: convIds } } });
  await prisma.conversationAssignment.deleteMany({ where: { conversationId: { in: convIds } } });
  await prisma.conversationTransfer.deleteMany({ where: { conversationId: { in: convIds } } });
  await prisma.auditLog.deleteMany({ where: { entity: "Conversation", entityId: { in: convIds } } });
  await prisma.conversation.deleteMany({ where: { id: { in: convIds } } });
  await prisma.contact.deleteMany({ where: { whatsappConnectionId: { in: ids } } });
  await prisma.quickReply.deleteMany({ where: { whatsappConnectionId: { in: ids } } });
}

/**
 * Remove de vez a demonstracao: dados, conexoes de demonstracao e atendentes
 * de exemplo. (A tela de Configuracoes nao exclui conexoes com historico —
 * o historico real e sempre preservado — por isso existe este caminho.)
 * Nunca toca em conexoes reais nem em usuarios que nao sejam os de exemplo.
 */
export async function removeDemoData(prisma: PrismaClient): Promise<void> {
  await purgeDemoData(prisma);
  const emails = Object.values(AGENTS).map((a) => a.email);
  const users = await prisma.user.findMany({ where: { email: { in: emails } }, select: { id: true } });
  const userIds = users.map((u) => u.id);
  await prisma.auditLog.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.auditLog.deleteMany({ where: { entity: { in: ["WhatsAppConnection", "QuickReply"] }, entityId: null } });
  await prisma.whatsAppConnection.deleteMany({ where: { isDemo: true } });
  await prisma.systemSetting.deleteMany({ where: { key: "demoSeed" } });
  console.log("Demonstracao removida (conexoes de demo, conversas, contatos e atendentes de exemplo).");
}

// ---------------------------------------------------------------------------
// Ponto de entrada
// ---------------------------------------------------------------------------

export async function seedDemoData(prisma: PrismaClient): Promise<void> {
  const force = process.env.SEED_DEMO_FORCE === "true";
  const marker = await prisma.systemSetting.findUnique({ where: { key: "demoSeed" } });
  if (marker && !force) {
    console.log("Dados de demonstracao ja existem — nada a fazer (use SEED_DEMO_FORCE=true para recriar com datas atuais).");
    return;
  }

  console.log(force ? "Recriando dados de demonstracao..." : "Criando dados de demonstracao...");
  if (force) await purgeDemoData(prisma);

  const manager = await prisma.user.findUnique({ where: { email: "gestor@whatsunivida.dev" } });
  if (!manager) throw new Error("Usuario gestor base nao encontrado — rode o seed completo (npm run seed).");

  // Conexoes de demonstracao
  const connIds = {} as Record<ConnKey, string>;
  for (const key of Object.keys(CONNECTIONS) as ConnKey[]) {
    const c = CONNECTIONS[key];
    const row = await prisma.whatsAppConnection.upsert({
      where: { name: c.name },
      update: { isDemo: true, color: c.color },
      create: {
        name: c.name,
        color: c.color,
        isDemo: true,
        status: "CONNECTED",
        connectedNumber: c.number,
        linkedNumber: c.number,
        lastConnectedAt: NOW,
        createdByUserId: manager.id,
      },
    });
    connIds[key] = row.id;
  }

  // Atendentes
  const passwordPlain = process.env.SEED_DEMO_PASSWORD ?? "***REMOVIDO***";
  const passwordHash = await bcrypt.hash(passwordPlain, 12);
  const agentIds = {} as Record<AgentKey, string>;
  let colorIdx = 0;
  for (const key of Object.keys(AGENTS) as AgentKey[]) {
    const a = AGENTS[key];
    const photoUrl = writeAvatar(path.join(UPLOAD_DIR, "profile"), "/uploads/profile", a.fullName, colorIdx++);
    const user = await prisma.user.upsert({
      where: { email: a.email },
      update: { whatsappConnectionId: connIds[a.conn], presence: a.presence, photoUrl },
      create: {
        email: a.email,
        fullName: a.fullName,
        displayName: a.displayName,
        role: "AGENT" as Role,
        passwordHash,
        status: "ACTIVE",
        presence: a.presence,
        photoUrl,
        whatsappConnectionId: connIds[a.conn],
        workState: "MT",
        workCity: "Tangara da Serra",
        lastAccessAt: minutesAgo(rint(5, 240)),
      },
    });
    agentIds[key] = user.id;
  }

  // Foto para admin/gestor
  const adminUser = await prisma.user.findUnique({ where: { email: "admin@whatsunivida.dev" } });
  for (const u of [adminUser, manager]) {
    if (u && !u.photoUrl) {
      const photoUrl = writeAvatar(path.join(UPLOAD_DIR, "profile"), "/uploads/profile", u.fullName, colorIdx++);
      await prisma.user.update({ where: { id: u.id }, data: { photoUrl } });
    }
  }

  const ctx: Ctx = {
    prisma,
    connIds,
    agentIds,
    managerId: manager.id,
    contactIds: new Map(),
    firstContactAt: new Map(),
    lastContactAt: new Map(),
  };

  // Respostas rapidas
  for (const key of Object.keys(QUICK_REPLIES) as ConnKey[]) {
    for (const qr of QUICK_REPLIES[key]) {
      await prisma.quickReply.upsert({
        where: { whatsappConnectionId_shortcut: { whatsappConnectionId: connIds[key], shortcut: qr.shortcut } },
        update: { name: qr.name, text: qr.text },
        create: { ...qr, whatsappConnectionId: connIds[key] },
      });
    }
  }

  // Conversas roteirizadas
  for (const spec of SCRIPTED) {
    await persistConversation(ctx, spec, contactRef(spec.conn, spec.contact));
  }

  // Historico gerado (distribuido entre as conexoes)
  const plan: [ConnKey, number][] = [["AT", 34], ["CO", 26], ["FI", 30]];
  for (const [conn, count] of plan) {
    for (let i = 0; i < count; i++) {
      const { spec, ref } = buildHistorical(conn);
      await persistConversation(ctx, spec, ref);
    }
  }

  // Contatos extras que ainda nao falaram com ninguem (aparecem em "Nova conversa"/contatos)
  for (const conn of Object.keys(CONTACT_NAMES) as ConnKey[]) {
    for (let i = 0; i < CONTACT_NAMES[conn].length; i++) {
      await ensureContact(ctx, contactRef(conn, CONTACT_NAMES[conn][i]));
    }
  }

  // Janela de interacao dos contatos
  for (const [key, id] of ctx.contactIds) {
    const first = ctx.firstContactAt.get(key);
    const last = ctx.lastContactAt.get(key);
    if (first || last) {
      await prisma.contact.update({ where: { id }, data: { ...(first ? { firstConversationAt: first } : {}), ...(last ? { lastInteractionAt: last } : {}) } });
    }
  }

  // Trilha de auditoria de acessos e configuracao
  const audit: Prisma.AuditLogCreateManyInput[] = [];
  const allAgents = Object.values(agentIds);
  for (let d = 0; d < 14; d++) {
    for (const uid of allAgents) {
      if (rand() < 0.7) {
        const t = new Date(NOW.getTime() - d * 24 * 60 * MIN - rint(0, 90) * MIN);
        t.setUTCHours(11 + rint(0, 2), rint(0, 59), 0, 0);
        if (t < NOW) audit.push({ userId: uid, action: "LOGIN_SUCCESS", entity: "User", entityId: uid, ipAddress: "203.0.113.10", createdAt: t });
      }
    }
  }
  audit.push(
    { userId: manager.id, action: "WHATSAPP_CONNECTION_CREATED", entity: "WhatsAppConnection", entityId: connIds.AT, createdAt: minutesAgo(60 * 24 * 20), metadata: { name: CONNECTIONS.AT.name } },
    { userId: manager.id, action: "WHATSAPP_CONNECTION_CREATED", entity: "WhatsAppConnection", entityId: connIds.CO, createdAt: minutesAgo(60 * 24 * 20), metadata: { name: CONNECTIONS.CO.name } },
    { userId: manager.id, action: "WHATSAPP_CONNECTION_CREATED", entity: "WhatsAppConnection", entityId: connIds.FI, createdAt: minutesAgo(60 * 24 * 19), metadata: { name: CONNECTIONS.FI.name } },
    { userId: manager.id, action: "QUICK_REPLY_CREATED", entity: "QuickReply", createdAt: minutesAgo(60 * 24 * 18) },
    { userId: adminUser?.id ?? manager.id, action: "SETTINGS_BRANDING_UPDATED", entity: "SystemSetting", entityId: "branding", createdAt: minutesAgo(60 * 24 * 21) }
  );
  await prisma.auditLog.createMany({ data: audit });

  // Identidade visual (so se ainda nao houver customizacao)
  const branding = await prisma.systemSetting.findUnique({ where: { key: "branding" } });
  if (!branding) {
    await prisma.systemSetting.create({
      data: { key: "branding", value: { companyName: "Univida Santa Cruz", primaryColor: "#0097B4", secondaryColor: "#FFE450", logoUrl: null, faviconUrl: null, appName: "WhatsUnivida", appIconUrl: null } },
    });
  }

  await prisma.systemSetting.upsert({
    where: { key: "demoSeed" },
    update: { value: { seededAt: NOW.toISOString() } },
    create: { key: "demoSeed", value: { seededAt: NOW.toISOString() } },
  });

  const [nConv, nMsg, nContacts] = await Promise.all([
    prisma.conversation.count({ where: { whatsappConnectionId: { in: Object.values(connIds) } } }),
    prisma.message.count({ where: { conversation: { whatsappConnectionId: { in: Object.values(connIds) } } } }),
    prisma.contact.count({ where: { whatsappConnectionId: { in: Object.values(connIds) } } }),
  ]);
  console.log(`Demonstracao pronta: ${nConv} conversas, ${nMsg} mensagens, ${nContacts} contatos, ${allAgents.length} atendentes, 3 conexoes.`);
}
