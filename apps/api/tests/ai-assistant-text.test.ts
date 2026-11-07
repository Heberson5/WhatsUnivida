import { describe, it, expect } from "vitest";
import { addressesMatch, extractCpf, isNo, isYes, maskCpf, monthOf, namesMatch, parseChoice, ruleIntent, validCnpj, validCpf } from "../src/modules/ai-assistant/ai-text";

describe("Assistente Virtual: CPF em qualquer formato", () => {
  it.each([
    ["529.982.247-25"],
    ["52998224725"],
    ["529 982 247 25"],
    ["meu cpf é 529982247-25"],
    ["CPF: 529.982.247/25 obrigado"],
    ["cinco dois nove nove oito dois dois quatro sete dois cinco"],
    ["cpf 52998224725 telefone 65 99928-6623"],
  ])("%s", (text) => {
    expect(extractCpf(text)).toBe("52998224725");
  });

  it("dígito verificador errado, sequência repetida ou poucos números não contam", () => {
    expect(extractCpf("529.982.247-26")).toBeNull();
    expect(extractCpf("111.111.111-11")).toBeNull();
    expect(extractCpf("12345")).toBeNull();
    expect(validCpf("52998224725")).toBe(true);
  });

  it("CNPJ também", () => {
    expect(validCnpj("11222333000181")).toBe(true);
    expect(extractCpf("cnpj 11.222.333/0001-81")).toBe("11222333000181");
    expect(maskCpf("52998224725")).toBe("***.982.247-**");
  });
});

describe("Assistente Virtual: nome", () => {
  it("confere sem acento, sem o nome do meio, com erro pequeno de digitação ou do áudio", () => {
    expect(namesMatch("maria da silva", "Maria Aparecida da Silva")).toBe(true);
    expect(namesMatch("MARIA APARECIDA SILVA", "Maria Aparecida da Silva")).toBe(true);
    expect(namesMatch("Eberson Souza", "Heberson Souza")).toBe(true);
    expect(namesMatch("José Antônio", "Jose Antonio")).toBe(true);
  });

  it("não confere com outro sobrenome, só o primeiro nome ou um nome a mais que não é dele", () => {
    expect(namesMatch("Maria Pereira", "Maria Aparecida da Silva")).toBe(false);
    expect(namesMatch("Maria", "Maria Aparecida da Silva")).toBe(false);
    expect(namesMatch("Maria Fernanda da Silva", "Maria Aparecida da Silva")).toBe(false);
    expect(namesMatch("João Silva", "Maria Aparecida da Silva")).toBe(false);
  });
});

describe("Assistente Virtual: endereço", () => {
  it("mesmo endereço escrito de outro jeito", () => {
    expect(addressesMatch("R. das Flores nº 100 - centro", "Rua das Flores, 100, Centro, Tangará da Serra, 78300-000")).toBe(true);
    expect(addressesMatch("rua das flores 100", "RUA DAS FLORES, 100")).toBe(true);
  });

  it("outro número ou outra rua: diferente", () => {
    expect(addressesMatch("Rua das Flores 200", "Rua das Flores, 100, Centro")).toBe(false);
    expect(addressesMatch("Avenida Brasil, 2000, Jardim Europa", "Rua das Flores, 100, Centro")).toBe(false);
    expect(addressesMatch("Rua das Flores", "Rua das Flores, 100")).toBe(false);
  });
});

describe("Assistente Virtual: pedidos óbvios (sem precisar da IA)", () => {
  it.each([
    ["Quero a 2ª via do boleto", "BOLETO"],
    ["me manda a linha digitável", "BOLETO"],
    ["quero pagar pelo pix", "BOLETO"],
    ["quanto eu devo?", "DEBITOS"],
    ["tenho parcelas atrasadas?", "DEBITOS"],
    ["quero falar com um atendente", "ATENDENTE"],
    ["me passa para uma atendente por favor", "ATENDENTE"],
    ["Bom dia!", "SAUDACAO"],
    ["Não, obrigado!", "AGRADECIMENTO"],
    ["era só isso", "AGRADECIMENTO"],
  ])("%s → %s", (text, intent) => {
    expect(ruleIntent(text)).toBe(intent);
  });

  it("assunto que as regras não reconhecem fica para a IA local", () => {
    expect(ruleIntent("gostaria de cancelar meu plano")).toBeNull();
  });

  it("sim, não e a escolha da parcela", () => {
    expect(isYes("Sim, por favor")).toBe(true);
    expect(isYes("talvez")).toBe(false);
    expect(isYes("sim")).toBe(true);
    expect(isNo("Não, obrigada.")).toBe(true);
    expect(parseChoice("a 2", 3)).toBe(2);
    expect(parseChoice("quero a segunda", 3)).toBe(2);
    expect(parseChoice("todas", 3)).toBe(0);
    expect(parseChoice("7", 3)).toBeNull();
    expect(monthOf("10/03/2026")).toBe("março/2026");
  });
});
