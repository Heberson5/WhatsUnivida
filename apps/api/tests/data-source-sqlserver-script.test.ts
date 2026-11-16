import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { assertReadOnlyQuery, lastResultSet } from "../src/modules/data-sources/data-source-fetch";

// The ERP's own script (scripts/planilha-whatsatendende): DECLARE, SET, temporary tables (#...) and DROP TABLE #... —
// much lighter on the server than the same thing written as one big WITH ... SELECT, which is what used to be required.
const ERP_SCRIPT = fs.readFileSync(path.resolve(__dirname, "../../../scripts/planilha-whatsatendende/whatsatendente.sql"), "utf8");

const sqlserver = (query: string) => () => assertReadOnlyQuery(query, "sqlserver");

describe("SQL Server: script de leitura com tabelas temporárias", () => {
  it("aceita o script do ERP como ele é", () => {
    expect(sqlserver(ERP_SCRIPT)).not.toThrow();
  });

  it("aceita o que só mexe em tabelas temporárias", () => {
    expect(sqlserver("SET NOCOUNT ON; DECLARE @x INT = 1; SELECT id INTO #a FROM clientes; DELETE FROM #a WHERE id = 2; UPDATE #a SET id = 3; INSERT INTO #a (id) VALUES (4); SELECT * FROM #a; DROP TABLE #a;")).not.toThrow();
    expect(sqlserver("IF OBJECT_ID('tempdb..#a') IS NOT NULL DROP TABLE #a; CREATE TABLE #a (id INT); SELECT * FROM #a")).not.toThrow();
    expect(sqlserver("SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED; SELECT 1")).not.toThrow();
  });

  it("palavras dentro de texto, comentário ou nome entre colchetes não contam", () => {
    expect(sqlserver("SELECT 'delete' AS acao, [dt_update] FROM [tbl_drop] -- update x\n/* insert into y */")).not.toThrow();
  });

  it("recusa qualquer escrita numa tabela de verdade", () => {
    for (const q of [
      "DELETE FROM clientes",
      "DELETE clientes WHERE id = 1",
      "UPDATE clientes SET nome = 'x'",
      "INSERT INTO clientes (id) VALUES (1)",
      "INSERT clientes VALUES (1)",
      "SELECT * INTO copia FROM clientes",
      "SELECT 1; DROP TABLE clientes",
      "DROP TABLE #a, clientes",
      "TRUNCATE TABLE clientes",
      "ALTER TABLE clientes ADD x INT",
      "CREATE TABLE copia (id INT)",
      "MERGE clientes USING #a ON 1 = 1 WHEN MATCHED THEN DELETE;",
      "EXEC sp_who",
      "EXECUTE ('DELETE FROM clientes')",
      "SELECT 1; COMMIT",
      "BEGIN TRAN; SELECT 1",
      "SELECT * FROM OPENROWSET('SQLNCLI', 'x', 'SELECT 1')",
      "USE master; SELECT 1",
    ]) {
      expect(sqlserver(q), q).toThrow();
    }
  });

  it("precisa ter um SELECT", () => {
    expect(sqlserver("DECLARE @x INT = 1")).toThrow();
  });

  it("outros bancos continuam só com uma única consulta SELECT", () => {
    expect(() => assertReadOnlyQuery("SELECT 1; SELECT 2", "postgres")).toThrow();
    expect(() => assertReadOnlyQuery("SELECT id INTO #a FROM x", "mysql")).toThrow();
    expect(() => assertReadOnlyQuery("WITH x AS (SELECT 1 a) SELECT * FROM x", "postgres")).not.toThrow();
  });
});

describe("o resultado é o último SELECT do script", () => {
  it("ignora os passos sem colunas e pega a tabela final", () => {
    const first = Object.assign([{ a: 1 }], { columns: { a: {} } });
    const last = Object.assign([{ telefone_whatsapp: "5565999990000" }], { columns: { telefone_whatsapp: {} } });
    const empty = Object.assign([], { columns: {} });
    expect(lastResultSet([first, last, empty])).toBe(last);
    expect(lastResultSet([])).toBeNull();
  });
});
