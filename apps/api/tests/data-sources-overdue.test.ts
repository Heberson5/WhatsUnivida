import { describe, it, expect } from "vitest";
import { buildContracts } from "../src/modules/data-sources/data-sources.service";

const map = { contract: "contrato", document: "documento", parcelDue: "vencimento", daysLate: "dias_atraso", parcelValue: "valor" } as never;
const row = (id: string, due: string, daysLate: string) => ({ id, data: { contrato: "C-1", documento: id, vencimento: due, dias_atraso: daysLate, valor: "90.00" } });

describe("parcela vencida pela data de vencimento", () => {
  it("não vencida quando a data ainda não chegou, mesmo com dias em atraso na planilha; vencida quando já passou, mesmo com 0", () => {
    const [contract] = buildContracts([row("futura", "19/11/2099", "12"), row("passada", "10/01/2020", "0")], map);
    const byId = Object.fromEntries(contract.parcels.map((p) => [p.id, p]));
    expect(byId.futura).toMatchObject({ overdue: false, daysLate: 0 });
    expect(byId.passada.overdue).toBe(true);
  });

  it("sem data legível, vale a coluna de dias em atraso", () => {
    const [contract] = buildContracts([row("sem-data", "", "5")].map((r) => ({ ...r, data: { ...r.data, documento: "X" } })), map);
    expect(contract.parcels[0].overdue).toBe(true);
  });
});
