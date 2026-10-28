import { describe, it, expect } from "vitest";
import { isGratitudeMessage } from "../src/modules/satisfaction/gratitude";

describe("isGratitudeMessage — só agradecimento, nada que peça resposta", () => {
  it.each([
    "obrigado",
    "Obrigada!",
    "muito obrigado",
    "obrigadooo",
    "OBRIGADO!!!",
    "obg",
    "valeu",
    "vlw!",
    "ok",
    "okkk",
    "OK 👍",
    "blz",
    "show",
    "tmj",
    "agradeço",
    "certo",
    "perfeito, obrigado",
    "ótimo, obrigada!",
    "entendi, obrigado",
    "obrigado, boa tarde",
    "valeu, tchau",
    "muito obrigada pelo atendimento",
    "obrigado pela ajuda!",
    "Muito obrigado a vocês",
    "Obrigado! Deus abençoe",
    "👍",
    "🙏",
    "🙏🙏",
    "👍🏽",
    "❤️",
    "obrigada 🙏",
  ])("é agradecimento: %s", (text) => {
    expect(isGratitudeMessage(text)).toBe(true);
  });

  it.each([
    "oi",
    "bom dia",
    "boa tarde",
    "tudo bem?",
    "obrigado, mas ainda tenho uma dúvida",
    "obrigado, só mais uma coisa",
    "obrigado, tenho outra dúvida",
    "preciso de ajuda",
    "quanto custa?",
    "pode me mandar o boleto?",
    "não resolveu",
    "ok, e o boleto?",
    "ok mas e agora",
    "ok 2ª via",
    "obrigado 10",
    "obrigado por favor me ajude",
    "https://exemplo.com obrigado",
    "😡",
    "👎",
    "kkkk",
    "?",
    "obrigado obrigado obrigado obrigado obrigado obrigado obrigado obrigado obrigado",
  ])("não é: %s", (text) => {
    expect(isGratitudeMessage(text)).toBe(false);
  });

  it("não é agradecimento quando não há texto", () => {
    expect(isGratitudeMessage("")).toBe(false);
    expect(isGratitudeMessage("   ")).toBe(false);
    expect(isGratitudeMessage(null)).toBe(false);
    expect(isGratitudeMessage(undefined)).toBe(false);
  });
});
