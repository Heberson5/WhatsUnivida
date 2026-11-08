/**
 * Assistente Virtual — how it says things. Each reply has a few versions, picked at random, so the customer doesn't
 * get the same sentence every time (the first version of each is the "classic" one, used by the tests). Values, dates
 * and linhas never come from here: they are filled in by the code ({cpf}, {lista}…).
 */

export type PhraseKey =
  | "askCpf"
  | "askCpfWithPrevious"
  | "cpfInvalid"
  | "cpfMissing"
  | "cpfNotFound"
  | "askName"
  | "nameMismatch"
  | "nameMismatchFinal"
  | "askAddress"
  | "noParcels"
  | "parcelsForBoleto"
  | "parcelsForDebts"
  | "parcelUnclear"
  | "boletoSent"
  | "boletoFailed"
  | "anythingElse"
  | "okAnythingElse"
  | "youreWelcome"
  | "howCanIHelp"
  | "notUnderstood"
  | "audioFailed"
  | "audioAskToWrite"
  | "dataUnavailable"
  | "dataUnavailableClosed"
  | "staleList"
  | "boletoSentStale"
  | "cpfReceivedWhichService"
  | "correctionCpf"
  | "correctionAddress"
  | "cpfLimit";

const PHRASES: Record<PhraseKey, string[]> = {
  askCpf: [
    "{proposito}, me informe o CPF do titular do plano (quem é responsável pelo pagamento). Se for empresa, o CNPJ.",
    "Claro! {proposito}, preciso do CPF do titular do plano, a pessoa responsável pelo pagamento. Pode me passar?",
    "Certo{virgula_nome}! {proposito}, me envia o CPF de quem é o titular do plano (ou o CNPJ, se for empresa)?",
  ],
  askCpfWithPrevious: [
    "{proposito}, preciso do CPF do titular do plano (quem é responsável pelo pagamento).\nSe for o mesmo de antes ({cpf}), responda *mesmo*. Se for de outra pessoa, envie o CPF dela.",
    "Claro! {proposito}, me diga de qual CPF é: se for o mesmo de antes ({cpf}), responda *mesmo*; se for de outra pessoa, envie o CPF dela.",
  ],
  cpfInvalid: [
    "Esse número não é um CPF válido. Confira e envie os 11 números do CPF (ou os 14 do CNPJ).",
    "Hum, esse CPF não confere. Pode conferir e mandar de novo? São 11 números (ou 14, se for CNPJ).",
  ],
  cpfMissing: [
    "Não identifiquei o CPF na mensagem. Envie os 11 números do CPF do titular (ou os 14 do CNPJ).",
    "Não consegui achar o CPF na sua mensagem. Pode mandar só os números do CPF do titular?",
  ],
  cpfNotFound: [
    "Não consegui confirmar seus dados. Confira o CPF e envie de novo, por favor.",
    "Não consegui confirmar seus dados com esse CPF. Pode conferir os números e mandar de novo?",
  ],
  askName: [
    "Obrigado! Para sua segurança, informe o nome completo do titular, como está no cadastro.",
    "Obrigado! Só para confirmar que é o titular: qual é o nome completo dele, como está no cadastro?",
  ],
  nameMismatch: [
    "Não consegui confirmar seus dados. Pode conferir o nome completo do titular?",
    "Não consegui confirmar seus dados com esse nome. Pode mandar o nome completo do titular, como está no cadastro?",
  ],
  nameMismatchFinal: ["Não consegui confirmar seus dados por aqui.", "Por segurança, não consegui confirmar seus dados por aqui."],
  askAddress: [
    "Certo! Agora informe o endereço do cadastro (rua, número e bairro).",
    "Perfeito! E qual é o endereço do cadastro? Pode ser só rua, número e bairro.",
  ],
  noParcels: [
    "Não encontrei parcelas em aberto para o CPF {cpf}.\nSe o boleto for de outra pessoa (por exemplo, o titular do plano), envie o CPF dela. Se não, responda *não*.",
    "Boa notícia: não encontrei parcelas em aberto para o CPF {cpf}. 😊\nSe o boleto for de outra pessoa (por exemplo, o titular do plano), envie o CPF dela. Se não, responda *não*.",
  ],
  parcelsForBoleto: [
    "Estas são as parcelas em aberto:\n{lista}\n\nResponda com o *número* da parcela que deseja o boleto{ou_todas}.",
    "Encontrei estas parcelas em aberto:\n{lista}\n\nDe qual você quer o boleto? Responda com o *número*{ou_todas}.",
  ],
  parcelsForDebts: [
    "Estas são as parcelas em aberto:\n{lista}\n\nQuer receber o boleto? Responda com o *número* da parcela{ou_todas_virgula} ou *não*.",
    "Encontrei estas parcelas em aberto:\n{lista}\n\nQuer que eu envie o boleto? É só responder com o *número*{ou_todas_virgula} ou *não*.",
  ],
  parcelUnclear: [
    "Não entendi qual parcela. Responda só com o número (de 1 a {total}){ou_todas}.",
    "Desculpe, não entendi qual parcela. Me manda só o número, de 1 a {total}{ou_todas}.",
  ],
  boletoSent: [
    "Pronto! O boleto está no PDF acima e a linha digitável logo abaixo dele, para copiar.\nPosso ajudar em algo mais?",
    "Prontinho! Mandei o boleto em PDF e a linha digitável logo abaixo, é só copiar.\nPosso ajudar em mais alguma coisa?",
  ],
  boletoSentStale: [
    "Pronto! O boleto está no PDF acima e a linha digitável logo abaixo dele, para copiar.\nSe você já pagou esta parcela nos últimos dias, pode desconsiderar.\nPosso ajudar em algo mais?",
    "Prontinho! Mandei o boleto em PDF e a linha digitável logo abaixo, é só copiar.\nSe já pagou esta parcela nos últimos dias, pode desconsiderar.\nPosso ajudar em mais alguma coisa?",
  ],
  staleList: ["_Se você pagou alguma delas nos últimos dias, ela ainda pode aparecer aqui._"],
  dataUnavailable: [
    "No momento não consigo consultar {o_que} por aqui. Seu pedido ficou registrado{com_cpf}, e um de nossos atendentes vai continuar o seu atendimento em instantes.",
    "Agora não estou conseguindo consultar {o_que} por aqui. Já deixei seu pedido registrado{com_cpf}, e um de nossos atendentes vai te atender em instantes.",
  ],
  dataUnavailableClosed: [
    "No momento não consigo consultar {o_que} por aqui. Seu pedido ficou registrado{com_cpf}, e um de nossos atendentes vai continuar o seu atendimento assim que o expediente começar.",
    "Agora não estou conseguindo consultar {o_que} por aqui. Já deixei seu pedido registrado{com_cpf}, e um de nossos atendentes vai te atender assim que o expediente começar.",
  ],
  boletoFailed: ["Não consegui gerar o boleto agora.", "Tive um problema para gerar o boleto agora."],
  anythingElse: ["Posso ajudar em algo mais?", "Posso ajudar em mais alguma coisa?"],
  okAnythingElse: ["Tudo bem! Posso ajudar em algo mais?", "Combinado! Posso ajudar em mais alguma coisa?"],
  youreWelcome: [
    "Por nada! Posso ajudar com boleto, linha digitável ou débitos em aberto. É só dizer.",
    "Imagina! Se precisar de boleto, linha digitável ou saber dos débitos, é só me chamar.",
  ],
  howCanIHelp: [
    "Como posso ajudar? Posso enviar boleto, linha digitável ou informar débitos em aberto.",
    "Em que posso ajudar? Consigo enviar boleto, linha digitável ou te dizer os débitos em aberto.",
  ],
  notUnderstood: [
    "Desculpe, não entendi. Você precisa de boleto, linha digitável ou saber os débitos em aberto? Se for outro assunto, me conte em poucas palavras que passo para a equipe.",
    "Desculpe, não entendi direito. É sobre boleto, linha digitável ou débitos em aberto? Se for outra coisa, me explica em poucas palavras que eu passo para a equipe.",
  ],
  audioFailed: ["Não consegui ouvir o seu áudio.", "Não consegui entender o seu áudio."],
  audioAskToWrite: [
    "Desculpe, não consegui ouvir o seu áudio. Pode me escrever, em poucas palavras, o que você precisa?",
    "Desculpe{virgula_nome}, o seu áudio não ficou claro para mim. Pode escrever o que você precisa? Por exemplo: *boleto* ou *débitos*.",
  ],
  cpfReceivedWhichService: [
    "Recebi o CPF {cpf}. Você precisa do *boleto* ou quer saber os *débitos em aberto*?",
    "Anotei o CPF {cpf}. É para enviar o *boleto* ou para ver os *débitos em aberto*?",
  ],
  correctionCpf: ["Sem problemas! Me envie o CPF certo do titular, por favor.", "Tudo bem! Qual é o CPF correto do titular?"],
  correctionAddress: ["Sem problemas! Me envie o endereço certo (rua, número e bairro).", "Tudo bem! Qual é o endereço correto? Rua, número e bairro."],
  cpfLimit: [
    "Por segurança, não consigo consultar mais CPFs por aqui hoje. Vou passar você para um de nossos atendentes.",
    "Por segurança, atingimos o limite de consultas de CPF por hoje neste número. Vou passar você para a nossa equipe.",
  ],
};

let pick: (count: number) => number = (count) => Math.floor(Math.random() * count);

/** Tests: always the first ("classic") version. */
export function __usePhraseVersionForTests(index: number | null): void {
  pick = index === null ? (count) => Math.floor(Math.random() * count) : (count) => Math.min(index, count - 1);
}

/** One of the versions of a reply, with its {placeholders} filled ({virgula_nome} = ", Maria" or nothing). */
export function phrase(key: PhraseKey, vars: Record<string, string | number | null | undefined> = {}): string {
  const versions = PHRASES[key];
  const text = versions[pick(versions.length)];
  return text.replace(/\{(\w+)\}/g, (_m, name: string) => {
    if (name === "virgula_nome") return vars.nome ? `, ${vars.nome}` : "";
    const value = vars[name];
    return value === null || value === undefined ? "" : String(value);
  });
}

/** "Bom dia" / "Boa tarde" / "Boa noite" at the business' local time (UTC minus the offset, as getTimezoneOffset). */
export function greetingOfTheDay(now: Date, tzOffsetMinutes: number): string {
  const local = new Date(now.getTime() - tzOffsetMinutes * 60_000);
  const hour = local.getUTCHours();
  if (hour >= 5 && hour < 12) return "Bom dia";
  if (hour >= 12 && hour < 18) return "Boa tarde";
  return "Boa noite";
}

/**
 * The customer's first name to use in the replies — only when it looks like a real name: the one saved by the team,
 * else the first word of the WhatsApp name when it is only letters (no emojis, numbers or "Cliente").
 */
export function firstNameFor(contact: { firstName: string | null; name: string | null }): string | null {
  const candidate = (contact.firstName ?? contact.name ?? "").trim().split(/\s+/)[0] ?? "";
  if (!/^[A-Za-zÀ-ÖØ-öø-ÿ]{2,15}$/.test(candidate)) return null;
  if (/^(cliente|contato|usuario|usuário|whatsapp|admin|teste)$/i.test(candidate)) return null;
  return candidate.charAt(0).toUpperCase() + candidate.slice(1).toLowerCase();
}

/** A pause like a person typing: a little longer for longer replies, never more than a few seconds. */
export function typingDelayMs(text: string): number {
  return Math.min(4_000, 700 + text.length * 20);
}
