import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { SAUBERLICH_CREDIT, sauberlichCopyright } from "@whatsatendende/types";

/**
 * The author's mark (Sauberlich System) on every screen: the menu shows "Desenvolvido por" on every page of the
 * system, and the screens before the login (login, maintenance, new password) show the copyright. Removing it
 * from any of them fails here — and the update doesn't go to the server.
 */
const source = (file: string) => fs.readFileSync(path.join(__dirname, file), "utf8");

describe("marca Sauberlich System nas telas", () => {
  it("o texto é o combinado", () => {
    expect(SAUBERLICH_CREDIT).toBe("Desenvolvido por Sauberlich System");
    expect(sauberlichCopyright(2026)).toBe("© 2026 Sauberlich System · Todos os direitos reservados");
  });

  it("o menu de todas as páginas mostra a marca, aberto ou recolhido", () => {
    const sidebar = source("components/layout/Sidebar.tsx");
    expect(sidebar).toContain('data-testid="sauberlich-credit"');
    expect(sidebar).toContain("{isCollapsed ? \"SS\" : SAUBERLICH_CREDIT}");
    expect(sidebar).toContain("title={SAUBERLICH_CREDIT}");
  });

  it("login, manutenção e nova senha mostram o direito autoral", () => {
    for (const file of ["pages/login/LoginPage.tsx", "pages/login/MaintenanceScreen.tsx", "pages/login/ResetPasswordPage.tsx"]) {
      expect(source(file), file).toContain("{sauberlichCopyright()}");
    }
  });
});
