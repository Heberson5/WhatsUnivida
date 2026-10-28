import { describe, expect, it } from "vitest";
import { dataColumnLabel } from "@whatsatendende/types";
import { formatDataValue } from "./format-data-value";

describe("Dados do cliente: rótulos e valores", () => {
  it("rótulos sem _ e com acentos", () => {
    expect(dataColumnLabel("situacao_contrato")).toBe("Situação do contrato");
    expect(dataColumnLabel("dia_vencimento")).toBe("Dia do vencimento");
    expect(dataColumnLabel("valor_em_atraso")).toBe("Valor em atraso");
    expect(dataColumnLabel("cpf_cnpj")).toBe("CPF/CNPJ");
    expect(dataColumnLabel("telefone_whatsapp")).toBe("Telefone (WhatsApp)");
  });

  it("valores como se leem: R$, telefone e CEP; mascarado fica como veio", () => {
    expect(formatDataValue("valor_em_atraso", "396.4").replace(/\s/g, " ")).toBe("R$ 396,40");
    expect(formatDataValue("telefone_whatsapp", "5565999990000")).toBe("+55 65 99999-0000");
    expect(formatDataValue("cep", "78300062")).toBe("78300-062");
    expect(formatDataValue("cpf_cnpj", "•••••••04")).toBe("•••••••04");
    expect(formatDataValue("cidade", "Tangará da Serra - MT")).toBe("Tangará da Serra - MT");
  });
});
